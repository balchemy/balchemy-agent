/** Owner-local S4 submission journal: one fsynced snapshot per agent holding every attempt to relay runner-signed swap
 * bytes through Balchemy. An attempt is recorded `signed` (with its exact wire bytes) BEFORE any network call, and its
 * state then only moves forward on relay or status evidence; the terminal states are immutable. Bounded and fail
 * closed: when full, only the oldest terminal attempt may be evicted; with none, a new attempt is refused before signing.
 * At most one unfinished attempt per wallet (decision 11). The stored bytes are only ever resent identically (decision 4);
 * nothing here signs, sends or settles. Writes require the daemon's existing exclusive writer.
 * An attempt whose message Balchemy saw land under another signature (observedSignature: the wallet key signed outside
 * this runner, which never re-signs) holds its wallet: admit refuses copy_unacknowledged, and the attempt is never evicted,
 * until the owner acknowledges it (copyAcknowledgedAt, the only change a terminal attempt accepts).
 * F2 release (owner decision 13 of 11 Nov 2026, docs/product/drafts/M3-F2-VALUATION-FREEZE-DESIGN.md): a relay-closed `runner:`
 * dispute whose bytes the runner proved can no longer land after a finalized slot F carries landingClosed (write-once, set only
 * by closeLanding, called only by S4 after two proofs). Its state stays `disputed`; it no longer holds its wallet
 * (privateSubmissionHoldsWallet), is immutable like a terminal attempt (only acknowledgeCopies may still change it) and is never
 * evicted. The key is omitted while null, so a journal without a release is written exactly as before; an older runner, whose
 * closed key set lacks it, fails closed (state_unavailable) only on a journal that holds a release.
 * SF R10 (owner decision 27 of 11 Nov 2026, docs/product/drafts/M3-SF1-SF2-HISTORY-AND-RESERVATION-DESIGN.md): closeLanding also
 * accepts a buy Balchemy leaves unresolved (privateSubmissionStalledBuy; never one Balchemy saw finalized). Its release only frees
 * the wallet; unlike a released dispute it stays open to server truth: status may still move it (to a negative state the runner
 * then proves, to facts_pending or `completed`, or to a dispute), while landingClosed itself never changes. A released buy that became a `runner:` dispute is immutable like an F2
 * release. A released attempt is never evicted while it is not terminal; once terminal (Balchemy's `completed` committed, R4's proven
 * negative, or the owner's close-out) its outcome is settled by evidence and it may be evicted like any terminal attempt, subject to
 * the caller's `retain` (S4 keeps a completed released buy until its mint is durably off the balance settlement).
 * Owner close-out (owner decision 26 of 11 Nov 2026, docs/product/drafts/M3-F2-VALUATION-FREEZE-DESIGN.md section 8): closeByOwner moves
 * a relay-closed `runner:` dispute, a released attempt or (owner decision 44 of 12 Nov 2026) a buy Balchemy left unresolved for at least
 * 30 minutes that the runner has not released to the terminal state closed_by_owner, with ownerClosed (the proven F and
 * when; omitted while null). It is evidence of nothing about the outcome. An older runner, whose closed state and key sets lack both,
 * fails closed (state_unavailable) only on a journal that holds a close-out. A closed attempt may be evicted again.
 * Buy sightings (SF R10 and SF2 sighting rules, fund-safety follow-up of 12 Nov 2026): `sighting` records, once the runner's own RPC
 * returned a buy, that it was `present` (a transaction body or a status for it) or `landed` (a finalized getTransaction without
 * error), and when. Written only by recordSighting (called only by S4, before any stop or gate check), never by update; it moves
 * only from absent to present or landed and from present to landed, never back, and is never removed. The key is omitted while
 * absent, so a journal without sightings is written byte-identical to before; an older runner, whose closed key set lacks it,
 * fails closed (state_unavailable) only on a journal that holds one.
 * Probe stamps (fund-safety follow-up C1, 12 Nov 2026): `probePending` is written by recordProbe (S4 only) BEFORE the buy proof's
 * reads and removed only once that probe's outcome is persisted: by recordSighting (the sighting replaces it, in the same write) or
 * by clearProbe (the probe sighted nothing). A stamp found later (a kill or a failed commit between the reads and that write) is
 * read by S4 exactly as a `present` sighting. Write-once per probe (a present stamp or any sighting is kept as it is), never next to
 * a sighting, omitted while absent, and it never moves updatedAt, so a probe that sighted nothing leaves the journal byte-identical;
 * an older runner (closed key set) fails closed only while a stamp is present. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { runnerSignedTransactionSignature, RUNNER_LOCAL_SWAP_STATES, type RunnerLocalSwapState } from "@balchemyai/agent-sdk";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp, type RunnerBuyCheckReason, type RunnerLandingReleaseReason } from "./protocol.js";
import { decodeBase58, isSolanaAddress } from "./solana-base58.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_SUBMISSION_STATES = ["signed", "submitted_known", "submitted_unknown", "facts_pending", "disputed",
  "completed", "failed_onchain", "expired_not_landed", "closed_by_owner"] as const;
export type PrivateSubmissionState = typeof PRIVATE_SUBMISSION_STATES[number];
/** Owner decision 26 (11 Nov 2026): the owner's close-out (`runner trades <agent> close <attempt>`) of an attempt whose bytes the runner
 * proved can no longer land. Terminal, but evidence of NOTHING about the outcome: never "did not land", never "not sold". Written only by
 * closeByOwner; no server state ever maps to it. */
export const PRIVATE_SUBMISSION_OWNER_CLOSED = "closed_by_owner";
export const PRIVATE_SUBMISSION_TERMINAL: readonly PrivateSubmissionState[] = ["completed", "failed_onchain", "expired_not_landed", "closed_by_owner"];
export const PRIVATE_SUBMISSION_MAX_ATTEMPTS = 64;
/** Identical-byte relays after the first one (decision 4), at least this far apart. */
export const PRIVATE_SUBMISSION_MAX_RESENDS = 8;
export const PRIVATE_SUBMISSION_RESEND_SPACING_MS = 2_000;
const MAX_JOURNAL_BYTES = 256 * 1024;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const ATTEMPT_KEY = /^att:[0-9a-f]{32}$/;
const REASON = /^[a-z0-9_:]{1,96}$/;
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** Journal reason of an attempt whose message landed under a different (observed) signature. */
export const PRIVATE_SUBMISSION_OBSERVED_COPY_REASON = "observed_resigned_copy";
/** Forward-only order; equal ranks may alternate (known/unknown, facts pending/disputed). */
const RANK: Readonly<Record<PrivateSubmissionState, number>> = Object.freeze({ signed: 0, submitted_known: 1, submitted_unknown: 1,
  facts_pending: 2, disputed: 2, completed: 3, failed_onchain: 3, expired_not_landed: 3, closed_by_owner: 3 });
export const PRIVATE_SUBMISSION_ERRORS = ["invalid_request", "unknown_agent", "journal_full", "wallet_busy", "attempt_conflict",
  "attempt_missing", "transition_invalid", "state_unavailable", "closing", "copy_unacknowledged"] as const;
export type PrivateSubmissionErrorCode = typeof PRIVATE_SUBMISSION_ERRORS[number];
export class PrivateSubmissionJournalError extends Error {
  constructor(readonly code: PrivateSubmissionErrorCode) { super(`Local submission journal ${code}`); this.name = "PrivateSubmissionJournalError"; }
}
function fail(code: PrivateSubmissionErrorCode = "invalid_request"): never { throw new PrivateSubmissionJournalError(code); }

/** Public facts of the validated buy, for readback only. gross = fee + net (lamports). */
export interface PrivateSubmissionBuySwap {
  direction: "buy"; inputMint: string; outputMint: string; grossInLamports: string; feeLamports: string; netInLamports: string;
  quotedOut: string; minOut: string; priorityFeeLamports: string;
}
/** S5c: public facts of a validated exit sell (token -> WSOL) of one position's pending exit: grossInUnits of the position mint
 * for at least minOut lamports (net of the platform fee), the platform fee rate, the priority fee, and the wallet's WSOL ATA
 * the finalized proof must find closed. Exact canonical integer text, closed keys. Its settlement is the position's, never
 * the spend ledger's. */
