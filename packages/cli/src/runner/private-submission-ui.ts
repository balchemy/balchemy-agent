/** `balchemy runner trades <agent>`: read-only readback of the local submission journal (state, public transaction
 * signature, validated amounts, timestamps). Never prints wire bytes, keys, proofs or RPC URLs, and changes nothing.
 * `balchemy runner wallet <agent> acknowledge-copy`: the owner's typed acknowledgement (real terminal only) of a trade that
 * landed under a signature this runner never made; it only lifts the hold on new autonomous submissions for that wallet.
 * `balchemy runner trades <agent> close <attempt>` (owner decision 26): the owner's typed close-out (real terminal only) of one trade
 * the bot holds for review (a runner dispute or a released trade, and, owner decision 44, a buy Balchemy has left unresolved for 30
 * minutes). The daemon proves on the owner's own RPC that it can no longer land, then closes it: a buy's spend stays counted and its
 * coin is never managed automatically; a sell's position stays held until a sale is proven. Nothing is signed or sent.
 * Owner decision 45: a `runner:ledger:` buy dispute (its spend record is missing or was already released, or it was already counted) stays held; the readback
 * explains it and points to the documented support step (runner docs, "A held trade with a spend-record error"). */
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId, RUNNER_BUY_CHECK_COUNTED, RUNNER_BUY_CHECK_PERMANENT_COUNT, runnerLandingReleaseRetry, type RunnerBuyCheckReason, type RunnerLandingReleaseReason,
  type RunnerTradeCloseRefusal } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError, runnerUpgradeHint } from "./not-running.js";
import { PRIVATE_EXECUTION_CAPABILITIES } from "./private-execution-gate.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS, PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON, PRIVATE_SELL_ENGINE_UNRESOLVED_LANDED_REASON,
  PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON, PRIVATE_SUBMISSION_LANDING_ENGINE_STATES, type PrivateSubmissionReadback,
  type PrivateSubmissionView } from "./private-submission-journal.js";
import { createWalletPrompt, guardTerminalSignals, type WalletPrompt } from "./private-trading-keystore-ui.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, type SocketProofOutcome, type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";
import { parsePrivateSubmissionRequest, privateSubmissionBinding, privateSubmissionEngineUnresolvedSellView, privateSubmissionStalledBuyClosableView, privateSubmissionUnreleasedStalledBuyView, privateSubmissionUnrelayedSellView,
  privateTradeClosePhrase, requestPrivateSubmissions, validatePrivateSubmissionReply, type PrivateSubmissionRequest, type PrivateSubmissionResponse,
  type PrivateSubmissionTransport } from "./private-submission-protocol.js";

export interface PrivateSubmissionCommandOptions {
  args: string[]; directory: string;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateSubmissionTransport;
}
export type PrivateSubmissionCommandResult = ({ kind: "list" } & PrivateSubmissionReadback) | { kind: "dry_run"; agentId: string };

function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid local trades command", cause: "Use runner trades <agent>.",
    fix: "Pass one local agent label. --yes, --force and --quiet are not supported; the readback changes nothing.", exitCode: 2 });
}
function unavailable(cause: string, upgrade?: readonly string[]): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Local trades unavailable", cause,
    fix: `Inspect runner status and read again.${upgrade ? ` ${runnerUpgradeHint(upgrade)}` : ""} ` + "Do not edit or reset the private journal; unfinished trades stay held until Balchemy proves an outcome.", exitCode: 1 });
}
export async function runPrivateSubmissionCommand(options: PrivateSubmissionCommandOptions): Promise<PrivateSubmissionCommandResult> {
  const [agentId] = options.args;
  if (options.args.length !== 1 || !isId(agentId) || options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.flags.dryRun) return { kind: "dry_run", agentId };
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== agentId) invalid();
  const request = parsePrivateSubmissionRequest({ ...privateSubmissionBinding(target), action: "list" });
  let response: PrivateSubmissionResponse;
  try { response = validatePrivateSubmissionReply(request, await (options.transport ?? requestPrivateSubmissions)(target.socketPath, request)); }
  catch { return unavailable("The selected runner could not return a validated trade journal.", knownRunnerAgents(options.directory)); }
  if (!response.ok && response.error === "unknown_agent") {
    const known = knownRunnerAgents(options.directory);
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Unknown agent", cause: `The running runner has no agent named ${agentId}.`,
      fix: known.length ? `Known agents: ${known.join(", ")}. Check the name and try again.` : "Check the name with balchemy runner status.", exitCode: 2 });
  }
  if (!response.ok) return unavailable(`The local runner returned ${response.error}.`);
  return { kind: "list", ...response.data };
}

export const ACKNOWLEDGE_COPY_ACTION = "acknowledge-copy";
export interface PrivateCopyAcknowledgementOptions extends PrivateSubmissionCommandOptions {
  interactive: boolean; write(text: string): void | Promise<void>; createPrompt?(): WalletPrompt;
  guardSignals?(cleanup: () => void): () => void;
  /** The CLI's clock for the close-out offer of a buy Balchemy left unresolved (owner decision 44); defaults to Date.now. */
  now?(): number;
  /** A2a socket proof (acknowledge_copy and close are raising), asked only on `proof_required` after the typed phrase. Undefined: the
   * prompt's own hidden field; null: no prompt here. */
  proofSecret?: SocketProofSecret | null;
  walletTransport?: PrivateTradingWalletTransport;
}
/** A2a: one owner change of this module through the socket proof. A lost reply (`unknown`) is thrown and never resent. */
async function provenSubmissionChange(options: PrivateCopyAcknowledgementOptions, target: PrivateBrainTarget, prompt: WalletPrompt,
  build: (passphrase?: string) => PrivateSubmissionRequest,
  exchange: (request: PrivateSubmissionRequest) => Promise<PrivateSubmissionResponse | "unknown">): Promise<SocketProofOutcome<PrivateSubmissionResponse> | "unknown"> {
  const first = build();
  try {
    return await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? first : build(passphrase)),
      send: async (request) => { const reply = await exchange(request); if (reply === "unknown") throw new Error("Local runner unavailable"); return reply; },
      error: (reply) => (reply.ok ? undefined : reply.error),
      secret: options.proofSecret !== undefined ? options.proofSecret : (label) => prompt.secret(label), unlock: socketProofUnlock(target, options.walletTransport) });
  } catch { return "unknown"; }
}
export type PrivateCopyAcknowledgementResult = { kind: "dry_run"; agentId: string } | { kind: "no_copy"; agentId: string }
  | { kind: "cancelled"; agentId: string; reason: "input_closed" | "acknowledgement_not_confirmed" }
  | { kind: "acknowledged"; agentId: string; acknowledged: number }
  /** The acknowledgement may or may not have been written; read `runner trades` before anything else. */
  | { kind: "outcome_unknown"; agentId: string };

