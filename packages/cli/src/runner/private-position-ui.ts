/** `balchemy runner positions <agent>`: read-only readback of the owner-local position ledger and the exit worker (states,
 * bounded reason codes, public mints, amounts, timestamps). Never prints keys, wire bytes, proofs, RPC URLs or provider
 * payloads, and changes nothing.
 * `balchemy runner positions <agent> resolve <position-id>`: the owner's typed resolution (real terminal only) of a position
 * held for review (`runner:` reason). The daemon first proves the pending exit from its own finalized chain readback; only a
 * PROVEN outcome is offered, the owner types RESOLVE <position-id>, and the daemon re-proves and applies exactly that outcome
 * with one ledger write. Nothing is signed, sent or sold by either command.
 * `balchemy runner positions <agent> unmanage <reservation-id>` (owner item 75): the owner's typed confirmation (real terminal only)
 * that takes a completed buy whose position the runner refused to open off automatic management for good. The daemon checks the
 * buy first; only an eligible one is offered, the owner types UNMANAGE <reservation-id>, and the daemon re-checks it and makes one
 * ledger write. Nothing is signed, sent or sold; the spend record, the trade journal and Balchemy are not changed; it cannot be
 * undone. */
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId, runnerLandingReleaseRetry, RUNNER_CLOCK_SKEW_TEXT, RUNNER_LEASE_LOST_EXIT_REASONS, type RunnerExitSummary } from "./protocol.js";
import { privateRunnerHoldRechecked, privateRunnerHoldRule } from "./private-position-balance.js";
import { knownRunnerAgents, runnerNotRunningError, runnerUpgradeHint } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import type { PrivatePositionExitsOffLedger, PrivatePositionProof, PrivatePositionReadback, PrivatePositionRefusal, PrivatePositionUnmanageBuy,
  PrivatePositionUnmanageRefusal, PrivatePositionView } from "./private-position-recovery.js";
import { PRIVATE_FEE_POLICY_REFUSALS, PRIVATE_MAX_FEE_BPS } from "./private-fee-policy.js";
import { parsePrivatePositionRequest, privatePositionBinding, requestPrivatePositions, validatePrivatePositionReply,
  type PrivatePositionRequest, type PrivatePositionResponse, type PrivatePositionTransport } from "./private-position-protocol.js";
import { createWalletPrompt, guardTerminalSignals, type WalletPrompt } from "./private-trading-keystore-ui.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, type SocketProofOutcome, type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";

export const RESOLVE_POSITION_ACTION = "resolve";
export const UNMANAGE_POSITION_ACTION = "unmanage";
const POSITION_ID = /^pos:[0-9a-f]{32}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface PrivatePositionCommandOptions {
  args: string[]; directory: string;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivatePositionTransport;
}
export type PrivatePositionCommandResult = ({ kind: "list" } & PrivatePositionReadback) | { kind: "dry_run"; agentId: string };

function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid local positions command",
    cause: `Use runner positions <agent>, runner positions <agent> ${RESOLVE_POSITION_ACTION} <position-id>, or runner positions <agent> ${UNMANAGE_POSITION_ACTION} <reservation-id>.`,
    fix: "Pass one local agent label (and one position id to resolve, or one reservation id to unmanage). --yes, --force and --quiet are not supported.", exitCode: 2 });
}
function unavailable(cause: string, upgrade?: readonly string[]): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Local positions unavailable", cause,
    fix: `Inspect runner status and read again.${upgrade ? ` ${runnerUpgradeHint(upgrade)}` : ""} ` + "Do not edit or reset the private position ledger; held positions stay held until a readback proves an outcome.", exitCode: 1 });
}
function target(options: PrivatePositionCommandOptions, agentId: string): PrivateBrainTarget {
  let resolved: PrivateBrainTarget;
  try { resolved = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (resolved.agentId !== agentId) invalid();
  return resolved;
}

export async function runPrivatePositionCommand(options: PrivatePositionCommandOptions): Promise<PrivatePositionCommandResult> {
  const [agentId] = options.args;
  if (options.args.length !== 1 || !isId(agentId) || options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.flags.dryRun) return { kind: "dry_run", agentId };
  const runner = target(options, agentId);
  const request = parsePrivatePositionRequest({ ...privatePositionBinding(runner), action: "list" });
  let response: PrivatePositionResponse;
  try { response = validatePrivatePositionReply(request, await (options.transport ?? requestPrivatePositions)(runner.socketPath, request)); }
  catch { return unavailable("The selected runner could not return a validated position ledger.", knownRunnerAgents(options.directory)); }
  if (!response.ok) return unavailable(`The local runner returned ${response.error}.`);
  if (response.data.kind !== "list") return unavailable("The selected runner could not return a validated position ledger.", knownRunnerAgents(options.directory));
  return { kind: "list", ...response.data.readback };
}

export interface PrivatePositionResolveOptions extends PrivatePositionCommandOptions {
  interactive: boolean; write(text: string): void | Promise<void>; createPrompt?(): WalletPrompt;
  guardSignals?(cleanup: () => void): () => void;
  /** A2a socket proof (resolve and unmanage are raising), asked only on `proof_required` after the typed phrase. Undefined: the prompt's
   * own hidden field; null: no prompt here. */
  proofSecret?: SocketProofSecret | null;
  walletTransport?: PrivateTradingWalletTransport;
}
/** A2a: one owner change of this module through the socket proof. A lost reply (`unknown`) is thrown and never resent. */
async function provenPositionChange(options: PrivatePositionResolveOptions, runner: PrivateBrainTarget, prompt: WalletPrompt,
  build: (passphrase?: string) => PrivatePositionRequest,
  exchange: (input: PrivatePositionRequest) => Promise<PrivatePositionResponse | "unknown">): Promise<SocketProofOutcome<PrivatePositionResponse> | "unknown"> {
  const first = build();
  try {
    return await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? first : build(passphrase)),
      send: async (request) => { const reply = await exchange(request); if (reply === "unknown") throw new Error("Local runner unavailable"); return reply; },
      error: (reply) => (reply.ok ? undefined : reply.error),
      secret: options.proofSecret !== undefined ? options.proofSecret : (label) => prompt.secret(label), unlock: socketProofUnlock(runner, options.walletTransport) });
  } catch { return "unknown"; }
}
export type PrivatePositionResolveResult = { kind: "dry_run"; agentId: string; positionId: string }
  /** Nothing changed: a refusal before any proof, or a readback that proves nothing (the hold stays). */
  | { kind: "unchanged"; agentId: string; positionId: string; refusal: PrivatePositionRefusal | null; proof: PrivatePositionProof | null }
  | { kind: "cancelled"; agentId: string; positionId: string; reason: "input_closed" | "resolution_not_confirmed" }
  | { kind: "resolved"; agentId: string; positionId: string; proof: PrivatePositionProof; position: PrivatePositionView }
  /** The resolution may or may not have been written; read `runner positions` before anything else. */
  | { kind: "outcome_unknown"; agentId: string; positionId: string };