export interface PrivateSubmissionSellSwap {
  direction: "sell"; positionId: string; inputMint: string; outputMint: string; grossInUnits: string; quotedOut: string; minOut: string;
  platformFeeBps: number; priorityFeeLamports: string; wsolAccount: string;
}
/** Buy snapshots written before exits existed parse exactly as before (the buy key set and rules are unchanged). */
export type PrivateSubmissionSwap = PrivateSubmissionBuySwap | PrivateSubmissionSellSwap;
export interface PrivateSubmissionAttempt {
  attemptKey: string; reservationId: string; buildDigest: string; walletBindingId: string; walletAddress: string;
  messageSha256: string; signature: string;
  /** Canonical base64 wire transaction (one signature + the validated message). Never displayed or re-signed. */
  wireB64: string; blockhash: string; lastValidBlockHeight: string; swap: PrivateSubmissionSwap;
  state: PrivateSubmissionState;
  /** Last engine state the relay proved (status or submit), or null before any. */
  engineState: RunnerLocalSwapState | null;
  /** Relay calls made, persisted before each one (the first plus at most PRIVATE_SUBMISSION_MAX_RESENDS). */
  submits: number; lastSubmitAt: number;
  /** `closed` after a relay refusal that no identical resend can change, or a locally observed expiry. */
  relay: "open" | "closed";
  reason: string | null; createdAt: number; updatedAt: number;
  /** A landed different-signature copy of this message that Balchemy adopted, or null. Set once, never changed. */
  observedSignature: string | null;
  /** When the owner acknowledged the observed copy (acknowledge-copy), or null. Until then the wallet is held. */
  copyAcknowledgedAt: number | null;
  /** F2: the finalized slot F after which these bytes provably cannot land, and when S4 recorded it; null while not released.
   * Write-once (closeLanding). Omitted from the stored file while null. */
  landingClosed: PrivateSubmissionLandingClosed | null;
  /** Owner decision 26: the finalized slot F after which these bytes provably cannot land (a fresh proof, or the release's own F), and
   * when the owner closed the attempt out (state closed_by_owner); null otherwise. Written once by closeByOwner. Omitted from the
   * stored file while null. */
  ownerClosed: PrivateSubmissionLandingClosed | null;
  /** SF R10 and SF2: what the runner's own RPC has shown of this buy, and when (write-once per kind, monotonic: present -> landed,
   * never back). Absent while there is none: the key is never present with an empty value, in memory or on disk. Written only by
   * recordSighting. */
  sighting?: PrivateSubmissionSighting;
  /** C1: a buy proof started at `at` whose outcome is not persisted yet (recordProbe; removed by recordSighting or clearProbe).
   * Absent while there is none; never next to `sighting`. S4 reads a stamp it finds as a `present` sighting. */
  probePending?: PrivateSubmissionProbePending;
}
export interface PrivateSubmissionProbePending { at: number }
export interface PrivateSubmissionLandingClosed { finalizedSlot: string; at: number }
/** SF R10 and SF2: `present` (some read returned the buy's transaction or a status for it) or `landed` (a finalized getTransaction
 * without error). `landed` supersedes `present`. */
export const PRIVATE_SUBMISSION_SIGHTING_KINDS = ["present", "landed"] as const;
export type PrivateSubmissionSightingKind = typeof PRIVATE_SUBMISSION_SIGHTING_KINDS[number];
export interface PrivateSubmissionSighting { kind: PrivateSubmissionSightingKind; at: number }
export type PrivateSubmissionRecordInput = Pick<PrivateSubmissionAttempt, "attemptKey" | "reservationId" | "buildDigest" | "walletBindingId"
  | "walletAddress" | "messageSha256" | "signature" | "wireB64" | "blockhash" | "lastValidBlockHeight" | "swap">;
export type PrivateSubmissionChange = Partial<Pick<PrivateSubmissionAttempt, "state" | "engineState" | "submits" | "lastSubmitAt" | "relay" | "reason"
  | "observedSignature">>;
interface PrivateSubmissionViewCommon {
  attemptKey: string; reservationId: string; state: PrivateSubmissionState; engineState: RunnerLocalSwapState | null; signature: string;
  lastValidBlockHeight: string; submits: number; reason: string | null; createdAt: number; updatedAt: number;
  /** Public signature of a landed copy signed outside this runner, or null. */
  observedSignature: string | null;
  /** True while an observed copy is unacknowledged: new autonomous submissions for this wallet are held. */
  securityHold: boolean;
  /** F2: the bytes provably can no longer land (a released runner dispute); the record stays disputed for owner review. Present
   * (true) only on a released attempt: absent reads as false, so the readback of a journal without releases is exactly the
   * pre-F2 wire and a CLI and a daemon of different versions still agree on it. SF R10: also a buy whose wallet lock was released
   * while Balchemy left it unresolved (its record may have moved on since). */
  released?: boolean;
  /** F2: why S4 has not released this runner dispute (SF R10: or this unresolved buy) yet (process-local; present only while S4 has
   * tried and not released). */
  releaseCheck?: RunnerLandingReleaseReason;
}
/** Readback projection of a buy (unchanged wire): no wire bytes, keys or proofs. */
export interface PrivateSubmissionBuyView extends PrivateSubmissionViewCommon {
  direction: "buy"; outputMint: string; grossInLamports: string; feeLamports: string; netInLamports: string; minOut: string;
  /** SF2: why the runner has not yet proven on its own RPC that this buy did not land, and how many counted results of that reason
   * it has (process-local; present only on a held buy whose Balchemy record is failed_onchain or expired_not_landed). */
  buyCheck?: PrivateSubmissionBuyCheck;
}
export interface PrivateSubmissionBuyCheck { reason: RunnerBuyCheckReason; counted: number }
/** Readback projection of an exit sell. The buy-only amount fields never exist on it (declared absent so a mixed readback
 * reads uniformly). */
export interface PrivateSubmissionSellView extends PrivateSubmissionViewCommon {
  direction: "sell"; positionId: string; inputMint: string; grossInUnits: string; quotedOut: string; minOut: string; platformFeeBps: number;
  outputMint?: never; grossInLamports?: never; feeLamports?: never; netInLamports?: never; buyCheck?: never;
}
export type PrivateSubmissionView = PrivateSubmissionBuyView | PrivateSubmissionSellView;
/** Newest attempts returned by one readback (fits one IPC frame). */
export const PRIVATE_SUBMISSION_READBACK_LIMIT = 16;
export interface PrivateSubmissionReadback { agentId: string; total: number; attempts: PrivateSubmissionView[] }
/** `evictedRecentAt` (K1 max_trades_per_day.v1, 19 Nov 2026; omitted while absent, so a journal that never evicted a recent attempt
 * is written byte-identical to before): the newest createdAt of an attempt this journal evicted while that attempt was less than
 * PRIVATE_SUBMISSION_DAY_MS old. While it is inside the last day, a rolling 24-hour trade count from this journal is incomplete
 * (privateSubmissionDayCount answers null: the daily limit holds). The next write after it aged out drops it again. An older runner,
 * whose closed key set lacks it, fails closed (state_unavailable) only on a journal that holds one, which needs 64 attempts within
 * one day. */
interface Snapshot { schemaVersion: 1; localProfileId: string; agentId: string; attempts: PrivateSubmissionAttempt[]; evictedRecentAt?: number }
/** The rolling window of max_trades_per_day.v1. */
export const PRIVATE_SUBMISSION_DAY_MS = 24 * 60 * 60_000;
/** The eviction watermark after a write at `nowMs` that evicted `evicted`: kept (or raised) only while inside the last day. */
function evictionWatermark(prior: number | undefined, evicted: readonly PrivateSubmissionAttempt[], nowMs: number): number | undefined {
  const recent = evicted.filter((item) => item.createdAt > nowMs - PRIVATE_SUBMISSION_DAY_MS).map((item) => item.createdAt);
  const kept = prior !== undefined && prior > nowMs - PRIVATE_SUBMISSION_DAY_MS ? [prior] : [];
  const all = [...kept, ...recent];
  return all.length ? Math.max(...all) : undefined;
}

export function isPrivateSubmissionTerminal(state: PrivateSubmissionState): boolean { return PRIVATE_SUBMISSION_TERMINAL.includes(state); }
/** An observed re-signed copy the owner has not acknowledged yet: it holds the wallet. */
export function privateSubmissionCopyHeld(attempt: Pick<PrivateSubmissionAttempt, "observedSignature" | "copyAcknowledgedAt">): boolean {
  return attempt.observedSignature !== null && attempt.copyAcknowledgedAt === null;
}
/** F2: a relay-closed `runner:` dispute whose landing S4 proved closed (landingClosed): it no longer holds its wallet. An absent
 * field reads as not released (fail closed). */
export function privateSubmissionReleased(attempt: Pick<PrivateSubmissionAttempt, "landingClosed">): boolean {
  return attempt.landingClosed !== null && attempt.landingClosed !== undefined;
}
/** F2: the attempt holds its wallet (one per wallet): every non-terminal attempt that is not released. Replaces "unfinished" in
 * every wallet-hold check. */
export function privateSubmissionHoldsWallet(attempt: Pick<PrivateSubmissionAttempt, "state" | "landingClosed">): boolean {
  return !isPrivateSubmissionTerminal(attempt.state) && !privateSubmissionReleased(attempt);
}
/** Owner decision 26: the owner closed this attempt out. Its outcome stays unknown: every consumer treats it as evidence of nothing
 * (like a runner dispute for "not sold" and "not landed"; the spend of a buy is committed and its mint is never managed). */
export function privateSubmissionOwnerClosed(attempt: Pick<PrivateSubmissionAttempt, "state">): boolean { return attempt.state === PRIVATE_SUBMISSION_OWNER_CLOSED; }
/** Owner decision 44 (12 Nov 2026, "Evet, 30 dk sonra taze kanıtla"): a buy Balchemy left unresolved that the runner has not released
 * becomes closable once it is this old (since createdAt). SF R10 releases such a buy only within one armed run, so a restart (every
 * restart disarms) used to leave it unclosable for good. The same 30 minutes as SF R10's grace (PRIVATE_STALL_RELEASE_GRACE_MS). */
