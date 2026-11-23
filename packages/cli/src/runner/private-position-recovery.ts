/** M3: owner-local position readback (`runner positions`) and the owner's resolution of a position held for review
 * (`runner positions <agent> resolve <position-id>`). Only constructed while the exits capability is available (the
 * production capabilities since S5): on the exits-off rollback build the daemon never builds a position ledger, so neither path
 * exists there.
 *
 * Readback: positions with state, bounded reason codes, amounts and timestamps, plus the exit worker's process-local status
 * and entry hold. No key, wire bytes, proof, RPC URL or provider payload.
 *
 * Resolution. A position is held (`runner:` reason) when the settlement pass (private-submission.ts) met a contradiction it
 * never settles automatically. Resolving re-proves the pending exit from the runner's OWN finalized chain readback of the one
 * journaled sell signature, with the same primitives the settlement uses, and changes the position only to what that proof
 * supports. The proof is a closed state machine:
 * - proven sold       the journaled signature finalized without error and privateSellProceeds proves exactly the pending
 *                     units were debited (and the proceeds) -> positions.completeExit.
 * - proven not sold   the journaled signature finalized WITH an error (an atomic failure moves nothing)
 *                     -> positions.failExit(proven_negative): the pending exit clears, the position is open again.
 *                     Never from absence: every reachable `runner:` hold was created either before any chain read (a conflicting
 *                     attempt, an observed copy, a runner dispute), after the settlement pass READ the journaled signature
 *                     present at finalized, or (SF8) after it read the signature absent while Balchemy reported a terminal state.
 *                     A later absent read is never evidence that the sale failed (a lagging or load-balanced backend, a provider
 *                     switch; for SF8 only the settlement pass's own four-check expiry proof decides), so an absent signature is
 *                     always `unknown`.
 * - unknown           an evidence read is unavailable or incomplete; a later read may change it. Nothing changes.
 * - conflicting       the journal or the chain contradicts the pending exit (no matching attempt, a landed copy signed
 *                     outside this runner, a different signature, a debit or proceeds contradiction). Nothing changes.
 *                     Also: when the journal attempt is disputed on a runner-observed contradiction of Balchemy's record (a
 *                     different signature, block height or observed copy reported for it), a copy under a signature this
 *                     runner never journaled cannot be excluded, so "not sold" is never proven for it (a proven sale still is).
 *                     The hold table (PRIVATE_RUNNER_HOLD_RULES, private-position-balance.ts) binds this proof exactly as it binds
 *                     the automatic settlement: a row with no outcome is never proven (exit_attempt_mismatch); an error read for a
 *                     sell the hold was created after reading LANDED is an inconsistent RPC (evidence_conflict); an outcome the row
 *                     or the engine rules refuse (for example "not sold" while Balchemy's record says completed) is
 *                     engine_record_conflict. A `runner:` reason the table does not list may only be proven sold.
 * Preconditions: the position is held with a `runner:` reason (an `s5c:` hold is still settled automatically) and, for a
 * resolution, still carries the exact pending exit the owner reviewed. The resolution re-runs the proof, applies only when it
 * is proven and equals what the owner confirmed, re-checks the position synchronously and then makes exactly one fsynced
 * ledger commit (compare-and-set on the pending exit's reservation). A second resolution finds the position no longer held
 * and changes nothing. Nothing here signs, builds, sends, relays or sells, and the journal attempt is never modified.
 *
 * Automatic wallet-balance settlement (owner decision of 11 Nov 2026, private-position-balance.ts): `settleHeld`, started by the
 * exit worker as its own task once the exit gate admits a pass, settles `runner:` holds from the wallet's finalized token balance.
 * Per held position: the local candidate checks, the full chain proof, then a SECOND candidate check and a second full proof from
 * fresh reads that must agree exactly, then synchronously a third candidate check and the one compare-and-set commit
 * (PrivatePositionLedger.settleByBalance). Any refusal leaves the hold and is retried with a growing delay; its bounded reason is
 * shown by `runner positions`. It shares the per-agent exclusivity of verify/resolve, so an owner resolution and an automatic
 * settlement never interleave. The exit worker never awaits it, so it never delays a valuation pass. Each position it tries has
 * its own hard budget (PRIVATE_POSITION_BALANCE_POSITION_BUDGET_MS, both proofs of one position at about 1 s per round trip), so
 * a slow position never uses up the next one's time; past it that position's reads are aborted and nothing changes for it
 * (`deadline_exceeded`). One call is bounded by PRIVATE_POSITION_BALANCE_PASS_BUDGET_MS in total.
 *
 * Readback also lists completed buys that are NOT managed because they were completed before automatic exits were enabled
 * (the ledger's enable-time watermark; owner decision of 11 Nov 2026), and those the owner took off automatic management.
 *
 * Unmanage (owner item 75 of 13 Nov 2026, `runner positions <agent> unmanage <reservation-id>`): a completed buy of this agent whose
 * position the exit worker refused to open (permanently: buy_unprotected; or transiently: position_unopened, for example a parser gap
 * that repeats) may be taken off automatic management by the owner's typed confirmation. `checkUnmanage` is read-only; `unmanage`
 * re-runs the same checks synchronously and then makes exactly one fsynced ledger commit (PrivatePositionLedger.unmanageBuy, which
 * compares and sets inside its own write). Eligible only when the buy is completed and journaled for this agent, has no position
 * (open, held or closed) and was never evicted, is not pre-enable, not already unmanaged, not a released unsettled attempt and not an
 * observed copy, and the running exit worker holds a refusal of its opening. Nothing here signs, sends or sells, the spend ledger and
 * the journal are never changed and nothing is sent to Balchemy. Irreversible: there is no re-manage. */
