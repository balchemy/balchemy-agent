import { randomUUID } from "node:crypto";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { privateAutonomyBinding, requestPrivateAutonomy, type PrivateAutonomyTransport } from "./private-autonomy-client.js";
import { parsePrivateAutonomyRequest, validatePrivateAutonomyReply, type PrivateAutonomyChannelError,
  type PrivateAutonomyData, type PrivateAutonomyRequest, type PrivateAutonomyResponse } from "./private-autonomy-protocol.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, type SocketProofOutcome, type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";

interface Options {
  args: string[]; directory: string;
  flags: Pick<CliFlags, "yes" | "force" | "dryRun" | "quiet">;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateAutonomyTransport;
  /** A2a socket proof of a higher daily call limit, asked only on `proof_required` (the CLI passes a raw-mode hidden prompt in a real
   * terminal). Absent or null: no prompt, so a raise the daemon refuses ends with its plain text. */
  proofSecret?: SocketProofSecret | null;
  walletTransport?: PrivateTradingWalletTransport;
}
export type PrivateAutonomyCommandResult = PrivateAutonomyData
  | { kind: "dry_run"; action: "status" | "update"; dailyCallLimit?: number }
  | { kind: "outcome_unknown"; operationId: string };
function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid model allowance command",
    cause: "Use runner limits <agent> [--daily-calls N], with a whole number from 1 to 2000.",
    fix: "Use --json for structured output. Counter resets, --force, --yes and --quiet are not supported.", exitCode: 2 });
}
function unavailable(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Model allowance unavailable",
    cause: "The selected local runner could not return a validated status.",
    fix: "Check runner status, then read runner limits for the same local agent. No limit update was sent.", exitCode: 1 });
}
function refused(code: PrivateAutonomyChannelError): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Model allowance request not confirmed",
    cause: `The local runner returned ${code}.`,
    fix: "Read runner limits for the same agent before deciding on another update. Counters cannot be reset.",
    exitCode: ["invalid_request", "unknown_agent", "profile_conflict", "instance_conflict", "revision_conflict", "operation_conflict"].includes(code) ? 2 : 1 });
}
export async function runPrivateAutonomyCommand(options: Options): Promise<PrivateAutonomyCommandResult> {
  const [agentId, flag, value] = options.args;
  if (!isId(agentId) || options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  let dailyCallLimit: number | undefined;
  if (options.args.length !== 1) {
    if (options.args.length !== 3 || flag !== "--daily-calls" || !value || !/^[1-9][0-9]{0,3}$/.test(value)
      || Number(value) > 2000) invalid();
    dailyCallLimit = Number(value);
  }
  if (options.flags.dryRun) return { kind: "dry_run", action: dailyCallLimit === undefined ? "status" : "update",
    ...(dailyCallLimit === undefined ? {} : { dailyCallLimit }) };
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== agentId) invalid();
  const transport = options.transport ?? requestPrivateAutonomy;
  const read = parsePrivateAutonomyRequest({ ...privateAutonomyBinding(target), action: "status" });
  let response: PrivateAutonomyResponse;
  try { response = validatePrivateAutonomyReply(read, await transport(target.socketPath, read)); }
  catch { return unavailable(); }
  if (!response.ok) return refused(response.error);
  if (response.data.kind !== "status") return unavailable();
  if (dailyCallLimit === undefined) return response.data;
  const operationId = randomUUID();
  const expectedRevision = response.data.status.policy.revision;
  // A2a: one operation id for every frame; the proof is added only on proof_required (a fresh frame id each time).
  const build = (passphrase?: string): PrivateAutonomyRequest => parsePrivateAutonomyRequest({ ...privateAutonomyBinding(target), action: "update", operationId,
    expectedRevision, dailyCallLimit, ...(passphrase !== undefined ? { passphrase } : {}) });
  const update = build();
  let outcome: SocketProofOutcome<PrivateAutonomyResponse>;
  try {
    outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? update : build(passphrase)),
      send: async (request) => validatePrivateAutonomyReply(request, await transport(target.socketPath, request)),
      error: (reply) => (reply.ok ? undefined : reply.error), secret: options.proofSecret ?? null, unlock: socketProofUnlock(target, options.walletTransport) });
  } catch { return { kind: "outcome_unknown", operationId }; }
  if (outcome.kind === "cancelled") {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Model allowance not saved", cause: "The passphrase prompt was closed. Nothing was changed.",
      fix: "Run the same command again to save it.", exitCode: 1 });
  }
  if (outcome.kind !== "response") return socketProofFailure(outcome, agentId, "Model allowance not saved");
  response = outcome.response;
  if (!response.ok) return refused(response.error);
  return response.data;
}
export function formatPrivateAutonomyResult(result: PrivateAutonomyCommandResult, agentId: string): string {
  if (result.kind === "dry_run") return result.action === "status"
    ? "Read-only model allowance preview; no connection or changes made.\n"
    : `Preview: set daily calls to ${result.dailyCallLimit}.\nNo connection or changes made. Counters would be preserved.\n`;
  if (result.kind === "outcome_unknown") return ["Daily limit update outcome unknown.", `Operation: ${result.operationId}`,
    "No update was retried. A current status is not an acknowledgement.", `Read current limits: balchemy runner limits ${agentId}`, ""].join("\n");
  const status = result.status;
  const lines = [`Autonomous model calls for ${agentId}`];
  if (result.kind === "update") lines.push("Daily limit saved. Existing usage is preserved.", `Operation: ${result.operationId}`);
  lines.push(`UTC day: ${status.utcDay}`, `Daily limit: ${status.policy.dailyCallLimit}`,
    `Used / reserved: ${status.reservedCalls ?? "unknown"}`, `Remaining: ${status.remainingCalls ?? "unknown"}`);
  if (status.state === "unprepared") lines.push("Status: accounting not initialized.", "Usage is unknown until the runner prepares accounting.");
  else if (status.state === "ready") lines.push("Status: accounting ready.");
  else if (status.reason === "daily_call_limit") lines.push("Status: held; daily call limit reached.");
  else if (status.reason === "legacy_usage_unknown") lines.push("Status: held; earlier usage is unknown.");
  else if (status.reason === "clock_rollback") lines.push("Status: held; local clock moved backwards.");
  else lines.push("Status: held; call accounting unavailable.");
  if (status.legacyHoldUntilMs !== null) {
    const date = new Date(status.legacyHoldUntilMs);
    lines.push(`Earlier-usage hold until: ${Number.isFinite(date.getTime()) ? date.toISOString() : "unavailable"}`);
  }
  lines.push("Per-asset cooldown: 10 minutes (fixed).", "Counters persist across restarts and model changes.",
    "This allowance covers autonomous signal model calls.", "It does not enable trading or change model credentials.");
  return `${lines.join("\n")}\n`;
}