export const PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS = 30 * 60_000;
/** Owner decision 44: a buy Balchemy left unresolved (privateSubmissionStalledBuy), not released, at least
 * PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS old at `nowMs`. Its close-out always needs a fresh expiry proof (no release F to reuse). */
export function privateSubmissionStalledBuyClosable(attempt: PrivateSubmissionAttempt, nowMs: number): boolean {
  return privateSubmissionStalledBuy(attempt) && !privateSubmissionReleased(attempt) && Number.isSafeInteger(nowMs)
    && nowMs - attempt.createdAt >= PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS;
}
/** Owner decision 26: what the owner may close out: a non-terminal attempt without an unacknowledged copy that is either a relay-closed
 * `runner:` dispute (released or not; buy or sell, R5/R6 included) or a released attempt (F2, or a buy released while Balchemy left it
 * unresolved, SF R10). Owner decision 44: with `nowMs`, also a buy Balchemy left unresolved and the runner has not released once it is
 * PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS old (privateSubmissionStalledBuyClosable). Without `nowMs` that case is never closable (fail
 * closed). Never a server dispute (engine:finalized_facts_disputed), facts_pending, a negative Balchemy record still under the SF2 check,
 * or an unresolved buy younger than that. */
export function privateSubmissionOwnerClosable(attempt: PrivateSubmissionAttempt, nowMs?: number): boolean {
  if (isPrivateSubmissionTerminal(attempt.state) || privateSubmissionCopyHeld(attempt)) return false;
  return (runnerDispute(attempt) && attempt.relay === "closed") || privateSubmissionReleased(attempt)
    || (nowMs !== undefined && privateSubmissionStalledBuyClosable(attempt, nowMs));
}
/** What arming counts (private-arming.ts readSubmissions): every non-terminal attempt (a released one included) is unresolved, and
 * every unacknowledged copy holds. An attempt the owner closed out is terminal, so it no longer counts. `unrelayed` (M3.6 D6 K1): how
 * many of the unresolved ones are trades Balchemy never received (privateSubmissionUnrelayed), so arming can name that hold. */
export function privateSubmissionArmingCounts(attempts: readonly PrivateSubmissionAttempt[]): { unfinished: number; copyHolds: number; unrelayed: number } {
  return { unfinished: attempts.filter((item) => !isPrivateSubmissionTerminal(item.state)).length, copyHolds: attempts.filter(privateSubmissionCopyHeld).length,
    unrelayed: attempts.filter(privateSubmissionUnrelayed).length };
}
/** M3.6 D6 K1 (finding F-M36-D6-K1, and its sell twin B1 of the slice 7 audit): an attempt Balchemy reports it never received.
 * Non-terminal, not disputed, not facts_pending, no observed copy, and its engine record still `awaiting_signature`: the engine holds no
 * signed bytes for it (the runner never broadcasts itself). Typically signed and journaled right before a crash (every restart disarms and
 * every relay needs live_armed), or relayed during an outage longer than the blockhash lifetime; the runner then closed its relay at the
 * blockhash expiry. The runner's own proof that the bytes can no longer land and did not land (private-submission.ts: a buy through
 * #settleBuys, SF2 R2-R4; a sell through #settleUnrelayedSells, privateExitExpiryProof) makes it terminal expired_not_landed, also while
 * the agent is disarmed; until then arming refuses `submission_unrelayed`. */
export function privateSubmissionUnrelayed(attempt: Pick<PrivateSubmissionAttempt, "state" | "observedSignature" | "engineState">): boolean {
  return !isPrivateSubmissionTerminal(attempt.state) && attempt.state !== "disputed" && attempt.state !== "facts_pending"
    && attempt.observedSignature === null && attempt.engineState === "awaiting_signature";
}
/** Final audit part 3 SF-A: the engine states of a sell Balchemy journaled (relayed) and has not resolved: the engine holds the signed
 * bytes, and neither a finalized outcome nor a negative is recorded yet. */
export const PRIVATE_SUBMISSION_ENGINE_UNRESOLVED_STATES: readonly RunnerLocalSwapState[] = Object.freeze(["prepared", "submitted_known", "submitted_unknown"]);
/** SF-A: a sell Balchemy relayed and leaves unresolved: non-terminal, not disputed, not facts_pending, no observed copy, not released, and
 * its engine record in PRIVATE_SUBMISSION_ENGINE_UNRESOLVED_STATES (never awaiting_signature: that is privateSubmissionUnrelayed, B1).
 * The runner proves it on its own RPC (private-submission.ts #settleStalledSells). */
export function privateSubmissionEngineUnresolvedSell(attempt: Pick<PrivateSubmissionAttempt, "swap" | "state" | "observedSignature" | "engineState" | "landingClosed">): boolean {
  return attempt.swap.direction === "sell" && !isPrivateSubmissionTerminal(attempt.state) && attempt.state !== "disputed" && attempt.state !== "facts_pending"
    && attempt.observedSignature === null && !privateSubmissionReleased(attempt) && attempt.engineState !== null
    && PRIVATE_SUBMISSION_ENGINE_UNRESOLVED_STATES.includes(attempt.engineState);
}
/** SF-A: the journal reason of the terminal write after the runner proved, on its own RPC, that a sell Balchemy left unresolved did not
 * land and can no longer land (expired_not_landed). Its engine record may still count the sell as pending. */
export const PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON = "s5c:engine_unresolved_not_landed";
/** SF-A: the journal reasons of the terminal writes after the runner's own RPC showed such a sell finalized: without error (completed)
 * or with one (failed_onchain). The settlement pass then settles the position from its own proof of that transaction. */
export const PRIVATE_SELL_ENGINE_UNRESOLVED_LANDED_REASON = "s5c:engine_unresolved_landed";
export const PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON = "s5c:engine_unresolved_failed";
/** SF-A: the runner-written negative terminal reasons whose engine record was still unresolved: the not-landed proof above, the S1
 * bound (private-submission.ts PRIVATE_SELL_EXPIRY_UNPROVEN_REASON; a literal here, tied to it by a test), and (finding 3 of the SF-A
 * review) the runner's own failed_onchain read (its single RPC's meta.err; its units return through the settlement pass). Balchemy may
 * report on them later; the runner keeps reading that report (privateSubmissionLateWatched). */
export const PRIVATE_SUBMISSION_LATE_WATCH_REASONS: readonly string[] = Object.freeze([PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON, "s5c:expiry_unproven",
  PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON]);
/** The one journal state each late-watch reason is written with (#settleStalledSells); any other pairing is never watched. */
const LATE_WATCH_STATE: Readonly<Record<string, PrivateSubmissionState>> = { [PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON]: "expired_not_landed",
  "s5c:expiry_unproven": "expired_not_landed", [PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON]: "failed_onchain" };
/** A sell in a runner-written negative terminal state of a late-watch reason (whatever Balchemy reported since). */
function lateWatchEnded(attempt: Pick<PrivateSubmissionAttempt, "swap" | "state" | "reason">): boolean {
  return attempt.swap.direction === "sell" && attempt.reason !== null && PRIVATE_SUBMISSION_LATE_WATCH_REASONS.includes(attempt.reason)
    && Object.hasOwn(LATE_WATCH_STATE, attempt.reason) && LATE_WATCH_STATE[attempt.reason] === attempt.state;
}
/** SF-A: the engine states that report a landing (a finalized success): a negative the runner wrote is contradicted by them. */
export const PRIVATE_SUBMISSION_LANDING_ENGINE_STATES: readonly RunnerLocalSwapState[] = Object.freeze(["completed", "finalized_facts_pending",
  "finalized_facts_disputed"]);
/** SF-A: the late engine states recordLateReport accepts: a landing, or the engine's own negative (consistent with the runner's). */
const LATE_ENGINE_STATES: readonly RunnerLocalSwapState[] = Object.freeze([...PRIVATE_SUBMISSION_LANDING_ENGINE_STATES, "failed_onchain", "expired_not_landed"]);
/** SF-A: a sell the runner itself made terminal-negative while Balchemy still had it unresolved, with no late report recorded yet. */
export function privateSubmissionLateWatched(attempt: Pick<PrivateSubmissionAttempt, "swap" | "state" | "reason" | "engineState" | "observedSignature">): boolean {
  return lateWatchEnded(attempt) && attempt.observedSignature === null && attempt.engineState !== null
    && PRIVATE_SUBMISSION_ENGINE_UNRESOLVED_STATES.includes(attempt.engineState);
}
/** SF-A review findings 2-4: such a sell on which Balchemy's later report recorded a landing (privateSubmissionEngineReportedLanding) or a
 * re-signed copy (recordLateReport): the runner's own negative is contradicted, so its position owes the owner a hold. */