import { privateSellProceeds, type PrivateSellFactsRefusal } from "./private-position-facts.js";
import { privateBalanceCandidate, privateRunnerHoldRule, privateRunnerOutcomeRefusal, provePrivateBalanceSettlement, type PrivateBalanceCandidate,
  type PrivateBalanceRpc } from "./private-position-balance.js";
import { PrivatePositionError, privateOwnerUnmanaged, privateUnmanagedMints, PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED, type PrivatePosition,
  type PrivatePositionLedger, type PrivatePositionSettlement } from "./private-positions.js";
import type { PrivateExitWorkerStatus } from "./private-exit-worker.js";
import { isPrivateSubmissionTerminal, privateSubmissionLateHoldOwed, privateSubmissionOwnerClosed, privateSubmissionReleased,
  type PrivateSubmissionAttempt } from "./private-submission-journal.js";
import type { PrivateSolanaRpc } from "./private-solana-rpc.js";
import { isRecord, RUNNER_EXIT_SUMMARY_HELD_LIMIT, type RunnerExitEntryHold, type RunnerExitSummary } from "./protocol.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_POSITION_PROOF_PROVEN = ["finalized_sale", "finalized_failed"] as const;
export const PRIVATE_POSITION_PROOF_UNKNOWN = ["rpc_missing", "rpc_unavailable", "transaction_malformed", "balances_missing",
  "transaction_absent"] as const;
export const PRIVATE_POSITION_PROOF_CONFLICTING = ["exit_attempt_missing", "exit_attempt_mismatch", "observed_copy", "engine_record_conflict", "evidence_conflict", "signature_mismatch",
  "fee_payer_mismatch", "input_debit_mismatch", "wallet_token_balance_decreased", "wsol_account_missing", "wsol_account_mismatch", "wsol_not_closed",
  "proceeds_negative"] as const;
export type PrivatePositionProofUnknown = typeof PRIVATE_POSITION_PROOF_UNKNOWN[number];
export type PrivatePositionProofConflicting = typeof PRIVATE_POSITION_PROOF_CONFLICTING[number];
export type PrivatePositionProof =
  | { readonly outcome: "proven"; readonly result: "sold"; readonly reason: "finalized_sale"; readonly proceedsLamports: string }
  | { readonly outcome: "proven"; readonly result: "not_sold"; readonly reason: "finalized_failed"; readonly proceedsLamports: null }
  | { readonly outcome: "unknown"; readonly result: null; readonly reason: PrivatePositionProofUnknown; readonly proceedsLamports: null }
  | { readonly outcome: "conflicting"; readonly result: null; readonly reason: PrivatePositionProofConflicting; readonly proceedsLamports: null };
/** Why a check or resolution never reached (or never applied) a proof. */
export const PRIVATE_POSITION_REFUSALS = ["position_missing", "not_held", "settlement_owned", "hold_changed", "proof_changed", "busy",
  "state_unavailable"] as const;
export type PrivatePositionRefusal = typeof PRIVATE_POSITION_REFUSALS[number];

export interface PrivatePositionView {
  positionId: string; tokenMint: string; state: PrivatePosition["state"]; holdReason: string | null;
  /** True exactly when the owner may resolve it (held with a `runner:` reason). */
  resolvable: boolean;
  /** proceedsLamports sums the exits with known proceeds; proceedsComplete is false once any exit's proceeds are unknown. */
  originalUnits: string; remainingUnits: string; costLamports: string; proceedsLamports: string; proceedsComplete: boolean;
  pendingExit: { reservationId: string; trigger: string; level: number | null; units: string; createdAt: number } | null;
  exits: number; createdAt: number; updatedAt: number;
  /** The last wallet-balance settlement applied to this position, or null. */
  settlement: Omit<PrivatePositionSettlement, "reservationId"> | null;
  /** Process-local: the last automatic wallet-balance check of this held position that changed nothing, or null. */
  balance: PrivatePositionBalanceStatus | null;
}
export interface PrivatePositionBalanceStatus { reason: string; tries: number; nextAt: number }
/** A completed buy the runner does not manage: it completed before automatic exits were enabled. */
export interface PrivatePositionUnmanagedView { reservationId: string; tokenMint: string; costLamports: string; completedAt: number }
/** Automatic wallet-balance settlement pacing: held positions checked per pass, and the per-position retry delay. */
export const PRIVATE_POSITION_BALANCE_PER_PASS = 2;
export const PRIVATE_POSITION_BALANCE_RETRY_BASE_MS = 30_000;
export const PRIVATE_POSITION_BALANCE_RETRY_MAX_MS = 600_000;
/** Hard budget of one held position in a settleHeld call (both of its proofs); past it its reads are aborted. The worst case is
 * 2 proofs x 6 sequential round trips (an absent sell): 12 round trips, so at 700 ms each 8.4 s, and the budget still covers
 * 1.25 s each. */
export const PRIVATE_POSITION_BALANCE_POSITION_BUDGET_MS = 15_000;
/** The resulting bound of one whole settleHeld call (every position it may try). The exit worker never waits for it. */
export const PRIVATE_POSITION_BALANCE_PASS_BUDGET_MS = PRIVATE_POSITION_BALANCE_PER_PASS * PRIVATE_POSITION_BALANCE_POSITION_BUDGET_MS;
export interface PrivatePositionWorkerView {
  reason: string | null;
  /** `reservationId`: the unopened buy's entry reservation (what `unmanage` names), null when the journal could not be read. */
  openingTotal: number; opening: Array<{ buildDigest: string; reservationId: string | null; reason: string; tries: number; kind: "transient" | "permanent" }>;
  backoffTotal: number; backoff: Array<{ positionId: string; reason: string; failures: number; untilMs: number }>;
}
/** Bounds that keep one readback inside one IPC frame. */
export const PRIVATE_POSITION_READBACK_LIMIT = 12;
export const PRIVATE_POSITION_WORKER_LIMIT = 6;
export const PRIVATE_POSITION_UNMANAGED_LIMIT = 4;
/** F-M36-D15-SF11: on a build without automatic exits, the open and held positions a build with them left in the ledger (read only,
 * as last recorded; this build never changes them), or "unreadable" when that ledger exists but cannot be read. */
