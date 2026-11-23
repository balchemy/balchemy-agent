/** Wallet-balance settlement of a `runner:` hold (owner decision of 11 Nov 2026: "Bot cüzdana bakıp kendi karar versin"). A
 * position is held with a `runner:` reason when the settlement pass (private-submission.ts) could not tell whether its pending
 * exit sold. While it is held every buy is refused. This module proves the outcome from the wallet's own finalized token balance,
 * automatically, and refuses (fails closed) whenever the proof is not exact. It never signs, builds, relays or sells, and never
 * writes the journal; the one ledger commit is PrivatePositionLedger.settleByBalance (compare-and-set), made by
 * PrivatePositionRecovery.settleHeld after a second, fresh proof.
 *
 * Every condition must hold; any failure is a bounded refusal reason and nothing changes:
 * 0. The hold reason is one PRIVATE_RUNNER_HOLD_RULES lists (hold_unclassified otherwise; a row with no outcome is
 *    hold_manual_only). That one exhaustive table says, per hold reason, what the settlement pass had already READ of the sell
 *    when it created the hold, and which outcomes settlement may ever accept for it. Staying held is always allowed.
 *    Two engine rules narrow it further (engine_record_conflict): "not sold" is never accepted while Balchemy's record says the
 *    sell completed (attempt state `completed`, which two providers checked: the runner's single RPC cannot overrule it), nor
 *    while a copy signed outside this runner is possible (an observed copy or a runner dispute: it may still land after F;
 *    mirrors provePrivateHeldExit). An outcome the table does not list is hold_outcome_refused.
 * 1. The pending sell can no longer land: either the four-check runner-side expiry proof of its blockhash
 *    (privateExitExpiryProof, shared with the S5c settlement pass), or the journaled sell is present at finalized AND its blockhash
 *    is expired (checks 1-2 of that proof), so no copy of the same message can land later either. Either way the proof yields the
 *    finalized slot F every later read must reach.
 *    The read must be consistent with what the hold was created from, and the proof must agree with what the sell itself shows
 *    (evidence_conflict otherwise). An absent sell is accepted only for a hold created before any chain read (evidence `none`);
 *    for a hold created after the settlement pass read it ABSENT while Balchemy reported a terminal state (evidence `absent`,
 *    SF8) it refuses sell_absent: only the sell's own transaction settles such a hold here. For every other hold the settlement
 *    pass READ the sell present at finalized, so a later absence is an inconsistent RPC,
 *    never evidence. For a hold created after it read the sell LANDED (meta.err null, evidence `landed`), a later read whose
 *    meta.err has flipped to an error is an inconsistent RPC as well, never proof of "not sold". A sell present at finalized
 *    without error landed, so only "sold" is accepted; a present failure moved nothing, so only "not sold" is; when that shown
 *    outcome is not allowed for the hold (step 0) the proof refuses before any expiry or balance read.
 * 2. No other wallet-holding attempt of the wallet (wallet_busy), no unacknowledged observed copy (copy_unacknowledged), and no
 *    other released attempt (F2: a runner dispute whose bytes can no longer land) of the same mint (released_same_mint): it may
 *    have moved units of this mint, so the balance equation is unproven. Released attempts of other mints are ignored.
 * 3. The wallet's balance of the mint at finalized: every token account the owner holds under BOTH the Token and the Token-2022
 *    program (getTokenAccountsByOwner, one response per program), each response at a context slot at or past F, parsed strictly
 *    (exact layout, initialized or frozen, the owner field equal to the wallet). Accounts of the mint under the other program
 *    than the mint's own refuse.
 * 4. H = the held position's units before the exit, X = the pending exit's units, O = the remaining units of every other open
 *    position of the same wallet and mint. Another held position, or another pending exit, of that mint refuses; so does a
 *    completed buy of that mint on the wallet that has no position (unopened, or bought before automatic exits were enabled):
 *    its units would be in the balance but not in O. So does any mint bought before automatic exits were enabled
 *    (unmanaged_mint: the ledger's watermark keeps those mints for good, whether or not their attempts are still journaled, so
 *    waiting never clears it). balance == O + H: not sold. balance == O + H - X: sold. Anything else is balance_mismatch.
 * 5. The mint: classic Token, or Token-2022 with only the swap path's allowlisted extensions (privateSolanaMintFacts: no
 *    transfer fee, no transfer hook, nothing unlisted), and every Token-2022 account of it carries only extensions that never
 *    change its amount (ImmutableOwner, MemoTransfer, CpiGuard). Anything else refuses: the exact math is not proven.
 * Residual limit, stated rather than hidden: tokens of the mint moved in or out of the wallet outside the runner (a manual
 * transfer) change the balance; the equalities then usually fail (balance_mismatch), and the agreement with the sell's own
 * transaction (condition 1) refuses an outside move of exactly X units whenever the sell is present at finalized.
 * Latency: the reads that do not depend on each other run concurrently (the mint with the sell; the Token with the Token-2022
 * balance), so one proof is 4 sequential round trips with the sell present and 6 with it absent. The first rejection of such a
 * pair aborts the other read, and both have settled before the proof returns: no read of a proof outlives it. The caller's stop
 * (`halted`, the exit gate) is checked after every read, so after a halt no further read starts. */