export function privateSubmissionLateContradicted(attempt: Pick<PrivateSubmissionAttempt, "swap" | "state" | "reason" | "engineState" | "observedSignature">): boolean {
  return lateWatchEnded(attempt) && (privateSubmissionEngineReportedLanding(attempt) || attempt.observedSignature !== null);
}
/** SF-A review finding 4: the hold a contradicted sell (privateSubmissionLateContradicted) owes is not applied yet, and still can be: its
 * position (same wallet and mint) is not closed, does not carry that sell as its pending exit (held, or settled by the settlement pass's
 * own rules), and never completed it. A missing position owes nothing. (Structural position type: this module reads no position ledger.) */
export function privateSubmissionLateHoldOwed(attempt: Pick<PrivateSubmissionAttempt, "swap" | "state" | "reason" | "engineState" | "observedSignature" | "reservationId"
  | "walletAddress">, position: { readonly state: string; readonly walletAddress: string; readonly tokenMint: string;
  readonly pendingExit: { readonly reservationId: string } | null; readonly exits: readonly { readonly reservationId: string }[] } | undefined): boolean {
  if (attempt.swap.direction !== "sell" || !privateSubmissionLateContradicted(attempt) || !position || position.state === "closed") return false;
  if (position.walletAddress !== attempt.walletAddress || position.tokenMint !== attempt.swap.inputMint) return false;
  return position.pendingExit?.reservationId !== attempt.reservationId && !position.exits.some((item) => item.reservationId === attempt.reservationId);
}
/** SF-A: Balchemy's record of this attempt reports a landing (a finalized success), whatever the journal state says. */
export function privateSubmissionEngineReportedLanding(attempt: Pick<PrivateSubmissionAttempt, "engineState">): boolean {
  return attempt.engineState !== null && PRIVATE_SUBMISSION_LANDING_ENGINE_STATES.includes(attempt.engineState);
}
/** The buy half of privateSubmissionUnrelayed (SF R10 never takes it; the buy settlement pass does). */
export function privateSubmissionUnrelayedBuy(attempt: Pick<PrivateSubmissionAttempt, "swap" | "state" | "observedSignature" | "engineState">): boolean {
  return attempt.swap.direction === "buy" && privateSubmissionUnrelayed(attempt);
}
/** C2: the reservation ids the spend ledger's compaction must never fold: every attempt that is not terminal or is released. A
 * later close-out (commit) or buy settlement (release, dispute) of such an attempt still reads its reservation. */
export function privateSubmissionKeptReservations(attempts: readonly PrivateSubmissionAttempt[]): string[] {
  return attempts.filter((item) => !isPrivateSubmissionTerminal(item.state) || privateSubmissionReleased(item)).map((item) => item.reservationId);
}
/** A `runner:` dispute: a runner-observed contradiction held for the owner (no server state settles it). */
function runnerDispute(attempt: Pick<PrivateSubmissionAttempt, "state" | "reason">): boolean {
  return attempt.state === "disputed" && (attempt.reason ?? "").startsWith("runner:");
}
/** SF R10: engine states outside the R10 scope: `completed`, the negatives (the SF2 buy settlement's, R3), and the two states the
 * engine reaches only after a finalized success (balchemy-trading-engine local_swap.rs: unresolved --finalized ok--> completed |
 * finalized_facts_pending | finalized_facts_disputed). Against Balchemy's positive record the runner's single RPC never releases
 * anything (the balance settlement's rule, private-position-balance.ts). */
export const PRIVATE_STALL_EXCLUDED_ENGINE_STATES: readonly RunnerLocalSwapState[] = Object.freeze(["completed", "failed_onchain", "expired_not_landed",
  "finalized_facts_pending", "finalized_facts_disputed"]);
/** SF R10: a buy Balchemy leaves unresolved: non-terminal, not disputed (neither a `runner:` dispute nor
 * engine:finalized_facts_disputed), not facts_pending, no observed copy, and no engine state in PRIVATE_STALL_EXCLUDED_ENGINE_STATES.
 * Examples: signed or submitted_unknown, a status refusal or an unreachable status, engine:reconcile_blocked_insufficient_providers.
 * The journal states are checked as well as the engine state: a journal state never moves down (RANK), so a later inconsistent
 * engine report cannot bring a finalized buy back into scope. */
export function privateSubmissionStalledBuy(attempt: Pick<PrivateSubmissionAttempt, "swap" | "state" | "observedSignature" | "engineState">): boolean {
  return attempt.swap.direction === "buy" && !isPrivateSubmissionTerminal(attempt.state) && attempt.state !== "disputed" && attempt.state !== "facts_pending"
    && attempt.observedSignature === null && (attempt.engineState === null || !PRIVATE_STALL_EXCLUDED_ENGINE_STATES.includes(attempt.engineState));
}
/** A released attempt accepts no journal change (only acknowledge-copy): every F2 release, and a released buy once it became a
 * `runner:` dispute. A released buy Balchemy left unresolved (R10) still follows server truth. */
function releaseFrozen(attempt: PrivateSubmissionAttempt): boolean {
  return privateSubmissionReleased(attempt) && (attempt.swap.direction !== "buy" || runnerDispute(attempt));
}
/** Terminal states never change; otherwise the rank never decreases. */
export function privateSubmissionTransitionAllowed(from: PrivateSubmissionState, to: PrivateSubmissionState): boolean {
  return from === to || (!isPrivateSubmissionTerminal(from) && RANK[to] >= RANK[from]);
}
/** Deterministic journal key for one reservation's only attempt (an attempt is never re-signed). */
export function privateSubmissionAttemptKey(input: { localProfileId: string; agentId: string; reservationId: string; buildDigest: string; messageSha256: string }): string {
  if (![input.localProfileId, input.agentId].every(isId) || !UUID4.test(input.reservationId) || !HEX.test(input.buildDigest) || !HEX.test(input.messageSha256)) fail();
  return `att:${createHash("sha256").update(JSON.stringify(["balchemy.local-agent.submission-attempt.v1", input.localProfileId, input.agentId,
    input.reservationId, input.buildDigest, input.messageSha256]), "utf8").digest("hex").slice(0, 32)}`;
}
export function privateSubmissionView(attempt: PrivateSubmissionAttempt): PrivateSubmissionView {
  if (attempt.swap.direction === "sell") {
    const sell = attempt.swap;
    return { attemptKey: attempt.attemptKey, reservationId: attempt.reservationId, state: attempt.state, engineState: attempt.engineState,
      signature: attempt.signature, direction: "sell", positionId: sell.positionId, inputMint: sell.inputMint, grossInUnits: sell.grossInUnits,
      quotedOut: sell.quotedOut, minOut: sell.minOut, platformFeeBps: sell.platformFeeBps, lastValidBlockHeight: attempt.lastValidBlockHeight,
      submits: attempt.submits, reason: attempt.reason, createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
      observedSignature: attempt.observedSignature, securityHold: privateSubmissionCopyHeld(attempt), ...releasedKey(attempt) };
  }
  return { attemptKey: attempt.attemptKey, reservationId: attempt.reservationId, state: attempt.state, engineState: attempt.engineState,
    signature: attempt.signature, direction: attempt.swap.direction, outputMint: attempt.swap.outputMint, grossInLamports: attempt.swap.grossInLamports,
    feeLamports: attempt.swap.feeLamports, netInLamports: attempt.swap.netInLamports, minOut: attempt.swap.minOut,
    lastValidBlockHeight: attempt.lastValidBlockHeight, submits: attempt.submits, reason: attempt.reason, createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
    observedSignature: attempt.observedSignature, securityHold: privateSubmissionCopyHeld(attempt), ...releasedKey(attempt) };
}
/** The view's `released` key: present only on a released attempt. */
function releasedKey(attempt: PrivateSubmissionAttempt): { released?: true } { return privateSubmissionReleased(attempt) ? { released: true } : {}; }