export type PrivatePositionExitsOffLedger = { total: number; positions: PrivatePositionView[] } | "unreadable";
/** `ledger` (exits unavailable) is present only when there is something to tell, so a runner of another version reads the plain reply. */
export type PrivatePositionReadback = { agentId: string; exits: "unavailable"; ledger?: PrivatePositionExitsOffLedger } | {
  agentId: string; exits: "available"; entryHold: RunnerExitEntryHold | null;
  /** Null while the exit worker is not running in this process. */
  worker: PrivatePositionWorkerView | null;
  total: number; positions: PrivatePositionView[];
  /** When automatic exits were first enabled for this agent (the watermark was recorded), or null before that. */
  managedSince: number | null;
  /** Completed buys from before that moment, never managed automatically (newest first, bounded). */
  unmanagedTotal: number; unmanaged: PrivatePositionUnmanagedView[];
  /** Owner item 75: completed buys the owner took off automatic management (newest first, bounded). */
  ownerUnmanagedTotal: number; ownerUnmanaged: PrivatePositionOwnerUnmanagedView[];
  /** SF-A review finding 4: positions (ids, sorted, bounded) on which Balchemy later reported a landing (or a copy) of a sell the runner had
   * itself ended negative, while the owner hold it owes is not applied yet (privateSubmissionLateHoldOwed). Present only when non-empty, so a
   * runner of another version still reads every other readback unchanged. */
  lateLandings?: string[];
  /** Final audit N5: the daemon's Hub reason for this agent, present only while it is "clock_skew" (the Hub connection was refused
   * for this computer's clock). Attached by the daemon's list handler, so a runner of another version reads every other readback. */
  hubReason?: "clock_skew";
};
/** Owner item 75: one completed buy the owner took off automatic management, and when. */
export interface PrivatePositionOwnerUnmanagedView { reservationId: string; tokenMint: string; at: number }
/** Owner item 75: why a completed buy cannot be taken off automatic management (nothing is written). */
export const PRIVATE_POSITION_UNMANAGE_REFUSALS = ["buy_missing", "pre_enable", "already_unmanaged", "attempt_released_unsettled", "observed_copy",
  "position_exists", "not_refused", "worker_unavailable", "unmanaged_full", "busy", "state_unavailable"] as const;
export type PrivatePositionUnmanageRefusal = typeof PRIVATE_POSITION_UNMANAGE_REFUSALS[number];
/** The eligible buy the owner is asked to confirm: public facts and the exit worker's current refusal of its opening. */
export interface PrivatePositionUnmanageBuy {
  reservationId: string; tokenMint: string; costLamports: string; completedAt: number;
  opening: { reason: string; kind: "transient" | "permanent"; tries: number };
}
/** refusal null <=> buy present (eligible). */
export interface PrivatePositionUnmanageCheck { reservationId: string; refusal: PrivatePositionUnmanageRefusal | null; buy: PrivatePositionUnmanageBuy | null }
/** applied true: the one ledger write committed; a refusal state_unavailable after the checks may or may not have committed. */
export interface PrivatePositionUnmanageResult extends PrivatePositionUnmanageCheck { applied: boolean }
export interface PrivatePositionCheck { positionId: string; refusal: PrivatePositionRefusal | null; proof: PrivatePositionProof | null; position: PrivatePositionView | null }
export interface PrivatePositionResolution extends PrivatePositionCheck { applied: boolean }
export interface PrivatePositionResolveInput { positionId: string; reservationId: string; result: "sold" | "not_sold" }

type ProofRpc = Pick<PrivateSolanaRpc, "getTransaction">;
export interface PrivatePositionRecoveryOptions {
  agentIds: readonly string[];
  /** The daemon's one position ledger (shared with the exit worker and the settlement pass). */
  positions: Pick<PrivatePositionLedger, "positions" | "position" | "completeExit" | "failExit" | "evicted" | "managedFrom" | "settleByBalance" | "unmanageBuy">;
  /** The S4 journal, read only. */
  readAttempts(agentId: string): readonly PrivateSubmissionAttempt[];
  /** The agent's own RPC (finalized reads only); undefined when none is configured. */
  readRpc(agentId: string): ProofRpc | undefined;
  /** The agent's own RPC for the wallet-balance settlement (finalized reads only); without it no hold is settled automatically. */
  readBalanceRpc?(agentId: string): PrivateBalanceRpc | undefined;
  /** The exit worker's process-local status and entry hold; undefined while it is not running. */
  readWorker?(agentId: string): { status: PrivateExitWorkerStatus; entryHold: RunnerExitEntryHold | null } | undefined;
  now?(): number;
  /** Test seam: the per-position settleHeld budget (defaults to PRIVATE_POSITION_BALANCE_POSITION_BUDGET_MS). */
  balanceBudgetMs?: number;
  /** Test seam (fake clock): schedules the budget's expiry and returns its cancel; defaults to an unref'd setTimeout. */
  balanceTimer?(ms: number, expire: () => void): () => void;
}

const RUNNER_HOLD = "runner:";
const resolvable = (position: PrivatePosition): boolean => position.state === "held" && (position.holdReason ?? "").startsWith(RUNNER_HOLD);
const unknown = (reason: PrivatePositionProofUnknown): PrivatePositionProof => Object.freeze({ outcome: "unknown", result: null, reason, proceedsLamports: null });
const conflicting = (reason: PrivatePositionProofConflicting): PrivatePositionProof => Object.freeze({ outcome: "conflicting", result: null, reason, proceedsLamports: null });
const notSold = (reason: "finalized_failed"): PrivatePositionProof => Object.freeze({ outcome: "proven", result: "not_sold", reason, proceedsLamports: null });
/** Every refusal of privateSellProceeds for a PRESENT transaction, classified exhaustively: unreadable evidence is unknown (a later
 * read may change it), a contradiction of what was signed is conflicting. (missing and failed are decided before it is called.) */