import type { PrivateSellFactsRefusal } from "./private-position-facts.js";
import type { PrivatePosition } from "./private-positions.js";
import type { PrivateSolanaRpc } from "./private-solana-rpc.js";
import { privateSolanaMintFacts, token2022Extensions, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./private-solana-tx-validator.js";
import { isPrivateSubmissionTerminal, privateSubmissionCopyHeld, privateSubmissionEngineReportedLanding, privateSubmissionHoldsWallet, privateSubmissionOwnerClosed,
  privateSubmissionReleased, type PrivateSubmissionAttempt } from "./private-submission-journal.js";
import { isRecord, type RunnerBuyCheckReason } from "./protocol.js";
import { encodeBase58 } from "./solana-base58.js";
import { isPrivateDualSolanaRpc } from "./private-solana-rpc-sources.js";

/** Blocks past Balchemy's lastValidBlockHeight before the runner's finalized chain may prove an expiry (see private-submission.ts). */
export const PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS = 150n;
/** Final audit N1: the most history witnesses one sell expiry proof sends (all in its one getSignatureStatuses call). */
export const PRIVATE_SELL_WITNESS_MAX = 3;
export type PrivateExitExpiryRpc = Pick<PrivateSolanaRpc, "getTransaction" | "getEpochInfo" | "isBlockhashValid" | "getSignatureStatuses">;
export type PrivateBalanceRpc = PrivateExitExpiryRpc & Pick<PrivateSolanaRpc, "getAccountInfo" | "getTokenAccountsByOwner">;
/** SF2: the settlement RPC of a dropped-buy proof. The balance reads are optional: without them the balance path (b) is not run. */
export type PrivateBuyProofRpc = PrivateExitExpiryRpc & Partial<Pick<PrivateSolanaRpc, "getAccountInfo" | "getTokenAccountsByOwner">>;
type Stop = () => boolean;

/** Checks 1-2 of the expiry proof: one finalized bank (its slot F) more than PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS past the
 * attempt's lastValidBlockHeight, and isBlockhashValid(processed) false on a backend at or past F. F, or null. May throw.
 * Exported for the F2 release proof (private-submission.ts #closeLandings), which runs it twice from fresh reads. */
export async function privateBlockhashExpired(rpc: PrivateExitExpiryRpc, attempt: PrivateSubmissionAttempt, stop: Stop, signal?: AbortSignal): Promise<bigint | null> {
  // Owner decision of 17 Nov 2026 (two Balchemy-provided sources): a negative proof holds only when it holds WHOLE on each source.
  // F is then the higher of the two (the bytes cannot land after either, so not after the later one; every later read must reach it).
  if (isPrivateDualSolanaRpc(rpc)) {
    const [a, b] = rpc.readers;
    const first = await blockhashExpiredOne(a, attempt, stop, signal);
    if (first === null || stop()) return null;
    const second = await blockhashExpiredOne(b, attempt, stop, signal);
    return second === null ? null : first > second ? first : second;
  }
  return blockhashExpiredOne(rpc, attempt, stop, signal);
}
async function blockhashExpiredOne(rpc: PrivateExitExpiryRpc, attempt: PrivateSubmissionAttempt, stop: Stop, signal?: AbortSignal): Promise<bigint | null> {
  let lastValid: bigint;
  try { lastValid = BigInt(attempt.lastValidBlockHeight); } catch { return null; }
  const finalized = await rpc.getEpochInfo({ commitment: "finalized" }, signal);
  if (stop() || !(finalized.blockHeight > lastValid + PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS)) return null;
  const blockhash = await rpc.isBlockhashValid(attempt.blockhash, { commitment: "processed" }, signal);
  if (stop() || blockhash.valid !== false || blockhash.contextSlot < finalized.absoluteSlot) return null;
  return finalized.absoluteSlot;
}

/** Why one run of the expiry proof did not hold (final audit S1). `deadSlot` is the F of checks 1-2 when they held (the bytes can no
 * longer land after it), else null. Only `witness_unproven` with a `deadSlot` is ever counted toward a sell's bound
 * (private-submission.ts): the blockhash is dead, yet the response that showed the sell absent did not show the witness finalized,
 * so only an RPC whose history reaches back far enough can still prove it. */
export const PRIVATE_EXIT_EXPIRY_UNPROVEN = ["expiry_unproven", "rpc_unavailable", "rpc_lagging", "transaction_appeared", "witness_unproven"] as const;
export type PrivateExitExpiryUnproven = typeof PRIVATE_EXIT_EXPIRY_UNPROVEN[number];
export type PrivateExitExpiryCheck = { readonly outcome: "proven"; readonly slot: bigint }
  | { readonly outcome: "unproven"; readonly reason: PrivateExitExpiryUnproven; readonly deadSlot: bigint | null };

/** Runner-side proof that an exit sell never landed and never can, from the agent's own RPC only (moved unchanged from
 * PrivateSubmissions.#provenExpired; final audit S1 adds only the reason of a run that did not hold and the witness rule). Any read
 * that is unavailable, inconsistent or short of the bound proves nothing:
 * 1. One finalized bank (getEpochInfo: its slot F and block height in the same response) is more than
 *    PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS past Balchemy's lastValidBlockHeight, so an understated value cannot free the units.
 * 2. isBlockhashValid(blockhash, processed) is false on a backend whose processed slot is at or past F.
 * 3. getSignatureStatuses([sell, ...witnesses], searchTransactionHistory) answered by ONE backend at or past F: the sell is absent
 *    while at least one older witness (privateSellWitnesses: transactions of the same wallet that each landed before this sell
 *    existed; final audit N1: up to PRIVATE_SELL_WITNESS_MAX of them, all in that one call) is found finalized without error (a
 *    history witness in the same response). A witness equal to the sell's own signature is never sent and proves nothing.
 * 4. getTransaction(finalized) of the journaled signature is still absent after all of that.
 * Never throws. */
export async function privateExitExpiryCheck(rpc: PrivateExitExpiryRpc, attempt: PrivateSubmissionAttempt, witness: string | readonly string[], signal?: AbortSignal,
  stop: Stop = () => signal?.aborted === true): Promise<PrivateExitExpiryCheck> {
  if (!isPrivateDualSolanaRpc(rpc)) return exitExpiryCheckOne(rpc, attempt, witness, signal, stop);
  // Two Balchemy-provided sources: the whole four-check proof runs on each; it holds only when both hold (combineExpiryChecks).
  const [a, b] = rpc.readers;
  const first = await exitExpiryCheckOne(a, attempt, witness, signal, stop);
  if (stop()) return Object.freeze({ outcome: "unproven" as const, reason: "rpc_unavailable" as const, deadSlot: null });
  return privateCombineExpiryChecks(first, await exitExpiryCheckOne(b, attempt, witness, signal, stop));
}
/** Least advanced first: the combined reason of two runs is the one that concludes less. */
const EXPIRY_UNPROVEN_ORDER: readonly PrivateExitExpiryUnproven[] = ["transaction_appeared", "rpc_unavailable", "rpc_lagging", "expiry_unproven", "witness_unproven"];
/** Two sources' runs of the expiry proof: proven only when both are (F the higher one); otherwise the reason that concludes less, and
 * a dead slot only when the blockhash was proven dead on both (only such a run ever counts toward a sell's bound). */
export function privateCombineExpiryChecks(first: PrivateExitExpiryCheck, second: PrivateExitExpiryCheck): PrivateExitExpiryCheck {
  const dead = (check: PrivateExitExpiryCheck): bigint | null => (check.outcome === "proven" ? check.slot : check.deadSlot);
  const [x, y] = [dead(first), dead(second)];
  const slot = x !== null && y !== null ? (x > y ? x : y) : null;
  if (first.outcome === "proven" && second.outcome === "proven") return Object.freeze({ outcome: "proven" as const, slot: slot! });
  const reasons = [first, second].flatMap((check) => (check.outcome === "unproven" ? [check.reason] : []));
  const reason = EXPIRY_UNPROVEN_ORDER.find((item) => reasons.includes(item)) ?? "rpc_unavailable";
  return Object.freeze({ outcome: "unproven" as const, reason, deadSlot: slot });
}
async function exitExpiryCheckOne(rpc: PrivateExitExpiryRpc, attempt: PrivateSubmissionAttempt, witness: string | readonly string[], signal?: AbortSignal,
  stop: Stop = () => signal?.aborted === true): Promise<PrivateExitExpiryCheck> {
  let dead: bigint | null = null;
  const unproven = (reason: PrivateExitExpiryUnproven): PrivateExitExpiryCheck => Object.freeze({ outcome: "unproven" as const, reason, deadSlot: dead });
  try {
    const witnesses = [...new Set(typeof witness === "string" ? [witness] : witness)].filter((item) => item !== attempt.signature)
      .slice(0, PRIVATE_SELL_WITNESS_MAX);
    const slot = await blockhashExpiredOne(rpc, attempt, stop, signal);
    if (stop()) return unproven("rpc_unavailable");
    if (slot === null) return unproven("expiry_unproven");
    dead = slot;
    if (witnesses.length === 0) return unproven("witness_unproven");
    const found = await rpc.getSignatureStatuses([attempt.signature, ...witnesses], { searchTransactionHistory: true }, signal);
    if (stop() || found.statuses.length !== 1 + witnesses.length) return unproven("rpc_unavailable");
    if (found.contextSlot < slot) return unproven("rpc_lagging");
    if (found.statuses[0] !== null) return unproven("transaction_appeared");
    // Any one witness finalized without error in this same response shows the history reaches back past every slot the sell could use.
    if (!found.statuses.slice(1).some((entry) => entry !== null && entry !== undefined && !entry.failed && entry.confirmationStatus === "finalized")) {
      return unproven("witness_unproven");
    }
    const again = await rpc.getTransaction(attempt.signature, { commitment: "finalized" }, signal);
    if (stop()) return unproven("rpc_unavailable");
    return again === null ? Object.freeze({ outcome: "proven" as const, slot }) : unproven("transaction_appeared");
  } catch { return unproven("rpc_unavailable"); }
}
/** privateExitExpiryCheck as F when proven, else null. */
export async function privateExitExpiryProof(rpc: PrivateExitExpiryRpc, attempt: PrivateSubmissionAttempt, witness: string | readonly string[], signal?: AbortSignal,
  stop: Stop = () => signal?.aborted === true): Promise<bigint | null> {
  const checked = await privateExitExpiryCheck(rpc, attempt, witness, signal, stop);
  return checked.outcome === "proven" ? checked.slot : null;
}
/** Final audit S1 and N1: the history witnesses of a sell's expiry proof, newest first, the rule buys already use (privateBuyWitness):
 * the newest completed journal attempts of the same wallet created before this sell (each journaled signature landed: no observed
 * copy) that are newer than the position's opening, at most PRIVATE_SELL_WITNESS_MAX - 1 of them, then the position's own entry buy
 * (the only witness before S1) as the last fallback. Every candidate landed before this sell existed: a completed attempt held the
 * wallet lock until Balchemy reported it completed (or, released, could not land after its F, proven before its lock was freed), and
 * the entry buy landed before its position opened. So a backend whose history shows ANY of them finalized without error in the same
 * response, at or past F, reaches back past every slot this sell could have landed in. A recent witness needs only a short history,
 * so a position older than the owner's RPC can search is no longer unprovable; several of them in one call keep one witness the RPC
 * cannot show (pruned, or its status not served) from blocking every later sell. Liveness only: the proof is exactly as strict. */
export function privateSellWitnesses(attempt: PrivateSubmissionAttempt, attempts: readonly PrivateSubmissionAttempt[], position: PrivatePosition): readonly string[] {
  const wallet = attempt.walletAddress; const entry = position.entry.signature;
  const newer = attempts.filter((item) => item.attemptKey !== attempt.attemptKey && item.walletAddress === wallet && item.state === "completed"
    && item.observedSignature === null && item.createdAt < attempt.createdAt && item.signature !== attempt.signature && item.signature !== entry
    && item.createdAt > position.createdAt)
    .sort((a, b) => b.createdAt - a.createdAt || (a.attemptKey < b.attemptKey ? -1 : 1));
  return Object.freeze([...new Set(newer.map((item) => item.signature))].slice(0, PRIVATE_SELL_WITNESS_MAX - 1).concat(entry));
}
/** The first (newest) witness of privateSellWitnesses: the single witness S1 sent. */
export function privateSellWitness(attempt: PrivateSubmissionAttempt, attempts: readonly PrivateSubmissionAttempt[], position: PrivatePosition): string {
  return privateSellWitnesses(attempt, attempts, position)[0]!;
}

export const PRIVATE_BALANCE_REFUSALS = ["not_runner_held", "hold_unclassified", "hold_manual_only", "hold_outcome_refused", "attempt_missing", "attempt_mismatch", "copy_unacknowledged", "wallet_busy", "released_same_mint",
  "other_position_held", "other_exit_pending", "unmanaged_balance", "unmanaged_mint", "watermark_missing", "evidence_conflict", "engine_record_conflict", "rpc_missing", "rpc_unavailable", "mint_unsupported", "token_2022_extension",
  "transaction_malformed", "signature_mismatch", "expiry_unproven", "rpc_lagging", "token_account_malformed", "token_account_program_mismatch",
  "balance_mismatch", "sell_absent"] as const;
export type PrivateBalanceRefusal = typeof PRIVATE_BALANCE_REFUSALS[number];
export type PrivateBalanceProof =
  | { readonly outcome: "proven"; readonly result: "sold" | "not_sold"; readonly balance: string; readonly heldUnits: string; readonly exitUnits: string;
      readonly otherUnits: string; readonly finalizedSlot: string }
  | { readonly outcome: "refused"; readonly reason: PrivateBalanceRefusal };
/** A held position the proof may run for, with exactly the facts it proves against (all read synchronously). `witness` is the sell's
 * history witnesses (privateSellWitnesses), for the four-check expiry proof of an absent sell. */
export type PrivateBalanceCandidate = { readonly ok: true; readonly position: PrivatePosition; readonly attempt: PrivateSubmissionAttempt; readonly otherUnits: string;
  readonly witness: string | readonly string[] }
  | { readonly ok: false; readonly reason: PrivateBalanceRefusal };

const refuse = (reason: PrivateBalanceRefusal): { readonly ok: false; readonly reason: PrivateBalanceRefusal } => Object.freeze({ ok: false as const, reason });
const refused = (reason: PrivateBalanceRefusal): PrivateBalanceProof => Object.freeze({ outcome: "refused" as const, reason });
/** Token-2022 account extensions that never change an account's amount. */
const NEUTRAL_ACCOUNT_EXTENSIONS: readonly number[] = [7, 8, 11];
const ACCOUNT_LEN = 165;

export type PrivateBalanceOutcome = "sold" | "not_sold";
/** privateSellProceeds refusals the settlement pass holds as `runner:` (transaction_missing is retried; transaction_malformed and
 * balances_missing are `s5c:` holds). */
export type PrivateRunnerSellFactsHold = Exclude<PrivateSellFactsRefusal, "transaction_missing" | "transaction_malformed" | "balances_missing">;
/** Every `runner:` hold reason private-submission.ts #settleExit can create; its `hold` accepts only these (and `s5c:` reasons),
 * so the compiler keeps PRIVATE_RUNNER_HOLD_RULES exhaustive. */
export type PrivateRunnerHoldReason = "runner:exit_attempt_mismatch" | "runner:observed_copy" | "runner:exit_disputed"
  | "runner:sell_landed_despite_failed_onchain" | "runner:sell_landed_despite_expired_not_landed" | `runner:sell_facts_${PrivateRunnerSellFactsHold}`
  | PrivateRunnerRecheckedHold | "runner:completed_contradicted_by_expiry";
/** SF8 (M3.6 D18): the `runner:` holds #settleExit names while it waits for the runner's own proof of a sell Balchemy reported
 * terminal but the runner's finalized chain does not show (absent at finalized). Unlike every other `runner:` hold, the settlement
 * pass itself re-checks them on every pass (they never wait for the owner):
 * - failed_onchain_transaction_missing: Balchemy said failed_onchain. A failed transaction lands, so absence alone proves nothing;
 *   once the four-check expiry proof (privateExitExpiryProof) holds, the bytes can never land and Balchemy also says negative:
 *   proven_negative (units back, the exit is re-planned, as for expired_not_landed).
 * - completed_transaction_missing: Balchemy said completed. Once the expiry proof holds, the runner's own proof contradicts
 *   Balchemy's record: renamed runner:completed_contradicted_by_expiry (an owner hold, never re-checked; never "not sold").
 * If the sell appears at finalized meanwhile, the existing landed and failed branches settle it. */
/** Final audit S1 adds two more:
 * - expired_not_landed_transaction_missing: Balchemy said expired_not_landed (or the runner closed a sell Balchemy never received), and
 *   the sell is absent at finalized. Before S1 this wait had no name. Exactly as failed_onchain_transaction_missing.
 * - sell_expiry_unproven: either of the two negative waits reached its bound (private-submission.ts PRIVATE_SELL_EXPIRY_BOUND: the
 *   blockhash proven dead at strictly increasing F over at least 10 minutes, yet the owner's RPC never showed the history witness
 *   in the response that showed the sell absent). Still re-checked, at the capped back-off, so an RPC with enough history settles it;
 *   it also opens the owner's balance path (its row below: "not sold" only, only from the wallet balance at or past a fresh F).
 * Every re-check waits (final audit SF1: 30 s doubling to 10 min while the history witness is unproven, 15 s after any other result);
 * the four proof reads never run every 5 s (only the sell's own getTransaction does). */
/** Final audit part 3 SF-A adds one more:
 * - sell_engine_unresolved: Balchemy relayed this sell and leaves it unresolved (its engine record still prepared or submitted), and the
 *   runner's own finalized view has passed its lastValidBlockHeight + 150 (private-submission.ts #settleStalledSells). It waits out
 *   PRIVATE_SELL_STALL_GRACE_MS (the engine's own landing window), then the runner proves the sell itself: landed or failed (the sell's own
 *   finalized transaction), or not landed (the four-check expiry proof: the exit is cleared, the units return), or, at
 *   PRIVATE_SELL_EXPIRY_BOUND, runner:sell_expiry_unproven. Only a sale from the sell's own finalized transaction settles it here. */
export const PRIVATE_RUNNER_RECHECKED_HOLDS = ["runner:failed_onchain_transaction_missing", "runner:completed_transaction_missing",
  "runner:expired_not_landed_transaction_missing", "runner:sell_expiry_unproven", "runner:sell_engine_unresolved"] as const;
export type PrivateRunnerRecheckedHold = typeof PRIVATE_RUNNER_RECHECKED_HOLDS[number];
/** A hold #settleExit re-checks itself on every pass (PRIVATE_RUNNER_RECHECKED_HOLDS). */
export function privateRunnerHoldRechecked(holdReason: string | null): boolean {
  return (PRIVATE_RUNNER_RECHECKED_HOLDS as readonly (string | null)[]).includes(holdReason);
}
/** What #settleExit had READ of the journaled sell when it created the hold:
 * - none:    created before any chain read; an absent sell may be settled through the four-check expiry proof;
 * - absent:  (SF8) read ABSENT at finalized while Balchemy reported a terminal state; only the sell's own finalized transaction
 *            settles it here, so an absent sell refuses (sell_absent) before any expiry or balance read: a wallet balance short
 *            of the exit's units with the sell absent is never a sale, and "not sold" is the settlement pass's own expiry proof;
 * - present: read present at finalized (with or without error); a later absence is an inconsistent RPC;
 * - landed:  read present at finalized with meta.err null; a later absence, or a later error, is an inconsistent RPC.
 * - expired: (S1) read ABSENT at finalized after Balchemy's negative state, its blockhash proven dead on the runner's own RPC, but the
 *            history witness never proven. An absent sell settles here only as "not sold", and only when checks 1-2 of the expiry
 *            proof hold again at a fresh F and the wallet's balance at or past that F still holds the exit's units (O + H): the
 *            bytes cannot land after F, and a landing before F would have debited them. Never "sold" from a balance while the sell is
 *            absent (the SF8 rule); a present sell follows the present-sell rules. */
export type PrivateRunnerHoldEvidence = "none" | "absent" | "present" | "landed" | "expired";
export interface PrivateRunnerHoldRule { readonly evidence: PrivateRunnerHoldEvidence; readonly outcomes: readonly PrivateBalanceOutcome[] }
const rule = (evidence: PrivateRunnerHoldEvidence, outcomes: readonly PrivateBalanceOutcome[]): PrivateRunnerHoldRule =>
  Object.freeze({ evidence, outcomes: Object.freeze([...outcomes]) });
/** Landed without error, then held because its facts contradicted what was signed: the units left with it, or nothing is proven. */
const LANDED_SOLD = rule("landed", ["sold"]);
/** The one exhaustive table: hold reason -> what was read, and the outcomes settlement may accept (staying held is always allowed).
 * The engine rules (module comment, step 0) apply on top of it. */
export const PRIVATE_RUNNER_HOLD_RULES: Readonly<Record<PrivateRunnerHoldReason, PrivateRunnerHoldRule>> = Object.freeze({
  // The journal attempt does not describe this exit (other position, wallet, mint or units): its signature and the balance
  // arithmetic prove nothing about the pending exit. Owner resolution only.
  "runner:exit_attempt_mismatch": rule("none", []),
  // A copy signed outside this runner landed: it, or another copy, may still land, so only a sale is ever proven.
  "runner:observed_copy": rule("none", ["sold"]),
  // Balchemy's record contradicted the journal (runner dispute): another copy cannot be ruled out, so only a sale.
  "runner:exit_disputed": rule("none", ["sold"]),
  // Balchemy said failed or expired, the runner READ the sell landed without error: only a sale; a later error is inconsistency.
  "runner:sell_landed_despite_failed_onchain": LANDED_SOLD,
  "runner:sell_landed_despite_expired_not_landed": LANDED_SOLD,
  // Balchemy said completed (two providers), the runner's single RPC read the sell failed: that RPC can never reopen the
  // position. Only a sale, once a later read shows it landed and the balance agrees.
  "runner:sell_facts_transaction_failed": rule("present", ["sold"]),
  // The RPC served another transaction under the journaled signature. Read before meta.err: the sell's own later finalized result
  // decides (the engine rule still refuses "not sold" while Balchemy's record says completed).
  "runner:sell_facts_signature_mismatch": rule("present", ["sold", "not_sold"]),
  // privateSellProceeds checks meta.err before these: each was read landed without error.
  "runner:sell_facts_fee_payer_mismatch": LANDED_SOLD,
  "runner:sell_facts_input_debit_mismatch": LANDED_SOLD,
  "runner:sell_facts_wallet_token_balance_decreased": LANDED_SOLD,
  "runner:sell_facts_wsol_account_missing": LANDED_SOLD,
  "runner:sell_facts_wsol_account_mismatch": LANDED_SOLD,
  "runner:sell_facts_wsol_not_closed": LANDED_SOLD,
  "runner:sell_facts_proceeds_negative": LANDED_SOLD,
  // SF8: read ABSENT at finalized. The settlement pass re-checks both itself. Here only a sale, and only from the sell's own
  // finalized transaction: "not sold" for the failed_onchain one is the settlement pass's own proven_negative (the four-check
  // expiry proof, which re-plans the exit), never a balance settlement; for the completed ones the engine rule refuses it anyway.
  "runner:failed_onchain_transaction_missing": rule("absent", ["sold"]),
  "runner:completed_transaction_missing": rule("absent", ["sold"]),
  // S1: the expired_not_landed twin of failed_onchain_transaction_missing, exactly as strict.
  "runner:expired_not_landed_transaction_missing": rule("absent", ["sold"]),
  // S1: a negative wait that reached its bound. Only "not sold", only from the balance after checks 1-2 at a fresh F (evidence
  // `expired`, module comment); the engine rule still refuses it for an observed copy or a runner dispute. A sale is settled by the
  // settlement pass from the sell's own finalized transaction, should it appear.
  "runner:sell_expiry_unproven": rule("expired", ["not_sold"]),
  // SF8: Balchemy said completed, and the runner's own four-check expiry proof shows these bytes never landed and never can. The
  // runner decides neither way on its own: an owner hold (exempt from I7 by design). Only a sale, should a later finalized read
  // show the sell landed after all.
  "runner:completed_contradicted_by_expiry": rule("absent", ["sold"]),
  // SF-A: Balchemy leaves the relayed sell unresolved and the runner has not proven it yet. Exactly as strict as the SF8 waits: only a sale,
  // only from the sell's own finalized transaction; "not sold" is the settlement pass's own four-check expiry proof, never the balance.
  "runner:sell_engine_unresolved": rule("absent", ["sold"]),
});
/** The table row of a hold reason, or undefined for any reason it does not list. */
export function privateRunnerHoldRule(holdReason: string | null): PrivateRunnerHoldRule | undefined {
  return holdReason !== null && Object.prototype.hasOwnProperty.call(PRIVATE_RUNNER_HOLD_RULES, holdReason)
    ? PRIVATE_RUNNER_HOLD_RULES[holdReason as PrivateRunnerHoldReason] : undefined;
}
/** The journal attempt carries evidence of a copy this runner did not sign, or Balchemy's record contradicted it. Owner decision 26:
 * an attempt the owner closed out (closed_by_owner) proves nothing either, so it never supports "not sold". */
const outsideCopyPossible = (attempt: PrivateSubmissionAttempt): boolean => attempt.observedSignature !== null
  || (attempt.state === "disputed" && (attempt.reason ?? "").startsWith("runner:")) || privateSubmissionOwnerClosed(attempt);
/** F2 and owner decision 26: an attempt of the wallet whose outcome is unknown but which can no longer land (released and not yet
 * terminal, or closed out by the owner): it may have moved units of its mint. A released attempt that later became terminal has a
 * known outcome: R4 proved on the runner's own RPC that it did not land (spend released), or Balchemy's `completed` was committed
 * (its mint is then an outside or pre-enable mint, refused on its own as unmanaged). */
const settledUnknown = (item: PrivateSubmissionAttempt): boolean => (privateSubmissionReleased(item) && !isPrivateSubmissionTerminal(item.state))
  || privateSubmissionOwnerClosed(item);
/** Why `outcome` may not settle this hold (the table, then the engine rules), or null when it may. Shared with the owner's
 * verify/resolve proof (provePrivateHeldExit), so neither path accepts an outcome the other refuses. */
export function privateRunnerOutcomeRefusal(holdRule: PrivateRunnerHoldRule, attempt: PrivateSubmissionAttempt, outcome: PrivateBalanceOutcome): PrivateBalanceRefusal | null {
  if (!holdRule.outcomes.includes(outcome)) return "hold_outcome_refused";
  // SF-A: also when Balchemy reported a landing later, on a sell the runner had itself written terminal-negative (recordLateReport).
  if (outcome === "not_sold" && (attempt.state === "completed" || privateSubmissionEngineReportedLanding(attempt) || outsideCopyPossible(attempt))) return "engine_record_conflict";
  return null;
}

/** Conditions 2 and 4 (local, synchronous): the position is held with a `runner:` reason, its journaled sell matches the pending
 * exit, nothing else on the wallet can move the mint, and every unit of the mint in the wallet is tracked by the ledger.
 * `unmanagedMints` are the ledger watermark's mints bought before enable; null while no watermark is recorded (refused). */
export function privateBalanceCandidate(position: PrivatePosition | undefined, positions: readonly PrivatePosition[],
  attempts: readonly PrivateSubmissionAttempt[], evicted: readonly string[], unmanagedMints: readonly string[] | null): PrivateBalanceCandidate {
  const pending = position?.pendingExit;
  if (!position || position.state !== "held" || !pending || !(position.holdReason ?? "").startsWith("runner:")) return refuse("not_runner_held");
  const holdRule = privateRunnerHoldRule(position.holdReason);
  if (!holdRule) return refuse("hold_unclassified");
  if (holdRule.outcomes.length === 0) return refuse("hold_manual_only");
  const attempt = attempts.find((item) => item.reservationId === pending.reservationId);
  if (!attempt) return refuse("attempt_missing");
  const swap = attempt.swap;
  if (swap.direction !== "sell" || swap.positionId !== position.positionId || attempt.walletAddress !== position.walletAddress
    || swap.inputMint !== position.tokenMint || swap.grossInUnits !== pending.units) return refuse("attempt_mismatch");
  const wallet = position.walletAddress;
  if (attempts.some((item) => item.walletAddress === wallet && privateSubmissionCopyHeld(item))) return refuse("copy_unacknowledged");
  if (attempts.some((item) => item.attemptKey !== attempt.attemptKey && item.walletAddress === wallet && privateSubmissionHoldsWallet(item))) {
    return refuse("wallet_busy");
  }
  // F2: a released attempt (cannot land after its F, but its outcome is unknown) of this mint may have moved these units; so may an
  // attempt the owner closed out (owner decision 26).
  if (attempts.some((item) => item.attemptKey !== attempt.attemptKey && item.walletAddress === wallet && settledUnknown(item)
    && (item.swap.direction === "buy" ? item.swap.outputMint : item.swap.inputMint) === position.tokenMint)) return refuse("released_same_mint");
  const same = positions.filter((item) => item.positionId !== position.positionId && item.state !== "closed" && item.walletAddress === wallet
    && item.tokenMint === position.tokenMint);
  if (same.some((item) => item.state === "held")) return refuse("other_position_held");
  if (same.some((item) => item.pendingExit !== null)) return refuse("other_exit_pending");
  if (unmanagedMints === null) return refuse("watermark_missing");
  if (unmanagedMints.includes(position.tokenMint)) return refuse("unmanaged_mint");
  const tracked = new Set(positions.map((item) => item.entry.reservationId)); const gone = new Set(evicted);
  if (attempts.some((item) => item.swap.direction === "buy" && item.swap.outputMint === position.tokenMint && item.walletAddress === wallet
    && item.state === "completed" && !tracked.has(item.reservationId) && !gone.has(item.reservationId))) return refuse("unmanaged_balance");
  const otherUnits = same.reduce((sum, item) => sum + BigInt(item.remainingUnits), 0n).toString();
  return Object.freeze({ ok: true as const, position, attempt, otherUnits, witness: privateSellWitnesses(attempt, attempts, position) });
}

/** One token account's facts (exact layout), or undefined when malformed. */
function tokenAccount(data: Uint8Array, program: string): { mint: string; owner: string; amount: bigint; extensions: readonly number[] } | undefined {
  if (!(data instanceof Uint8Array) || data.length < ACCOUNT_LEN) return undefined;
  let extensions: readonly number[] = [];
  if (data.length !== ACCOUNT_LEN) {
    if (program !== TOKEN_2022_PROGRAM) return undefined;
    const parsed = token2022Extensions(data, 2);
    if (!parsed) return undefined;
    extensions = parsed;
  }
  // AccountState: 1 initialized, 2 frozen (a frozen balance is still the wallet's); 0 uninitialized is malformed here.
  if (data[108] !== 1 && data[108] !== 2) return undefined;
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return { mint: encodeBase58(data.subarray(0, 32)), owner: encodeBase58(data.subarray(32, 64)), amount: bytes.readBigUInt64LE(64), extensions };
}

/** Two independent reads in one round trip. The first rejection aborts the other (`abort`), and both have settled before this
 * returns or throws, so neither outlives the proof (nor the recovery lock it runs under). */
async function pair<A, B>(abort: () => void, first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const fail = (error: unknown): never => { abort(); throw error; };
  const [a, b] = await Promise.allSettled([first.catch(fail), second.catch(fail)]);
  if (a.status === "rejected") throw a.reason;
  if (b.status === "rejected") throw b.reason;
  return [a.value, b.value];
}

/** Conditions 1, 3, 4 and 5 for one candidate, from the agent's own RPC (finalized reads only). Never throws, never writes.
 * `halted` (true stops) is checked after every read: once it is true no further read starts and nothing is proven. */
export async function provePrivateBalanceSettlement(candidate: Extract<PrivateBalanceCandidate, { ok: true }>, rpc: PrivateBalanceRpc | undefined,
  signal?: AbortSignal, halted?: Stop): Promise<PrivateBalanceProof> {
  if (!isPrivateDualSolanaRpc(rpc)) return balanceSettlementOne(candidate, rpc, signal, halted);
  // Two Balchemy-provided sources: either outcome ("sold" or "not sold") settles a held position, so the whole proof must hold on
  // BOTH with the same result and balance; anything else stays held (the first refusal's reason; a contradiction is evidence_conflict).
  const [a, b] = rpc.readers;
  const first = await balanceSettlementOne(candidate, a, signal, halted);
  if (first.outcome !== "proven") return first;
  if (signal?.aborted || halted?.() === true) return refused("rpc_unavailable");
  const second = await balanceSettlementOne(candidate, b, signal, halted);
  if (second.outcome !== "proven") return second;
  if (first.result !== second.result || first.balance !== second.balance) { rpc.disagree(); return refused("evidence_conflict"); }
  return BigInt(second.finalizedSlot) > BigInt(first.finalizedSlot) ? second : first;
}
async function balanceSettlementOne(candidate: Extract<PrivateBalanceCandidate, { ok: true }>, rpc: PrivateBalanceRpc | undefined,
  signal?: AbortSignal, halted?: Stop): Promise<PrivateBalanceProof> {
  const { position, attempt } = candidate; const pending = position.pendingExit;
  if (!pending) return refused("not_runner_held");
  // 0. The hold's row of the table (re-derived here, so the proof alone never accepts an outcome the table forbids).
  const holdRule = privateRunnerHoldRule(position.holdReason);
  if (!holdRule) return refused("hold_unclassified");
  if (holdRule.outcomes.length === 0) return refused("hold_manual_only");
  if (!rpc) return refused("rpc_missing");
  // Every read of this proof runs under `reads`: linked to the caller's signal, aborted by the first rejected read of a pair and
  // once the proof ends.
  const reads = new AbortController(); const read = reads.signal;
  const forward = (): void => reads.abort();
  const abort = (): void => reads.abort();
  if (signal?.aborted) reads.abort(); else signal?.addEventListener("abort", forward, { once: true });
  const stop = (): boolean => read.aborted || halted?.() === true;
  try {
    if (stop()) return refused("rpc_unavailable");
    // 5 and 1: the mint (immutable after initialization) and the journaled sell are independent reads: one round trip.
    const [mint, sell] = await pair(abort, rpc.getAccountInfo(position.tokenMint, { commitment: "finalized" }, read),
      rpc.getTransaction(attempt.signature, { commitment: "finalized" }, read));
    if (stop()) return refused("rpc_unavailable");
    // 5. The mint program and extensions.
    if (!mint) return refused("mint_unsupported");
    const facts = privateSolanaMintFacts(mint);
    if (!facts.ok) return refused(facts.reason.startsWith("mint_not_supported:token_2022") ? "token_2022_extension" : "mint_unsupported");
    // 1. The pending sell can no longer land.
    let finalizedSlot: bigint | null;
    /** What the sell's own finalized transaction proves: present without error, it landed; present with an error, it moved nothing. */
    let shown: PrivateBalanceOutcome | null = null;
    if (sell === null) {
      // SF8: read absent, Balchemy said terminal: only the sell's own transaction settles it here.
      if (holdRule.evidence === "absent") return refused("sell_absent");
      // S1 (evidence `expired`): checks 1-2 at a fresh F only; the balance at or past F decides, and only "not sold" (the row and the
      // late check below refuse a sale while the sell is absent).
      if (holdRule.evidence === "expired") finalizedSlot = await blockhashExpiredOne(rpc, attempt, stop, read);
      // The settlement pass read this sell present at finalized before it created this hold: a later absence proves nothing.
      else if (holdRule.evidence !== "none") return refused("evidence_conflict");
      else {
        const checked = await exitExpiryCheckOne(rpc, attempt, candidate.witness, read, stop);
        finalizedSlot = checked.outcome === "proven" ? checked.slot : null;
      }
    } else {
      const body = isRecord(sell.transaction) ? sell.transaction : undefined;
      const meta = isRecord(sell.meta) ? sell.meta : undefined;
      const signatures = body?.signatures; const slot = sell.slot;
      if (!meta || !("err" in meta) || !Array.isArray(signatures) || typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) {
        return refused("transaction_malformed");
      }
      if (signatures.length !== 1 || signatures[0] !== attempt.signature) return refused("signature_mismatch");
      shown = meta.err === null ? "sold" : "not_sold";
      // The settlement pass read this sell LANDED before it created this hold: a later error is an inconsistent RPC.
      if (holdRule.evidence === "landed" && shown !== "sold") return refused("evidence_conflict");
      // The sell's own result is not an outcome this hold may settle to: refused before any expiry or balance read.
      const early = privateRunnerOutcomeRefusal(holdRule, attempt, shown);
      if (early) return refused(early);
      finalizedSlot = await blockhashExpiredOne(rpc, attempt, stop, read);
      if (finalizedSlot !== null && BigInt(slot) > finalizedSlot) return refused("rpc_lagging");
    }
    if (stop()) return refused("rpc_unavailable");
    if (finalizedSlot === null) return refused("expiry_unproven");
    // 3. The wallet's balance of the mint under both token programs (two independent reads, one round trip), each response at or
    // past F.
    const programs = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM] as const;
    const accounts = await pair(abort, rpc.getTokenAccountsByOwner(position.walletAddress, programs[0], { commitment: "finalized" }, read),
      rpc.getTokenAccountsByOwner(position.walletAddress, programs[1], { commitment: "finalized" }, read));
    if (stop()) return refused("rpc_unavailable");
    let balance = 0n;
    for (const [index, program] of programs.entries()) {
      const found = accounts[index]!;
      if (found.contextSlot < finalizedSlot) return refused("rpc_lagging");
      for (const account of found.accounts) {
        const parsed = tokenAccount(account.data, program);
        if (!parsed || parsed.owner !== position.walletAddress) return refused("token_account_malformed");
        if (parsed.mint !== position.tokenMint) continue;
        if (program !== facts.tokenProgram) return refused("token_account_program_mismatch");
        if (parsed.extensions.some((kind) => !NEUTRAL_ACCOUNT_EXTENSIONS.includes(kind))) return refused("token_2022_extension");
        balance += parsed.amount;
      }
    }
    // 4. Exactly one of the two outcomes, or nothing.
    const held = BigInt(position.remainingUnits); const units = BigInt(pending.units); const others = BigInt(candidate.otherUnits);
    const result = balance === others + held ? "not_sold" : balance === others + held - units ? "sold" : null;
    if (result === null) return refused("balance_mismatch");
    // The balance must agree with the sell's own transaction when it is present (an index behind its context slot, or exactly X
    // units moved in or out from outside, would otherwise read as the opposite outcome).
    if (shown !== null && result !== shown) return refused("evidence_conflict");
    // 0. Only an outcome the table and the engine rules allow for this hold (an absent sell reaches this only for evidence `none`).
    const late = privateRunnerOutcomeRefusal(holdRule, attempt, result);
    if (late) return refused(late);
    return Object.freeze({ outcome: "proven" as const, result, balance: balance.toString(), heldUnits: position.remainingUnits, exitUnits: pending.units,
      otherUnits: candidate.otherUnits, finalizedSlot: finalizedSlot.toString() });
  } catch { return refused("rpc_unavailable"); } finally { signal?.removeEventListener("abort", forward); reads.abort(); }
}