/** Security warning shown wherever an unacknowledged observed copy is reported. */
export const RESIGNED_COPY_WARNING = "SECURITY WARNING: a transaction with your key was signed outside Balchemy.";
/** D13 (M3.6 drills): the tokens of a bought copy open no position, so the runner never sells them automatically. */
export const COPY_NO_STOP_LOSS_TEXT = "If the copy was a buy, its tokens open no position, so they have no stop-loss or take-profit, also after you acknowledge it: close or watch them by hand.";
function copyLines(agentId: string, held: readonly PrivateSubmissionView[]): string[] {
  return [RESIGNED_COPY_WARNING,
    "Balchemy never re-signs. The same swap landed under a signature this runner did not make, so this wallet's key was used elsewhere.",
    ...held.map((item) => `  ${item.attemptKey}: relayed ${item.signature}, landed as ${item.observedSignature ?? ""} (${item.state.replace(/_/g, " ")})`),
    "New autonomous trades for this wallet are held. If you did not sign it, move the funds and replace this wallet before continuing.",
    `Acknowledge only after review: balchemy runner wallet ${agentId} ${ACKNOWLEDGE_COPY_ACTION}`];
}

export async function runPrivateCopyAcknowledgement(options: PrivateCopyAcknowledgementOptions): Promise<PrivateCopyAcknowledgementResult> {
  const [agentId, action] = options.args;
  if (options.args.length !== 2 || !isId(agentId) || action !== ACKNOWLEDGE_COPY_ACTION || options.flags.yes || options.flags.force || options.flags.quiet) {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid copy acknowledgement command", cause: `Use runner wallet <agent> ${ACKNOWLEDGE_COPY_ACTION}.`,
      fix: "Pass one local agent label. --yes, --force and --quiet are not supported; the acknowledgement needs a typed confirmation.", exitCode: 2 });
  }
  if (options.flags.dryRun) return { kind: "dry_run", agentId };
  if (!options.interactive || options.flags.json || options.flags.ci) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive wallet terminal required",
      cause: "Acknowledging a transaction signed outside Balchemy requires a real terminal and a typed confirmation.",
      fix: "Run without --json or --ci in a terminal. runner trades shows the warning without changing anything.", exitCode: 2 });
  }
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== agentId) invalid();
  const transport = options.transport ?? requestPrivateSubmissions;
  const exchange = async (request: PrivateSubmissionRequest): Promise<PrivateSubmissionResponse | "unknown"> => {
    try { return validatePrivateSubmissionReply(request, await transport(target.socketPath, request)); }
    catch { return request.action === "list" ? unavailable("The selected runner could not return a validated trade journal.", knownRunnerAgents(options.directory)) : "unknown"; }
  };
  const before = await exchange(parsePrivateSubmissionRequest({ ...privateSubmissionBinding(target), action: "list" }));
  if (before === "unknown") return unavailable("The selected runner could not return a validated trade journal.", knownRunnerAgents(options.directory));
  if (!before.ok) return unavailable(`The local runner returned ${before.error}.`);
  const held = before.data.attempts.filter((item) => item.securityHold);
  if (!held.length) return { kind: "no_copy", agentId };
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  const releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => prompt.close());
  try {
    const phrase = `ACKNOWLEDGE COPY ${agentId}`;
    await options.write([...copyLines(agentId, held),
      "Acknowledging records that you reviewed it and lifts the hold. It changes no trade, ledger entry, key or Balchemy record.",
      COPY_NO_STOP_LOSS_TEXT,
      `Type exactly ${phrase} to continue; any other answer cancels.`, ""].join("\n"));
    const answer = await prompt.line("acknowledge> ");
    if (answer === null || prompt.closed) return { kind: "cancelled", agentId, reason: "input_closed" };
    if (answer !== phrase) return { kind: "cancelled", agentId, reason: "acknowledgement_not_confirmed" };
    const outcome = await provenSubmissionChange(options, target, prompt, (passphrase) => parsePrivateSubmissionRequest({ ...privateSubmissionBinding(target),
      action: "acknowledge_copy", ...(passphrase !== undefined ? { passphrase } : {}) }), exchange);
    if (outcome === "unknown") return { kind: "outcome_unknown", agentId };
    if (outcome.kind === "cancelled") return { kind: "cancelled", agentId, reason: "input_closed" };
    if (outcome.kind !== "response") return socketProofFailure(outcome, agentId, "Copy not acknowledged");
    const after = outcome.response;
    if (!after.ok) return { kind: "outcome_unknown", agentId };
    if (after.data.attempts.some((item) => item.securityHold)) return { kind: "outcome_unknown", agentId };
    return { kind: "acknowledged", agentId, acknowledged: held.length };
  } finally { releaseSignals(); prompt.close(); }
}
export function formatPrivateCopyAcknowledgementResult(result: PrivateCopyAcknowledgementResult): string {
  if (result.kind === "dry_run") return `Copy acknowledgement preview for ${result.agentId}. No connection, prompt or change made.\n`;
  if (result.kind === "no_copy") return `No unacknowledged transaction signed outside Balchemy for ${result.agentId}. Nothing changed.\n`;
  if (result.kind === "cancelled") return `Copy acknowledgement cancelled (${result.reason.replace(/_/g, " ")}). The wallet stays held.\n`;
  if (result.kind === "outcome_unknown") return [`Copy acknowledgement outcome unknown for ${result.agentId}. Nothing was retried.`,
    `Read the journal before anything else: balchemy runner trades ${result.agentId}`, ""].join("\n");
  return [`Acknowledged ${result.acknowledged} transaction${result.acknowledged === 1 ? "" : "s"} signed outside Balchemy for ${result.agentId}.`,
    "The hold on new autonomous trades for this wallet is lifted. Trade history and the spend ledger are unchanged.", ""].join("\n");
}