const SELL_FACTS: Readonly<Record<PrivateSellFactsRefusal, PrivatePositionProof>> = Object.freeze({
  transaction_missing: unknown("transaction_malformed"), transaction_malformed: unknown("transaction_malformed"), balances_missing: unknown("balances_missing"),
  transaction_failed: notSold("finalized_failed"), signature_mismatch: conflicting("signature_mismatch"), fee_payer_mismatch: conflicting("fee_payer_mismatch"),
  input_debit_mismatch: conflicting("input_debit_mismatch"), wallet_token_balance_decreased: conflicting("wallet_token_balance_decreased"),
  wsol_account_missing: conflicting("wsol_account_missing"), wsol_account_mismatch: conflicting("wsol_account_mismatch"),
  wsol_not_closed: conflicting("wsol_not_closed"), proceeds_negative: conflicting("proceeds_negative") });

export function privatePositionView(position: PrivatePosition, balance: PrivatePositionBalanceStatus | null = null): PrivatePositionView {
  const pending = position.pendingExit; const settled = position.settlement;
  return { positionId: position.positionId, tokenMint: position.tokenMint, state: position.state, holdReason: position.holdReason,
    resolvable: resolvable(position), originalUnits: position.originalUnits, remainingUnits: position.remainingUnits, costLamports: position.costLamports,
    proceedsLamports: position.proceedsLamports, proceedsComplete: position.exits.every((item) => item.proceedsLamports !== null),
    pendingExit: pending ? { reservationId: pending.reservationId, trigger: pending.trigger, level: pending.level, units: pending.units, createdAt: pending.createdAt } : null,
    exits: position.exits.length, createdAt: position.createdAt, updatedAt: position.updatedAt,
    settlement: settled ? { result: settled.result, reason: settled.reason, heldFor: settled.heldFor, at: settled.at } : null,
    balance: resolvable(position) && balance ? { ...balance } : null };
}
function delayFor(failures: number): number {
  return Math.min(PRIVATE_POSITION_BALANCE_RETRY_MAX_MS, PRIVATE_POSITION_BALANCE_RETRY_BASE_MS * 2 ** Math.min(Math.max(failures - 1, 0), 20));
}
const BALANCE_REASON = { sold: "balance_proven_sold", not_sold: "balance_proven_not_sold" } as const;
/** Held first, then pending exits, then open, then closed; newest first within each. */
function rank(position: PrivatePosition): number {
  return position.state === "held" ? 0 : position.state === "closed" ? 3 : position.pendingExit !== null ? 1 : 2;
}

/** The proof state machine for one held position's pending exit (see the module comment). Reads only; never throws. */
export async function provePrivateHeldExit(position: PrivatePosition, attempt: PrivateSubmissionAttempt | undefined, rpc: ProofRpc | undefined,
  signal?: AbortSignal): Promise<PrivatePositionProof> {
  const pending = position.pendingExit;
  if (!pending || !attempt) return conflicting("exit_attempt_missing");
  const swap = attempt.swap;
  if (attempt.reservationId !== pending.reservationId || swap.direction !== "sell" || swap.positionId !== position.positionId
    || attempt.walletAddress !== position.walletAddress || swap.inputMint !== position.tokenMint || swap.grossInUnits !== pending.units) {
    return conflicting("exit_attempt_mismatch");
  }
  // A landed copy signed outside this runner: the journaled signature alone can prove neither a sale nor its absence.
  if (attempt.observedSignature !== null) return conflicting("observed_copy");
  // The hold table's row (the same one the automatic settlement applies). A row with no outcome (the journal attempt does not
  // describe this exit) is never proven either way.
  const holdRule = privateRunnerHoldRule(position.holdReason);
  if (holdRule && holdRule.outcomes.length === 0) return conflicting("exit_attempt_mismatch");
  /** A proven outcome the row or the engine rules refuse is never offered; an unlisted `runner:` reason may only be proven sold. */
  const allowed = (proof: PrivatePositionProof): PrivatePositionProof => {
    if (proof.outcome !== "proven") return proof;
    const refused = holdRule ? privateRunnerOutcomeRefusal(holdRule, attempt, proof.result) !== null : proof.result !== "sold";
    return refused ? conflicting("engine_record_conflict") : proof;
  };
  /** A finalized failure moves nothing, but for a hold created after the sell was read LANDED a later error is an inconsistent
   * RPC, never proof of "not sold". */
  const failed = (): PrivatePositionProof => holdRule?.evidence === "landed" ? conflicting("evidence_conflict") : allowed(notSold("finalized_failed"));
  // Balchemy's record for this attempt contradicted the journal (runner: dispute): the absence or failure of the journaled
  // signature alone cannot prove that no other copy sold the units.
  // Owner decision 26: an attempt the owner closed out was such a dispute (or a released attempt); it proves nothing either.
  const engineConflict = (attempt.state === "disputed" && (attempt.reason ?? "").startsWith(RUNNER_HOLD)) || privateSubmissionOwnerClosed(attempt);
  if (!rpc) return unknown("rpc_missing");
  const read = async (signature: string): Promise<{ value: unknown } | undefined> => {
    if (signal?.aborted) return undefined;
    try { const value: unknown = await rpc.getTransaction(signature, { commitment: "finalized" }, signal); return signal?.aborted ? undefined : { value }; }
    catch { return undefined; }
  };
  const first = await read(attempt.signature);
  if (!first) return unknown("rpc_unavailable");
  const transaction = first.value;
  if (transaction !== null && transaction !== undefined) {
    const body = isRecord(transaction) && isRecord(transaction.transaction) ? transaction.transaction : undefined;
    const meta = isRecord(transaction) && isRecord(transaction.meta) ? transaction.meta : undefined;
    const signatures = body?.signatures;
    if (!meta || !("err" in meta) || !Array.isArray(signatures)) return unknown("transaction_malformed");
    if (signatures.length !== 1 || signatures[0] !== attempt.signature) return conflicting("signature_mismatch");
    // A finalized failure is atomic: nothing it carried moved.
    if (meta.err !== null) return failed();
    const proof = privateSellProceeds(transaction, { signature: attempt.signature, walletAddress: attempt.walletAddress, tokenMint: swap.inputMint,
      units: pending.units, wsolAccount: swap.wsolAccount });
    if (proof.ok) return allowed(Object.freeze({ outcome: "proven", result: "sold", reason: "finalized_sale", proceedsLamports: proof.proceedsLamports }));
    const refused = SELL_FACTS[proof.reason];
    return refused.result === "not_sold" ? failed() : refused;
  }
  // Absent at finalized: never a state change. A lagging or load-balanced backend, or another provider, can miss a sell that
  // landed; no runner-local read of an absence proves that nothing sold (see the module comment).
  return engineConflict ? conflicting("engine_record_conflict") : unknown("transaction_absent");
}