/** SF2 (docs/product/drafts/M3-SF1-SF2-HISTORY-AND-RESERVATION-DESIGN.md, R2): what the runner's own RPC proves about a buy Balchemy
 * reports `failed_onchain` or `expired_not_landed`. Only `not_landed` may release its spend reservation and its wallet.
 * - `not_landed`: it landed and failed (moved no input), or it can no longer land and did not land before F. `outsideUnits` is the
 *   outside credit of the mint (dust) the proof found and accounted for, or null. `finalizedSlot` is null exactly when the proof is
 *   the returned transaction itself (landed and failed); every not_landed from absence carries its F (SF R10 sightings rely on it).
 * - `landed`: the runner's own finalized getTransaction of the journaled signature shows it without error. The ONLY route here.
 * - `unproven`: `counted` only after checks 1-2 of the expiry proof held and every read answered at or past F (the bytes can no
 *   longer land), so the same counted result can become permanent (R2); an uncounted one never does. `balance` is the wallet's
 *   balance of the mint the balance path read, or null when it was not run.
 * `sighted` (SF R10 and SF2 sightings): some read of THIS proof returned the buy itself, a non-null getTransaction body (malformed
 * included) or a non-null getSignatureStatuses entry for it, whatever the final result. It is set the moment such a read answers,
 * before any stop, lagging, expiry or outage check reclassifies the result, so a buy one RPC backend showed is never lost to the
 * reason code (a status below F, a malformed body before the blockhash expired, a halt or a throw right after the read). */