function lamports(value: string): string {
  const text = value.padStart(10, "0"); return `${text.slice(0, -9)}.${text.slice(-9)} SOL`;
}
const PROOF_TEXT: Readonly<Record<PrivatePositionProof["reason"], string>> = Object.freeze({
  finalized_sale: "the journaled sell signature is finalized and the exact pending units left the wallet",
  finalized_failed: "the journaled sell signature finalized with an error, so nothing it carried moved",
  rpc_missing: "no Solana RPC is configured for this agent", rpc_unavailable: "the agent's RPC did not answer",
  transaction_malformed: "the finalized transaction could not be read", balances_missing: "the finalized transaction lacks balance facts",
  transaction_absent: "the agent's RPC does not serve the journaled sell signature at finalized; an absent read never proves it did not land",
  exit_attempt_missing: "no journaled sell attempt matches the pending exit", exit_attempt_mismatch: "the journaled sell attempt does not match the pending exit",
  observed_copy: "a copy of the sell landed under a signature this runner never made",
  engine_record_conflict: "Balchemy's record of this sell, or why it was held, rules this outcome out (a completed record or a possible copy signed elsewhere is never overruled by one RPC read)",
  evidence_conflict: "the agent's RPC now shows a failure for a sell the runner already read landed without error; an inconsistent read never proves it did not sell",
  signature_mismatch: "the finalized transaction carries another signature",
  fee_payer_mismatch: "the finalized transaction was paid by another wallet", input_debit_mismatch: "the finalized sale debited a different amount",
  wallet_token_balance_decreased: "the finalized transaction reduced another token balance", wsol_account_missing: "the finalized sale lacks the wallet's WSOL account",
  wsol_account_mismatch: "the finalized sale used an unexpected WSOL account", wsol_not_closed: "the finalized sale left the WSOL account open",
  proceeds_negative: "the finalized sale shows no proceeds" });
const REFUSAL_TEXT: Readonly<Record<PrivatePositionRefusal, string>> = Object.freeze({
  position_missing: "No such position for this agent.", not_held: "This position is not held for review; nothing to resolve.",
  settlement_owned: "This hold is still settled automatically by the runner; it needs no owner resolution.",
  hold_changed: "The held exit changed since it was reviewed.", proof_changed: "The fresh readback no longer proves what you confirmed.",
  busy: "Another position check is running for this agent.", state_unavailable: "The local position or journal state could not be read." });
export function formatPrivatePositionProof(proof: PrivatePositionProof): string {
  if (proof.outcome === "proven") {
    return proof.result === "sold" ? `Proven sold: ${PROOF_TEXT[proof.reason]}; proceeds ${lamports(proof.proceedsLamports)}.`
      : `Proven not sold: ${PROOF_TEXT[proof.reason]}.`;
  }
  return `${proof.outcome === "unknown" ? "Unknown" : "Conflicting"} (${proof.reason}): ${PROOF_TEXT[proof.reason]}.`;
}

