/** Production readers of the setup state: each is the read-only status call of the existing command (never a prompt or a
 * change). Wallet status also reads the Hub binding over the network; a failure there reads as `unavailable`. */
import type { BehaviorRuleRevision } from "@balchemyai/agent-rules";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { inspectLocalRunner } from "./lifecycle.js";
import { readLocalProfile } from "./metadata.js";
import { readPairingAdoption, readPairingApproval } from "./pairing-identity.js";
import { runPrivateSpendLimitsCommand } from "./private-arming-ui.js";
import { readPrivateBrainTarget } from "./private-brain-client.js";
import { readPrivateModelStatus } from "./private-brain-ui.js";
import { privateRuleApproval, runPrivateRuleCommand } from "./private-rule-commands.js";
import { runPrivateSizingCommand } from "./private-sizing-ui.js";
import { runPrivateModelBudgetCommand } from "./private-model-budget-ui.js";
import { runPrivateSolanaRpcCommand } from "./private-solana-rpc-ui.js";
import { privateSetupRpc } from "./private-setup-context.js";
import { runPrivateTradingWalletCommand } from "./private-trading-keystore-ui.js";
import type { SetupBindingState, SetupStateReaders, SetupWalletState } from "./setup-state.js";

type Flags = Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
const FLAGS: Flags = Object.freeze({ json: false, ci: false, yes: false, force: false, dryRun: false, quiet: false });
const silent = (): void => {};
function unreadable(what: string): TerminalError {
  return new TerminalError({ code: "RUNTIME_ERROR", title: `${what} could not be read`,
    cause: `The runner did not confirm the current ${what.toLowerCase()}. Nothing was changed.`, fix: "Check balchemy runner status.", exitCode: 1 });
}

export function createSetupStateReaders(directory: string): SetupStateReaders {
  const read = { args: [] as string[], flags: FLAGS, directory, interactive: false, write: silent };
  return {
    async inspect() {
      const status = await inspectLocalRunner(directory);
      return { process: status.process, agents: status.agents.map((item) => item.agentId) };
    },
    async pairing(agentId) {
      const profile = readLocalProfile(directory);
      if (!profile) return "unpaired";
      const options = { directory, localProfileId: profile.localProfileId, agentId };
      return readPairingAdoption(options) ? "paired" : readPairingApproval(options) ? "awaiting_confirmation" : "unpaired";
    },
    async model(agentId) {
      const response = await readPrivateModelStatus(readPrivateBrainTarget(directory, agentId));
      if (!response.ok || !response.model) throw unreadable("Model state");
      return { ready: response.model.state === "ready", saved: response.vault.saved };
    },
    async wallet(agentId) {
      const result = await runPrivateTradingWalletCommand({ ...read, args: [agentId, "status"] });
      if (result.kind !== "status") return { wallet: "unavailable" as SetupWalletState, binding: "unavailable" as SetupBindingState };
      return { wallet: result.wallet.state as SetupWalletState, binding: (result.binding?.state ?? "unavailable") as SetupBindingState };
    },
    async rpc(agentId) {
      const result = await runPrivateSolanaRpcCommand({ ...read, args: [agentId, "status"] });
      if (result.kind !== "status") throw unreadable("RPC setting");
      return privateSetupRpc(result.status.endpoint?.class ?? null, result.provided?.state ?? null);
    },
    async limits(agentId) {
      const result = await runPrivateSpendLimitsCommand({ ...read, args: [agentId, "limits"] });
      if (result.kind !== "status") throw unreadable("Spend limits");
      return result.limits.perTrade.kind === "unset" || result.limits.daily.kind === "unset" ? "unset" : "set";
    },
    async rules(agentId) {
      const result = await runPrivateRuleCommand({ ...read, args: [agentId, "solana", "status"] });
      const head = result.kind === "status" && typeof result.head === "object" && result.head !== null ? result.head as { state?: unknown } : undefined;
      if (!head || typeof head.state !== "string") throw unreadable("Rules");
      return head.state === "empty" ? "empty" : "present";
    },
    async rulesApproval(agentId) {
      const result = await runPrivateRuleCommand({ ...read, args: [agentId, "solana", "show"] });
      // `show` returns the validated confirmed revision (null when none is confirmed).
      const revision = result.kind === "show" && typeof result.revision === "object" && result.revision !== null ? result.revision as BehaviorRuleRevision : undefined;
      if (!revision) throw unreadable("Rules");
      return privateRuleApproval(revision.compiled, revision.rules) === "automatic_within_limits" ? "automatic" : "required";
    },
    async budget(agentId) {
      const result = await runPrivateModelBudgetCommand({ ...read, args: [agentId] });
      if (result.kind !== "status") throw unreadable("AI budget");
      return result.status.policy.revision > 0 ? "set" : "default";
    },
    async sizing(agentId) {
      const result = await runPrivateSizingCommand({ ...read, args: [agentId] });
      if (result.kind !== "status") throw unreadable("Buy size");
      return result.status.policy ? "set" : "missing";
    },
  };
}
