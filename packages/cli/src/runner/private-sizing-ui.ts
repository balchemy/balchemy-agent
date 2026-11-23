/** Explicit owner sizing confirmation. This never grants trade authority. */
import { randomUUID } from "node:crypto";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { createRulePrompt, operationConfirmation, type RulePrompt } from "./private-rule-commands.js";
import { parsePrivateSolAmount, parsePrivateBuyAmountPolicyInput, privateSizingSlippageUsable, PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS,
  type PrivateSizingStatus } from "./private-sizing.js";
import { privateSizingBinding, requestPrivateSizing, type PrivateSizingTransport } from "./private-sizing-client.js";
import { privateChangeEntriesLines, PRIVATE_CHANGE_UNSAVED_TEXT } from "./private-change-entries.js";
import { parsePrivateSizingRequest, validatePrivateSizingReply, type PrivateSizingChannelError,
  type PrivateSizingData, type PrivateSizingRequest, type PrivateSizingResponse } from "./private-sizing-protocol.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, terminalSocketProofSecret, type SocketProofOutcome,
  type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";

/** `secret` (optional): the hidden prompt of the A2a socket proof (the cockpit card's); the readline CLI prompt has none. */
export type SizingPrompt = Pick<RulePrompt, "closed" | "confirm" | "close" | "secret">;
export interface PrivateSizingCommandOptions {
  args: string[]; directory: string; interactive: boolean;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  write(text: string): void | Promise<void>;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateSizingTransport;
  createPrompt?(): SizingPrompt;
  /** A2a socket proof, asked only on `proof_required` after the typed CONFIRM. Undefined: the prompt's own hidden field (the CLI: a raw-mode
   * prompt once its readline prompt is closed); null: no prompt (the cockpit's lowered path). */
  proofSecret?: SocketProofSecret | null;
  walletTransport?: PrivateTradingWalletTransport;
}
type SizingCommand = { agentId: string; action: "status" }
  | { agentId: string; action: "update"; amountSol: string; amountBaseUnits: string; slippageBps: number };
export type PrivateSizingCommandResult = PrivateSizingData | { kind: "cancelled" }
  | { kind: "dry_run"; command: SizingCommand } | { kind: "outcome_unknown"; operationId: string };