export async function runPrivatePositionResolve(options: PrivatePositionResolveOptions): Promise<PrivatePositionResolveResult> {
  const [agentId, action, positionId] = options.args;
  if (options.args.length !== 3 || !isId(agentId) || action !== RESOLVE_POSITION_ACTION || typeof positionId !== "string" || !POSITION_ID.test(positionId)
    || options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.flags.dryRun) return { kind: "dry_run", agentId, positionId };
  if (!options.interactive || options.flags.json || options.flags.ci) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive terminal required",
      cause: "Resolving a held position requires a real terminal and a typed confirmation.",
      fix: "Run without --json or --ci in a terminal. runner positions shows held positions without changing anything.", exitCode: 2 });
  }
  const runner = target(options, agentId);
  const transport = options.transport ?? requestPrivatePositions;
  const exchange = async (input: PrivatePositionRequest): Promise<PrivatePositionResponse | "unknown"> => {
    try { return validatePrivatePositionReply(input, await transport(runner.socketPath, input)); } catch { return "unknown"; }
  };
  const verify = parsePrivatePositionRequest({ ...privatePositionBinding(runner), action: "verify", positionId });
  const checked = await exchange(verify);
  if (checked === "unknown") return unavailable("The selected runner could not return a validated position check.", knownRunnerAgents(options.directory));
  if (!checked.ok) return unavailable(`The local runner returned ${checked.error}.`);
  if (checked.data.kind !== "verify") return unavailable("The selected runner could not return a validated position check.", knownRunnerAgents(options.directory));
  const check = checked.data.check;
  const pending = check.position?.pendingExit;
  if (check.refusal !== null || !check.proof || check.proof.outcome !== "proven" || !check.position || !pending) {
    return { kind: "unchanged", agentId, positionId, refusal: check.refusal, proof: check.proof };
  }
  const proof = check.proof; const position = check.position;
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  const releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => prompt.close());
  try {
    const phrase = `RESOLVE ${positionId}`;
    await options.write([`Held position ${positionId} (${position.holdReason ?? "held"}) of ${position.tokenMint}.`,
      `Pending ${pending.trigger.replace(/_/g, " ")} exit ${pending.reservationId}: ${pending.units} of ${position.remainingUnits} remaining base units.`,
      formatPrivatePositionProof(proof),
      proof.result === "sold"
        ? "Resolving records this exit as completed with the proven proceeds; the position closes if nothing remains."
        : "Resolving clears the pending exit and opens the position again; while armed, the exit worker may then trigger a new sell of the remaining units.",
      "Nothing is signed, sent or sold by this command, and the trade journal is not changed. The runner re-checks the chain before writing.",
      `Type exactly ${phrase} to continue; any other answer cancels.`, ""].join("\n"));
    const answer = await prompt.line("resolve> ");
    if (answer === null || prompt.closed) return { kind: "cancelled", agentId, positionId, reason: "input_closed" };
    if (answer !== phrase) return { kind: "cancelled", agentId, positionId, reason: "resolution_not_confirmed" };
    const outcome = await provenPositionChange(options, runner, prompt, (passphrase) => parsePrivatePositionRequest({ ...privatePositionBinding(runner),
      action: "resolve", positionId, reservationId: pending.reservationId, result: proof.result, ...(passphrase !== undefined ? { passphrase } : {}) }), exchange);
    if (outcome === "unknown") return { kind: "outcome_unknown", agentId, positionId };
    if (outcome.kind === "cancelled") return { kind: "cancelled", agentId, positionId, reason: "input_closed" };
    if (outcome.kind !== "response") return socketProofFailure(outcome, agentId, "Position not resolved");
    const after = outcome.response;
    if (!after.ok || after.data.kind !== "resolve") return { kind: "outcome_unknown", agentId, positionId };
    const resolution = after.data.resolution;
    if (resolution.applied && resolution.proof && resolution.position) return { kind: "resolved", agentId, positionId, proof: resolution.proof, position: resolution.position };
    // A ledger write that failed may or may not have been committed.
    if (resolution.refusal === "state_unavailable" && resolution.proof?.outcome === "proven") return { kind: "outcome_unknown", agentId, positionId };
    return { kind: "unchanged", agentId, positionId, refusal: resolution.refusal, proof: resolution.proof };
  } finally { releaseSignals(); prompt.close(); }
}
export function formatPrivatePositionResolveResult(result: PrivatePositionResolveResult): string {
  if (result.kind === "dry_run") return `Position resolution preview for ${result.positionId}. No connection, prompt or change made.\n`;
  if (result.kind === "cancelled") return `Position resolution cancelled (${result.reason.replace(/_/g, " ")}). The position stays held.\n`;
  if (result.kind === "outcome_unknown") return [`Position resolution outcome unknown for ${result.positionId}. Nothing was retried.`,
    `Read the ledger before anything else: balchemy runner positions ${result.agentId}`, ""].join("\n");
  if (result.kind === "unchanged") {
    return [`Position ${result.positionId} was not changed.`, ...(result.refusal ? [REFUSAL_TEXT[result.refusal]] : []),
      ...(result.proof ? [formatPrivatePositionProof(result.proof)] : []),
      ...(result.proof && result.proof.outcome !== "proven" ? ["Only a proven chain readback can resolve a hold. The position stays held; nothing was signed or sent."] : []), ""].join("\n");
  }
  return [`Resolved ${result.positionId}: ${formatPrivatePositionProof(result.proof)}`,
    `Position is now ${result.position.state}; ${result.position.remainingUnits} of ${result.position.originalUnits} base units remain.`,
    "Nothing was signed or sent. The trade journal is unchanged.", ""].join("\n");
}

export type PrivatePositionUnmanageCommandResult = { kind: "dry_run"; agentId: string; reservationId: string }
  /** Nothing changed: the buy is not eligible (or no longer was at the write). */
  | { kind: "unchanged"; agentId: string; reservationId: string; refusal: PrivatePositionUnmanageRefusal }
  | { kind: "cancelled"; agentId: string; reservationId: string; reason: "input_closed" | "unmanage_not_confirmed" }
  | { kind: "unmanaged"; agentId: string; reservationId: string; buy: PrivatePositionUnmanageBuy }
  /** The write may or may not have been committed; read `runner positions` before anything else. */
  | { kind: "outcome_unknown"; agentId: string; reservationId: string };
const UNMANAGE_REFUSAL_TEXT: Readonly<Record<PrivatePositionUnmanageRefusal, string>> = Object.freeze({
  buy_missing: "No completed buy of this agent has this reservation id in the trade journal.",
  pre_enable: "This buy completed before automatic exits were enabled; it is already not managed automatically.",
  already_unmanaged: "You already took this buy off automatic management.",
  attempt_released_unsettled: "This buy was released while its outcome is still unsettled; settle or close it out first (balchemy runner trades <agent>).",
  observed_copy: "A copy of this buy landed under another signature; it has its own hold (see balchemy runner trades <agent>).",
  position_exists: "This buy has a position (open, held or closed) or had one; the runner manages or managed it.",
  not_refused: "The runner has not refused to open this buy's position: it may still open it. The exit worker tries only while the bot is armed; read runner positions again after it has tried.",
  worker_unavailable: "The exit worker is not running in this runner, so it cannot say whether this buy's position was refused.",
  unmanaged_full: "The runner already keeps its maximum of 64 buys taken off automatic management; no more can be added.",
  busy: "Another position check is running for this agent; try again.",
  state_unavailable: "The local position or journal state could not be read." });