function u64(value: unknown, minimum = 0n): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) fail();
  const result = BigInt(value); if (result < minimum || result > (1n << 64n) - 1n) fail(); return result;
}
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  const present = optional.filter((key) => Object.hasOwn(fields, key)).length;
  if (Reflect.ownKeys(value).length !== keys.length + present || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
const isTxSignature = (value: unknown): value is string => typeof value === "string" && TX_SIGNATURE.test(value) && decodeBase58(value, 64) !== undefined;
const POSITION_ID = /^pos:[0-9a-f]{32}$/;
const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** S5c exit sell facts: closed keys, canonical integers, the position mint -> WSOL, minOut <= quotedOut, a u8 fee rate. */
function parseSellSwap(value: unknown): PrivateSubmissionSellSwap {
  exact(value, ["direction", "positionId", "inputMint", "outputMint", "grossInUnits", "quotedOut", "minOut", "platformFeeBps", "priorityFeeLamports",
    "wsolAccount"]);
  u64(value.grossInUnits, 1n); const quoted = u64(value.quotedOut, 1n), minimum = u64(value.minOut, 1n); u64(value.priorityFeeLamports);
  const rate = value.platformFeeBps;
  if (value.direction !== "sell" || typeof value.positionId !== "string" || !POSITION_ID.test(value.positionId) || !isSolanaAddress(value.inputMint)
    || value.inputMint === WSOL_MINT || value.outputMint !== WSOL_MINT || !isSolanaAddress(value.wsolAccount) || value.wsolAccount === value.inputMint
    || typeof rate !== "number" || !Number.isInteger(rate) || rate < 0 || rate > 255 || minimum > quoted) fail();
  return { direction: "sell", positionId: value.positionId, inputMint: value.inputMint, outputMint: WSOL_MINT, grossInUnits: value.grossInUnits as string,
    quotedOut: value.quotedOut as string, minOut: value.minOut as string, platformFeeBps: rate, priorityFeeLamports: value.priorityFeeLamports as string,
    wsolAccount: value.wsolAccount };
}
/** The swap facts' own `direction` data field selects the closed key set; anything but a sell keeps the exact buy rules. */
function parseSwap(value: unknown): PrivateSubmissionSwap {
  const direction = isRecord(value) ? Object.getOwnPropertyDescriptor(value, "direction") : undefined;
  if (direction && "value" in direction && direction.value === "sell") return parseSellSwap(value);
  exact(value, ["direction", "inputMint", "outputMint", "grossInLamports", "feeLamports", "netInLamports", "quotedOut", "minOut", "priorityFeeLamports"]);
  const gross = u64(value.grossInLamports, 1n), fee = u64(value.feeLamports), net = u64(value.netInLamports, 1n);
  u64(value.quotedOut, 1n); u64(value.minOut, 1n); u64(value.priorityFeeLamports);
  if (value.direction !== "buy" || !isSolanaAddress(value.inputMint) || !isSolanaAddress(value.outputMint) || value.inputMint === value.outputMint
    || gross !== fee + net) fail();
  return { direction: "buy", inputMint: value.inputMint, outputMint: value.outputMint, grossInLamports: value.grossInLamports as string,
    feeLamports: value.feeLamports as string, netInLamports: value.netInLamports as string, quotedOut: value.quotedOut as string,
    minOut: value.minOut as string, priorityFeeLamports: value.priorityFeeLamports as string };
}
/** The wire must be exactly one signature (the stored one) over the message whose sha256 is stored. */
function wireMatches(wireB64: unknown, signature: unknown, messageSha256: unknown): boolean {
  if (typeof wireB64 !== "string" || typeof signature !== "string" || runnerSignedTransactionSignature(wireB64) !== signature) return false;
  const wire = Buffer.from(wireB64, "base64");
  return createHash("sha256").update(wire.subarray(65)).digest("hex") === messageSha256;
}
function parseAttempt(value: unknown): PrivateSubmissionAttempt {
  // observedSignature/copyAcknowledgedAt are absent in journals written before re-signed copies were reported (read as null);
  // landingClosed (F2) and ownerClosed (owner decision 26) are absent while null.
  exact(value, ["attemptKey", "reservationId", "buildDigest", "walletBindingId", "walletAddress", "messageSha256", "signature", "wireB64",
    "blockhash", "lastValidBlockHeight", "swap", "state", "engineState", "submits", "lastSubmitAt", "relay", "reason", "createdAt", "updatedAt"],
  ["observedSignature", "copyAcknowledgedAt", "landingClosed", "ownerClosed", "sighting", "probePending"]);
  const v = value; u64(v.lastValidBlockHeight, 1n);
  const sighting = Object.hasOwn(v, "sighting") ? parseSighting(v.sighting, v) : undefined;
  const probePending = Object.hasOwn(v, "probePending") ? parseProbePending(v.probePending, v, sighting) : undefined;
  const observedSignature = v.observedSignature ?? null; const copyAcknowledgedAt = v.copyAcknowledgedAt ?? null;
  if ((observedSignature !== null && (!isTxSignature(observedSignature) || observedSignature === v.signature))
    || (copyAcknowledgedAt !== null && (observedSignature === null || !isTimestamp(copyAcknowledgedAt)
      || copyAcknowledgedAt < (v.createdAt as number) || copyAcknowledgedAt > (v.updatedAt as number)))) fail();
  const landingClosed = parseLandingClosed(v.landingClosed ?? null, v);
  const ownerClosed = parseOwnerClosed(v.ownerClosed ?? null, v, landingClosed, observedSignature !== null && copyAcknowledgedAt === null);
  if (typeof v.attemptKey !== "string" || !ATTEMPT_KEY.test(v.attemptKey) || typeof v.reservationId !== "string" || !UUID4.test(v.reservationId)
    || typeof v.buildDigest !== "string" || !HEX.test(v.buildDigest) || typeof v.walletBindingId !== "string" || !UUID4.test(v.walletBindingId)
    || !isSolanaAddress(v.walletAddress) || typeof v.messageSha256 !== "string" || !HEX.test(v.messageSha256) || !isSolanaAddress(v.blockhash)
    || !wireMatches(v.wireB64, v.signature, v.messageSha256)
    || !PRIVATE_SUBMISSION_STATES.includes(v.state as PrivateSubmissionState)
    || (v.engineState !== null && !RUNNER_LOCAL_SWAP_STATES.includes(v.engineState as RunnerLocalSwapState))
    || typeof v.submits !== "number" || !Number.isSafeInteger(v.submits) || v.submits < 1 || v.submits > 1 + PRIVATE_SUBMISSION_MAX_RESENDS
    || (v.relay !== "open" && v.relay !== "closed") || (v.reason !== null && (typeof v.reason !== "string" || !REASON.test(v.reason)))
    || !isTimestamp(v.createdAt) || !isTimestamp(v.updatedAt) || !isTimestamp(v.lastSubmitAt) || v.updatedAt < v.createdAt
    || v.lastSubmitAt < v.createdAt || v.lastSubmitAt > v.updatedAt) fail();
  return { attemptKey: v.attemptKey, reservationId: v.reservationId, buildDigest: v.buildDigest, walletBindingId: v.walletBindingId,
    walletAddress: v.walletAddress, messageSha256: v.messageSha256, signature: v.signature as string, wireB64: v.wireB64 as string,
    blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight as string, swap: parseSwap(v.swap), state: v.state as PrivateSubmissionState,
    engineState: v.engineState as RunnerLocalSwapState | null, submits: v.submits, lastSubmitAt: v.lastSubmitAt, relay: v.relay,
    reason: v.reason as string | null, createdAt: v.createdAt, updatedAt: v.updatedAt, observedSignature: observedSignature as string | null,
    copyAcknowledgedAt: copyAcknowledgedAt as number | null, landingClosed, ownerClosed, ...(sighting ? { sighting } : {}),
    ...(probePending ? { probePending } : {}) };
}
/** C1 stamp invariants: present only as a closed {at} (never null or empty), only on a buy without a sighting, at or after createdAt
 * (it never moves updatedAt, so it is not bounded by it). */
function parseProbePending(value: unknown, attempt: Record<string, unknown>, sighting: PrivateSubmissionSighting | undefined): PrivateSubmissionProbePending {
  exact(value, ["at"]);
  if (sighting !== undefined || !isRecord(attempt.swap) || attempt.swap.direction !== "buy" || !isTimestamp(value.at) || !isTimestamp(attempt.createdAt)
    || value.at < attempt.createdAt) fail();
  return { at: value.at };
}
/** Sighting invariants: present only as a closed {kind, at} (never null or empty), only on a buy, createdAt <= at <= updatedAt. */
function parseSighting(value: unknown, attempt: Record<string, unknown>): PrivateSubmissionSighting {
  exact(value, ["kind", "at"]);
  if (!PRIVATE_SUBMISSION_SIGHTING_KINDS.includes(value.kind as PrivateSubmissionSightingKind) || !isRecord(attempt.swap) || attempt.swap.direction !== "buy"
    || !isTimestamp(value.at) || !isTimestamp(attempt.createdAt) || !isTimestamp(attempt.updatedAt) || value.at < attempt.createdAt
    || value.at > attempt.updatedAt) fail();
  return { kind: value.kind as PrivateSubmissionSightingKind, at: value.at };
}
const SIGHTING_RANK: Readonly<Record<PrivateSubmissionSightingKind, number>> = Object.freeze({ present: 1, landed: 2 });
/** The stronger of two sightings (`landed` over `present` over none). */
export function privateSubmissionStrongerSighting(a: PrivateSubmissionSightingKind | undefined, b: PrivateSubmissionSightingKind | undefined): PrivateSubmissionSightingKind | undefined {
  if (a === undefined) return b; if (b === undefined) return a;
  return SIGHTING_RANK[b] > SIGHTING_RANK[a] ? b : a;
}
/** F2 invariants: only a relay-closed `runner:` dispute is ever released, at a canonical u64 slot, createdAt <= at <= updatedAt.
 * SF R10: or a buy (released while Balchemy left it unresolved; status may have moved it on since). */
function parseLandingClosed(value: unknown, attempt: Record<string, unknown>): PrivateSubmissionLandingClosed | null {
  if (value === null) return null;
  exact(value, ["finalizedSlot", "at"]);
  u64(value.finalizedSlot);
  const runner = typeof attempt.reason === "string" && attempt.reason.startsWith("runner:") && attempt.relay === "closed";
  // Owner decision 26: a released runner dispute the owner closed out keeps its release (state closed_by_owner, reason unchanged).
  const dispute = (attempt.state === "disputed" || attempt.state === PRIVATE_SUBMISSION_OWNER_CLOSED) && runner;
  const buy = isRecord(attempt.swap) && attempt.swap.direction === "buy";
  if ((!dispute && !buy) || !isTimestamp(value.at) || !isTimestamp(attempt.createdAt) || !isTimestamp(attempt.updatedAt)
    || value.at < attempt.createdAt || value.at > attempt.updatedAt) fail();
  return { finalizedSlot: value.finalizedSlot as string, at: value.at };
}
/** Owner decision 26 invariants: state closed_by_owner exactly when ownerClosed is set; only an attempt the owner could close is ever
 * closed (relay closed, no unacknowledged copy, and a `runner:` reason or a release), at a canonical u64 slot not below the release's
 * own F, createdAt <= at <= updatedAt. */
function parseOwnerClosed(value: unknown, attempt: Record<string, unknown>, landingClosed: PrivateSubmissionLandingClosed | null, copyHeld: boolean): PrivateSubmissionLandingClosed | null {
  const closed = attempt.state === PRIVATE_SUBMISSION_OWNER_CLOSED;
  if (value === null) { if (closed) fail(); return null; }
  exact(value, ["finalizedSlot", "at"]);
  const slot = u64(value.finalizedSlot);
  const runner = typeof attempt.reason === "string" && attempt.reason.startsWith("runner:");
  // Owner decision 44: a close-out that was neither a runner dispute nor a release is a buy Balchemy left unresolved, closed at least
  // PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS after it was journaled: no observed copy and no engine state outside R10's scope.
  const stalledBuy = isRecord(attempt.swap) && attempt.swap.direction === "buy" && (attempt.observedSignature ?? null) === null
    && (attempt.engineState === null || !PRIVATE_STALL_EXCLUDED_ENGINE_STATES.includes(attempt.engineState as RunnerLocalSwapState))
    && isTimestamp(value.at) && isTimestamp(attempt.createdAt) && value.at - attempt.createdAt >= PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS;
  if (!closed || attempt.relay !== "closed" || copyHeld || (!runner && landingClosed === null && !stalledBuy)
    || (landingClosed !== null && slot < BigInt(landingClosed.finalizedSlot)) || !isTimestamp(value.at) || !isTimestamp(attempt.createdAt)
    || !isTimestamp(attempt.updatedAt) || value.at < attempt.createdAt || value.at > attempt.updatedAt) fail();
  return { finalizedSlot: value.finalizedSlot as string, at: value.at };
}
/** Stored form: landingClosed and ownerClosed are omitted while null, so a journal without a release or a close-out is written
 * byte-identical to before F2. */
function stored(snapshot: Snapshot): Snapshot {
  const attempts = snapshot.attempts.map((item) => {
    const { landingClosed, ownerClosed, ...rest } = item;
    return { ...rest, ...(landingClosed === null ? {} : { landingClosed }), ...(ownerClosed === null || ownerClosed === undefined ? {} : { ownerClosed }) };
  });
  return { ...snapshot, attempts: attempts as PrivateSubmissionAttempt[] };
}
/** In-memory form: every attempt carries landingClosed and ownerClosed (null when absent from the stored form). */
function loaded(snapshot: Snapshot): Snapshot {
  return { ...snapshot, attempts: snapshot.attempts.map((item) => ({ ...item, landingClosed: item.landingClosed ?? null, ownerClosed: item.ownerClosed ?? null })) };
}
function parseSnapshot(value: unknown, scope: { localProfileId: string; agentId: string }): Snapshot {
  exact(value, ["schemaVersion", "localProfileId", "agentId", "attempts"], ["evictedRecentAt"]);
  if (Object.hasOwn(value, "evictedRecentAt") && !isTimestamp(value.evictedRecentAt)) fail();
  if (value.schemaVersion !== 1 || value.localProfileId !== scope.localProfileId || value.agentId !== scope.agentId
    || !Array.isArray(value.attempts) || value.attempts.length > PRIVATE_SUBMISSION_MAX_ATTEMPTS) fail();
  const attempts = (value.attempts as unknown[]).map(parseAttempt);
  // One wallet-holding attempt per wallet; a released attempt (F2) no longer holds it.
  const open = attempts.filter(privateSubmissionHoldsWallet).map((item) => item.walletAddress);
  if (new Set(attempts.map((item) => item.attemptKey)).size !== attempts.length || new Set(attempts.map((item) => item.reservationId)).size !== attempts.length
    || new Set(open).size !== open.length) fail();
  return { schemaVersion: 1, localProfileId: scope.localProfileId, agentId: scope.agentId, attempts,
    ...(Object.hasOwn(value, "evictedRecentAt") ? { evictedRecentAt: value.evictedRecentAt as number } : {}) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
export function privateSubmissionFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `submission-journal-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}
/** Terminal attempts the caller still needs (S5c: a terminal exit sell whose position has not settled from it yet, since its
 * journaled signature is the only key to the finalized proof). Never evicted while this returns true; a throw retains. */
export type PrivateSubmissionRetain = (attempt: PrivateSubmissionAttempt) => boolean;
/** Room for one more attempt: the attempts kept after evicting the oldest terminal one when full; undefined when full. */
function admitted(snapshot: Snapshot, reservationId: string, walletAddress: string, retain?: PrivateSubmissionRetain): PrivateSubmissionAttempt[] {
  if (snapshot.attempts.some((item) => item.reservationId === reservationId)) fail("attempt_conflict");
  if (snapshot.attempts.some((item) => item.walletAddress === walletAddress && privateSubmissionHoldsWallet(item))) fail("wallet_busy");
  if (snapshot.attempts.some((item) => item.walletAddress === walletAddress && privateSubmissionCopyHeld(item))) fail("copy_unacknowledged");
  if (snapshot.attempts.length < PRIVATE_SUBMISSION_MAX_ATTEMPTS) return [...snapshot.attempts];
  // An unacknowledged observed copy is evidence the owner must see: it is never evicted.
  const kept = (item: PrivateSubmissionAttempt): boolean => { if (!retain) return false; try { return retain(item) !== false; } catch { return true; } };
  // A released attempt that is not terminal (F2, or an R10 buy still open to server truth) is never evicted: only non-terminal
  // attempts are left out below. A terminal released attempt (Balchemy's `completed`, R4's proven negative, the owner's close-out,
  // owner decision 26) is settled by evidence and may be evicted; the caller's `retain` still keeps what it needs, for example a
  // closed or completed released buy whose mint is not yet durably kept off automatic management.
  const terminal = snapshot.attempts.filter((item) => isPrivateSubmissionTerminal(item.state) && !privateSubmissionCopyHeld(item) && !kept(item));
  if (!terminal.length) fail("journal_full");
  const oldest = terminal.reduce((a, b) => (b.updatedAt < a.updatedAt ? b : a));
  return snapshot.attempts.filter((item) => item !== oldest);
}

export interface PrivateSubmissionJournalOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this journal never creates a second lock. */
  assertAvailable(): void;
}
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<Snapshot> };

export class PrivateSubmissionJournal {
  readonly #options: PrivateSubmissionJournalOptions;
  readonly #agentIds: string[];
  readonly #slots = new Map<string, Slot>();
  #closed = false;

  constructor(options: PrivateSubmissionJournalOptions) {
    if (!isRecord(options) || typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !isId(options.localProfileId)
      || !Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.assertAvailable !== "function") fail();
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, directory: path.resolve(options.directory), agentIds: this.#agentIds };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** K1 max_trades_per_day.v1: the eviction watermark (see Snapshot), or null when none is stored. Read-only. */
  evictedRecentAt(agentId: string): number | null { return this.#read(agentId, false)?.evictedRecentAt ?? null; }
  /** Read-only; an agent without a journal reads empty and creates no file. */
  list(agentId: string): readonly PrivateSubmissionAttempt[] { return freeze((this.#read(agentId, false)?.attempts ?? []).map((item) => ({ ...item }))); }
  attempt(agentId: string, attemptKey: string): PrivateSubmissionAttempt | undefined {
    const found = this.#read(agentId, false)?.attempts.find((item) => item.attemptKey === attemptKey); return found ? freeze({ ...found }) : undefined;
  }
  forReservation(agentId: string, reservationId: string): PrivateSubmissionAttempt | undefined {
    const found = this.#read(agentId, false)?.attempts.find((item) => item.reservationId === reservationId); return found ? freeze({ ...found }) : undefined;
  }
  /** Read-only admission check before any signature: throws journal_full, wallet_busy, copy_unacknowledged or attempt_conflict.
   * `retain` (S5c) protects terminal attempts the caller still needs from eviction; omitted, eviction is unchanged. */
  admit(agentId: string, reservationId: string, walletAddress: string, retain?: PrivateSubmissionRetain): void {
    if (typeof reservationId !== "string" || !UUID4.test(reservationId) || !isSolanaAddress(walletAddress)) fail();
    const snapshot = this.#read(agentId, false);
    if (snapshot) admitted(snapshot, reservationId, walletAddress, retain);
  }
  /** Fsyncs a new `signed` attempt with its exact wire bytes; the first relay is counted (and timed) here, before it is made. */
  record(agentId: string, input: PrivateSubmissionRecordInput, nowMs: number, retain?: PrivateSubmissionRetain): PrivateSubmissionAttempt {
    exact(input, ["attemptKey", "reservationId", "buildDigest", "walletBindingId", "walletAddress", "messageSha256", "signature", "wireB64",
      "blockhash", "lastValidBlockHeight", "swap"]);
    if (!isTimestamp(nowMs)) fail();
    const attempt = parseAttempt({ ...input, swap: { ...input.swap }, state: "signed", engineState: null, submits: 1, lastSubmitAt: nowMs,
      relay: "open", reason: null, createdAt: nowMs, updatedAt: nowMs, observedSignature: null, copyAcknowledgedAt: null, landingClosed: null, ownerClosed: null });
    return this.#mutate(agentId, true, (snapshot) => {
      const kept = admitted(snapshot, attempt.reservationId, attempt.walletAddress, retain);
      const { evictedRecentAt: prior, ...rest } = snapshot;
      const watermark = evictionWatermark(prior, snapshot.attempts.filter((item) => !kept.includes(item)), nowMs);
      return { next: { ...rest, attempts: [...kept, attempt], ...(watermark === undefined ? {} : { evictedRecentAt: watermark }) }, result: { ...attempt } };
    });
  }
  /** Forward-only change of one attempt; never touches its bytes, signature or swap. A no-op change writes nothing. A terminal
   * or released (F2) attempt accepts no change at all; a buy released while Balchemy left it unresolved (R10) still does until it
   * becomes terminal or a `runner:` dispute (landingClosed itself is never changed here). */
  update(agentId: string, attemptKey: string, change: PrivateSubmissionChange, nowMs: number): PrivateSubmissionAttempt {
    if (!isRecord(change) || Object.keys(change).some((key) => !["state", "engineState", "submits", "lastSubmitAt", "relay", "reason", "observedSignature"].includes(key))
      || !isTimestamp(nowMs)) fail();
    return this.#mutate(agentId, false, (snapshot) => {
      const index = snapshot.attempts.findIndex((item) => item.attemptKey === attemptKey);
      const current = snapshot.attempts[index]; if (!current) fail("attempt_missing");
      const merged = { ...current, ...change };
      // closed_by_owner is written only by closeByOwner (owner decision 26), never by a generic change.
      if ((merged.state === PRIVATE_SUBMISSION_OWNER_CLOSED && current.state !== PRIVATE_SUBMISSION_OWNER_CLOSED)
        || !privateSubmissionTransitionAllowed(current.state, merged.state) || merged.submits < current.submits
        || merged.lastSubmitAt < current.lastSubmitAt || (current.relay === "closed" && merged.relay === "open")
        || (current.observedSignature !== null && merged.observedSignature !== current.observedSignature)
        || ((isPrivateSubmissionTerminal(current.state) || releaseFrozen(current)) && JSON.stringify(merged) !== JSON.stringify(current))) {
        fail("transition_invalid");
      }
      if (JSON.stringify(merged) === JSON.stringify(current)) return { next: undefined, result: { ...current } };
      const next = parseAttempt({ ...merged, updatedAt: Math.max(nowMs, current.updatedAt) });
      const attempts = [...snapshot.attempts]; attempts[index] = next;
      return { next: { ...snapshot, attempts }, result: { ...next } };
    });
  }
  /** Owner acknowledgement of every observed copy of this agent's journal: records copyAcknowledgedAt (terminal attempts
   * included; nothing else changes) and lifts the wallet hold. Idempotent; returns how many copies it acknowledged now. */
  acknowledgeCopies(agentId: string, nowMs: number): number {
    if (!isTimestamp(nowMs)) fail();
    return this.#mutate(agentId, false, (snapshot) => {
      const held = snapshot.attempts.filter(privateSubmissionCopyHeld).length;
      if (!held) return { next: undefined, result: 0 };
      const attempts = snapshot.attempts.map((item) => {
        if (!privateSubmissionCopyHeld(item)) return item;
        const updatedAt = Math.max(nowMs, item.updatedAt);
        return parseAttempt({ ...item, swap: { ...item.swap }, copyAcknowledgedAt: updatedAt, updatedAt });
      });
      return { next: { ...snapshot, attempts }, result: held };
    });
  }
  /** F2, called only by S4 (private-submission.ts #closeLandings) after two proofs from fresh reads: records that this attempt's
   * bytes can no longer land after finalized slot `finalizedSlot`. Compare-and-set on `expected`, the whole attempt S4 proved
   * against, compared as exact JSON (every field, the bytes, signature and swap included), so its safety never depends on what the
   * caller chose to compare: refuses an unknown key (attempt_missing), a terminal attempt, anything but a relay-closed `runner:`
   * dispute or a buy Balchemy leaves unresolved (SF R10, privateSubmissionStalledBuy), an attempt already released (write-once: never
   * overwritten) (transition_invalid), and an attempt that differs in any way from `expected` (attempt_conflict). No other field
   * changes except updatedAt, which moves to the release time when that is later. */
  closeLanding(agentId: string, attemptKey: string, expected: PrivateSubmissionAttempt, finalizedSlot: string, nowMs: number): PrivateSubmissionAttempt {
    if (!isRecord(expected) || !isTimestamp(nowMs)) fail();
    u64(finalizedSlot);
    return this.#mutate(agentId, false, (snapshot) => {
      const index = snapshot.attempts.findIndex((item) => item.attemptKey === attemptKey);
      const current = snapshot.attempts[index]; if (!current) fail("attempt_missing");
      const dispute = runnerDispute(current) && current.relay === "closed";
      if (isPrivateSubmissionTerminal(current.state) || (!dispute && !privateSubmissionStalledBuy(current)) || privateSubmissionReleased(current)) {
        fail("transition_invalid");
      }
      if (JSON.stringify(current) !== JSON.stringify(expected)) fail("attempt_conflict");
      const at = Math.max(nowMs, current.updatedAt);
      const next = parseAttempt({ ...current, swap: { ...current.swap }, updatedAt: at, landingClosed: { finalizedSlot, at } });
      const attempts = [...snapshot.attempts]; attempts[index] = next;
      return { next: { ...snapshot, attempts }, result: { ...next } };
    });
  }
  /** Owner decision 26, called only by S4 (private-submission.ts closeByOwner) after the owner's typed confirmation and a fresh proof
   * (or the release's own) that the bytes can no longer land after `finalizedSlot`: moves the attempt to closed_by_owner. Compare-and-set
   * on `expected`, the whole attempt the proof was made against, as exact JSON (attempt_conflict otherwise). Refuses an unknown key
   * (attempt_missing) and anything privateSubmissionOwnerClosable rejects at `nowMs` (owner decision 44: an unresolved, unreleased buy
   * only once it is PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS old), a terminal attempt (an earlier close-out included) or a slot below the
   * release's F (transition_invalid). Changes only the state, relay (closed), ownerClosed and updatedAt; the reason, engine state,
   * release and copy fields stay as evidence. The spend and position effects are the caller's, made before this write. */
  closeByOwner(agentId: string, attemptKey: string, expected: PrivateSubmissionAttempt, finalizedSlot: string, nowMs: number): PrivateSubmissionAttempt {
    if (!isRecord(expected) || !isTimestamp(nowMs)) fail();
    const slot = u64(finalizedSlot);
    return this.#mutate(agentId, false, (snapshot) => {
      const index = snapshot.attempts.findIndex((item) => item.attemptKey === attemptKey);
      const current = snapshot.attempts[index]; if (!current) fail("attempt_missing");
      if (!privateSubmissionOwnerClosable(current, nowMs) || (current.landingClosed !== null && slot < BigInt(current.landingClosed.finalizedSlot))) fail("transition_invalid");
      if (JSON.stringify(current) !== JSON.stringify(expected)) fail("attempt_conflict");
      const at = Math.max(nowMs, current.updatedAt);
      const next = parseAttempt({ ...current, swap: { ...current.swap }, state: PRIVATE_SUBMISSION_OWNER_CLOSED, relay: "closed", updatedAt: at,
        ownerClosed: { finalizedSlot, at } });
      const attempts = [...snapshot.attempts]; attempts[index] = next;
      return { next: { ...snapshot, attempts }, result: { ...next } };
    });
  }
  /** SF R10 and SF2, called only by S4 (private-submission.ts #closeStalls and #settleBuys, right after the proof's reads and before
   * any stop or gate check): records that the runner's own RPC returned this buy (`present`) or showed it landed (`landed`).
   * Compare-and-set on the attempt's journaled `signature` (the bytes whose reads were sighted; attempt_conflict otherwise) and on
   * the stored sighting, which only moves up: absent -> present | landed, present -> landed. A stored sighting at least as strong
   * as `kind` is kept as it is (no write, the attempt returned): never downgraded, never removed, idempotent after a crash. Refuses
   * an unknown key (attempt_missing), and anything but a non-terminal buy that is not a `runner:` dispute (transition_invalid; no
   * rule reads a sighting there). Changes only `sighting` (its `at` is the write time) and updatedAt, which moves to it when later.
   * C1: the same write removes a probe stamp (the probe's outcome is now persisted). Like every write here, a failed commit holds the agent's journal for the rest of the process
   * (state_unavailable): the sighting is then not on disk, but the stamp recordProbe wrote before the reads is, and the restart that
   * clears the hold reads it as a `present` sighting. */
  recordSighting(agentId: string, attemptKey: string, signature: string, kind: PrivateSubmissionSightingKind, nowMs: number): PrivateSubmissionAttempt {
    if (typeof signature !== "string" || !PRIVATE_SUBMISSION_SIGHTING_KINDS.includes(kind) || !isTimestamp(nowMs)) fail();
    return this.#mutate(agentId, false, (snapshot) => {
      const index = snapshot.attempts.findIndex((item) => item.attemptKey === attemptKey);
      const current = snapshot.attempts[index]; if (!current) fail("attempt_missing");
      if (current.signature !== signature) fail("attempt_conflict");
      if (current.swap.direction !== "buy" || isPrivateSubmissionTerminal(current.state) || runnerDispute(current)) fail("transition_invalid");
      // A stamp is never next to a sighting (parseProbePending), so a kept sighting has none to remove.
      if (privateSubmissionStrongerSighting(current.sighting?.kind, kind) === current.sighting?.kind) return { next: undefined, result: { ...current } };
      const at = Math.max(nowMs, current.updatedAt);
      const { probePending: _stamp, ...rest } = current;
      const next = parseAttempt({ ...rest, swap: { ...current.swap }, updatedAt: at, sighting: { kind, at } });
      const attempts = [...snapshot.attempts]; attempts[index] = next;
      return { next: { ...snapshot, attempts }, result: { ...next } };
    });
  }
  /** SF-A, called only by S4 (private-submission.ts #watchLateSells): records Balchemy's later report on a sell the runner itself made
   * terminal-negative while Balchemy still had it unresolved (privateSubmissionLateWatched): its engine state, when that is a landing or
   * the engine's own negative, and an observed re-signed copy, when Balchemy reports one. The one change a terminal attempt accepts besides
   * acknowledge-copy; once written the attempt is no longer watched (write-once). Compare-and-set on `expected` as exact JSON
   * (attempt_conflict); refuses an unknown key (attempt_missing), an attempt that is not watched, or a report that is neither
   * (transition_invalid). Changes only engineState, observedSignature (from null) and updatedAt; the state, reason and relay stay. */
  recordLateReport(agentId: string, attemptKey: string, expected: PrivateSubmissionAttempt, report: { engineState: RunnerLocalSwapState; observedSignature: string | null },
    nowMs: number): PrivateSubmissionAttempt {
    if (!isRecord(expected) || !isRecord(report) || !RUNNER_LOCAL_SWAP_STATES.includes(report.engineState) || !isTimestamp(nowMs)
      || (report.observedSignature !== null && !isTxSignature(report.observedSignature))) fail();
    return this.#mutate(agentId, false, (snapshot) => {
      const index = snapshot.attempts.findIndex((item) => item.attemptKey === attemptKey);
      const current = snapshot.attempts[index]; if (!current) fail("attempt_missing");
      if (!privateSubmissionLateWatched(current) || (report.observedSignature === null && !LATE_ENGINE_STATES.includes(report.engineState))) fail("transition_invalid");
      if (JSON.stringify(current) !== JSON.stringify(expected)) fail("attempt_conflict");
      const next = parseAttempt({ ...current, swap: { ...current.swap }, engineState: report.engineState, updatedAt: Math.max(nowMs, current.updatedAt),
        ...(report.observedSignature !== null ? { observedSignature: report.observedSignature } : {}) });
      const attempts = [...snapshot.attempts]; attempts[index] = next;
      return { next: { ...snapshot, attempts }, result: { ...next } };
    });
  }
  /** C1, called only by S4 (private-submission.ts #stamp) right BEFORE the buy proof's reads: the durable probe stamp. Compare-and-set
   * on the journaled `signature` (attempt_conflict); the same scope as recordSighting (transition_invalid otherwise). Write-once: an
   * attempt that already holds a stamp or any sighting is returned unchanged (no write). Changes only `probePending` ({at: nowMs},
   * not before createdAt); updatedAt never moves. */
  recordProbe(agentId: string, attemptKey: string, signature: string, nowMs: number): PrivateSubmissionAttempt {
    if (typeof signature !== "string" || !isTimestamp(nowMs)) fail();
    return this.#mutate(agentId, false, (snapshot) => {
      const index = snapshot.attempts.findIndex((item) => item.attemptKey === attemptKey);
      const current = snapshot.attempts[index]; if (!current) fail("attempt_missing");
      if (current.signature !== signature) fail("attempt_conflict");
      if (current.swap.direction !== "buy" || isPrivateSubmissionTerminal(current.state) || runnerDispute(current)) fail("transition_invalid");
      if (current.sighting !== undefined || current.probePending !== undefined) return { next: undefined, result: { ...current } };
      const next = parseAttempt({ ...current, swap: { ...current.swap }, probePending: { at: Math.max(nowMs, current.createdAt) } });
      const attempts = [...snapshot.attempts]; attempts[index] = next;
      return { next: { ...snapshot, attempts }, result: { ...next } };
    });
  }
  /** C1, called only by S4 (private-submission.ts #unstamp) once its probe sighted nothing and the process holds no sighting: removes
   * the stamp written at `at`. Compare-and-set on the signature and on the stamp's `at` (attempt_conflict); the same scope as
   * recordProbe (transition_invalid). No stamp: unchanged, no write. updatedAt never moves, so the attempt is byte-identical to before
   * the probe. */
  clearProbe(agentId: string, attemptKey: string, signature: string, at: number): PrivateSubmissionAttempt {
    if (typeof signature !== "string" || !isTimestamp(at)) fail();
    return this.#mutate(agentId, false, (snapshot) => {
      const index = snapshot.attempts.findIndex((item) => item.attemptKey === attemptKey);
      const current = snapshot.attempts[index]; if (!current) fail("attempt_missing");
      if (current.signature !== signature) fail("attempt_conflict");
      if (current.probePending === undefined) return { next: undefined, result: { ...current } };
      if (current.probePending.at !== at) fail("attempt_conflict");
      if (current.swap.direction !== "buy" || isPrivateSubmissionTerminal(current.state) || runnerDispute(current)) fail("transition_invalid");
      const { probePending: _stamp, ...rest } = current;
      const next = parseAttempt({ ...rest, swap: { ...current.swap } });
      const attempts = [...snapshot.attempts]; attempts[index] = next;
      return { next: { ...snapshot, attempts }, result: { ...next } };
    });
  }
  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Preserve files. */ } }
    this.#slots.clear();
  }

  /** One synchronous read-check-commit section; `next: undefined` writes nothing. Any write failure holds the agent. */
  #mutate<T>(agentId: string, create: boolean, change: (snapshot: Snapshot) => { next: Snapshot | undefined; result: T }): T {
    const slot = this.#slot(agentId, create);
    if (!slot) return fail("attempt_missing");
    if (slot.kind !== "open") return fail("state_unavailable");
    let snapshot: Snapshot;
    try { snapshot = loaded(slot.storage.read()); } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
    const { next, result } = change(snapshot);
    if (next) {
      try { slot.storage.commit(stored(parseSnapshot(structuredClone(next), { localProfileId: this.#options.localProfileId, agentId }))); }
      catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
    }
    return freeze(result);
  }
  #read(agentId: string, create: boolean): Snapshot | undefined {
    const slot = this.#slot(agentId, create);
    if (!slot) return undefined;
    if (slot.kind === "held") return fail("state_unavailable");
    try { return loaded(slot.storage.read()); } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
  }
  #slot(agentId: string, create: boolean): Slot | undefined {
    if (this.#closed) fail("closing");
    if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent");
    try { this.#options.assertAvailable(); } catch { return fail("state_unavailable"); }
    const current = this.#slots.get(agentId);
    if (current) return current;
    const files = privateSubmissionFiles(agentId);
    const exists = (name: string): boolean => {
      try { fs.lstatSync(path.join(this.#options.directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    };
    try { if (!create && !exists(files.markerFile) && !exists(files.snapshotFile)) return undefined; }
    catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
    try {
      const scope = { localProfileId: this.#options.localProfileId, agentId };
      const storage = new OwnedJsonSnapshot<Snapshot>({ directory: this.#options.directory, ...files,
        marker: { schemaVersion: 1, localProfileId: scope.localProfileId, agentId, kind: "submission_journal" }, maximumBytes: MAX_JOURNAL_BYTES,
        initial: { schemaVersion: 1, ...scope, attempts: [] }, assertAvailable: this.#options.assertAvailable,
        decode: (value) => stored(parseSnapshot(value, scope)) });
      const slot: Slot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
  }
}
