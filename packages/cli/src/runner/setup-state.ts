/** Read-only setup state of one local agent: the eight setup steps in the owner-approved order (Phase 2, 19 Nov 2026), and whether each
 * one is done. The chat cockpit (owner decision of 16 Nov 2026) uses it as its setup checklist and to choose the next step.
 * Nothing here changes anything. "Done" for every step is not "ready to arm": the arming precheck stays the final word
 * (stop-loss, executable rules, the owner's wallet approval, open trades). */
import type { PrivateSetupRpc } from "./private-setup-context.js";

export type SetupWalletState = "absent" | "held" | "locked" | "unlocked" | "unavailable";
export type SetupBindingState = "bound" | "unbound" | "revoked" | "held" | "unavailable";
/** Read-only state readers; production wiring is setup-state-readers.ts, tests inject fakes. */
export interface SetupStateReaders {
  inspect(agentId: string): Promise<{ process: "running" | "stopped"; agents: readonly string[] }>;
  pairing(agentId: string): Promise<"paired" | "awaiting_confirmation" | "unpaired">;
  model(agentId: string): Promise<{ ready: boolean; saved: boolean | "unavailable" }>;
  wallet(agentId: string): Promise<{ wallet: SetupWalletState; binding: SetupBindingState }>;
  /** Owner decision of 17 Nov 2026: Balchemy provides the connection (`balchemy`, or `waiting` while it is set up); the owner's own
   * endpoint (`own`) is optional. */
  rpc(agentId: string): Promise<PrivateSetupRpc>;
  limits(agentId: string): Promise<"unset" | "set">;
  rules(agentId: string): Promise<"empty" | "present">;
  /** Whether the confirmed rules let the agent trade automatically within the caps (arming refuses otherwise). */
  rulesApproval(agentId: string): Promise<"automatic" | "required">;
  sizing(agentId: string): Promise<"missing" | "set">;
  /** Phase 2: whether the owner set the daily AI budget (the default $5 counts as set once confirmed in setup). Optional: without it the
   * budget row is unknown. */
  budget?(agentId: string): Promise<"default" | "set">;
}

/** Phase 2 order (owner decision of 19 Nov 2026): the model and its daily budget, then the trading wallet BEFORE the one Hub visit (so the
 * Hub page never waits for it), then what the agent does. The Solana connection is Balchemy's and is no setup step (an own RPC is an
 * advanced setting only). Rules come before the buy size (sizing records the rule revision it was set against). */
export const SETUP_STEPS = [
  "Start the runner", "Connect an AI model", "Daily AI budget", "Trading wallet",
  "Link it to your Hub account", "Trading rules", "Spend limits", "Buy size",
] as const;
/** Index of the first step the chat and its cards cover (rules, limits, buy size). */
export const SETUP_CHAT_STEP = 5;
const TOTAL = SETUP_STEPS.length;
/** Owner-approved suggestions (16 Nov 2026). Each is only a default answer; the unchanged typed confirmation of its
 * command still follows. Slippage is not asked in setup (A1, owner decision of 22 Nov 2026): 100 bps (1%) applies and Settings >
 * Advanced changes it. The suggested starter rules are gone (A1): they named "new pairs", which holds every buy; the setup card shows
 * example directives instead (cockpit-setup.ts SETUP_EXAMPLE_DIRECTIVES). */
export const SETUP_DEFAULTS = Object.freeze({
  perTrade: "0.1", daily: "0.5", amountSol: "0.05", slippageBps: "100",
});
export type SetupStepState = "done" | "todo" | "unknown";

/** The state of every step, in order. A reader that fails gives `unknown`; while the runner is not running every later
 * step is `unknown`. */
export async function readSetupChecklist(agentId: string, readers: SetupStateReaders): Promise<SetupStepState[]> {
  const read = async (check: () => Promise<boolean>): Promise<SetupStepState> => {
    try { return await check() ? "done" : "todo"; } catch { return "unknown"; }
  };
  const runner = await read(async () => { const state = await readers.inspect(agentId); return state.process === "running" && state.agents.includes(agentId); });
  if (runner !== "done") return [runner, ...SETUP_STEPS.slice(1).map((): SetupStepState => "unknown")];
  const budget = readers.budget;
  return [runner,
    await read(async () => (await readers.model(agentId)).ready),
    budget ? await read(async () => await budget(agentId) === "set") : "unknown",
    await read(async () => (await readers.wallet(agentId)).wallet === "unlocked"),
    await read(async () => await readers.pairing(agentId) === "paired" && (await readers.wallet(agentId)).binding === "bound"),
    await read(async () => await readers.rules(agentId) === "present" && await readers.rulesApproval(agentId) === "automatic"),
    await read(async () => await readers.limits(agentId) === "set"),
    await read(async () => await readers.sizing(agentId) === "set")];
}

export function formatSetupChecklist(agentId: string, states: readonly SetupStepState[]): string {
  const mark = { done: "✓", todo: "·", unknown: "?" } as const;
  return [`Setup checklist for ${agentId} (the ${TOTAL} setup steps; arming re-checks everything itself):`,
    ...SETUP_STEPS.map((title, index) => `  ${mark[states[index] ?? "unknown"]} ${index + 1}. ${title}`), ""].join("\n");
}