/** The typed-confirmation prompt of `unmanage` (owner item 75): the facts, the opening refusal and every consequence. */
export function formatPrivatePositionUnmanagePrompt(reservationId: string, buy: PrivatePositionUnmanageBuy, phrase: string): string {
  const opening = buy.opening;
  return [`Completed buy ${reservationId} of ${buy.tokenMint}: cost ${lamports(buy.costLamports)}, completed ${new Date(buy.completedAt).toISOString()}.`,
    opening.kind === "permanent"
      ? `The runner refused to open its position for good (${opening.reason}): its tokens have no position and no stop-loss, and new buys are held (buy_unprotected).`
      : `The runner has not opened its position yet (${opening.reason}, ${opening.tries} tr${opening.tries === 1 ? "y" : "ies"}) and is still retrying; new buys are held meanwhile (position_unopened). If your RPC is only lagging, wait: the position opens once your RPC serves the finalized buy. Use this only as a last resort after review.`,
    "Taking this buy off automatic management means:",
    "- the runner will never sell these tokens automatically;",
    "- there is no stop-loss or take-profit for them;",
    "- you manage them by hand in your wallet;",
    "- new buys may resume if nothing else holds them.",
    "The runner also never settles a held position of this coin from the wallet balance.",
    "This cannot be undone: no command puts these tokens back under automatic management.",
    "Nothing is signed, sent or sold by this command; the buy's spend stays counted, and the trade journal and Balchemy's records are not changed.",
    `Type exactly ${phrase} to continue; any other answer cancels.`, ""].join("\n");
}
export async function runPrivatePositionUnmanage(options: PrivatePositionResolveOptions): Promise<PrivatePositionUnmanageCommandResult> {
  const [agentId, action, reservationId] = options.args;
  if (options.args.length !== 3 || !isId(agentId) || action !== UNMANAGE_POSITION_ACTION || typeof reservationId !== "string" || !UUID4.test(reservationId)
    || options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.flags.dryRun) return { kind: "dry_run", agentId, reservationId };
  if (!options.interactive || options.flags.json || options.flags.ci) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive terminal required",
      cause: "Taking a buy off automatic management requires a real terminal and a typed confirmation.",
      fix: "Run without --json or --ci in a terminal. runner positions shows unopened buys without changing anything.", exitCode: 2 });
  }
  const runner = target(options, agentId);
  const transport = options.transport ?? requestPrivatePositions;
  const exchange = async (input: PrivatePositionRequest): Promise<PrivatePositionResponse | "unknown"> => {
    try { return validatePrivatePositionReply(input, await transport(runner.socketPath, input)); } catch { return "unknown"; }
  };
  const check = parsePrivatePositionRequest({ ...privatePositionBinding(runner), action: "unmanage_check", reservationId });
  const checked = await exchange(check);
  if (checked === "unknown") return unavailable("The selected runner could not return a validated buy check.", knownRunnerAgents(options.directory));
  if (!checked.ok) return unavailable(`The local runner returned ${checked.error}.`);
  if (checked.data.kind !== "unmanage_check") return unavailable("The selected runner could not return a validated buy check.", knownRunnerAgents(options.directory));
  const eligibility = checked.data.check;
  if (eligibility.refusal !== null || eligibility.buy === null) return { kind: "unchanged", agentId, reservationId, refusal: eligibility.refusal ?? "state_unavailable" };
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  const releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => prompt.close());
  try {
    const phrase = `UNMANAGE ${reservationId}`;
    await options.write(formatPrivatePositionUnmanagePrompt(reservationId, eligibility.buy, phrase));
    const answer = await prompt.line("unmanage> ");
    if (answer === null || prompt.closed) return { kind: "cancelled", agentId, reservationId, reason: "input_closed" };
    if (answer !== phrase) return { kind: "cancelled", agentId, reservationId, reason: "unmanage_not_confirmed" };
    const outcome = await provenPositionChange(options, runner, prompt, (passphrase) => parsePrivatePositionRequest({ ...privatePositionBinding(runner),
      action: "unmanage", reservationId, ...(passphrase !== undefined ? { passphrase } : {}) }), exchange);
    if (outcome === "unknown") return { kind: "outcome_unknown", agentId, reservationId };
    if (outcome.kind === "cancelled") return { kind: "cancelled", agentId, reservationId, reason: "input_closed" };
    if (outcome.kind !== "response") return socketProofFailure(outcome, agentId, "Buy not taken off automatic management");
    const after = outcome.response;
    if (!after.ok || after.data.kind !== "unmanage") return { kind: "outcome_unknown", agentId, reservationId };
    const result = after.data.result;
    if (result.applied && result.buy) return { kind: "unmanaged", agentId, reservationId, buy: result.buy };
    // A ledger write that failed after the checks may or may not have been committed.
    if (result.refusal === "state_unavailable") return { kind: "outcome_unknown", agentId, reservationId };
    return { kind: "unchanged", agentId, reservationId, refusal: result.refusal ?? "state_unavailable" };
  } finally { releaseSignals(); prompt.close(); }
}
export function formatPrivatePositionUnmanageResult(result: PrivatePositionUnmanageCommandResult): string {
  if (result.kind === "dry_run") return `Unmanage preview for buy ${result.reservationId}. No connection, prompt or change made.\n`;
  if (result.kind === "cancelled") return `Unmanage cancelled (${result.reason.replace(/_/g, " ")}). Nothing changed.\n`;
  if (result.kind === "outcome_unknown") return [`Unmanage outcome unknown for buy ${result.reservationId}. Nothing was retried.`,
    `Read the ledger before anything else: balchemy runner positions ${result.agentId}`, ""].join("\n");
  if (result.kind === "unchanged") {
    return [`Buy ${result.reservationId} was not changed.`, UNMANAGE_REFUSAL_TEXT[result.refusal].replace("<agent>", result.agentId), ""].join("\n");
  }
  return [`Buy ${result.reservationId} of ${result.buy.tokenMint} is no longer managed automatically: the runner never sells these tokens and has no stop-loss or take-profit for them; manage them by hand in your wallet.`,
    `New buys resume only if nothing else holds them: balchemy runner positions ${result.agentId}`,
    "Nothing was signed, sent or sold. The spend record and the trade journal are unchanged.", ""].join("\n");
}

