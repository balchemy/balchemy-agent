/** `balchemy runner signals <agent> [--launchpads pumpfun,...|none]`: the agent's launchpad signal sources (K4). Without the flag it
 * shows the catalog and the subscription; with it, it replaces the subscription with exactly those live launchpads (`none`
 * unsubscribes). Choosing a source needs no wallet signature; a launch is a public observation the agent researches, never a buy. */
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateLaunchpadRequest, privateLaunchpadRequest, requestPrivateLaunchpads, validatePrivateLaunchpadReply, type PrivateLaunchpadChannelError,
  type PrivateLaunchpadRequest, type PrivateLaunchpadResponse, type PrivateLaunchpadTransport } from "./private-launchpad-protocol.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, type SocketProofOutcome, type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";
import type { PrivateLaunchpadView } from "./private-launchpads.js";

export interface PrivateLaunchpadCommandOptions {
  args: string[]; directory: string;
  flags: Pick<CliFlags, "json" | "dryRun">;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateLaunchpadTransport;
  /** A2a socket proof of a set that adds a source, asked only on `proof_required` (the cockpit's secret card, or a raw-mode prompt in the
   * CLI). Absent or null: no prompt, so an added source the daemon refuses ends with its plain text. */
  proofSecret?: SocketProofSecret | null;
  walletTransport?: PrivateTradingWalletTransport;
}
export type PrivateLaunchpadCommand = { agentId: string; action: "status" } | { agentId: string; action: "set"; launchpadIds: string[] };
export type PrivateLaunchpadCommandResult = { kind: "status" | "set"; view: PrivateLaunchpadView } | { kind: "dry_run"; command: PrivateLaunchpadCommand };
function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid launchpad sources command",
    cause: "Use runner signals <agent>, or runner signals <agent> --launchpads <id,id,...> (or --launchpads none to unsubscribe).",
    fix: "Launchpad ids are lowercase (for example pumpfun). Run runner signals <agent> to list them.", exitCode: 2 });
}
export function parsePrivateLaunchpadArguments(args: string[]): PrivateLaunchpadCommand {
  const [agentId] = args; if (!isId(agentId)) invalid();
  if (args.length === 1) return Object.freeze({ agentId, action: "status" });
  if (args.length !== 3 || args[1] !== "--launchpads" || typeof args[2] !== "string") invalid();
  const value = args[2].trim();
  if (value === "none") return Object.freeze({ agentId, action: "set", launchpadIds: [] });
  const ids = value.split(",").map((item) => item.trim());
  if (!ids.length || ids.some((item) => !/^[a-z][a-z0-9_]{1,31}$/.test(item)) || ids.length > 32) invalid();
  // The server compares ids by code unit: plain sort, unique.
  return Object.freeze({ agentId, action: "set", launchpadIds: [...new Set(ids)].sort() });
}
function refused(code: PrivateLaunchpadChannelError): never {
  const cause = code === "launchpad_not_live" ? "That launchpad is coming soon: it cannot be chosen yet."
    : code === "launchpad_unknown" ? "That launchpad is not in Balchemy's catalog."
      : code === "lease_unavailable" ? "The agent has no live connection to Balchemy right now."
        : code === "catalog_unavailable" || code === "subscription_unavailable" ? "Balchemy could not be reached for the launchpad sources."
          : `The local runner returned ${code}.`;
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Launchpad sources not changed", cause,
    fix: "Run runner signals <agent> to see the current sources and the catalog.", exitCode: ["invalid_request", "unknown_agent", "launchpad_unknown",
      "launchpad_not_live", "profile_conflict", "instance_conflict"].includes(code) ? 2 : 1 });
}
export async function runPrivateLaunchpadCommand(options: PrivateLaunchpadCommandOptions): Promise<PrivateLaunchpadCommandResult> {
  const command = parsePrivateLaunchpadArguments(options.args);
  if (options.flags.dryRun) return { kind: "dry_run", command };
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(command.agentId) : readPrivateBrainTarget(options.directory, command.agentId)) }); }
  catch { throw runnerNotRunningError(command.agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== command.agentId) invalid();
  const input = command.action === "set" ? { action: "set" as const, launchpadIds: command.launchpadIds } : { action: "status" as const };
  const transport = options.transport ?? requestPrivateLaunchpads;
  // A2a: the proof is added only on proof_required (a fresh frame id each time).
  const build = (passphrase?: string): PrivateLaunchpadRequest => passphrase === undefined || input.action !== "set" ? privateLaunchpadRequest(target, input)
    : parsePrivateLaunchpadRequest({ ...privateLaunchpadRequest(target, input), passphrase });
  const first = build();
  let response: PrivateLaunchpadResponse;
  let outcome: SocketProofOutcome<PrivateLaunchpadResponse>;
  try {
    outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? first : build(passphrase)),
      send: async (request) => validatePrivateLaunchpadReply(request, await transport(target.socketPath, request)),
      error: (reply) => (reply.ok ? undefined : reply.error), secret: command.action === "set" ? options.proofSecret ?? null : null,
      unlock: socketProofUnlock(target, options.walletTransport) });
  }
  catch {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Launchpad sources unavailable", cause: "The local runner did not answer.",
      fix: command.action === "set" ? "Run runner signals <agent> to see whether the change was saved before trying again." : "Inspect runner status and try again.", exitCode: 1 });
  }
  if (outcome.kind === "cancelled") {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Launchpad sources not changed", cause: "The passphrase prompt was closed. Nothing was changed.",
      fix: "Run runner signals <agent> to see the current sources.", exitCode: 1 });
  }
  if (outcome.kind !== "response") return socketProofFailure(outcome, command.agentId, "Launchpad sources not changed");
  response = outcome.response;
  if (!response.ok) return refused(response.error);
  return { kind: command.action, view: response.view };
}
export function formatPrivateLaunchpadResult(result: PrivateLaunchpadCommandResult, agentId: string): string {
  if (result.kind === "dry_run") return result.command.action === "status" ? "Read-only launchpad preview; no connection made.\n"
    : `Launchpad preview: ${result.command.launchpadIds.length ? result.command.launchpadIds.join(", ") : "none"}. No change made.\n`;
  const lines = [`Launchpad signal sources for ${agentId}`, ...(result.kind === "set" ? ["Saved."] : [])];
  for (const item of result.view.launchpads) {
    lines.push(`  ${item.subscribed ? "[x]" : "[ ]"} ${item.name} (${item.id})${item.status === "coming_soon" ? " - coming soon" : ""}`);
    if (item.status === "coming_soon") lines.push(`      ${item.sourceNote}`);
  }
  lines.push(`Subscription revision ${result.view.revision}${result.view.subscribedIds.length ? "" : " (no launchpad chosen)"}.`,
    "A launch is a public observation: the agent researches the token and your rules decide; it is never a buy by itself.",
    `Change: balchemy runner signals ${agentId} --launchpads <id,id,...> | none`, "");
  return lines.join("\n");
}