export const CLOSE_TRADE_ACTION = "close";
const ATTEMPT_KEY = /^att:[0-9a-f]{32}$/;
export type PrivateTradeCloseResult = { kind: "dry_run"; agentId: string; attemptKey: string }
  | { kind: "not_closable"; agentId: string; attemptKey: string; reason: "not_listed" | "not_closable" | "copy_unacknowledged" }
  /** Owner decision 44: a buy Balchemy left unresolved can be closed out only from `closableAt` (30 minutes after it was signed). */
  | { kind: "not_closable"; agentId: string; attemptKey: string; reason: "too_early"; closableAt: number }
  | { kind: "cancelled"; agentId: string; attemptKey: string; reason: "input_closed" | "close_not_confirmed" }
  /** `othersHeld`: the daemon's readback after the close-out still lists another unresolved trade (or is truncated), so arming
   * stays refused (submission_unresolved). */
  | { kind: "closed"; agentId: string; attemptKey: string; finalizedSlot: string; direction: "buy" | "sell"; othersHeld: boolean }
  | { kind: "refused"; agentId: string; attemptKey: string; reason: RunnerTradeCloseRefusal }
  /** The close-out may or may not have been written; read `runner trades` before anything else. */
  | { kind: "outcome_unknown"; agentId: string; attemptKey: string };
/** Owner decision 26: a view the owner may close out (the journal's privateSubmissionOwnerClosable on the view's fields: runner disputes
 * are always relay-closed). Owner decision 44: with `nowMs`, also a buy Balchemy left unresolved that the runner has not released,
 * once it is 30 minutes old; without `nowMs` that case is not offered. */
export function privateTradeClosableView(item: PrivateSubmissionView, nowMs?: number): boolean {
  const terminal = item.state === "completed" || item.state === "failed_onchain" || item.state === "expired_not_landed" || item.state === "closed_by_owner";
  return !terminal && !item.securityHold && ((item.state === "disputed" && (item.reason ?? "").startsWith("runner:")) || item.released === true
    || (nowMs !== undefined && privateSubmissionStalledBuyClosableView(item, nowMs)));
}
/** Owner decision 45: the plain-language name of the documented support step (runner docs) for a held trade whose spend record is wrong. */
export const SPEND_RECORD_SUPPORT_STEP = "runner docs: \"A held trade with a spend-record error\"";
/** Owner decision 45: a buy dispute whose spend record does not fit and that the daemon always refuses to close out: spend_released for
 * `runner:ledger:reservation_released`, spend_missing for `reservation_missing` and any other unknown `runner:ledger:` reason. Only
 * `reservation_committed` (the spend is already counted) can be closed out. Null when this view is not such a hold. */
function spendRecordHold(item: PrivateSubmissionView): "spend_missing" | "spend_released" | null {
  const reason = item.reason ?? "";
  if (item.direction !== "buy" || item.state !== "disputed" || !reason.startsWith("runner:ledger:") || reason === "runner:ledger:reservation_committed") return null;
  return reason === "runner:ledger:reservation_released" ? "spend_released" : "spend_missing";
}
const CLOSE_REFUSAL: Readonly<Record<RunnerTradeCloseRefusal, string>> = Object.freeze({
  confirmation_mismatch: "the typed confirmation did not match", attempt_missing: "the trade is not in this agent's journal",
  terminal: "the trade is already final (or already closed out)", copy_unacknowledged: "a transaction signed outside Balchemy is unacknowledged; acknowledge it first",
  not_closable: "only a trade the bot holds for review (a runner dispute, a released trade, or a buy Balchemy has left unresolved for 30 minutes) can be closed out",
  runtime_not_idle: "the bot is stopped (halted) or its state is unreadable; resume it first", rpc_not_owned: "the Solana RPC is not your own; set your own RPC first",
  rpc_missing: "no Solana RPC of your own is configured", rpc_unavailable: "your RPC did not answer; try again",
  wire_blockhash_mismatch: "the stored bytes do not match their blockhash; it can never be proven", expiry_unproven: "your RPC does not yet prove that it can no longer land; try again later",
  proof_regressed: "your RPC answered inconsistently; try again", attempt_changed: "the trade changed during the check; review it again",
  spend_missing: `its spend record is missing, so the bot cannot count it (a rare internal error: stopping is safer than counting the spend wrong); Balchemy support resolves it with you by hand (${SPEND_RECORD_SUPPORT_STEP})`,
  spend_released: `its spend was already released, so the bot cannot count it again (a rare internal error: stopping is safer than counting the spend wrong); Balchemy support resolves it with you by hand (${SPEND_RECORD_SUPPORT_STEP})`,
  mint_unavailable: "the coin could not be kept off automatic management", position_unavailable: "its position could not be read or kept held",
  state_unavailable: "local state unavailable; try again", journal_unavailable: "the journal write failed; read runner trades before anything else",
  partly_applied: "it was partly applied (the coin may now be kept off automatic management and its spend may be counted) and then stopped; run the same close again to finish it",
  busy: "the bot is checking this agent's trades right now; try again", closing: "the runner is shutting down" });