/** A `runner:` hold whose table row allows no outcome (the journaled sell does not describe the exit): neither the wallet balance
 * nor `resolve` can ever clear it, so no resolve command is suggested for it. */
const manualOnly = (holdReason: string | null): boolean => privateRunnerHoldRule(holdReason)?.outcomes.length === 0;
const MANUAL_ONLY_TEXT = "  No runner command can clear this hold: the journaled sell does not describe this exit, so neither the wallet balance nor a chain readback can prove its outcome, and new buys stay held. Do not move the bot's tokens by hand; contact Balchemy support.";
/** SF8: a hold the runner's settlement pass re-checks itself; it lifts or is renamed without the owner. */
const RECHECKED_TEXT = "  The runner re-checks this hold automatically from its own chain readback (with a growing delay, at most every 10 minutes): Balchemy reported this sell finished, but the runner has not found it on chain yet. It lifts once the runner proves the outcome itself.";
/** Final audit S1: a negative wait that reached its bound: the owner's RPC cannot prove the sell never landed. */
const SELL_EXPIRY_UNPROVEN = "runner:sell_expiry_unproven";
const SELL_EXPIRY_UNPROVEN_TEXT = "  Your RPC cannot prove that this sell never landed: its transaction history does not reach the earlier trade the proof needs. The units stay in this position, its exit is not planned again and new buys stay held. Ways out: switch to an RPC with full transaction history (the runner re-checks this hold every 10 minutes), or arm the bot on your own RPC: the runner then settles it from the wallet balance, only as \"not sold\" and only while the wallet still holds this exit's units. Do not move the bot's tokens by hand; if neither works, contact Balchemy support.";
/** Final audit part 3 SF-A: Balchemy relayed this position's sell and leaves it unresolved; the runner proves it itself. */
const SELL_ENGINE_UNRESOLVED = "runner:sell_engine_unresolved";
const SELL_ENGINE_UNRESOLVED_TEXT = "  Balchemy has not resolved this position's sell. The runner checks it itself on your own RPC (about 7 minutes after its blockhash expired, then retried; also while the bot is not armed): if the sell landed, the position settles from its transaction; if your RPC proves it did not land, the exit is cleared and planned again, and the wallet is freed for the other positions' exits; if your RPC's history cannot prove it, the hold becomes runner:sell_expiry_unproven. Details: balchemy runner trades <agent>. Do not move the bot's tokens by hand.";
/** SF-A: the engine still counts an earlier sell of the coin as pending (the runner proved on your own RPC that it did not land). */
const ENGINE_PENDING_SELL_REASON = "build:server:position_insufficient";
export const ENGINE_PENDING_SELL_TEXT = "position_insufficient: Balchemy still counts an earlier sell of this coin as pending (if the runner proved on your own RPC that it did not land, runner trades shows it as \"did not land ... while Balchemy left it unresolved\"). This position's sell is retried at least once a minute and runs once Balchemy resolves that sell; other coins' exits are not affected.";
/** SF-A review finding 4: Balchemy later reported a landing (or a copy) of a sell the runner had itself ended negative, and the owner hold
 * that report owes is not applied yet (readback `lateLandings`). Never the "still pending" text for those positions. */
export const LATE_LANDING_TEXT = "Balchemy later reported that an earlier sell of this coin landed, after your own RPC had shown that it did not land or failed (runner trades shows it). That contradicts your own RPC, so the runner holds the position for review as soon as no other exit attempt of it is in progress (it tries at least once a minute); until then a new sell of it can be refused (position_insufficient). It is never sold or reopened on either word. Do not move the bot's tokens by hand.";
/** Final audit S3: a completed buy whose position was refused permanently; owner item 75: the owner's way out. */
const unprotectedText = (agentId: string, reservationId: string | null): string => "  No position and no stop-loss: this buy's tokens are in the wallet, but the runner refused to open their position, so it never sells them automatically and new buys stay held. "
  + `After review, you can take its tokens off automatic management and manage them by hand: balchemy runner positions ${agentId} ${UNMANAGE_POSITION_ACTION} ${reservationId ?? "<reservation-id>"}`;
/** Owner item 75: a transiently unopened buy: the runner keeps retrying; unmanage is a last resort after review. */
const unopenedText = (agentId: string, reservationId: string | null): string => "  The runner keeps retrying to open this position (if your RPC is only lagging, wait). "
  + `If it never opens, as a last resort after review: balchemy runner positions ${agentId} ${UNMANAGE_POSITION_ACTION} ${reservationId ?? "<reservation-id>"}`;
/** Final audit S4: the exit refusals of the runner's built-in fee policy (private-fee-policy.ts), at the local check or the preflight. */
const FEE_POLICY_EXIT_REASONS: readonly string[] = PRIVATE_FEE_POLICY_REFUSALS.flatMap((code) => [`build:local:${code}`, `build:preflight:${code}`]);
export const FEE_POLICY_EXIT_TEXT = `Balchemy's fee terms are outside this runner's built-in limits (at most ${PRIVATE_MAX_FEE_BPS / 100} %, to one of Balchemy's listed fee wallets); exits are refused and retried until they match, or until you update the runner.`;
/** Final audit S2: Balchemy's daily exit budget refused this exit's build. Keyed on the server stage only: the runner's own spend ledger
 * uses the same code when its local file is full (build:local:reservation_capacity_exhausted), which is a different cause. */