export type PrivateBuyNegativeProof =
  | { readonly outcome: "not_landed"; readonly finalizedSlot: string | null; readonly outsideUnits: string | null; readonly sighted: boolean }
  | { readonly outcome: "landed" }
  | { readonly outcome: "unproven"; readonly reason: RunnerBuyCheckReason; readonly counted: boolean; readonly finalizedSlot: string | null;
      readonly balance: string | null; readonly sighted: boolean };
/** The synchronous facts a dropped-buy proof runs against (all read together, before any RPC read). `positions` null: no position
 * ledger (the balance path is not run). `unmanagedMints` null: no watermark recorded (the balance path is not run). */
export interface PrivateBuyNegativeContext {
  readonly attempt: PrivateSubmissionAttempt; readonly attempts: readonly PrivateSubmissionAttempt[]; readonly positions: readonly PrivatePosition[] | null;
  readonly evicted: readonly string[]; readonly unmanagedMints: readonly string[] | null;
}

/** R2(b) preconditions (S2-B conditions 2 and the mint-level parts of 4, synchronous): T, the remaining units of the open positions of
 * this wallet and mint, or null when the balance cannot explain this buy alone. Condition 5 and the reads follow in the proof. */
export function privateBuyBalanceUnits(context: PrivateBuyNegativeContext): bigint | null {
  const { attempt, attempts, positions, evicted, unmanagedMints } = context; const swap = attempt.swap;
  if (swap.direction !== "buy" || positions === null || unmanagedMints === null) return null;
  const wallet = attempt.walletAddress; const mint = swap.outputMint;
  // 2. Nothing else on the wallet can have moved the mint: no other wallet-holding attempt, no unacknowledged copy, no other released
  // attempt (F2: cannot land after its F, outcome unknown) of the mint.
  if (attempts.some((item) => item.walletAddress === wallet && privateSubmissionCopyHeld(item))) return null;
  if (attempts.some((item) => item.attemptKey !== attempt.attemptKey && item.walletAddress === wallet && privateSubmissionHoldsWallet(item))) return null;
  if (attempts.some((item) => item.attemptKey !== attempt.attemptKey && item.walletAddress === wallet && settledUnknown(item)
    && (item.swap.direction === "buy" ? item.swap.outputMint : item.swap.inputMint) === mint)) return null;
  // 4. Every unit of the mint in the wallet is tracked: no held position, no pending exit, no unmanaged mint, no completed buy of the
  // mint without a position.
  const same = positions.filter((item) => item.state !== "closed" && item.walletAddress === wallet && item.tokenMint === mint);
  if (same.some((item) => item.state === "held" || item.pendingExit !== null)) return null;
  if (unmanagedMints.includes(mint)) return null;
  const tracked = new Set(positions.map((item) => item.entry.reservationId)); const gone = new Set(evicted);
  if (attempts.some((item) => item.swap.direction === "buy" && item.swap.outputMint === mint && item.walletAddress === wallet && item.state === "completed"
    && !tracked.has(item.reservationId) && !gone.has(item.reservationId))) return null;
  return same.reduce((sum, item) => sum + BigInt(item.remainingUnits), 0n);
}