function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid owner sizing command",
    cause: "Use runner sizing <agent>, or supply both --amount-sol <exact decimal> and --slippage-bps <integer>.",
    fix: `Enter a positive SOL amount with at most 9 decimal places and slippage from 1 to ${PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS} bps (a buy never executes above it). `
      + "--yes, --force and --quiet are not supported.", exitCode: 2 });
}
export function parsePrivateSizingArguments(args: string[]): SizingCommand {
  const [agentId] = args; if (!isId(agentId)) invalid();
  if (args.length === 1) return Object.freeze({ agentId, action: "status" });
  if (args.length !== 5) invalid();
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1]!;
    if (!["--amount-sol", "--slippage-bps"].includes(key) || values.has(key)) invalid(); values.set(key, value);
  }
  const slippage = values.get("--slippage-bps");
  if (!slippage || !/^[1-9][0-9]{0,4}$/.test(slippage) || !privateSizingSlippageUsable(Number(slippage))) invalid();
  try {
    const parsed = parsePrivateBuyAmountPolicyInput({ operationId: "preview", expectedRevision: 0, expectedRuleRevisionId: null,
      amountSol: values.get("--amount-sol"), slippageBps: Number(slippage) });
    const amount = parsePrivateSolAmount(parsed.amountSol);
    return Object.freeze({ agentId, action: "update", ...amount, slippageBps: parsed.slippageBps });
  } catch { return invalid(); }
}
function unavailable(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Owner sizing unavailable",
    cause: "The selected runner could not return validated sizing and current rules.",
    fix: "Inspect runner status and read sizing again. No sizing update was sent.", exitCode: 1 });
}
function refused(code: PrivateSizingChannelError, operationId?: string): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Owner sizing not confirmed",
    cause: code === "rule_revision_conflict" ? "The confirmed rules changed during this review." : `The local runner returned ${code}.`,
    fix: `Read current sizing and rules before starting another review. Do not reset private state or resend an unknown update.${operationId ? ` ${PRIVATE_CHANGE_UNSAVED_TEXT}` : ""}`,
    operationId, exitCode: ["invalid_request", "unknown_agent", "profile_conflict", "instance_conflict", "revision_conflict", "rule_revision_conflict", "operation_conflict"].includes(code) ? 2 : 1 });
}
export async function runPrivateSizingCommand(options: PrivateSizingCommandOptions): Promise<PrivateSizingCommandResult> {
  const command = parsePrivateSizingArguments(options.args);
  if (options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.flags.dryRun) return { kind: "dry_run", command };
  if (command.action === "update" && (!options.interactive || options.flags.json || options.flags.ci)) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive sizing confirmation required",
      cause: "A visible terminal and exact owner confirmation are required to save a buy amount.",
      fix: "Run without --json or --ci in a terminal. Read-only runner sizing supports JSON and non-interactive use.", exitCode: 2 });
  }
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(command.agentId)
    : readPrivateBrainTarget(options.directory, command.agentId)) }); }
  catch { throw runnerNotRunningError(command.agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== command.agentId) invalid();
  const transport = options.transport ?? requestPrivateSizing;
  let prompt: SizingPrompt | undefined;
  try {
    if (command.action === "update") prompt = (options.createPrompt ?? createRulePrompt)();
    const read = parsePrivateSizingRequest({ ...privateSizingBinding(target), action: "status" });
    let response: PrivateSizingResponse;
    try { response = validatePrivateSizingReply(read, await transport(target.socketPath, read)); } catch { return unavailable(); }
    if (!response.ok) return refused(response.error);
    if (response.data.kind !== "status") return unavailable();
    if (command.action === "status") return response.data;
    if (!prompt || prompt.closed) return { kind: "cancelled" };
    const status = response.data.status; const operationId = randomUUID();
    const expectedRevision = status.policy?.revision ?? 0;
    // A2a: one operation id for every frame of this save; each frame has a fresh frame id (the proof is added only on proof_required).
    const build = (passphrase?: string): PrivateSizingRequest => parsePrivateSizingRequest({ ...privateSizingBinding(target), action: "update", operationId,
      expectedRevision, expectedRuleRevisionId: status.currentRuleRevisionId, amountSol: command.amountSol, slippageBps: command.slippageBps,
      ...(passphrase !== undefined ? { passphrase } : {}) });
    const update = build();
    const { phrase, alternates } = operationConfirmation(operationId);
    await options.write([`Review owner buy sizing for ${command.agentId}`, "Chain: Solana", `Sizing revision: ${expectedRevision} -> ${expectedRevision + 1}`,
      `Current rules: ${status.currentRuleRevisionId ?? "none confirmed"}`, `Amount: ${command.amountSol} SOL`,
      `Lamports: ${command.amountBaseUnits}`, `Slippage: ${command.slippageBps} bps`,
      "Owner sizing only. No execution, signing or live permission is granted.", `Sizing operation: ${operationId}`,
      `Read current sizing after interruption: balchemy runner sizing ${command.agentId}`,
      `Type exactly ${phrase} to save; any other answer cancels.`, ""].join("\n"));
    if (prompt.closed || !await prompt.confirm(phrase, alternates) || prompt.closed) return { kind: "cancelled" };
    const opened = prompt;
    const own = opened.secret?.bind(opened);
    const secret: SocketProofSecret | null = options.proofSecret !== undefined ? options.proofSecret
      : own ?? (options.createPrompt ? null : terminalSocketProofSecret(true, () => opened.close()));
    let outcome: SocketProofOutcome<PrivateSizingResponse>;
    try {
      outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? update : build(passphrase)),
        send: async (request) => validatePrivateSizingReply(request, await transport(target.socketPath, request)),
        error: (reply) => (reply.ok ? undefined : reply.error), secret, unlock: socketProofUnlock(target, options.walletTransport) });
    } catch { return { kind: "outcome_unknown", operationId }; }
    if (outcome.kind === "cancelled") return { kind: "cancelled" };
    if (outcome.kind !== "response") return socketProofFailure(outcome, command.agentId, "Owner sizing not saved");
    response = outcome.response;
    if (!response.ok) {
      if (["state_unavailable", "cancelled"].includes(response.error)) return { kind: "outcome_unknown", operationId };
      return refused(response.error, operationId);
    }
    return response.data;
  } finally { prompt?.close(); }
}
function statusLines(status: PrivateSizingStatus): string[] {
  const lines = [`Current rules: ${status.currentRuleRevisionId ?? "none confirmed"}`];
  if (!status.policy) return [...lines, "Owner buy amount: not configured.", "No default amount is selected."];
  const policy = status.policy;
  lines.push(`Sizing revision: ${policy.revision}`, `Amount: ${policy.amountSol} SOL`, `Lamports: ${policy.amountBaseUnits}`,
    `Slippage: ${policy.slippageBps} bps`, `Configured against rules: ${policy.configuredAgainstRuleRevisionId ?? "none confirmed"}`);
  if (policy.configuredAgainstRuleRevisionId !== status.currentRuleRevisionId) lines.push("Current rules differ from the rules recorded when sizing was configured.");
  return lines;
}
export function formatPrivateSizingResult(result: PrivateSizingCommandResult, agentId: string): string {
  if (result.kind === "cancelled") return "Sizing cancelled. No update was sent; the daemon remains running.\n";
  if (result.kind === "dry_run") return result.command.action === "status"
    ? "Read-only sizing preview; no connection or changes made.\n"
    : `Sizing preview: ${result.command.amountSol} SOL (${result.command.amountBaseUnits} lamports), ${result.command.slippageBps} bps.\nNo connection, confirmation or change made.\n`;
  if (result.kind === "outcome_unknown") return ["Sizing update outcome unknown.", `Operation: ${result.operationId}`,
    "No update was retried. Current sizing alone does not acknowledge this operation.", `Read current sizing: balchemy runner sizing ${agentId}`,
    PRIVATE_CHANGE_UNSAVED_TEXT, ""].join("\n");
  return [`Owner Solana buy sizing for ${agentId}`, ...(result.kind === "update" ? ["Sizing policy saved.", `Operation: ${result.operationId}`,
    ...privateChangeEntriesLines(result.entries, agentId)] : []),
    ...statusLines(result.status), "Sizing does not grant execution, signing or live permission.", ""].join("\n");
}