export async function runPrivateTradeClose(options: PrivateCopyAcknowledgementOptions): Promise<PrivateTradeCloseResult> {
  const [agentId, action, attemptKey] = options.args;
  if (options.args.length !== 3 || !isId(agentId) || action !== CLOSE_TRADE_ACTION || typeof attemptKey !== "string" || !ATTEMPT_KEY.test(attemptKey)
    || options.flags.yes || options.flags.force || options.flags.quiet) {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid trade close-out command", cause: `Use runner trades <agent> ${CLOSE_TRADE_ACTION} <attempt>.`,
      fix: "Pass one local agent label and one attempt key from runner trades. --yes, --force and --quiet are not supported; closing needs a typed confirmation.", exitCode: 2 });
  }
  if (options.flags.dryRun) return { kind: "dry_run", agentId, attemptKey };
  if (!options.interactive || options.flags.json || options.flags.ci) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive terminal required",
      cause: "Closing out a held trade requires a real terminal and a typed confirmation.",
      fix: "Run without --json or --ci in a terminal. runner trades shows held trades without changing anything.", exitCode: 2 });
  }
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== agentId) invalid();
  const transport = options.transport ?? requestPrivateSubmissions;
  const exchange = async (request: PrivateSubmissionRequest): Promise<PrivateSubmissionResponse | "unknown"> => {
    try { return validatePrivateSubmissionReply(request, await transport(target.socketPath, request)); } catch { return "unknown"; }
  };
  const before = await exchange(parsePrivateSubmissionRequest({ ...privateSubmissionBinding(target), action: "list" }));
  if (before === "unknown") return unavailable("The selected runner could not return a validated trade journal.", knownRunnerAgents(options.directory));
  if (!before.ok) return unavailable(`The local runner returned ${before.error}.`);
  // Closable trades are pinned at the top of the bounded readback, so a closable trade is always listed.
  const item = before.data.attempts.find((entry) => entry.attemptKey === attemptKey);
  if (!item) return { kind: "not_closable", agentId, attemptKey, reason: "not_listed" };
  if (item.securityHold) return { kind: "not_closable", agentId, attemptKey, reason: "copy_unacknowledged" };
  const now = (options.now ?? Date.now)();
  if (!privateTradeClosableView(item, now)) {
    // Owner decision 44: a buy Balchemy left unresolved becomes closable 30 minutes after it was signed (Balchemy may resolve it first).
    if (item.direction === "buy" && privateSubmissionUnreleasedStalledBuyView(item)) {
      return { kind: "not_closable", agentId, attemptKey, reason: "too_early", closableAt: item.createdAt + PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS };
    }
    return { kind: "not_closable", agentId, attemptKey, reason: "not_closable" };
  }
  // Owner decision 45: no prompt for a trade the daemon always refuses; the refusal names the support step. Nothing is sent.
  const spendHold = spendRecordHold(item);
  if (spendHold) return { kind: "refused", agentId, attemptKey, reason: spendHold };
  // Owner decision 44: an unresolved buy Balchemy may still have seen land before it expired.
  const unresolvedBuy = item.direction === "buy" && privateSubmissionStalledBuyClosableView(item, now);
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  const releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => prompt.close());
  try {
    const phrase = privateTradeClosePhrase(attemptKey);
    await options.write([`Close out ${attemptKey} (${privateSubmissionStateLabel(item)}${item.reason ? `; ${item.reason}` : ""}).`,
      amounts(item), `  Signature: ${item.signature}`,
      item.released === true
        ? "The bot reuses the proof it made on your own Solana RPC when it released this trade (it can no longer land); nothing is read again. Its outcome stays unknown: it is never treated as not landed or not sold."
        : "The bot first proves again on your own Solana RPC that this trade can no longer land. Its outcome stays unknown: it is never treated as not landed or not sold.",
      ...(unresolvedBuy ? ["The bot has had no final answer from Balchemy about this buy for more than 30 minutes (Balchemy may still have a record the runner could not read). If it landed before it expired, its coins are in your trading wallet, but the bot will never manage them; you decide what to do with them."] : []),
      item.direction === "buy"
        ? `Closing keeps its spend counted against your caps and keeps this coin off automatic management for good.${EXITS_AVAILABLE
          ? " If nothing else is held, this trade no longer keeps the bot from being armed; new buys and stop-losses run only while it is armed, this computer is on, the runner is running and the wallet is unlocked." : ""}`
        : `Closing keeps its position held until a sale is proven, so this coin stays out of automatic sells and new buys stay held while it is.${EXITS_AVAILABLE
          ? " Other coins' stop-losses run only while the bot is armed, this computer is on, the runner is running and the wallet is unlocked." : ""}`,
      "Nothing is signed, sent, sold or refunded by this command, and Balchemy's record is not changed.",
      `Type exactly ${phrase} to continue; any other answer cancels.`, ""].join("\n"));
    const answer = await prompt.line("close> ");
    if (answer === null || prompt.closed) return { kind: "cancelled", agentId, attemptKey, reason: "input_closed" };
    if (answer !== phrase) return { kind: "cancelled", agentId, attemptKey, reason: "close_not_confirmed" };
    const outcome = await provenSubmissionChange(options, target, prompt, (passphrase) => parsePrivateSubmissionRequest({ ...privateSubmissionBinding(target),
      action: "close", attemptKey, confirmation: answer, ...(passphrase !== undefined ? { passphrase } : {}) }), exchange);
    if (outcome === "unknown") return { kind: "outcome_unknown", agentId, attemptKey };
    if (outcome.kind === "cancelled") return { kind: "cancelled", agentId, attemptKey, reason: "input_closed" };
    if (outcome.kind !== "response") return socketProofFailure(outcome, agentId, "Trade not closed out");
    const after = outcome.response;
    if (!after.ok || !after.data.closeOut) return { kind: "outcome_unknown", agentId, attemptKey };
    const result = after.data.closeOut;
    if (result.outcome === "closed") {
      const others = after.data.total > after.data.attempts.length || after.data.attempts.some((entry) => entry.attemptKey !== attemptKey
        && entry.state !== "completed" && entry.state !== "failed_onchain" && entry.state !== "expired_not_landed" && entry.state !== "closed_by_owner");
      return { kind: "closed", agentId, attemptKey, finalizedSlot: result.finalizedSlot, direction: item.direction, othersHeld: others };
    }
    // A journal write that failed may or may not have been committed.
    if (result.reason === "journal_unavailable") return { kind: "outcome_unknown", agentId, attemptKey };
    return { kind: "refused", agentId, attemptKey, reason: result.reason };
  } finally { releaseSignals(); prompt.close(); }
}
export function formatPrivateTradeCloseResult(result: PrivateTradeCloseResult, exitsAvailable: boolean = EXITS_AVAILABLE): string {
  if (result.kind === "dry_run") return `Trade close-out preview for ${result.attemptKey}. No connection, prompt or change made.\n`;
  if (result.kind === "not_closable") {
    if (result.reason === "too_early") {
      return [`Trade ${result.attemptKey} cannot be closed out yet: Balchemy may still resolve this buy. It can be closed out from ${new Date(result.closableAt).toISOString()} (30 minutes after it was signed). Nothing changed.`,
        `Read it again then: balchemy runner trades ${result.agentId}`, ""].join("\n");
    }
    const why = result.reason === "not_listed" ? "it is not among the trades the bot holds for review" : result.reason === "copy_unacknowledged"
      ? CLOSE_REFUSAL.copy_unacknowledged : CLOSE_REFUSAL.not_closable;
    return `Trade ${result.attemptKey} cannot be closed out: ${why}. Nothing changed.\n`;
  }
  if (result.kind === "cancelled") return `Trade close-out cancelled (${result.reason.replace(/_/g, " ")}). The trade stays held.\n`;
  if (result.kind === "outcome_unknown") return [`Trade close-out outcome unknown for ${result.attemptKey}. Nothing was retried.`,
    `Read the journal before anything else: balchemy runner trades ${result.agentId}`, ""].join("\n");
  if (result.kind === "refused") {
    // A write failure may have left a more conservative, idempotent write behind (protocol.ts RUNNER_TRADE_CLOSE_REFUSALS).
    const tail = result.reason === "partly_applied" ? "It stays held." : result.reason === "mint_unavailable" || result.reason === "position_unavailable"
      ? "It stays held; try again." : "Nothing changed; it stays held.";
    return `Trade ${result.attemptKey} was not closed out: ${CLOSE_REFUSAL[result.reason]}. ${tail}\n`;
  }
  return [`Closed out ${result.attemptKey}: it can no longer land after finalized slot ${result.finalizedSlot}.`,
    result.direction === "buy" ? "Its spend stays counted and its coin is not managed automatically." : "Its position stays held until a sale is proven; new buys stay held while it is.",
    // Arming is mentioned only in a build with automatic exits; without them every arm is refused anyway.
    result.othersHeld
      ? exitsAvailable ? `Other trades of this agent are still unresolved, so arming stays refused until they settle or are closed out: balchemy runner trades ${result.agentId}`
        : `Other trades of this agent are still unresolved: balchemy runner trades ${result.agentId}`
      : exitsAvailable ? `If nothing else is held, the bot can be armed again: balchemy runner arm ${result.agentId}`
        : "No other trade of this agent is unresolved.", ""].join("\n");
}

