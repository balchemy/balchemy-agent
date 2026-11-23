/** `balchemy runner budget <agent> [--daily-usd N]`: today's spend of the agent's own AI model API cost, the daily limit
 * and its reset time. Lowering the limit applies at once; raising it needs the typed confirmation `BUDGET <agent>` in a
 * visible terminal. Spend is never reset. This grants no trading or model authority. */
import { randomUUID } from "node:crypto";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { createWalletPrompt, guardTerminalSignals, type WalletPrompt } from "./private-trading-keystore-ui.js";
import { isPrivateModelBudgetLimit, type PrivateModelBudgetStatus, type PrivateModelCapturedPrice } from "./private-model-budget.js";
import { formatPrivateModelUsd } from "./private-model-prices.js";
import { privateModelBudgetBinding, requestPrivateModelBudget, type PrivateModelBudgetTransport } from "./private-model-budget-client.js";
import { parsePrivateModelBudgetRequest, validatePrivateModelBudgetReply, type PrivateModelBudgetChannelError,
  type PrivateModelBudgetData, type PrivateModelBudgetRequest, type PrivateModelBudgetResponse } from "./private-model-budget-protocol.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, type SocketProofOutcome, type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";

/** `secret` (optional): the hidden field of the A2a socket proof, asked only on `proof_required` after the typed BUDGET. */
export type BudgetPrompt = Pick<WalletPrompt, "closed" | "line" | "close"> & { secret?: WalletPrompt["secret"] };
export interface PrivateModelBudgetCommandOptions {
  args: string[]; directory: string; interactive: boolean;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  write(text: string): void | Promise<void>;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateModelBudgetTransport;
  createPrompt?(): BudgetPrompt;
  /** Restores the terminal (raw mode) on SIGINT/SIGTERM/SIGHUP; returns an unsubscribe. */
  guardSignals?(cleanup: () => void): () => void;
  /** A2a socket proof. Undefined: the raise's own prompt (a lowering has none, so the daemon's proof_required ends with its plain text);
   * null: no prompt here. */
  proofSecret?: SocketProofSecret | null;
  walletTransport?: PrivateTradingWalletTransport;
}
export type PrivateModelBudgetCommandResult = PrivateModelBudgetData | { kind: "cancelled" }
  | { kind: "dry_run"; action: "status" | "update"; dailyLimitMicroUsd?: number }
  | { kind: "outcome_unknown"; operationId: string };

function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid AI budget command",
    cause: "Use runner budget <agent> [--daily-usd N], with N in US dollars from 0.10 to 1000 (at most two decimals).",
    fix: "Use --json for structured output. Spend resets, --force, --yes and --quiet are not supported.", exitCode: 2 });
}
function unavailable(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "AI budget unavailable",
    cause: "The selected local runner could not return a validated AI budget status.",
    fix: "Check runner status, then read runner budget for the same local agent. No limit update was sent.", exitCode: 1 });
}
function refused(code: PrivateModelBudgetChannelError, operationId?: string): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "AI budget change not saved",
    cause: code === "revision_conflict" ? "The AI budget changed during this review."
      : code === "clock_rollback" ? "This computer's clock is behind the budget's last saved time." : `The local runner returned ${code}.`,
    fix: "Read runner budget for the same agent before deciding on another change. Spend cannot be reset.", operationId,
    exitCode: ["invalid_request", "unknown_agent", "profile_conflict", "instance_conflict", "revision_conflict", "operation_conflict"].includes(code) ? 2 : 1 });
}
/** Exact decimal dollars to integer micro-USD: "5" -> 5_000_000, "0.10" -> 100_000. */
export function parsePrivateModelBudgetUsd(value: string | undefined): number | undefined {
  const match = typeof value === "string" ? /^(0|[1-9][0-9]{0,3})(?:\.([0-9]{1,2}))?$/.exec(value) : null;
  if (!match) return undefined;
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(2, "0")) * 10_000;
  return isPrivateModelBudgetLimit(micro) ? micro : undefined;
}
export function privateModelBudgetConfirmation(agentId: string): string { return `BUDGET ${agentId}`; }
function createBudgetPrompt(): BudgetPrompt {
  const prompt = createWalletPrompt();
  return { get closed() { return prompt.closed; }, line: (label) => prompt.line(label), secret: (label) => prompt.secret(label), close: () => prompt.close() };
}