/** R2(a) history witness: the newest completed journal attempt of the same wallet older than this one (its journaled signature
 * landed: no observed copy), else the entry signature of a position of the wallet; null when there is none. */
export function privateBuyWitness(context: PrivateBuyNegativeContext): string | null {
  const { attempt } = context; const wallet = attempt.walletAddress;
  const older = context.attempts.filter((item) => item.attemptKey !== attempt.attemptKey && item.walletAddress === wallet && item.state === "completed"
    && item.observedSignature === null && item.createdAt < attempt.createdAt && item.signature !== attempt.signature)
    .sort((a, b) => b.createdAt - a.createdAt || (a.attemptKey < b.attemptKey ? -1 : 1));
  if (older[0]) return older[0].signature;
  const entry = (context.positions ?? []).filter((item) => item.walletAddress === wallet && item.state !== "closed" && item.entry.signature !== attempt.signature)
    .sort((a, b) => b.createdAt - a.createdAt || (a.positionId < b.positionId ? -1 : 1))[0];
  return entry?.entry.signature ?? null;
}

/** R2(b) read: the wallet's balance of `mint` under both token programs at or past F (S2-B conditions 3 and 5). `refused` when
 * condition 5 or the strict parsing refuses (the balance path is then not run), `lagging` when a response is behind F. May throw. */