/** A buy's terminal negative label says "spend released": after SF2 a buy reaches failed_onchain | expired_not_landed only after
 * the runner proved on its own RPC that it did not land and released the spend (R4). */
const HELD: Readonly<Record<PrivateSubmissionView["state"], string>> = Object.freeze({
  signed: "signed locally; relay not confirmed (held)", submitted_known: "relayed; landing not yet proven (held)",
  submitted_unknown: "relay outcome unknown (held)", facts_pending: "finalized; fill facts pending (held)",
  disputed: "disputed; held for review", completed: "completed (spend committed)", failed_onchain: "failed on-chain (spend released)",
  expired_not_landed: "expired without landing (spend released)",
  closed_by_owner: "closed out by you; outcome unknown (spend counted; coin not managed automatically)" });
/** S5c exit sells settle a position, never the spend ledger. A sell's failed or expired state is Balchemy's report (or the runner's
 * own terminal write): the position's exit is cleared only once the runner proves it from its own RPC (the settlement pass), and
 * until then the position may be held awaiting that proof, so these labels claim nothing about the exit or the position. */
const SELL_HELD: Readonly<Record<PrivateSubmissionView["state"], string>> = Object.freeze({ ...HELD,
  completed: "completed (position settles from its finalized sale)",
  failed_onchain: "Balchemy reports failed on-chain; the position settles only from your own RPC's proof (see runner positions)",
  expired_not_landed: "Balchemy reports expired without landing; the position settles only from your own RPC's proof (see runner positions)",
  closed_by_owner: "closed out by you; outcome unknown (position held until a sale is proven)" });
/** Final audit SF2: the journal reason of a sell the runner ended at its expiry bound (private-submission.ts
 * PRIVATE_SELL_EXPIRY_UNPROVEN_REASON; kept as a literal so this readback module does not load the submission service). */
export const SELL_EXPIRY_UNPROVEN_REASON = "s5c:expiry_unproven";
/** M3.6 slice 7 (B1): the journal reason of a sell Balchemy never received that the runner proved did not land on its own RPC
 * (private-submission.ts PRIVATE_SELL_NOT_LANDED_REASON; a literal for the same reason, tied to its source by a test). The one
 * runner-proven case: its label may say the exit is cleared. */
export const SELL_NOT_LANDED_REASON = "s5c:not_landed_proven";
const SELL_NOT_LANDED_LABEL = "expired without landing, proven on your own RPC (exit cleared; position kept)";
/** Final audit SF2: such a sell's bytes cannot land after its F, but whether it landed earlier is unproven and the exit is not cleared
 * (the position is held runner:sell_expiry_unproven), so neither claim of the expired_not_landed label holds. */
const SELL_EXPIRY_UNPROVEN_LABEL = "expiry not proven (blockhash dead; landing unproven); the position is held, see runner positions";
/** Final audit part 3 SF-A: the runner's own terminal writes of a sell Balchemy relayed and left unresolved. */
const SELL_ENGINE_UNRESOLVED_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON]: "did not land, proven on your own RPC while Balchemy left it unresolved (exit cleared; position kept)",
  [PRIVATE_SELL_ENGINE_UNRESOLVED_LANDED_REASON]: "landed, shown finalized on your own RPC while Balchemy left it unresolved (the position settles from that transaction)",
  [PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON]: "failed on-chain, shown finalized on your own RPC while Balchemy left it unresolved (exit cleared; position kept)" });