export async function runPrivateModelBudgetCommand(options: PrivateModelBudgetCommandOptions): Promise<PrivateModelBudgetCommandResult> {
  const [agentId, flag, value] = options.args;
  if (!isId(agentId) || options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  let dailyLimitMicroUsd: number | undefined;
  if (options.args.length !== 1) {
    if (options.args.length !== 3 || flag !== "--daily-usd") invalid();
    dailyLimitMicroUsd = parsePrivateModelBudgetUsd(value);
    if (dailyLimitMicroUsd === undefined) invalid();
  }
  if (options.flags.dryRun) return { kind: "dry_run", action: dailyLimitMicroUsd === undefined ? "status" : "update",
    ...(dailyLimitMicroUsd === undefined ? {} : { dailyLimitMicroUsd }) };
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== agentId) invalid();
  const transport = options.transport ?? requestPrivateModelBudget;
  const read = parsePrivateModelBudgetRequest({ ...privateModelBudgetBinding(target), action: "status" });
  let response: PrivateModelBudgetResponse;
  try { response = validatePrivateModelBudgetReply(read, await transport(target.socketPath, read)); }
  catch { return unavailable(); }
  if (!response.ok) return refused(response.error);
  if (response.data.kind !== "status") return unavailable();
  if (dailyLimitMicroUsd === undefined) return response.data;
  const current = response.data.status;
  const raising = dailyLimitMicroUsd > current.policy.dailyLimitMicroUsd;
  const operationId = randomUUID();
  // A2a: one operation id for every frame of this change; the proof is added only on proof_required (a fresh frame id each time).
  const build = (passphrase?: string): PrivateModelBudgetRequest => parsePrivateModelBudgetRequest({ ...privateModelBudgetBinding(target), action: "update",
    operationId, expectedRevision: current.policy.revision, dailyLimitMicroUsd, ...(passphrase !== undefined ? { passphrase } : {}) });
  const update = build();
  let prompt: BudgetPrompt | undefined; let releaseSignals: (() => void) | undefined;
  try {
    if (raising) {
      if (!options.interactive || options.flags.json || options.flags.ci) {
        throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive AI budget confirmation required",
          cause: "Raising the daily AI budget needs your typed confirmation in a visible terminal.",
          fix: "Run without --json or --ci in a terminal. Lowering the budget and reading it work non-interactively. No update was sent.", exitCode: 2 });
      }
      const opened = (options.createPrompt ?? createBudgetPrompt)(); prompt = opened;
      releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => opened.close());
      const phrase = privateModelBudgetConfirmation(agentId);
      await options.write([`Raise the daily AI budget of ${agentId}`,
        `Daily limit: ${formatPrivateModelUsd(current.policy.dailyLimitMicroUsd)} -> ${formatPrivateModelUsd(dailyLimitMicroUsd)} per UTC day`,
        `Spent today: ${formatPrivateModelUsd(current.spentMicroUsd)}. Today's spend is kept.`,
        "This is the agent's own AI model API cost, billed by your model provider. It grants no trading permission.",
        `Budget operation: ${operationId}`, `Type exactly ${phrase} to save; any other answer cancels.`, ""].join("\n"));
      if (opened.closed) return { kind: "cancelled" };
      const typed = await opened.line("approval> ");
      if (typed !== phrase || opened.closed) return { kind: "cancelled" };
    }
    // A raise asks through its own prompt; a lowering has none (no passphrase prompt on a lowered path).
    const own = prompt?.secret?.bind(prompt);
    const secret: SocketProofSecret | null = options.proofSecret !== undefined ? options.proofSecret : own ?? null;
    let outcome: SocketProofOutcome<PrivateModelBudgetResponse>;
    try {
      outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? update : build(passphrase)),
        send: async (request) => validatePrivateModelBudgetReply(request, await transport(target.socketPath, request)),
        error: (reply) => (reply.ok ? undefined : reply.error), secret, unlock: socketProofUnlock(target, options.walletTransport) });
    } catch { return { kind: "outcome_unknown", operationId }; }
    if (outcome.kind === "cancelled") return { kind: "cancelled" };
    if (outcome.kind !== "response") return socketProofFailure(outcome, agentId, "AI budget change not saved");
    response = outcome.response;
    if (!response.ok) {
      if (response.error === "state_unavailable" || response.error === "closing") return { kind: "outcome_unknown", operationId };
      return refused(response.error, operationId);
    }
    return response.data;
  } finally { prompt?.close(); releaseSignals?.(); }
}

/** Phase 2 (D2): stores the OpenRouter catalog price of the model the owner just chose in the agent's budget record. Undefined when the
 * runner did not confirm it (the budget then keeps the table / highest-price rule for that model; nothing else changes). */