async function buyWalletBalance(rpc: Required<PrivateBuyProofRpc>, wallet: string, mint: string, slot: bigint, signal: AbortSignal | undefined,
  stop: Stop): Promise<{ kind: "balance"; amount: bigint } | { kind: "refused" } | { kind: "lagging" } | { kind: "stopped" }> {
  const reads = new AbortController(); const forward = (): void => reads.abort();
  if (signal?.aborted) reads.abort(); else signal?.addEventListener("abort", forward, { once: true });
  try {
    const account = await rpc.getAccountInfo(mint, { commitment: "finalized" }, reads.signal);
    if (stop()) return { kind: "stopped" };
    if (!account) return { kind: "refused" };
    const facts = privateSolanaMintFacts(account);
    if (!facts.ok) return { kind: "refused" };
    const programs = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM] as const;
    const found = await pair(forward, rpc.getTokenAccountsByOwner(wallet, programs[0], { commitment: "finalized" }, reads.signal),
      rpc.getTokenAccountsByOwner(wallet, programs[1], { commitment: "finalized" }, reads.signal));
    if (stop()) return { kind: "stopped" };
    let amount = 0n;
    for (const [index, program] of programs.entries()) {
      const response = found[index]!;
      if (response.contextSlot < slot) return { kind: "lagging" };
      for (const item of response.accounts) {
        const parsed = tokenAccount(item.data, program);
        if (!parsed || parsed.owner !== wallet) return { kind: "refused" };
        if (parsed.mint !== mint) continue;
        if (program !== facts.tokenProgram || parsed.extensions.some((kind) => !NEUTRAL_ACCOUNT_EXTENSIONS.includes(kind))) return { kind: "refused" };
        amount += parsed.amount;
      }
    }
    return { kind: "balance", amount };
  } finally { signal?.removeEventListener("abort", forward); reads.abort(); }
}