/** The state label of `runner trades` and the close-out prompt (exported for its tests). */
export function privateSubmissionStateLabel(item: Pick<PrivateSubmissionView, "direction" | "state" | "reason">): string {
  if (item.direction !== "sell") return HELD[item.state];
  const unresolved = item.reason !== null && Object.hasOwn(SELL_ENGINE_UNRESOLVED_LABELS, item.reason) ? SELL_ENGINE_UNRESOLVED_LABELS[item.reason] : undefined;
  if (unresolved !== undefined && (item.state === "completed" || item.state === "failed_onchain" || item.state === "expired_not_landed")) return unresolved;
  if (item.state === "expired_not_landed" && item.reason === SELL_EXPIRY_UNPROVEN_REASON) return SELL_EXPIRY_UNPROVEN_LABEL;
  if (item.state === "expired_not_landed" && item.reason === SELL_NOT_LANDED_REASON) return SELL_NOT_LANDED_LABEL;
  return SELL_HELD[item.state];
}
function lamports(value: string): string {
  const text = value.padStart(10, "0"); return `${text.slice(0, -9)}.${text.slice(-9)} SOL`;
}
function amounts(item: PrivateSubmissionView): string {
  if (item.direction === "sell") {
    return `  Sell ${item.grossInUnits} base units of ${item.inputMint} (${item.positionId}): quoted ${lamports(item.quotedOut)}, min out ${lamports(item.minOut)}, platform fee ${item.platformFeeBps} bps`;
  }
  return `  Buy ${item.outputMint}: gross ${lamports(item.grossInLamports)}, fee ${lamports(item.feeLamports)}, net ${lamports(item.netInLamports)}, min out ${item.minOut}`;
}
/** SF2: why a held buy negative is not proven yet (R8). */
const BUY_CHECK: Readonly<Record<RunnerBuyCheckReason, string>> = Object.freeze({
  balance_unexplained: "the wallet's balance of this coin does not match", no_witness: "no older transaction of this wallet to check your RPC's history against",
  witness_unproven: "your RPC's history could not be confirmed", transaction_malformed: "your RPC returned an unreadable transaction",
  rpc_missing: "no Solana RPC of your own is configured", rpc_unavailable: "your RPC did not answer", expiry_unproven: "its blockhash has not expired on your RPC yet",
  rpc_lagging: "your RPC is behind", transaction_appeared: "your RPC has shown the transaction; re-checking",
  gate_refused: "waiting: the bot is stopped, or the RPC is not your own", state_unavailable: "local state unavailable; retried",
  attempt_changed: "the trade changed during the check; retried", journal_unavailable: "the journal write failed; retried" });
/** Older than this, an unresolved buy is shown as stalled (operator runbook, design section 7.8). */
const STALLED_BUY_MS = 30 * 60_000;
/** SF R10: a buy released while Balchemy left it unresolved that Balchemy now reports failed or expired, still held for R2-R4. */
const releasedNegative = (item: PrivateSubmissionView): boolean => item.direction === "buy" && item.released === true
  && (item.engineState === "failed_onchain" || item.engineState === "expired_not_landed") && item.state !== "disputed" && item.state !== "closed_by_owner"
  && item.state !== "completed" && item.state !== "failed_onchain" && item.state !== "expired_not_landed";
/** This build's exits capability: every sentence about exits, stop-losses or arming is shown only where exits exist. */
const EXITS_AVAILABLE = PRIVATE_EXECUTION_CAPABILITIES.exits === true;
const exitsOff = (exits: boolean): string => exits
  ? "  Until this trade is closed out, new buys stay held and, after a restart, the bot cannot be armed, so automatic exits of this agent stay off."
  : "  Until this trade is closed out, new buys stay held.";
/** An unresolved buy the bot has not released (and that is no runner dispute) cannot be closed out yet. */
const notClosableYet = (exits: boolean): string => `  No close-out is available for it yet (Balchemy has not resolved it and the bot has not released it on your own RPC's proof): new buys stay held${exits
  ? " and, after a restart, the bot cannot be armed, so automatic exits of this agent stay off" : ""}.`;
function buyLines(item: PrivateSubmissionView, now: number, exits: boolean): string[] {
  if (item.direction !== "buy" || item.state === "closed_by_owner") return [];
  const negative = item.engineState === "failed_onchain" || item.engineState === "expired_not_landed";
  // M3.6 D6 K1: Balchemy never received this buy (its record still awaits a signature).
  const unrelayed = item.engineState === "awaiting_signature";
  const terminal = item.state === "completed" || item.state === "failed_onchain" || item.state === "expired_not_landed";
  const reason = item.reason ?? "";
  if (reason.startsWith("runner:buy_landed_despite_")) {
    return [unrelayed ? "  Landed on your own RPC although Balchemy never received it; spend held; owner review."
      : "  Landed on your own RPC although Balchemy reported it did not; spend held; owner review.", exitsOff(exits)];
  }
  if (reason.startsWith("runner:buy_negative_unproven")) {
    return [`  ${unrelayed ? "Balchemy never received it" : "Balchemy reports it did not land"}; your RPC could not prove it (${reason.slice("runner:buy_negative_unproven:".length).replace(/_/g, " ") || "unproven"}); spend held; owner review.`, exitsOff(exits)];
  }
  // Owner decision 45: this buy's spend record does not fit (already counted although Balchemy reports it did not land, or missing). The
  // bot never guesses a spend: it stays held, and the documented support step resolves it with the owner by hand.
  if (reason.startsWith("runner:ledger:")) {
    const support = `  Support step (${SPEND_RECORD_SUPPORT_STEP}): share this attempt key and signature with Balchemy support, never a key or passphrase.`;
    if (reason === "runner:ledger:reservation_committed") {
      // Two sources: SF2 (Balchemy reported failed or expired) and #apply (Balchemy reported completed, for example after an interrupted close-out).
      return [item.engineState === "completed"
        ? "  Balchemy reports it completed, but its spend was already counted (for example by an interrupted close-out), so the bot does not settle it by itself. You may close it out (its spend stays counted), or ask Balchemy support to check it with you first."
        : "  Balchemy reports it did not land, but its spend was already counted, so the bot does not release it by itself. You may close it out (its spend stays counted), or ask Balchemy support to check it with you first.",
        support, exitsOff(exits)];
    }
    const hold = [support, `  Until then new buys stay held${exits ? " and, after a restart, the bot cannot be armed, so automatic exits of this agent stay off" : ""}.`];
    if (reason === "runner:ledger:reservation_released") {
      return ["  The bot's spend for this buy was already released, so it cannot count it again (a rare internal error: stopping is safer than counting the spend wrong). It stays held until Balchemy support resolves it with you by hand.", ...hold];
    }
    return ["  The bot's spend record for this buy is missing, so it cannot count or settle it by itself (a rare internal error: stopping is safer than counting the spend wrong). It stays held until Balchemy support resolves it with you by hand.",
      ...hold];
  }
  if (terminal || item.state === "disputed") return [];
  // A held buy negative can stay held with no counted progress (an RPC behind, a ledger that cannot keep the coin): like any
  // unresolved trade it is then shown as stalled, with what it keeps off. Owner decision 44: an unresolved buy the bot has not released
  // can then be closed out (lines() shows the command).
  const stalled = now - item.createdAt > STALLED_BUY_MS
    ? ["  Unresolved for more than 30 minutes.", item.released === true || privateTradeClosableView(item, now) ? exitsOff(exits) : notClosableYet(exits)] : [];
  if (negative) {
    const check = item.buyCheck;
    const counted = check && check.counted > 0 && (RUNNER_BUY_CHECK_COUNTED as readonly string[]).includes(check.reason)
      ? `, ${check.counted} of ${RUNNER_BUY_CHECK_PERMANENT_COUNT} checks` : "";
    // A buy R10 released earlier says so in its released line instead (releasedLine).
    return [...(releasedNegative(item) ? [] : ["  Balchemy reports it did not land; checking on your RPC (spend held)."]),
      ...(check ? [`  Check: ${BUY_CHECK[check.reason]}${counted}`] : []), ...stalled];
  }
  // Only a build with automatic exits proves it (the daemon's check needs the exits capability, as SF R10 does).
  if (unrelayed && (exits || item.buyCheck)) {
    const check = item.buyCheck;
    const counted = check && check.counted > 0 && (RUNNER_BUY_CHECK_COUNTED as readonly string[]).includes(check.reason)
      ? `, ${check.counted} of ${RUNNER_BUY_CHECK_PERMANENT_COUNT} checks` : "";
    return ["  Never sent: Balchemy holds no signed copy of it. The bot releases its spend by itself once your own RPC proves it can no longer land and did not land (spend held; checked while the bot is not armed).",
      ...(check ? [`  Check: ${BUY_CHECK[check.reason]}${counted}`] : []), ...stalled];
  }
  return stalled;
}
/** F2 and SF R10: what a released attempt still holds. A buy released while Balchemy left it unresolved (R10) keeps its spend reserved
 * and new buys held; status may still move it on, and once terminal it holds nothing more. */