const EXIT_BUDGET_REASON = "build:server:reservation_capacity_exhausted";
export const EXIT_BUDGET_TEXT = "reservation_capacity_exhausted: Balchemy's daily exit budget is used up: 64 attempts a day for this coin whose transaction Balchemy built, or 512 a day for the agent. This position's exit is retried and runs again after 00:00 UTC; other coins' exits are not affected unless the agent's budget is used up.";
/** SF8: Balchemy's `completed` contradicted by the runner's own expiry proof. */
const CONTRADICTED_TEXT = "  Balchemy reports this sell completed, but the runner's own chain readback proves it never landed and never can. The runner settles it neither way on its own and new buys stay held. Do not move the bot's tokens by hand; review it, and contact Balchemy support if the sale never appears.";
const STATE_TEXT: Readonly<Record<PrivatePositionView["state"], string>> = Object.freeze({ open: "open", held: "HELD for review", closed: "closed" });
/** `<agent>` is replaced by the agent label (entryHoldText). */
const ENTRY_HOLD_TEXT: Readonly<Record<string, string>> = Object.freeze({
  attempt_released_unsettled: "held: a stuck trade can no longer land, but its result needs your review",
  position_held: "held: a position is held for review",
  exit_pending: "held: an exit is pending",
  position_unopened: `held: a completed buy has no position yet, so its tokens have no stop-loss until the position opens (the runner keeps retrying; if it never opens, as a last resort after review: balchemy runner positions <agent> ${UNMANAGE_POSITION_ACTION} <reservation-id>)`,
  buy_unprotected: `held for review: a completed buy's position was refused, so its tokens have no stop-loss (after review: balchemy runner positions <agent> ${UNMANAGE_POSITION_ACTION} <reservation-id>)`,
  ledger_full: "held: the position ledger holds its maximum of open positions", unavailable: "held: the exit worker is unavailable" });
function entryHoldText(agentId: string, hold: string | null): string {
  return hold === null ? "not held by exits" : (ENTRY_HOLD_TEXT[hold] ?? "held").replace("<agent>", agentId);
}
/** Final audit N4: the exit worker's H2 rule (private-exit-worker.ts): while one position of a mint has an exit pending (held ones
 * included), no other position of that mint is valued, so none of them can trigger a stop-loss. Named from the shown positions. */
function sameMintBlock(item: PrivatePositionView, shown: readonly PrivatePositionView[]): string[] {
  if (item.state !== "open" || item.pendingExit !== null) return [];
  const by = shown.find((other) => other.positionId !== item.positionId && other.state !== "closed" && other.pendingExit !== null && other.tokenMint === item.tokenMint);
  return by ? [`  Not valued meanwhile (no stop-loss or take-profit check): position ${by.positionId} of the same coin ${by.state === "held" ? "is held for review" : "has an exit pending"}; this one is valued again once that exit settles.`] : [];
}
function positionLines(agentId: string, item: PrivatePositionView, shown: readonly PrivatePositionView[] = []): string[] {
  const pending = item.pendingExit; const settled = item.settlement; const balance = item.balance;
  const proceeds = item.proceedsComplete ? `proceeds ${lamports(item.proceedsLamports)}`
    : `proceeds ${lamports(item.proceedsLamports)} known plus UNKNOWN proceeds of an exit settled from the wallet balance (no PnL for it)`;
  return [`- ${item.positionId}  ${STATE_TEXT[item.state]}${item.holdReason ? ` (${item.holdReason})` : ""}`,
    `  Mint ${item.tokenMint}: ${item.remainingUnits} of ${item.originalUnits} base units remain; cost ${lamports(item.costLamports)}, ${proceeds}, ${item.exits} exit${item.exits === 1 ? "" : "s"}`,
    ...(pending ? [`  Pending ${pending.trigger.replace(/_/g, " ")}${pending.level === null ? "" : ` level ${pending.level + 1}`} exit ${pending.reservationId}: ${pending.units} units since ${new Date(pending.createdAt).toISOString()}`] : []),
    ...(settled ? [`  Settled from the wallet balance ${new Date(settled.at).toISOString()} (${settled.reason}, was ${settled.heldFor}): ${settled.result === "sold"
      ? "the exit sold; its proceeds are unknown" : "the exit did not sell; the position was opened again"}`] : []),
    ...(balance ? [balance.reason === "unmanaged_mint"
      ? "  Automatic wallet-balance check: unmanaged_mint. The wallet holds tokens of this mint bought before automatic exits were enabled, so its balance can never prove this exit; waiting will not clear it. Review and resolve it yourself."
      : balance.reason === "hold_manual_only"
        ? "  Automatic wallet-balance check: hold_manual_only. The journaled sell does not describe this exit, so the wallet balance can never settle it; waiting will not clear it."
        : `  Automatic wallet-balance check: ${balance.reason} (${balance.tries} tr${balance.tries === 1 ? "y" : "ies"}); retried after ${new Date(balance.nextAt).toISOString()}`] : []),
    ...(item.resolvable && manualOnly(item.holdReason) ? [MANUAL_ONLY_TEXT] : []),
    ...(item.resolvable && item.holdReason === SELL_EXPIRY_UNPROVEN ? [SELL_EXPIRY_UNPROVEN_TEXT]
      : item.resolvable && item.holdReason === SELL_ENGINE_UNRESOLVED ? [SELL_ENGINE_UNRESOLVED_TEXT.replace("<agent>", agentId)]
      : item.resolvable && privateRunnerHoldRechecked(item.holdReason) ? [RECHECKED_TEXT] : []),
    ...(item.resolvable && item.holdReason === "runner:completed_contradicted_by_expiry" ? [CONTRADICTED_TEXT] : []),
    ...(item.resolvable && !manualOnly(item.holdReason) && !privateRunnerHoldRechecked(item.holdReason) ? [`  Review, then resolve from a proven chain readback: balchemy runner positions ${agentId} ${RESOLVE_POSITION_ACTION} ${item.positionId}`] : []),
    ...(item.state === "held" && !item.resolvable ? ["  The runner retries this hold automatically from its own chain readback."] : []),
    ...sameMintBlock(item, shown),
    `  Created ${new Date(item.createdAt).toISOString()}, updated ${new Date(item.updatedAt).toISOString()}`];
}
/** F-M36-D15-SF11: a build without automatic exits (for example after a downgrade from one with them). The positions are the last
 * record of the build with exits; this build never values, sells or settles them, so each has no stop-loss and a pending sell waits. */