/** R2: the runner-side proof for one buy Balchemy reports failed_onchain or expired_not_landed, from the agent's own RPC only
 * (finalized reads). Never throws, never writes. `stop` (true stops) is checked after every read.
 * 1. getTransaction(finalized) of the journaled signature: present with its single signature and meta.err set -> not_landed (it
 *    landed and failed); present with meta.err null -> landed; malformed or another signature -> unproven transaction_malformed
 *    (counted only once checks 1-2 below hold).
 * 2. Absent: checks 1-2 of the expiry proof (privateBlockhashExpired) give F; otherwise expiry_unproven (uncounted).
 * 3. (b) first, where its preconditions hold (privateBuyBalanceUnits, then condition 5 and both programs at or past F):
 *    balance == T -> not_landed. A mismatch is NEVER landed (anyone can send the mint to the wallet): (a) decides.
 *    (a) getSignatureStatuses([buy, witness], searchTransactionHistory) at or past F: the buy null and the witness finalized without
 *    error. Proven with (b) not run -> not_landed; proven with T < balance < T + minOut -> not_landed with the extra as outside
 *    units (any landing of this message credits at least minOut); proven with any other balance -> balance_unexplained; not proven
 *    -> balance_unexplained after a (b) mismatch, otherwise no_witness or witness_unproven (all counted). A non-null buy status is
 *    transaction_appeared (uncounted: a later getTransaction decides).
 * 4. getTransaction(finalized) is still absent after all of that (otherwise transaction_appeared, uncounted). */
export async function privateBuyNegativeProof(rpc: PrivateBuyProofRpc, context: PrivateBuyNegativeContext, signal?: AbortSignal,
  stop: Stop = () => signal?.aborted === true): Promise<PrivateBuyNegativeProof> {
  if (!isPrivateDualSolanaRpc(rpc)) return buyNegativeProofOne(rpc, context, signal, stop);
  // Two Balchemy-provided sources: the whole proof runs on each (the buy outcome is entry-deciding: both must agree).
  const [a, b] = rpc.readers;
  const first = await buyNegativeProofOne(a, context, signal, stop);
  if (stop()) return Object.freeze({ outcome: "unproven" as const, reason: "rpc_unavailable" as const, counted: false, finalizedSlot: null, balance: null,
    sighted: first.outcome === "landed" || first.sighted });
  const second = await buyNegativeProofOne(b, context, signal, stop);
  const combined = privateCombineBuyNegativeProofs(first, second);
  if ((first.outcome === "landed" && second.outcome === "not_landed") || (first.outcome === "not_landed" && second.outcome === "landed")) rpc.disagree();
  return combined;
}
/** Two sources' runs of the dropped-buy proof. `landed` and `not_landed` only when both say so (the same F kind and outside units);
 * otherwise unproven, counted only when both runs were counted, with the uncounted (least advanced) run's reason, F only when both
 * reached one (the higher), and a sighting when either run saw the buy. Landed on one and not landed on the other is a disagreement. */