function releasedLine(item: PrivateSubmissionView, exits: boolean): string {
  const dispute = item.state === "disputed" && (item.reason ?? "").startsWith("runner:");
  if (item.direction !== "buy" || dispute) {
    return `  Can no longer land (proven on your own RPC); Balchemy record disputed; owner review.${exits
      ? " Other coins' exits may run while the bot stays armed (after a restart it cannot be armed until this trade is closed out);" : ""} new buys stay held.`;
  }
  // Terminal: settled by evidence (Balchemy's committed record, or R4's own proof); it no longer holds new buys.
  if (item.state === "completed") {
    return "  Balchemy reported it completed after your own RPC had proven it did not land; this contradicts that proof. Its spend is committed, its position follows Balchemy's record, and its coin is kept off the wallet-balance settlement for good; nothing to close out.";
  }
  // Released while unresolved, then Balchemy saw it finalized (facts pending or disputed): its record contradicts the runner's proof.
  if (item.state === "facts_pending" || item.state === "disputed") {
    return "  Balchemy saw it finalized after your own RPC had proven it did not land; this contradicts that proof; owner review. New buys stay held.";
  }
  if (item.state === "failed_onchain" || item.state === "expired_not_landed") {
    return "  Wallet lock released earlier on your own RPC's proof; Balchemy then reported it did not land, the bot proved that again on your own RPC and released the spend. Settled; nothing to close out.";
  }
  // Released while unresolved, then Balchemy reported it did not land and R2-R4 are still checking it: one line (buyLines adds only
  // the check's detail).
  if (releasedNegative(item)) {
    return "  Wallet lock released earlier on your own RPC's proof; Balchemy now reports it did not land and the runner is checking it (spend held). New buys stay held.";
  }
  return `  Balchemy has not resolved this buy. Your own RPC proved it did not land and can no longer land, so the wallet lock is released${exits
    ? " and other coins' sells (stop-losses) can run while the bot stays armed (after a restart it cannot be armed until this trade settles or is closed out)" : ""}. Its spend stays reserved and new buys stay held until you review it.`;
}
const unrelayedSell = (item: PrivateSubmissionView): boolean => privateSubmissionUnrelayedSellView(item as unknown as Record<string, unknown>);
/** M3.6 slice 7 (B1): what a sell Balchemy never received waits for (checked while the bot is not armed, too). */
const SELL_CHECK: Readonly<Record<RunnerLandingReleaseReason, string>> = Object.freeze({
  wire_blockhash_mismatch: "the stored bytes do not match their blockhash; never settled automatically, owner review",
  rpc_missing: "no Solana RPC of your own is configured", rpc_unavailable: "your RPC did not answer",
  expiry_unproven: "your RPC has not proven yet that it can no longer land (its blockhash still valid, or your RPC behind); retried every 15 seconds",
  proof_regressed: "your RPC went back in time; retried", gate_refused: "waiting: the bot is stopped, or the RPC is not your own",
  state_unavailable: "the position no longer matches this sell, or local state is unavailable; retried", attempt_changed: "the trade changed during the check; retried",
  journal_unavailable: "the journal write failed; retried", stall_grace: "retried", buy_landed: "retried", balance_unexplained: "retried", no_witness: "retried",
  witness_unproven: "it can no longer land, but your RPC's history did not show the earlier trade the proof needs; retried with a growing delay, and after about 15 minutes the bot ends it and holds the position as runner:sell_expiry_unproven (see runner positions)",
  transaction_malformed: "retried", rpc_lagging: "your RPC is behind", transaction_appeared: "retried" });
/** SF-A: what a sell Balchemy relayed and leaves unresolved waits for (checked while the bot is not armed, too). */
const SELL_STALL_CHECK: Readonly<Record<RunnerLandingReleaseReason, string>> = Object.freeze({ ...SELL_CHECK,
  stall_grace: "its blockhash expired on your own RPC; Balchemy gets about 7 more minutes to resolve it before the bot checks it itself",
  expiry_unproven: "your RPC has not proven yet that it can no longer land (its blockhash still valid, or your RPC behind); retried every 15 seconds",
  transaction_malformed: "your RPC returned an unreadable transaction for it; retried every 15 seconds",
  state_unavailable: "the position no longer carries this sell, or local state is unavailable; retried" });