function exitsOffText(agentId: string, ledger: PrivatePositionExitsOffLedger | undefined): string {
  if (ledger === undefined) {
    return [`Local positions for ${agentId}: automatic exits are not available in this version, so no position is tracked.`,
      "Readback only: nothing was changed.", ""].join("\n");
  }
  const byHand = "Close or watch them by hand, or upgrade to a version with automatic exits; this version never sells them automatically.";
  if (ledger === "unreadable") {
    return [`Local positions for ${agentId}: automatic exits are off in this version, and the position ledger left by a version with automatic exits could not be read.`,
      `Any position it holds has NO stop-loss or take-profit while this version runs. ${byHand}`,
      "Readback only: nothing was signed, sent, sold or changed.", ""].join("\n");
  }
  const count = `${ledger.total} position${ledger.total === 1 ? "" : "s"}`;
  const lines = ledger.positions.flatMap((item) => {
    const pending = item.pendingExit;
    return [`- ${item.positionId}  ${STATE_TEXT[item.state]}${item.holdReason ? ` (${item.holdReason})` : ""}: NO stop-loss or take-profit in this version`,
      `  Mint ${item.tokenMint}: ${item.remainingUnits} of ${item.originalUnits} base units remain; cost ${lamports(item.costLamports)}`,
      ...(pending ? [`  Pending sell (${pending.trigger.replace(/_/g, " ")}${pending.level === null ? "" : ` level ${pending.level + 1}`} exit ${pending.reservationId}): ${pending.units} units since ${new Date(pending.createdAt).toISOString()}.`,
        `  Waiting: this version never settles or retries it. If it was sent it may already have landed (balchemy runner trades ${agentId}); its result is applied to this position after you upgrade to a version with automatic exits.`] : [])];
  });
  return [`Local positions for ${agentId}: automatic exits are off in this version. ${count} recorded by a version with automatic exits ${ledger.total === 1 ? "is" : "are"} still open, with NO stop-loss or take-profit while this version runs.`,
    byHand,
    ...lines,
    ...(ledger.total > ledger.positions.length ? [`(${ledger.positions.length} of ${ledger.total} shown, held first.)`] : []),
    "Shown as last recorded by the version with automatic exits; this version never changes the position ledger.",
    "Readback only: nothing was signed, sent, sold or changed.", ""].join("\n");
}
export function formatPrivatePositionResult(result: PrivatePositionCommandResult): string {
  if (result.kind === "dry_run") return "Read-only positions preview; no connection or changes made.\n";
  if (result.exits === "unavailable") return exitsOffText(result.agentId, result.ledger);
  const worker = result.worker;
  const late = result.lateLandings ?? [];
  // The "still pending" text only for a position_insufficient backoff that no recorded late landing explains, of a position not held
  // for review (a held position's sell is not retried, and its backoff entry is stale: e.g. the late-landing hold was applied since).
  const held = new Set(result.positions.filter((item) => item.state === "held").map((item) => item.positionId));
  const enginePending = (worker?.backoff ?? []).some((item) => item.reason === ENGINE_PENDING_SELL_REASON && !late.includes(item.positionId) && !held.has(item.positionId));
  const head = [`Local positions for ${result.agentId}: ${result.total} recorded${result.total > result.positions.length ? ` (${result.positions.length} shown, held first)` : ""}.`,
    `New buys: ${entryHoldText(result.agentId, result.entryHold)}.`,
    worker ? `Exit worker: last pass ${worker.reason ?? "ok"}; ${worker.openingTotal} completed buy${worker.openingTotal === 1 ? "" : "s"} without a position; ${worker.backoffTotal} position${worker.backoffTotal === 1 ? "" : "s"} in backoff.`
      : "Exit worker: not running in this process.",
    ...(worker && (FEE_POLICY_EXIT_REASONS.includes(worker.reason ?? "") || worker.backoff.some((item) => FEE_POLICY_EXIT_REASONS.includes(item.reason))) ? [FEE_POLICY_EXIT_TEXT] : []),
    ...(enginePending ? [ENGINE_PENDING_SELL_TEXT] : []),
    ...(worker && (worker.reason === EXIT_BUDGET_REASON || worker.backoff.some((item) => item.reason === EXIT_BUDGET_REASON)) ? [EXIT_BUDGET_TEXT] : []),
    // Final audit N5: the Hub connection was refused for this computer's clock, and the exit worker shows what a missing lease causes.
    ...(worker && result.hubReason === "clock_skew" && (RUNNER_LEASE_LOST_EXIT_REASONS.includes(worker.reason ?? "")
      || worker.backoff.some((item) => RUNNER_LEASE_LOST_EXIT_REASONS.includes(item.reason))) ? [RUNNER_CLOCK_SKEW_TEXT] : []),
    ...(late.length > 0 ? [`${LATE_LANDING_TEXT} Position${late.length === 1 ? "" : "s"}: ${late.join(", ")}.`] : [])];
  const opening = (worker?.opening ?? []).flatMap((item) => [`- Unopened buy ${item.buildDigest.slice(0, 16)}${item.reservationId ? ` (reservation ${item.reservationId})` : ""}: ${item.reason} (${item.kind}, ${item.tries} tr${item.tries === 1 ? "y" : "ies"})`,
    item.kind === "permanent" ? unprotectedText(result.agentId, item.reservationId) : unopenedText(result.agentId, item.reservationId)]);
  const backoff = (worker?.backoff ?? []).map((item) => `- Backoff ${item.positionId}: ${item.reason}, ${item.failures} failure${item.failures === 1 ? "" : "s"}, until ${new Date(item.untilMs).toISOString()}`);
  const unmanaged = result.unmanagedTotal > 0 ? [`Not managed (before enable): ${result.unmanagedTotal} completed buy${result.unmanagedTotal === 1 ? "" : "s"} from before automatic exits were enabled${result.managedSince === null ? "" : ` (${new Date(result.managedSince).toISOString()})`}; the runner never sells ${result.unmanagedTotal === 1 ? "it" : "them"} automatically.`,
    ...result.unmanaged.map((item) => `- Not managed ${item.reservationId}: mint ${item.tokenMint}, cost ${lamports(item.costLamports)}, completed ${new Date(item.completedAt).toISOString()}`)] : [];
  // Owner item 75: buys the owner took off automatic management.
  const owner = result.ownerUnmanagedTotal > 0 ? [`Not managed (by you): ${result.ownerUnmanagedTotal} completed buy${result.ownerUnmanagedTotal === 1 ? "" : "s"} you took off automatic management; the runner never sells ${result.ownerUnmanagedTotal === 1 ? "it" : "them"} automatically and has no stop-loss or take-profit for ${result.ownerUnmanagedTotal === 1 ? "it" : "them"}.`,
    ...result.ownerUnmanaged.map((item) => `- Not managed ${item.reservationId}: mint ${item.tokenMint}, taken off automatic management ${new Date(item.at).toISOString()}`)] : [];
  return [...head, ...(result.positions.length ? result.positions.flatMap((item) => positionLines(result.agentId, item, result.positions)) : ["No position is recorded."]),
    ...opening, ...backoff, ...unmanaged, ...owner, "Readback only: nothing was signed, sent, sold or changed.", ""].join("\n");
}