export class PrivatePositionRecovery {
  readonly #options: PrivatePositionRecoveryOptions;
  readonly #agentIds: string[];
  readonly #busy = new Set<string>();
  /** Process-local wallet-balance status per agent: positionId -> the pending exit it was for, last reason, tries, next retry. */
  readonly #balance = new Map<string, Map<string, PrivatePositionBalanceStatus & { reservationId: string }>>();
  constructor(options: PrivatePositionRecoveryOptions) { this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds }; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }
  #balanceStatus(agentId: string, position: PrivatePosition): PrivatePositionBalanceStatus | null {
    const found = this.#balance.get(agentId)?.get(position.positionId);
    return found && found.reservationId === position.pendingExit?.reservationId ? { reason: found.reason, tries: found.tries, nextAt: found.nextAt } : null;
  }

  /** Automatic wallet-balance settlement of this agent's `runner:` holds (see the module comment). Skipped while a verify or
   * resolution runs for the agent. Never throws, never signs or sends, never writes the journal. `admitted` (the exit worker's
   * gate, re-checked synchronously) is required and fails closed: missing, throwing or anything but true counts as refused. It is
   * checked before each position, after every read of a proof (no further read starts once it refuses), before the second proof
   * and right before the commit (`halted`), so a halt during a settlement never changes the ledger. */
  async settleHeld(agentId: string, signal: AbortSignal | undefined, admitted: () => boolean): Promise<void> {
    this.#known(agentId);
    if (this.#busy.has(agentId) || signal?.aborted) return;
    this.#busy.add(agentId);
    const gate = (): boolean => { try { return typeof admitted === "function" && admitted() === true; } catch { return false; } };
    try { await this.#settleHeld(agentId, signal, gate); } catch { /* Held; the next pass retries. */ } finally { this.#busy.delete(agentId); }
  }
  /** One position's hard budget, linked to the caller's signal: past it (or once done) every read under it aborts. */
  #budget(signal: AbortSignal | undefined): { signal: AbortSignal; expired: () => boolean; done: () => void } {
    const budget = new AbortController(); let expired = false;
    const ms = this.#options.balanceBudgetMs ?? PRIVATE_POSITION_BALANCE_POSITION_BUDGET_MS;
    const expire = (): void => { expired = true; budget.abort(); };
    let cancel: () => void;
    if (this.#options.balanceTimer) cancel = this.#options.balanceTimer(ms, expire);
    else { const timer = setTimeout(expire, ms); timer.unref?.(); cancel = () => clearTimeout(timer); }
    const forward = (): void => budget.abort();
    if (signal?.aborted) budget.abort(); else signal?.addEventListener("abort", forward, { once: true });
    return { signal: budget.signal, expired: () => expired, done: () => { cancel(); signal?.removeEventListener("abort", forward); budget.abort(); } };
  }
  async #settleHeld(agentId: string, signal: AbortSignal | undefined, admitted: () => boolean): Promise<void> {
    const status = this.#balance.get(agentId) ?? new Map<string, PrivatePositionBalanceStatus & { reservationId: string }>();
    this.#balance.set(agentId, status);
    const positions = this.#options.positions.positions(agentId);
    for (const id of [...status.keys()]) {
      const current = positions.find((item) => item.positionId === id);
      if (!current || !resolvable(current) || current.pendingExit?.reservationId !== status.get(id)?.reservationId) status.delete(id);
    }
    const held = positions.filter(resolvable).sort((a, b) => a.updatedAt - b.updatedAt || (a.positionId < b.positionId ? -1 : 1));
    let tried = 0;
    for (const position of held) {
      if (signal?.aborted || tried >= PRIVATE_POSITION_BALANCE_PER_PASS || !admitted()) return;
      const reservationId = position.pendingExit?.reservationId;
      if (!reservationId) continue;
      const record = status.get(position.positionId);
      if (record && this.#now() < record.nextAt) continue;
      tried += 1;
      // Its own budget: the time an earlier position took is never charged to this one.
      const budget = this.#budget(signal);
      let settled: string | null;
      try { settled = await this.#settleOne(agentId, position.positionId, budget.signal, admitted); } finally { budget.done(); }
      if (settled === null) { status.delete(position.positionId); continue; }
      const reason = budget.expired() ? "deadline_exceeded" : settled;
      const tries = (record?.tries ?? 0) + 1;
      status.set(position.positionId, { reservationId, reason, tries, nextAt: this.#now() + delayFor(tries) });
    }
  }
  /** One held position: candidate, proof, fresh candidate, fresh proof, synchronous candidate re-check, one commit. Null when the
   * commit applied; otherwise the bounded reason nothing changed. */
  async #settleOne(agentId: string, positionId: string, signal: AbortSignal, admitted: () => boolean): Promise<string | null> {
    const o = this.#options;
    // The gate stops every proof read by read: after a halt no further read starts.
    const halted = (): boolean => !admitted();
    const candidate = (): PrivateBalanceCandidate | "state_unavailable" => {
      try {
        const positions = o.positions.positions(agentId);
        return privateBalanceCandidate(positions.find((item) => item.positionId === positionId), positions, o.readAttempts(agentId), o.positions.evicted(agentId),
          privateUnmanagedMints(o.positions.managedFrom(agentId)));
      } catch { return "state_unavailable"; }
    };
    const facts = (value: Extract<PrivateBalanceCandidate, { ok: true }>): string => JSON.stringify([value.position, value.attempt, value.otherUnits]);
    let rpc: PrivateBalanceRpc | undefined;
    try { rpc = o.readBalanceRpc?.(agentId); } catch { rpc = undefined; }
    const first = candidate();
    if (first === "state_unavailable" || !first.ok) return first === "state_unavailable" ? first : first.reason;
    const proof = await provePrivateBalanceSettlement(first, rpc, signal, halted);
    if (proof.outcome !== "proven") return halted() ? "halted" : proof.reason;
    if (!admitted()) return "halted";
    // Condition 6: re-read and re-prove from fresh reads; both proofs must agree exactly.
    const second = candidate();
    if (second === "state_unavailable" || !second.ok) return second === "state_unavailable" ? second : second.reason;
    if (facts(second) !== facts(first)) return "reprove_changed";
    const again = await provePrivateBalanceSettlement(second, rpc, signal, halted);
    if (again.outcome !== "proven") return halted() ? "halted" : again.reason;
    if (again.result !== proof.result || again.balance !== proof.balance || again.heldUnits !== proof.heldUnits || again.exitUnits !== proof.exitUnits
      || again.otherUnits !== proof.otherUnits) return "reprove_changed";
    if (signal.aborted) return "closing";
    // Synchronous from the gate and this re-check to the one commit: a halt during the proofs never changes the ledger.
    if (!admitted()) return "halted";
    // Synchronous from this re-check to the one commit (which compares and sets the same facts inside the ledger's own write).
    const final = candidate();
    if (final === "state_unavailable" || !final.ok) return final === "state_unavailable" ? final : final.reason;
    if (facts(final) !== facts(second)) return "reprove_changed";
    const pending = final.position.pendingExit;
    if (!pending) return "not_runner_held";
    try {
      o.positions.settleByBalance(agentId, positionId, { reservationId: pending.reservationId, result: again.result, reason: BALANCE_REASON[again.result],
        heldUnits: again.heldUnits, exitUnits: again.exitUnits, otherUnits: again.otherUnits }, this.#now());
    } catch (error: unknown) { return error instanceof PrivatePositionError ? `commit:${error.code}` : "state_unavailable"; }
    return null;
  }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #known(agentId: string): void { if (!this.#options.agentIds.includes(agentId)) throw new Error("unknown agent"); }
  #worker(agentId: string): { status: PrivateExitWorkerStatus; entryHold: RunnerExitEntryHold | null } | undefined {
    try { return this.#options.readWorker?.(agentId); } catch { return undefined; }
  }

  /** Read-only readback. Throws only when the ledger is unavailable, or the journal while buys from before enable exist. */
  list(agentId: string): PrivatePositionReadback {
    this.#known(agentId);
    const positions = [...this.#options.positions.positions(agentId)].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt
      || (a.positionId < b.positionId ? -1 : 1));
    const worker = this.#worker(agentId);
    // The watermark may be recorded by the worker's entry hold above, so it is read after it.
    const managed = this.#options.positions.managedFrom(agentId);
    const preEnable = new Set(managed?.preEnable ?? []);
    // The unopened buys' entry reservations (what `unmanage` names); null when the journal cannot be read (the readback still answers).
    let digests: Map<string, string> | null = null;
    if (worker && worker.status.opening.length > 0) {
      try {
        digests = new Map(this.#options.readAttempts(agentId).filter((item) => item.swap.direction === "buy").map((item) => [item.buildDigest, item.reservationId]));
      } catch { digests = null; }
    }
    const owner = [...(managed?.ownerUnmanaged ?? [])].sort((a, b) => b.at - a.at || (a.reservationId < b.reservationId ? -1 : 1))
      .map((item): PrivatePositionOwnerUnmanagedView => ({ reservationId: item.reservationId, tokenMint: item.tokenMint, at: item.at }));
    const unmanaged = managed && managed.preEnable.length > 0 ? this.#options.readAttempts(agentId)
      .filter((item) => item.swap.direction === "buy" && item.state === "completed" && preEnable.has(item.reservationId))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.reservationId < b.reservationId ? -1 : 1))
      .map((item): PrivatePositionUnmanagedView => ({ reservationId: item.reservationId, tokenMint: item.swap.outputMint,
        costLamports: item.swap.direction === "buy" ? item.swap.grossInLamports : "0", completedAt: item.updatedAt })) : [];
    // SF-A review finding 4: a recorded late landing whose hold is owed (readback only; an unreadable journal shows none).
    let late: string[] = [];
    try {
      const owed = new Set<string>();
      for (const item of this.#options.readAttempts(agentId)) {
        if (item.swap.direction !== "sell") continue;
        const positionId = item.swap.positionId;
        if (privateSubmissionLateHoldOwed(item, positions.find((position) => position.positionId === positionId))) owed.add(positionId);
      }
      late = [...owed].sort().slice(0, PRIVATE_POSITION_READBACK_LIMIT);
    } catch { late = []; }
    return { agentId, exits: "available", entryHold: worker ? worker.entryHold : null,
      worker: worker ? { reason: worker.status.reason, openingTotal: worker.status.opening.length,
        opening: worker.status.opening.slice(0, PRIVATE_POSITION_WORKER_LIMIT).map((item) => ({ buildDigest: item.buildDigest,
          reservationId: digests?.get(item.buildDigest) ?? null, reason: item.reason, tries: item.tries, kind: item.kind })),
        backoffTotal: worker.status.backoff.length, backoff: worker.status.backoff.slice(0, PRIVATE_POSITION_WORKER_LIMIT).map((item) => ({ ...item })) } : null,
      total: positions.length, positions: positions.slice(0, PRIVATE_POSITION_READBACK_LIMIT).map((item) => privatePositionView(item, this.#balanceStatus(agentId, item))),
      managedSince: managed ? managed.recordedAt : null, unmanagedTotal: unmanaged.length, unmanaged: unmanaged.slice(0, PRIVATE_POSITION_UNMANAGED_LIMIT),
      ownerUnmanagedTotal: owner.length, ownerUnmanaged: owner.slice(0, PRIVATE_POSITION_UNMANAGED_LIMIT), ...(late.length > 0 ? { lateLandings: late } : {}) };
  }

  /** The status summary (RunnerExecutionStatus.exits). Throws only when the ledger itself is unavailable. */
  summary(agentId: string): RunnerExitSummary {
    this.#known(agentId);
    const positions = this.#options.positions.positions(agentId);
    const held = positions.filter((item): item is PrivatePosition & { holdReason: string } => item.state === "held" && item.holdReason !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const worker = this.#worker(agentId);
    return { entryHold: worker ? worker.entryHold : null, reason: worker?.status.reason ?? null,
      open: positions.filter((item) => item.state === "open" && item.pendingExit === null).length,
      pending: positions.filter((item) => item.state === "open" && item.pendingExit !== null).length, held: held.length,
      unopened: worker?.status.opening.length ?? 0, backoff: worker?.status.backoff.length ?? 0,
      heldPositions: held.slice(0, RUNNER_EXIT_SUMMARY_HELD_LIMIT).map((item) => ({ positionId: item.positionId, holdReason: item.holdReason })) };
  }

  /** Read-only proof of one held position (what a resolution would apply). Never mutates. */
  async verify(agentId: string, positionId: string, signal?: AbortSignal): Promise<PrivatePositionCheck> {
    this.#known(agentId);
    return this.#exclusive(agentId, async () => {
      const target = this.#target(agentId, positionId, null);
      if ("refusal" in target) return { positionId, refusal: target.refusal, proof: null, position: target.view };
      const proof = await this.#prove(agentId, target.position, signal);
      return { positionId, refusal: proof === "state_unavailable" ? "state_unavailable" : null, proof: proof === "state_unavailable" ? null : proof,
        position: privatePositionView(target.position) };
    }, (refusal) => ({ positionId, refusal, proof: null, position: null }));
  }

  /** The owner's resolution: a fresh proof that must equal what the owner confirmed, then one compare-and-set ledger commit. */
  async resolve(agentId: string, input: PrivatePositionResolveInput, signal?: AbortSignal): Promise<PrivatePositionResolution> {
    this.#known(agentId);
    const { positionId, reservationId } = input;
    const unchanged = (refusal: PrivatePositionRefusal | null, proof: PrivatePositionProof | null, view: PrivatePositionView | null): PrivatePositionResolution =>
      ({ positionId, applied: false, refusal, proof, position: view });
    return this.#exclusive(agentId, async () => {
      const target = this.#target(agentId, positionId, reservationId);
      if ("refusal" in target) return unchanged(target.refusal, null, target.view);
      const proof = await this.#prove(agentId, target.position, signal);
      if (proof === "state_unavailable") return unchanged("state_unavailable", null, privatePositionView(target.position));
      if (proof.outcome !== "proven") return unchanged(null, proof, privatePositionView(target.position));
      if (proof.result !== input.result) return unchanged("proof_changed", proof, privatePositionView(target.position));
      if (signal?.aborted) return unchanged("state_unavailable", proof, privatePositionView(target.position));
      // Synchronous from this re-check to the one commit: still exactly the held pending exit that was proven.
      const current = this.#target(agentId, positionId, reservationId);
      if ("refusal" in current) return unchanged(current.refusal, proof, current.view);
      const pending = current.position.pendingExit;
      if (!pending || JSON.stringify(pending) !== JSON.stringify(target.position.pendingExit)) return unchanged("hold_changed", proof, privatePositionView(current.position));
      let after: PrivatePosition;
      try {
        after = proof.result === "sold"
          ? this.#options.positions.completeExit(agentId, positionId, reservationId, { soldUnits: pending.units, proceedsLamports: proof.proceedsLamports }, this.#now())
          : this.#options.positions.failExit(agentId, positionId, reservationId, "proven_negative", `owner:resolved_${proof.reason}`, this.#now());
      } catch { return unchanged("state_unavailable", proof, null); }
      return { positionId, applied: true, refusal: null, proof, position: privatePositionView(after) };
    }, (refusal) => unchanged(refusal, null, null));
  }

  /** Owner item 75: read-only eligibility of one completed buy for `unmanage` (what the owner is asked to confirm). Never mutates. */
  async checkUnmanage(agentId: string, reservationId: string): Promise<PrivatePositionUnmanageCheck> {
    this.#known(agentId);
    return this.#exclusive(agentId, async () => this.#unmanageTarget(agentId, reservationId), (refusal) => ({ reservationId, refusal, buy: null }));
  }
  /** Owner item 75: the owner's confirmed unmanage. The same checks, synchronously, then the one compare-and-set ledger commit. Never
   * signs, sends or sells; never touches the spend ledger, the journal or Balchemy's state. */
  async unmanage(agentId: string, reservationId: string): Promise<PrivatePositionUnmanageResult> {
    this.#known(agentId);
    const refused = (refusal: PrivatePositionUnmanageRefusal): PrivatePositionUnmanageResult => ({ reservationId, applied: false, refusal, buy: null });
    return this.#exclusive(agentId, async () => {
      // Synchronous from this check to the one commit.
      const target = this.#unmanageTarget(agentId, reservationId);
      if (target.refusal !== null || target.buy === null) return { ...target, applied: false };
      try { this.#options.positions.unmanageBuy(agentId, { reservationId, tokenMint: target.buy.tokenMint }, this.#now()); }
      catch (error: unknown) {
        const code = error instanceof PrivatePositionError ? error.code : null;
        // Ledger refusals are decided before any write; anything else may or may not have committed (state_unavailable).
        return refused(code === "position_conflict" || code === "position_evicted" ? "position_exists" : code === "ledger_full" ? "unmanaged_full"
          : code === "position_not_managed" ? "pre_enable" : "state_unavailable");
      }
      return { reservationId, applied: true, refusal: null, buy: target.buy };
    }, refused);
  }
  /** The eligibility checks of `unmanage` (synchronous, reads only). */
  #unmanageTarget(agentId: string, reservationId: string): PrivatePositionUnmanageCheck {
    const refuse = (refusal: PrivatePositionUnmanageRefusal): PrivatePositionUnmanageCheck => ({ reservationId, refusal, buy: null });
    // The worker first: its entry hold may record the watermark, which is read after it.
    const worker = this.#worker(agentId);
    let attempts: readonly PrivateSubmissionAttempt[]; let positions: readonly PrivatePosition[]; let evicted: readonly string[];
    let managed: ReturnType<PrivatePositionRecoveryOptions["positions"]["managedFrom"]>;
    try {
      attempts = this.#options.readAttempts(agentId); positions = this.#options.positions.positions(agentId);
      evicted = this.#options.positions.evicted(agentId); managed = this.#options.positions.managedFrom(agentId);
    } catch { return refuse("state_unavailable"); }
    const attempt = attempts.find((item) => item.reservationId === reservationId && item.swap.direction === "buy");
    if (attempt && privateSubmissionReleased(attempt) && !isPrivateSubmissionTerminal(attempt.state)) return refuse("attempt_released_unsettled");
    if (!attempt || attempt.swap.direction !== "buy" || attempt.state !== "completed") return refuse("buy_missing");
    if (managed && managed.preEnable.includes(reservationId)) return refuse("pre_enable");
    if (privateOwnerUnmanaged(managed, reservationId)) return refuse("already_unmanaged");
    if (attempt.observedSignature !== null) return refuse("observed_copy");
    if (positions.some((item) => item.entry.reservationId === reservationId || item.entry.buildDigest === attempt.buildDigest) || evicted.includes(reservationId)) {
      return refuse("position_exists");
    }
    if (!worker) return refuse("worker_unavailable");
    // No watermark yet: the exit worker has not run for this agent, so it has refused nothing.
    if (!managed) return refuse("not_refused");
    if ((managed.ownerUnmanaged?.length ?? 0) >= PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED) return refuse("unmanaged_full");
    const opening = worker.status.opening.find((item) => item.buildDigest === attempt.buildDigest);
    if (!opening) return refuse("not_refused");
    // Refused locally (never buy_unprotected): an observed copy has its own hold, an evicted position sold out.
    if (opening.reason === "observed_copy") return refuse("observed_copy");
    if (opening.reason === "position_evicted") return refuse("position_exists");
    return { reservationId, refusal: null, buy: { reservationId, tokenMint: attempt.swap.outputMint, costLamports: attempt.swap.grossInLamports,
      completedAt: attempt.updatedAt, opening: { reason: opening.reason, kind: opening.kind, tries: opening.tries } } };
  }

  /** One check or resolution per agent at a time; a concurrent one is refused `busy` (never queued behind a proof). */
  async #exclusive<T>(agentId: string, work: () => Promise<T>, refused: (refusal: "busy") => T): Promise<T> {
    if (this.#busy.has(agentId)) return refused("busy");
    this.#busy.add(agentId);
    try { return await work(); } finally { this.#busy.delete(agentId); }
  }
  #target(agentId: string, positionId: string, reservationId: string | null):
    { position: PrivatePosition } | { refusal: PrivatePositionRefusal; view: PrivatePositionView | null } {
    let position: PrivatePosition | undefined;
    try { position = this.#options.positions.position(agentId, positionId); } catch { return { refusal: "state_unavailable", view: null }; }
    if (!position) return { refusal: "position_missing", view: null };
    const view = privatePositionView(position);
    if (position.state !== "held") return { refusal: "not_held", view };
    if (!resolvable(position)) return { refusal: "settlement_owned", view };
    if (reservationId !== null && position.pendingExit?.reservationId !== reservationId) return { refusal: "hold_changed", view };
    return { position };
  }
  async #prove(agentId: string, position: PrivatePosition, signal?: AbortSignal): Promise<PrivatePositionProof | "state_unavailable"> {
    let attempt: PrivateSubmissionAttempt | undefined;
    try {
      const reservationId = position.pendingExit?.reservationId;
      attempt = this.#options.readAttempts(agentId).find((item) => item.reservationId === reservationId);
    } catch { return "state_unavailable"; }
    let rpc: ProofRpc | undefined;
    try { rpc = this.#options.readRpc(agentId); } catch { rpc = undefined; }
    return provePrivateHeldExit(position, attempt, rpc, signal);
  }
}