const engineUnresolvedSell = (item: PrivateSubmissionView): boolean => privateSubmissionEngineUnresolvedSellView(item as unknown as Record<string, unknown>);
/** SF-A: the owner's reading of a sell the bot ended while Balchemy left it unresolved, and of Balchemy's later report on it. */
function sellEngineLines(item: PrivateSubmissionView): string[] {
  if (item.direction !== "sell") return [];
  if (engineUnresolvedSell(item)) {
    return ["  Balchemy has not resolved this sell, and the bot holds the wallet for it, so no other position's exit can sell meanwhile. About 7 minutes after its blockhash expired on your own RPC, the bot checks it itself (also while it is not armed; nothing is sent or signed): if your RPC shows it finalized, the position settles from that transaction; if your RPC proves it did not land, the trade ends, the wallet is free again (other positions' exits run) and this position's exit is planned again. Balchemy may still count the old sell as pending and refuse that new sell (position_insufficient) until it resolves it.",
      ...(item.releaseCheck ? [`  Check: ${SELL_STALL_CHECK[item.releaseCheck]}`] : [])];
  }
  const reportedLanding = item.engineState !== null && PRIVATE_SUBMISSION_LANDING_ENGINE_STATES.includes(item.engineState);
  // SF-A review findings 2-3: Balchemy's later landing on the runner's own failed_onchain read, or on a sell the runner ended at the S1 bound.
  if (item.state === "failed_onchain" && item.reason === PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON) {
    return reportedLanding ? ["  Balchemy later reported this sell landed, which contradicts your own RPC's finalized read (failed on-chain): the position is held for review (runner:sell_facts_transaction_failed; see runner positions). It is never sold or reopened on either word."]
      : item.engineState === "expired_not_landed" || item.engineState === "failed_onchain" ? ["  Balchemy later agreed that it did not sell; nothing more to settle."] : [];
  }
  if (item.state === "expired_not_landed" && item.reason === SELL_EXPIRY_UNPROVEN_REASON) {
    return reportedLanding ? ["  Balchemy later reported this sell landed, after your own RPC could not prove whether it did: the position is held for review (see runner positions). It is never sold or reopened on either word."] : [];
  }
  if (item.state !== "expired_not_landed" || item.reason !== PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON) return [];
  if (reportedLanding) {
    return ["  Balchemy later reported this sell landed, which contradicts your own RPC's proof: the position is held for review (runner:completed_contradicted_by_expiry; see runner positions). It is never sold or reopened on either word."];
  }
  if (item.observedSignature !== null) return [];
  if (item.engineState === "expired_not_landed" || item.engineState === "failed_onchain") return ["  Balchemy later agreed that it did not land; nothing more to settle."];
  return ["  Balchemy may still count it as pending: a new sell of this position can be refused (position_insufficient) until Balchemy resolves it. Other positions' exits are not affected; the bot keeps reading Balchemy's record of it."];
}
function sellLines(item: PrivateSubmissionView, exits: boolean): string[] {
  if (engineUnresolvedSell(item)) return exits || item.releaseCheck ? sellEngineLines(item) : [];
  if (item.direction === "sell" && (item.reason === PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON || item.reason === PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON
    || item.reason === SELL_EXPIRY_UNPROVEN_REASON)) return sellEngineLines(item);
  if (!unrelayedSell(item) || !(exits || item.releaseCheck)) return [];
  return ["  Never sent: Balchemy holds no signed copy of this sell. The bot ends it by itself once your own RPC proves it can no longer land and did not land; then the coins stay in the position and the exit is planned again (checked while the bot is not armed, too).",
    ...(item.releaseCheck ? [`  Check: ${SELL_CHECK[item.releaseCheck]}`] : [])];
}
function lines(item: PrivateSubmissionView, now: number, agentId: string, exits: boolean): string[] {
  return [`- ${item.attemptKey}  ${privateSubmissionStateLabel(item)}`, `  Signature: ${item.signature}`,
    ...(item.observedSignature !== null ? [`  SECURITY: landed as ${item.observedSignature}, a signature this runner never made${item.securityHold
      ? " (unacknowledged; wallet held)" : " (acknowledged)"}`] : []),
    // F2: proven on the runner's own RPC; the record stays disputed and new buys stay held until the owner reviews it.
    ...(item.released && item.state !== "closed_by_owner" ? [releasedLine(item, exits)] : []),
    // Owner decisions 26 and 44: what the owner may do about a trade held for review. Owner decision 45: a buy whose spend record is
    // missing can never be closed out (the daemon refuses spend_missing), so its support step is shown instead (buyLines).
    ...(privateTradeClosableView(item, now) && spendRecordHold(item) === null ? [`  Review, then close out (${item.released === true ? "reuses its release proof" : "proven on your own RPC first"}): balchemy runner trades ${agentId} ${CLOSE_TRADE_ACTION} ${item.attemptKey}`] : []),
    // F2: why the runner has not released this dispute yet (process-local; a permanent reason is never retried).
    ...(item.releaseCheck && !unrelayedSell(item) && !engineUnresolvedSell(item) ? [`  Release check: ${item.releaseCheck} (${runnerLandingReleaseRetry(item.releaseCheck)})`] : []),
    ...sellLines(item, exits),
    ...buyLines(item, now, exits),
    amounts(item),
    `  Relays: ${item.submits}; valid until block ${item.lastValidBlockHeight}${item.engineState ? `; engine ${item.engineState}` : ""}${item.reason ? `; last: ${item.reason}` : ""}`,
    `  Created ${new Date(item.createdAt).toISOString()}, updated ${new Date(item.updatedAt).toISOString()}`];
}
export function formatPrivateSubmissionResult(result: PrivateSubmissionCommandResult, now: number = Date.now(), exitsAvailable: boolean = EXITS_AVAILABLE): string {
  if (result.kind === "dry_run") return "Read-only trades preview; no connection or changes made.\n";
  const head = [`Local trades for ${result.agentId}: ${result.total} journaled${result.total > result.attempts.length ? ` (newest ${result.attempts.length} shown)` : ""}`];
  if (!result.attempts.length) return [...head, "No local trade has been signed.", ""].join("\n");
  const held = result.attempts.filter((item) => item.securityHold);
  return [...(held.length ? [...copyLines(result.agentId, held), ""] : []), ...head, ...result.attempts.flatMap((item) => lines(item, now, result.agentId, exitsAvailable)),
    "Readback only: nothing was resent, signed or settled.", ""].join("\n");
}