/** `runner status` lines for the exits summary (RunnerExecutionStatus.exits, already validated by the status parser). */
/** `clockSkew`: the same status reply's Hub reason is clock_skew. The Hub line already carries the clock text (once per output), so
 * a last pass that a missing lease explains only points to it. */
export function formatRunnerExitSummary(agentId: string, exits: RunnerExitSummary | "unavailable", hub: { clockSkew?: boolean } = {}): string {
  if (exits === "unavailable") return `    Exits: position ledger unavailable; new buys are held. Details: balchemy runner positions ${agentId}\n`;
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
  const clock = hub.clockSkew === true && RUNNER_LEASE_LOST_EXIT_REASONS.includes(exits.reason ?? "") ? " (no Hub lease: this computer's clock, see the Hub line)" : "";
  return [`    Exits: new buys ${entryHoldText(agentId, exits.entryHold)}; positions ${exits.open} open, ${exits.pending} exit pending, ${exits.held} held for review; ${plural(exits.unopened, "completed buy")} without a position; ${exits.backoff} in backoff; last pass ${exits.reason ?? "ok"}${clock}.`,
    ...exits.heldPositions.map((item) => manualOnly(item.holdReason)
      ? `    Held ${item.positionId}: ${item.holdReason}. No runner command can clear it; contact Balchemy support.`
      : item.holdReason === SELL_EXPIRY_UNPROVEN
      ? `    Held ${item.positionId}: ${item.holdReason}. Your RPC cannot prove this sell never landed: use an RPC with full transaction history, or arm the bot on your own RPC so the wallet balance can settle it. Details: balchemy runner positions ${agentId}`
      : item.holdReason === SELL_ENGINE_UNRESOLVED
      ? `    Held ${item.positionId}: ${item.holdReason}. Balchemy has not resolved this sell; the runner proves it on your own RPC (re-checked automatically). Details: balchemy runner trades ${agentId}`
      : privateRunnerHoldRechecked(item.holdReason)
      ? `    Held ${item.positionId}: ${item.holdReason} (re-checked automatically from the runner's own chain readback).`
      : item.holdReason.startsWith("runner:")
      ? `    Held ${item.positionId}: ${item.holdReason}. Review, then: balchemy runner positions ${agentId} ${RESOLVE_POSITION_ACTION} ${item.positionId}`
      : `    Held ${item.positionId}: ${item.holdReason} (retried automatically).`),
    // F2: runner disputes not released yet (bounded; the full list is runner trades).
    ...(exits.releaseChecks ?? []).map((item) => item.reason === "wire_blockhash_mismatch"
      ? `    Not released ${item.attemptKey}: ${item.reason} (permanent; never retried). Review: balchemy runner trades ${agentId}`
      : `    Not released yet ${item.attemptKey}: ${item.reason} (${runnerLandingReleaseRetry(item.reason)}). Details: balchemy runner trades ${agentId}`),
    ...(FEE_POLICY_EXIT_REASONS.includes(exits.reason ?? "") ? [`    ${FEE_POLICY_EXIT_TEXT}`] : []),
    ...(exits.reason === EXIT_BUDGET_REASON ? [`    ${EXIT_BUDGET_TEXT}`] : []),
    `    Details: balchemy runner positions ${agentId}`, ""].join("\n");
}