export function privateCombineBuyNegativeProofs(first: PrivateBuyNegativeProof, second: PrivateBuyNegativeProof): PrivateBuyNegativeProof {
  const sighted = (proof: PrivateBuyNegativeProof): boolean => proof.outcome === "landed" || proof.sighted;
  const seen = sighted(first) || sighted(second);
  const unproven = (reason: RunnerBuyCheckReason, counted: boolean, slot: string | null, balance: string | null): PrivateBuyNegativeProof =>
    Object.freeze({ outcome: "unproven" as const, reason, counted, finalizedSlot: slot, balance, sighted: seen });
  if (first.outcome === "landed" && second.outcome === "landed") return Object.freeze({ outcome: "landed" as const });
  if (first.outcome === "not_landed" && second.outcome === "not_landed") {
    if ((first.finalizedSlot === null) !== (second.finalizedSlot === null) || first.outsideUnits !== second.outsideUnits) {
      return unproven("rpc_unavailable", false, null, null);
    }
    const slot = first.finalizedSlot !== null && second.finalizedSlot !== null
      ? (BigInt(first.finalizedSlot) > BigInt(second.finalizedSlot) ? first.finalizedSlot : second.finalizedSlot) : null;
    return Object.freeze({ outcome: "not_landed" as const, finalizedSlot: slot, outsideUnits: first.outsideUnits, sighted: seen });
  }
  if (first.outcome !== "unproven" && second.outcome !== "unproven") return unproven("rpc_unavailable", false, null, null);
  if (first.outcome !== "unproven" || second.outcome !== "unproven") {
    const only = (first.outcome === "unproven" ? first : second) as Extract<PrivateBuyNegativeProof, { outcome: "unproven" }>;
    // One run proved something, the other did not: its reason and fields, but never counted on one source's evidence.
    return unproven(only.reason, false, only.finalizedSlot, only.balance);
  }
  const lead = !first.counted || second.counted ? first : second;
  const slot = first.finalizedSlot !== null && second.finalizedSlot !== null
    ? (BigInt(first.finalizedSlot) > BigInt(second.finalizedSlot) ? first.finalizedSlot : second.finalizedSlot) : null;
  return unproven(lead.reason, first.counted && second.counted, slot, first.balance === second.balance ? first.balance : null);
}
async function buyNegativeProofOne(rpc: PrivateBuyProofRpc, context: PrivateBuyNegativeContext, signal?: AbortSignal,
  stop: Stop = () => signal?.aborted === true): Promise<PrivateBuyNegativeProof> {
  const { attempt } = context; const swap = attempt.swap;
  // Set by any read that returned the buy, before that read's stop check (the result below may still carry any reason).
  let sighted = false;
  const unproven = (reason: RunnerBuyCheckReason, counted: boolean, slot: bigint | null = null, balance: bigint | null = null): PrivateBuyNegativeProof =>
    Object.freeze({ outcome: "unproven" as const, reason, counted, finalizedSlot: slot === null ? null : slot.toString(), balance: balance === null ? null : balance.toString(), sighted });
  const notLanded = (slot: bigint | null, outside: bigint | null): PrivateBuyNegativeProof => Object.freeze({ outcome: "not_landed" as const,
    finalizedSlot: slot === null ? null : slot.toString(), outsideUnits: outside === null ? null : outside.toString(), sighted });
  if (swap.direction !== "buy") return unproven("state_unavailable", false);
  try {
    // 1. The journaled signature on the runner's own finalized chain.
    const first = await rpc.getTransaction(attempt.signature, { commitment: "finalized" }, signal);
    if (first !== null && first !== undefined) sighted = true;
    if (stop()) return unproven("rpc_unavailable", false);
    if (first !== null && first !== undefined) {
      const body = isRecord(first) && isRecord(first.transaction) ? first.transaction : undefined;
      const meta = isRecord(first) && isRecord(first.meta) ? first.meta : undefined;
      const signatures = body?.signatures;
      if (meta && "err" in meta && Array.isArray(signatures) && signatures.length === 1 && signatures[0] === attempt.signature) {
        return meta.err === null ? Object.freeze({ outcome: "landed" as const }) : notLanded(null, null);
      }
      const slot = await blockhashExpiredOne(rpc, attempt, stop, signal);
      if (stop()) return unproven("rpc_unavailable", false);
      return slot === null ? unproven("expiry_unproven", false) : unproven("transaction_malformed", true, slot);
    }
    // 2. Checks 1-2: the bytes can no longer land after F.
    const slot = await blockhashExpiredOne(rpc, attempt, stop, signal);
    if (stop()) return unproven("rpc_unavailable", false);
    if (slot === null) return unproven("expiry_unproven", false);
    const absent = async (): Promise<boolean> => {
      const again = await rpc.getTransaction(attempt.signature, { commitment: "finalized" }, signal);
      if (again !== null && again !== undefined) sighted = true;
      if (stop()) throw new Error("stopped");
      return again === null || again === undefined;
    };
    // 3(b). The balance, where nothing else can explain it.
    const held = privateBuyBalanceUnits(context);
    let balance: bigint | null = null;
    if (held !== null && rpc.getAccountInfo && rpc.getTokenAccountsByOwner) {
      const read = await buyWalletBalance(rpc as Required<PrivateBuyProofRpc>, attempt.walletAddress, swap.outputMint, slot, signal, stop);
      if (read.kind === "stopped" || stop()) return unproven("rpc_unavailable", false);
      if (read.kind === "lagging") return unproven("rpc_lagging", false);
      if (read.kind === "balance") {
        if (read.amount === held) return (await absent()) ? notLanded(slot, null) : unproven("transaction_appeared", false);
        balance = read.amount;
      }
    }
    // 3(a). The history witness (also after any (b) mismatch).
    const witness = privateBuyWitness(context);
    if (witness === null) return unproven(balance !== null ? "balance_unexplained" : "no_witness", true, slot, balance);
    const found = await rpc.getSignatureStatuses([attempt.signature, witness], { searchTransactionHistory: true }, signal);
    // A status for the buy is a sighting whatever its context slot (a lagging backend still saw it) or the response's shape.
    if (Array.isArray(found?.statuses) && found.statuses[0] !== null && found.statuses[0] !== undefined) sighted = true;
    if (stop()) return unproven("rpc_unavailable", false);
    if (found.statuses.length !== 2) return unproven("rpc_unavailable", false);
    if (found.contextSlot < slot) return unproven("rpc_lagging", false);
    if (found.statuses[0] !== null) return unproven("transaction_appeared", false);
    const entry = found.statuses[1];
    if (!entry || entry.failed || entry.confirmationStatus !== "finalized") {
      return unproven(balance !== null ? "balance_unexplained" : "witness_unproven", true, slot, balance);
    }
    let outside: bigint | null = null;
    if (balance !== null) {
      const floor = held ?? 0n;
      // Any landing of this message (the journaled bytes or a re-signed copy) credits at least minOut, so a smaller extra is outside.
      if (!(balance > floor && balance < floor + BigInt(swap.minOut))) return unproven("balance_unexplained", true, slot, balance);
      outside = balance - floor;
    }
    // 4. Still absent after all of that.
    return (await absent()) ? notLanded(slot, outside) : unproven("transaction_appeared", false);
  } catch { return unproven("rpc_unavailable", false); }
}