/** A2a: a first capture or a lower price is raising; `proof` answers the daemon's proof_required (the model card's passphrase first, then
 * one hidden prompt). Without it a raising capture is not stored (undefined), exactly as an unconfirmed one. */
export async function savePrivateModelPrice(target: PrivateBrainTarget, price: PrivateModelCapturedPrice,
  transport: PrivateModelBudgetTransport = requestPrivateModelBudget,
  proof: { known?: string; secret?: SocketProofSecret | null; walletTransport?: PrivateTradingWalletTransport } = {}): Promise<PrivateModelBudgetStatus | undefined> {
  try {
    const build = (passphrase?: string): PrivateModelBudgetRequest => parsePrivateModelBudgetRequest({ ...privateModelBudgetBinding(target), action: "price", ...price,
      ...(passphrase !== undefined ? { passphrase } : {}) });
    const first = build();
    const outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? first : build(passphrase)),
      send: async (request) => validatePrivateModelBudgetReply(request, await transport(target.socketPath, request)),
      error: (reply) => (reply.ok ? undefined : reply.error), secret: proof.secret ?? null,
      ...(proof.known !== undefined ? { known: proof.known } : {}), unlock: socketProofUnlock(target, proof.walletTransport) });
    if (outcome.kind !== "response") return undefined;
    const response = outcome.response;
    return response.ok && response.data.kind === "status" ? response.data.status : undefined;
  } catch { return undefined; }
}
/** One line for a captured OpenRouter price. */
export function formatPrivateCapturedPrice(price: PrivateModelCapturedPrice): string {
  return `${price.model}: ${formatPrivateModelUsd(price.inputMicroUsdPerMillion)} per million input tokens, ${formatPrivateModelUsd(price.outputMicroUsdPerMillion)} per million output tokens (OpenRouter catalog)`;
}
function statusLines(status: PrivateModelBudgetStatus): string[] {
  const lines = [`UTC day: ${status.utcDay}`, `Daily limit: ${formatPrivateModelUsd(status.policy.dailyLimitMicroUsd)}`,
    `Spent today: ${formatPrivateModelUsd(status.spentMicroUsd)} (${status.calls} model call${status.calls === 1 ? "" : "s"})`,
    `In progress: ${formatPrivateModelUsd(status.reservedMicroUsd)}`, `Remaining: ${formatPrivateModelUsd(status.remainingMicroUsd)}`,
    `Resets: ${new Date(status.resetAt).toISOString()} (00:00 UTC)`];
  if (status.state === "ready") lines.push("Status: ready.");
  else if (status.reason === "model_budget_exhausted") lines.push("Status: held; today's AI budget is used up. Chat answers with a short note and new autonomous decisions are held until the reset.");
  else lines.push("Status: held; this computer's clock moved backwards. Model calls resume once it passes the last saved time.");
  return lines;
}
export function formatPrivateModelBudgetResult(result: PrivateModelBudgetCommandResult, agentId: string): string {
  if (result.kind === "dry_run") return result.action === "status"
    ? "Read-only AI budget preview; no connection or changes made.\n"
    : `Preview: set the daily AI budget to ${formatPrivateModelUsd(result.dailyLimitMicroUsd ?? 0)}.\nNo connection or changes made. Today's spend would be kept.\n`;
  if (result.kind === "cancelled") return "AI budget change cancelled. No update was sent.\n";
  if (result.kind === "outcome_unknown") return ["AI budget update outcome unknown.", `Operation: ${result.operationId}`,
    "No update was retried. A current status is not an acknowledgement.", `Read the current budget: balchemy runner budget ${agentId}`, ""].join("\n");
  const lines = [`AI model budget for ${agentId}`];
  if (result.kind === "update") lines.push("Daily limit saved. Today's spend is kept.", `Operation: ${result.operationId}`);
  lines.push(...statusLines(result.status),
    `Prices: table of ${result.status.priceTableDate}; a model not in it counts at the highest listed price. OpenRouter calls count at the cost OpenRouter reports.`,
    ...(result.status.modelPrice ? [`Captured price: ${formatPrivateCapturedPrice(result.status.modelPrice)}; it estimates calls of that model before they are made.`] : []),
    "Covers the agent's own AI model API cost: chat and autonomous decisions. Stop-loss and take-profit exits never use the model and keep running.",
    `Change it: balchemy runner budget ${agentId} --daily-usd N (0.10 to 1000; raising asks for confirmation).`);
  return `${lines.join("\n")}\n`;
}
