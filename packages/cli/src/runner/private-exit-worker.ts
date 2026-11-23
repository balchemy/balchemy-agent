/** S5c-2d exit orchestration, behind the exits capability, which the production capabilities carry since S5
 * (PRIVATE_EXIT_EXECUTION_AVAILABLE true). Without it (the exits-off rollback build, the flag false) everything here is inert:
 * `start` schedules nothing and a pass returns before any read, so no position is opened, no sell assessment is requested, no
 * RPC is called, nothing is built and no file is written. The daemon additionally never constructs this worker (nor the
 * position ledger) on that build.
 *
 * One serialized pass per agent per poll (an agent has exactly one trading wallet, so this serializes per wallet):
 * 0. The enable-time watermark (owner decision of 11 Nov 2026: only buys completed after automatic exits were enabled are
 *    managed), recorded ONCE per agent, at its first pass with the exits capability, from the local journal: one local ledger
 *    write, no network. Every later pass only reads it. It is not activity: it defines which buys are managed, so it does not
 *    wait for the gate (the buy worker's entryHold records it too, before the first buy under the capability).
 * 1. The exit choke point (private-execution-gate.ts, step `exit_build`: live_armed, armed, idle, the exits capability, the
 *    owner's own RPC; an entries pause never blocks it). Refused (disarmed, halted or stopped, not idle, no owner RPC): nothing
 *    else at all this pass: no network, no settlement, no opening, no valuation, no position write. The only write a refused pass
 *    can make is step 0's one-time watermark.
 * 1b. Admitted: the automatic wallet-balance settlement of `runner:` holds (PrivatePositionRecovery.settleHeld, owner decision of
 *    11 Nov 2026) is STARTED as its own task, at most one per agent at a time, under the recovery's per-agent lock and its own
 *    hard budget per held position. The pass never awaits it, so a slow RPC never delays opening, valuation or an exit of this
 *    pass, and the S3 deadline below is unaffected. It reads the chain and makes at most one compare-and-set ledger commit per
 *    held position; it never signs, builds, relays or sells and never writes the journal. A halt (gate refused) starts none; for
 *    one already running, the gate is re-checked synchronously after every RPC read, before its second proof, before its next
 *    position and immediately before each commit, so after a halt it starts no further read (at most the read already in flight
 *    completes; close() aborts it) and makes no further ledger change.
 * 2. Position opening: a buy attempt Balchemy reported `completed` whose position does not exist yet opens it only from facts
 *    the runner proves itself: the finalized transaction of the journaled signature on the runner's OWN RPC
 *    (privateBuyTokenCredit: exact units, never below the build's minOut), the committed spend reservation of that attempt
 *    (cost = its gross input, the buy platform fee included), and the execution intent -> signal job -> resolved plan of that
 *    reservation (the exit snapshot, privateExitSnapshotValid; the plan digest and slippage every sell assessment names).
 *    The cost is the attempt's own validated gross input; the spend reservation is only a cross-check while the spend
 *    ledger still holds it (settled reservations of earlier UTC days are dropped), the job comes from the intent that
 *    recorded this attempt. Unproven or contradicting facts open nothing and stay visible (status), classified
 *    (PrivateExitOpenRefusalKind): TRANSIENT (not finalized yet, a read or ledger write unavailable) is retried with a
 *    growing delay (F-M36-D2-A2: an RPC wait, the transaction not on its finalized view yet or the read failed, at every pass
 *    instead, PRIVATE_EXIT_OPEN_CHAIN_RETRY_MS) and never given up, and holds new entries (entryHold) until the position opens; PERMANENT (provenance
 *    missing or invalid, a facts contradiction, an observed re-signed copy, a position already sold out and evicted: named by a
 *    journaled sell or recorded in the ledger's evicted list, whichever order the journal evicted in) is never
 *    retried. A full ledger (`position:ledger_full`) is transient: the buy opens once an active position closes, and holds
 *    entries until then.
 *    Final audit S3: a permanent refusal of #open (anything but the two local ones, an observed copy, which the copy hold and
 *    acknowledge-copy cover, and an evicted position, which sold out) leaves landed tokens with no position and no stop-loss, so it
 *    holds new entries for good under the named owner hold `buy_unprotected` (entryHold), instead of letting buys resume. Of the
 *    facts refusals, transaction_missing, transaction_malformed and balances_missing are TRANSIENT (an RPC that has not finalized the
 *    transaction yet, or served it partly), retried with the growing delay. S4 keeps the buy journaled while its position has not
 *    opened (privateBuyAwaitingPosition), and the daemon keeps its execution intent, so neither `intent_missing` nor a lost signature
 *    can come from eviction.
 * 3. Wallet (the sell hold): an unacknowledged copy (copy_unacknowledged), any wallet-holding journal attempt
 *    (privateSubmissionHoldsWallet: non-terminal and not released), an open spend reservation (one whose journaled attempt is
 *    released excepted; a reservation with no journal attempt still holds: a signature may exist only in memory) or a running
 *    buy intent (wallet_busy), or a pending exit with no journal attempt (exit_unjournaled) holds every SELL (one in-flight swap
 *    per wallet), first match in that order. A pending or held exit with a journal attempt blocks only positions of the SAME
 *    mint (once that attempt is terminal or released).
 *    F2 Step 1 (docs/product/drafts/M3-F2-VALUATION-FREEZE-DESIGN.md): a sell hold never pauses valuation. Every free position is
 *    still valued; a triggered sell is deferred with no write (`deferred:<hold>`: no beginExit, build or ledger write), its
 *    position is valued first at the next opportunity (still under every other position's deadline) and sells on the first pass
 *    after the hold lifts. F2 Step 2: S4 releases a runner dispute whose bytes provably can no longer land (private-submission.ts
 *    #closeLandings), so it stops holding the wallet; its own mint stays blocked (H2 for a sell; the balance settlement refuses
 *    the mint of a released buy) and new buys stay held (entryHold attempt_released_unsettled).
 * 4. Valuation, per open position: one lease-pinned sell assessment of all remaining units, paced at least
 *    PRIVATE_EXIT_ASSESSMENT_SPACING_MS apart per agent (Balchemy allows one per 2 s and 120 per minute per agent, so the
 *    agent's valuations are inherently serial), re-validated against exactly the request and the local clock;
 *    value = quote.outAmount - quote.platformFeeLamports. L6: at most PRIVATE_EXIT_VALUATIONS_PER_PASS per pass, chosen by
 *    priority = time since the last valuation x a weight from that valuation's headroom to the nearest DOWNSIDE trigger
 *    (stop-loss, armed trailing stop; a late take-profit costs nothing; held, unavailable or unknown headroom counts as near),
 *    never valued first, and S3: under a hard deadline: no free position waits longer than PRIVATE_EXIT_MAX_VALUATION_INTERVAL_MS
 *    (one full round of the largest ledger at the assessment spacing). The exact bound: between two valuation ATTEMPTS of a free
 *    position, at most PRIVATE_EXIT_MAX_VALUATION_INTERVAL_MS, but only while (b) the agent is not in a provider-wide back-off (at
 *    most PRIVATE_EXIT_UNAVAILABLE_MAX_MS per failure), (c) the exit gate admits the pass, and (d) the position is not in its own
 *    exit back-off (a refused exit leaves it unvalued
 *    for up to PRIVATE_EXIT_PROTECTIVE_BACKOFF_MAX_MS after a stop-loss or trailing stop, PRIVATE_EXIT_BACKOFF_MAX_MS after a
 *    take-profit). F1: a failed assessment counts as that position's attempt and backs off only that
 *    position (PRIVATE_EXIT_VALUATION_BACKOFF_*); a position in its own back-off is left out of the pick, so it never
 *    starves the others. A weighted pick is taken only while every other position
 *    can still be valued, one per spacing in deadline order, before its deadline; otherwise the earliest deadline goes first.
 *    A pass that used its whole budget with positions left asks for the next pass at once (still paced by the spacing). So no
 *    position ever waits longer than plain round-robin of a full ledger would make it, and any slack below saturation goes to
 *    the positions nearest a stop. (At a full, saturated ledger there is no slack: every position is valued once per round.)
 *    evaluatePrivateExit decides: hold (stale or unavailable evidence never triggers), none (a changed trailing state is
 *    persisted, forward-only), or sell. A sell of fewer units than remain takes a SECOND fresh assessment of exactly the exit
 *    units (Balchemy binds the exit to the assessment it names); item 6: that assessment must still yield exactly the same
 *    decision (recheckPrivatePartialExit), otherwise the partial exit is aborted before anything is recorded
 *    (`partial_exit_aborted:<reason>`, no backoff: the next valuation decides afresh). Then: a fresh UUID v4 exit reservation
 *    -> positions.beginExit -> buildPrivateExitCandidate -> PrivateSubmissions.submitExit. At most one exit per agent per pass.
 * Outcomes: a build that did not validate can never have been signed, so a pending exit it left behind (no journal attempt)
 * is cleared as proven_negative; a submission refusal keeps whatever the submission decided (it alone knows whether a
 * signature exists); an unknown submission outcome holds the pending exit until reconciliation or restart recovery proves
 * it. Every refusal starts a growing per-position backoff (capped lower for a stop-loss or trailing stop, F5), every failed
 * assessment a per-position one and a provider-wide assessment failure also a per-agent one, so a repeating server refusal can
 * never loop hot (a wallet-lock wait does not count: the next pass simply retries). F-M36-D7-B: every back-off, retry deadline,
 * the pacing and the ranking run on a monotonic clock, so a wall-clock step never lengthens or shortens one (a +10 min step left
 * the stop-loss unvalued for 10 min after the reset); freshness and every write keep the wall clock. Never re-signs, never
 * retries a broadcast: S4 owns relay, resends and settlement.
 * A wallet sell hold (step 3) never removes this bound (F2 Step 1, condition (a) of the earlier statement is gone); it only
 * defers a triggered sell until the wallet is free.
 * Entry hold (`entryHold`, given to the buy worker only while exits are available): any non-terminal released attempt (F2: until
 * the owner closes it out; SF R10: also until Balchemy's completed is committed or R4 proves it did not land), any held position, any pending exit, a ledger at its maximum of active positions (L5: the next buy
 * could not open one) or any completed buy whose position is unopened (transiently: position_unopened; S3, refused permanently:
 * buy_unprotected) refuses a new buy, so buying never outruns protection. */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AgentSdkError, RunnerSellAssessmentClient, runnerSellAssessmentRequestDigest, validateRunnerSolanaSellAssessment, type RunnerSellAssessmentRequest,
  type RunnerSolanaSellAssessment } from "@balchemyai/agent-sdk";
import { signRunnerSellAssessmentProof } from "./pairing-identity.js";
import { privateExecutionGate, PRIVATE_EXECUTION_CAPABILITIES, type PrivateExecutionCapabilities, type PrivateExecutionGateRefusal,
  type PrivateExecutionLiveFacts } from "./private-execution-gate.js";
import type { PrivateExecutionIntent, PrivateExecutionIntents } from "./private-execution-intents.js";
import type { PrivateExitBuildInput, PrivateExitBuildOutcome } from "./private-exit-build.js";
import { evaluatePrivateExit, privateExitHeadroomBps, privateExitSnapshotValid, recheckPrivatePartialExit, type PrivateExitDecision,
  type PrivateExitTrigger, type PrivateExitValuation } from "./private-exit-triggers.js";
import { privateBuyTokenCredit } from "./private-position-facts.js";
import { PrivateBrainStoreError } from "./private-brain-store.js";
import { PrivatePositionError, privatePositionId, PRIVATE_POSITION_MAX_SLIPPAGE_BPS, PRIVATE_POSITIONS_MAX_ACTIVE, type PrivatePosition,
  type PrivatePositionLedger, type PrivatePositionManagedFrom } from "./private-positions.js";
import type { PrivateSignalJob } from "./private-signal-job.js";
import type { PrivateSpendLedger, PrivateSpendReservation } from "./private-spend-ledger.js";
import type { PrivateExitSubmissionOutcome, PrivateValidatedExit } from "./private-submission.js";
import { isPrivateSubmissionTerminal, privateSubmissionCopyHeld, privateSubmissionHoldsWallet, privateSubmissionOwnerClosed, privateSubmissionReleased,
  type PrivateSubmissionAttempt } from "./private-submission-journal.js";
import type { RunnerAgentState } from "./protocol.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import { addRunnerAgent } from "./agent-roster.js";
import { privateDcaJobId } from "./private-dca.js";
import type { PrivateDcaAdd } from "./private-dca-store.js";

/** K1b DCA hooks (private-dca-store.ts, private-dca-worker.ts); absent: no DCA, every buy opens through its intent as before. */
export interface PrivateExitDcaHooks {
  /** The durable DCA add of a buy reservation, undefined when that buy is no DCA add; a throw is unavailable (transient). */
  add(agentId: string, reservationId: string): PrivateDcaAdd | undefined;
  /** The add's own lot opened (submitted -> opened). A throw is ignored: the DCA worker reconciles it from the position ledger. */
  opened(agentId: string, reservationId: string, units: string): void;
  /** A stop-loss or trailing-stop exit of the mint begins: its DCA campaign ends for good. Called before beginExit; a throw never
   * blocks the exit (the DCA worker also ends it from the pending exit). */
  protectiveExit(agentId: string, mint: string, trigger: "stop_loss" | "trailing_stop"): void;
  /** True while a DCA add of the agent is running (it holds sells like a running signal intent); a throw holds nothing. */
  running(agentId: string): boolean;
}

/** Owner item 75: the entry reservationIds a watermark keeps off automatic management: pre-enable buys and owner-unmanaged buys. */
function unmanagedBuys(watermark: PrivatePositionManagedFrom): Set<string> {
  return new Set([...watermark.preEnable, ...(watermark.ownerUnmanaged ?? []).map((item) => item.reservationId)]);
}
export const PRIVATE_EXIT_POLL_MS = 5_000;
/** Above Balchemy's 2 s per-agent sell-assessment spacing; at most ~29 per minute, well under its 120 per minute. */
export const PRIVATE_EXIT_ASSESSMENT_SPACING_MS = 2_100;
/** Per-position delay after a refused exit: 15 s doubling to 10 min (a take-profit, or a failure with no exit decision). */
export const PRIVATE_EXIT_BACKOFF_BASE_MS = 15_000;
export const PRIVATE_EXIT_BACKOFF_MAX_MS = 600_000;
/** F5: a refused PROTECTIVE exit (stop-loss, trailing stop) grows the same way but is capped at 60 s: a stop that cannot sell
 * is retried at least once a minute, while a take-profit sold late costs nothing. */
export const PRIVATE_EXIT_PROTECTIVE_BACKOFF_MAX_MS = 60_000;
const PROTECTIVE_TRIGGERS: readonly PrivateExitTrigger[] = ["stop_loss", "trailing_stop"];
/** Per-agent delay after a PROVIDER-WIDE assessment failure (transport, timeout, rate limit, server error, auth or a lease change):
 * 5 s doubling to 2 min. */
export const PRIVATE_EXIT_UNAVAILABLE_BASE_MS = 5_000;
export const PRIVATE_EXIT_UNAVAILABLE_MAX_MS = 120_000;
/** F1: per-position delay after ANY failed assessment of that position (one that threw or did not re-validate against exactly its
 * request): 5 s doubling to 2 min, reset by its next valid assessment. The failed attempt also counts as that position's
 * valuation time for the deadline scheduler, so a position whose assessment always fails takes at most its own round-robin slot
 * and can never monopolise the earliest-deadline pick; the cap stays below PRIVATE_EXIT_MAX_VALUATION_INTERVAL_MS, so it is still
 * retried at least once per round. */
export const PRIVATE_EXIT_VALUATION_BACKOFF_BASE_MS = 5_000;
export const PRIVATE_EXIT_VALUATION_BACKOFF_MAX_MS = 120_000;
/** Position opening: a transient refusal is retried 10 s doubling to 5 min, without a give-up. */
export const PRIVATE_EXIT_OPEN_BASE_MS = 10_000;
export const PRIVATE_EXIT_OPEN_MAX_MS = 300_000;
/** F-M36-D2-A2: the opening waits that end when the owner's RPC catches up or answers again (the buy's finalized transaction not on
 * its view yet, or the read threw) are retried at every pass instead: their wait is capped at half a poll (so a timer that fires a
 * little early never skips a pass), never doubled. Until the position opens the filled tokens have no stop-loss, and a doubling delay
 * that never reset left it up to PRIVATE_EXIT_OPEN_MAX_MS after the RPC recovered. The cost is one finalized getTransaction per
 * unopened buy per pass (at most OPENS_PER_PASS), the cadence the S5c settlement pass reads a sell at. The other transient refusals
 * keep the doubling: a transaction served without its body or balances (transaction_malformed, balances_missing) is no lag a quick
 * re-read outlasts (a parser gap repeats forever, final audit N5), and local-state or job-read failures are not RPC waits. */
export const PRIVATE_EXIT_OPEN_CHAIN_RETRY_MS = PRIVATE_EXIT_POLL_MS / 2;
const OPEN_CHAIN_WAITS: readonly string[] = ["facts:transaction_missing", "rpc_unavailable"];
/** H1b: TRANSIENT opening refusals a later read may change (retried, they hold entries); PERMANENT ones no retry can change
 * (reported only, never retried, never hold entries). */
export type PrivateExitOpenRefusalKind = "transient" | "permanent";
type OpenRefusal = { reason: string; kind: PrivateExitOpenRefusalKind };
const transient = (reason: string): OpenRefusal => ({ reason, kind: "transient" });
const permanent = (reason: string): OpenRefusal => ({ reason, kind: "permanent" });
/** Position-ledger errors a retry can change (writer or clock availability, or a full ledger an exit will free); every other
 * code is permanent. */
const TRANSIENT_POSITION_ERRORS: readonly string[] = ["state_unavailable", "closing", "clock_rollback", "ledger_full"];
/** Final audit S3: privateBuyTokenCredit refusals a later read may change (an RPC that has not finalized the transaction yet, or served it
 * without its body or balances); every other facts refusal contradicts what was signed and is permanent. */
const TRANSIENT_FACTS: readonly string[] = ["transaction_missing", "transaction_malformed", "balances_missing"];
/** L6: valuations per pass (about 8.4 s at the spacing); a pass that used them all with positions left runs the next at once. */
export const PRIVATE_EXIT_VALUATIONS_PER_PASS = 4;
/** L6: headroom bands (bps from the nearest downside trigger at the last valuation) and their priority weights; they share out
 * only the slack the PRIVATE_EXIT_MAX_VALUATION_INTERVAL_MS deadline leaves (none at a full, saturated ledger). */
export const PRIVATE_EXIT_NEAR_TRIGGER_BPS = 500;
export const PRIVATE_EXIT_WATCH_TRIGGER_BPS = 2000;
const WEIGHT_NEAR = 4; const WEIGHT_WATCH = 2; const WEIGHT_FAR = 1;
/** L6/S3: the hard bound between two valuations of a free position: one full round of the largest ledger at the assessment
 * spacing (64 x 2.1 s = 134.4 s). Priority never defers a position past it. */
export const PRIVATE_EXIT_MAX_VALUATION_INTERVAL_MS = PRIVATE_POSITIONS_MAX_ACTIVE * PRIVATE_EXIT_ASSESSMENT_SPACING_MS;
function weight(headroom: number | null | undefined): number {
  if (headroom === undefined || headroom === null || headroom <= PRIVATE_EXIT_NEAR_TRIGGER_BPS) return WEIGHT_NEAR;
  return headroom <= PRIVATE_EXIT_WATCH_TRIGGER_BPS ? WEIGHT_WATCH : WEIGHT_FAR;
}
/** Build or submission refusals that only mean the wallet lock is taken: not counted toward the exit backoff. */
const WALLET_WAITS: readonly string[] = ["wallet_busy"];
const PLAN_DIGEST = /^sha256:[0-9a-f]{64}$/;
/** Openings attempted per pass (each one is one finalized getTransaction on the owner's RPC). */
const OPENS_PER_PASS = 4;
const SELL_ASSESSMENT_TIMEOUT_MS = 15_000;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface PrivateExitWorkerOptions {
  localProfileId: string;
  agentIds: readonly string[];
  /** The owner-local position ledger (the daemon's one instance, shared with the submission settlement). */
  positions: Pick<PrivatePositionLedger, "positions" | "position" | "evicted" | "forgetEvicted" | "open" | "recordTrailing" | "beginExit" | "failExit"
    | "managedFrom" | "recordManagedFrom">;
  /** The automatic wallet-balance settlement of `runner:` holds (PrivatePositionRecovery.settleHeld), started as its own task by
   * a pass the exit gate admitted (never awaited by the pass; at most one in flight per agent); it never signs or sends and never
   * writes the journal. Omitted: no hold is settled automatically. */
  settleHeld?(agentId: string, signal: AbortSignal, admitted: () => boolean): Promise<void>;
  /** The S4 journal, read only. */
  readAttempts(agentId: string): readonly PrivateSubmissionAttempt[];
  /** The spend ledger, read only: the buy's committed reservation and any open (unsigned) reservation of the wallet. */
  ledger: Pick<PrivateSpendLedger, "reservation" | "status">;
  /** The S8b intent store, read only: the job behind a buy reservation, and any running buy. */
  intents: Pick<PrivateExecutionIntents, "get" | "list">;
  readJob(agentId: string, jobId: string, signal: AbortSignal): Promise<PrivateSignalJob>;
  readRuntime(agentId: string): RunnerAgentState | undefined;
  /** Live owner facts for the exit choke point (RPC class); a throw refuses. */
  readFacts(agentId: string): PrivateExecutionLiveFacts;
  /** The agent's OWN RPC: the finalized transaction of a journaled signature, null while none is available; a throw is unavailable. */
  readTransaction(agentId: string, signature: string, signal: AbortSignal): Promise<unknown>;
  /** One lease-pinned sell assessment (queryPrivateSellAssessment); a throw is unavailable. */
  assess(agentId: string, request: RunnerSellAssessmentRequest, signal: AbortSignal): Promise<RunnerSolanaSellAssessment>;
  /** buildPrivateExitCandidate with the agent's own RPC; never throws by contract (a throw is treated as not validated). */
  build(agentId: string, input: PrivateExitBuildInput, signal: AbortSignal): Promise<PrivateExitBuildOutcome>;
  /** PrivateSubmissions.submitExit: the one signature, the fsynced journal, then the relay. */
  submit(agentId: string, built: PrivateValidatedExit, signal: AbortSignal): Promise<PrivateExitSubmissionOutcome>;
  now?(): number; pollMs?: number; spacingMs?: number;
  /** F-M36-D7-B: the monotonic clock (default performance.now()) every in-memory schedule runs on: the assessment pacing, the
   * deadline ranking's valuation times and every back-off or retry deadline (provider-wide, per-position valuation, refused exit,
   * position opening), so a wall-clock step in either direction neither lengthens nor shortens one. `now` (the wall clock) stays
   * the clock of everything compared with server time or written: assessment validation, trigger freshness and every ledger write. */
  monotonicNow?(): number;
  /** Cancellable wait used for assessment pacing (tests replace it). */
  delay?(ms: number, signal: AbortSignal): Promise<void>;
  /** Test-only seam (see private-execution-gate.ts); production never sets it, so the worker stays inert. */
  capabilities?: PrivateExecutionCapabilities;
  /** K1b DCA (see PrivateExitDcaHooks). */
  dca?: PrivateExitDcaHooks;
}
/** K1b DCA: the last complete valuation of one position (net of the platform fee), process-local. */
export interface PrivateExitLastValuation { units: string; valueLamports: string; observedAtMs: number }
/** Process-local readback; nothing here is persisted. */
export interface PrivateExitWorkerStatus {
  /** Why the last pass stopped short or held (null when it ran to its end without a hold). */
  reason: string | null;
  /** Completed buys without a position yet: the last refusal, the attempts made and whether this process gave up. */
  opening: ReadonlyArray<{ buildDigest: string; reason: string; tries: number; kind: PrivateExitOpenRefusalKind }>;
  /** Positions waiting out a refusal backoff; untilMs is a wall-clock instant on this runner's clock at readback (an integer),
   * derived from the monotonic deadline. */
  backoff: ReadonlyArray<{ positionId: string; reason: string; failures: number; untilMs: number }>;
}
/** F-M36-D7-B: every time and deadline in this process-local state is on the monotonic clock (monotonicNow), never the wall clock. */
interface AgentState {
  reason: string | null; lastAssessAt: number; unavailable: number; unavailableUntil: number;
  /** The last valuation ATTEMPT per position (F1: a failed assessment counts), the deadline scheduler's clock. */
  valuedAt: Map<string, number>;
  /** L6: bps headroom to the nearest trigger at the last valuation; null when unknown (hold, sell, abort, failed assessment). */
  headroom: Map<string, number | null>;
  /** Refused exits (F5: protective ones capped lower). */
  failures: Map<string, { reason: string; failures: number; untilMs: number }>;
  /** F1: failed assessments of one position; cleared by its next valid assessment. */
  valuationFailures: Map<string, { reason: string; failures: number; untilMs: number }>;
  opening: Map<string, { reason: string; tries: number; nextAt: number; kind: PrivateExitOpenRefusalKind }>;
  /** F2 Step 1: positions whose triggered sell was deferred by a wallet hold; ranked like never valued until their next valuation. */
  deferred: Set<string>;
  /** K1b DCA: the last complete valuation per position (the dip trigger reads it; no extra assessment). */
  valuations: Map<string, PrivateExitLastValuation>;
}
type Step = "next" | "stop";

const code = (text: string): string => text.replace(/[^a-z0-9_:]/g, "_").slice(0, 96) || "refused";
function delayFor(base: number, max: number, failures: number): number { return Math.min(max, base * 2 ** Math.min(Math.max(failures - 1, 0), 20)); }
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
}
/** Net expected proceeds of a complete sell quote: outAmount minus the platform fee (never negative). */
function netValue(quote: NonNullable<RunnerSolanaSellAssessment["quote"]>): string {
  const out = BigInt(quote.outAmount); const fee = BigInt(quote.platformFeeLamports);
  return (out > fee ? out - fee : 0n).toString();
}

/** F1: assessment failures that say nothing about one position: transport, timeout, rate limit, server error, auth, a lease
 * change or anything unrecognised. They back off the whole agent (as well as the position). Only a response that does not
 * validate for exactly this request (`invalid_response`, the runner's own re-validation included) or a server refusal of this
 * request (HTTP 400, `policy_error`) is the position's own failure: that position alone waits, the others are still valued. */
function providerWide(error: unknown): boolean {
  return !(error instanceof AgentSdkError) || (error.code !== "invalid_response" && error.code !== "policy_error");
}

export class PrivateExitWorker {
  readonly #options: PrivateExitWorkerOptions;
  readonly #agentIds: string[];
  readonly #states = new Map<string, AgentState>();
  readonly #running = new Map<string, Promise<void>>();
  /** The wallet-balance settlement task in flight per agent (step 1b); never awaited by a pass. */
  readonly #settling = new Map<string, Promise<void>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #abort = new AbortController();
  #started = false;
  #closed = false;
  constructor(options: PrivateExitWorkerOptions) { this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds }; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void {
    // After start, the new agent gets the pass timer start gives every agent (without it, an armed new agent would have no exits).
    if (addRunnerAgent(this.#agentIds, agentId) && this.#started && !this.#closed) this.#kick(agentId);
  }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  /** F-M36-D7-B: the clock of every in-memory schedule (see PrivateExitWorkerOptions.monotonicNow). */
  #monotonic(): number { return (this.#options.monotonicNow ?? (() => performance.now()))(); }
  #exits(): boolean {
    const capabilities = this.#options.capabilities ?? PRIVATE_EXECUTION_CAPABILITIES;
    return typeof capabilities === "object" && capabilities !== null && capabilities.exits === true;
  }

  /** Daemon start, after S4 start recovery. Without the exits capability (the exits-off rollback build) this schedules nothing. */
  start(): void {
    if (this.#closed || !this.#exits()) return;
    this.#started = true;
    for (const agentId of this.#options.agentIds) this.#kick(agentId);
  }
  /** One pass for this agent now, serialized with any scheduled one (also the test seam). */
  async poll(agentId: string): Promise<void> {
    if (!this.#options.agentIds.includes(agentId)) return;
    for (let current = this.#running.get(agentId); current; current = this.#running.get(agentId)) await current;
    if (this.#closed || !this.#exits()) return;
    const work = this.#pass(agentId).then(() => undefined, () => undefined).finally(() => { this.#running.delete(agentId); });
    this.#running.set(agentId, work);
    await work;
  }
  status(agentId: string): PrivateExitWorkerStatus {
    const state = this.#states.get(agentId);
    if (!state) return { reason: null, opening: [], backoff: [] };
    // The monotonic deadline shown as a wall-clock instant of this moment (a non-negative integer, as the readback protocol requires).
    const wall = this.#now(); const monotonic = this.#monotonic();
    const until = (deadline: number): number => Math.max(0, Math.round(wall + (deadline - monotonic)));
    return { reason: state.reason,
      opening: [...state.opening].map(([buildDigest, item]) => ({ buildDigest, reason: item.reason, tries: item.tries, kind: item.kind })),
      backoff: [...state.failures, ...state.valuationFailures]
        .map(([positionId, item]) => ({ positionId, reason: item.reason, failures: item.failures, untilMs: until(item.untilMs) })) };
  }
  /** H1d: synchronous, local-only entry hold for the buy worker. Null lets a new buy proceed; a throw refuses it. Any released
   * attempt that is not terminal (F2, SF R10: attempt_released_unsettled), any held position, any pending exit, or any completed buy whose position is
   * not open yet (unless it is an SF R10 released buy later completed whose mint is among the watermark's outside mints, or its opening
   * was refused locally: an observed copy or an evicted position) holds new entries. Final audit S3: a permanently refused opening holds
   * them too, under the owner hold buy_unprotected (it takes precedence over position_unopened). */
  entryHold(agentId: string): string | null {
    if (!this.#exits() || !this.#options.agentIds.includes(agentId)) return null;
    const o = this.#options;
    // The enable-time watermark is recorded before the first buy can be built under the capability (a throw refuses the buy).
    const watermark = this.#watermark(agentId);
    const preEnable = unmanagedBuys(watermark); const outsideMints = new Set(watermark.outsideMints ?? []);
    const attempts = o.readAttempts(agentId);
    // F2: a released runner dispute's outcome is unknown until the owner closes it out: buys stay held. SF R10: so is a buy released
    // while Balchemy left it unresolved (its spend stays reserved), until its outcome is settled by evidence.
    // Only a NON-TERMINAL released attempt holds. Terminal means settled: the owner closed it out (closed_by_owner: spend committed,
    // mint unmanaged), Balchemy's `completed` was committed (S4 first keeps its mint off the balance settlement as an outside mint,
    // or pre-enable without a watermark; such a buy never holds buys as position_unopened below), or R4 proved on the runner's own
    // RPC that it did not land (spend released).
    if (attempts.some((item) => privateSubmissionReleased(item) && !isPrivateSubmissionTerminal(item.state))) return "attempt_released_unsettled";
    const positions = o.positions.positions(agentId);
    if (positions.some((item) => item.state === "held")) return "position_held";
    if (positions.some((item) => item.state !== "closed" && item.pendingExit !== null)) return "exit_pending";
    // L5: a full ledger could not open the next buy's position.
    if (positions.filter((item) => item.state !== "closed").length >= PRIVATE_POSITIONS_MAX_ACTIVE) return "ledger_full";
    const opening = this.#states.get(agentId)?.opening;
    const evicted = new Set(o.positions.evicted(agentId));
    let unopened = false;
    for (const attempt of attempts) {
      if (attempt.swap.direction !== "buy" || attempt.state !== "completed") continue;
      // Completed before automatic exits were enabled, or taken off automatic management by the owner (owner item 75): never managed,
      // so it never holds new buys (neither position_unopened nor buy_unprotected).
      if (preEnable.has(attempt.reservationId)) continue;
      // SF R10: a buy released on the runner's own proof that Balchemy later completed is settled (S4 committed its spend after
      // keeping its mint among the watermark's outside mints): its units are outside management by design, so a position that
      // cannot open (its transaction absent on the runner's RPC) never holds new buys. Every other completed buy still does.
      if (privateSubmissionReleased(attempt) && outsideMints.has(attempt.swap.outputMint)) continue;
      const positionId = privatePositionId(o.localProfileId, agentId, attempt.buildDigest);
      if (this.#refusedLocally(attempt, attempts, positionId, evicted)) continue;
      if (o.positions.position(agentId, positionId)) continue;
      // S3: landed tokens whose position can never open have no stop-loss: new buys stay held for the owner (it never lifts by itself).
      if (opening?.get(attempt.buildDigest)?.kind === "permanent") return "buy_unprotected";
      unopened = true;
    }
    return unopened ? "position_unopened" : null;
  }
  /** K1b DCA: the last complete valuation of a position (process-local), undefined before one. */
  valuation(agentId: string, positionId: string): PrivateExitLastValuation | undefined {
    const value = this.#states.get(agentId)?.valuations.get(positionId);
    return value ? { ...value } : undefined;
  }
  /** K1b DCA: true while a triggered sell of the mint waits for the wallet (F2 deferred): an add of the mint must not take the wallet first. */
  exitWanted(agentId: string, mint: string): boolean {
    const state = this.#states.get(agentId);
    if (!state || state.deferred.size === 0) return false;
    return this.#options.positions.positions(agentId).some((item) => item.tokenMint === mint && state.deferred.has(item.positionId));
  }
  /** Resolves once no pass and no settlement task is in flight (timers may still be pending). */
  async idle(): Promise<void> {
    while (this.#running.size > 0 || this.#settling.size > 0) await Promise.all([...this.#running.values(), ...this.#settling.values()]);
  }
  async close(): Promise<void> {
    this.#closed = true; this.#abort.abort();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await this.idle().catch(() => undefined);
  }

  #kick(agentId: string): void {
    if (this.#closed || !this.#exits() || this.#running.has(agentId)) return;
    const timer = this.#timers.get(agentId); if (timer) { clearTimeout(timer); this.#timers.delete(agentId); }
    let more = false;
    const work = this.#pass(agentId).then((value) => { more = value; }, () => undefined).finally(() => {
      this.#running.delete(agentId);
      if (this.#closed || !this.#started) return;
      // L6: a pass that used its whole valuation budget with positions left continues at once (the spacing still paces it).
      const next = setTimeout(() => { this.#timers.delete(agentId); this.#kick(agentId); }, more ? 0 : this.#options.pollMs ?? PRIVATE_EXIT_POLL_MS);
      next.unref(); this.#timers.set(agentId, next);
    });
    this.#running.set(agentId, work);
  }
  #state(agentId: string): AgentState {
    let state = this.#states.get(agentId);
    if (!state) {
      state = { reason: null, lastAssessAt: -Infinity, unavailable: 0, unavailableUntil: 0, valuedAt: new Map(), headroom: new Map(), failures: new Map(),
        valuationFailures: new Map(), opening: new Map(), deferred: new Set(), valuations: new Map() };
      this.#states.set(agentId, state);
    }
    return state;
  }
  /** The enable-time watermark (owner decision of 11 Nov 2026: only buys completed after automatic exits were enabled are
   * managed). Recorded once, synchronously, from the journal's COMPLETED buy attempts at this moment (with their output mints); the
   * ledger keeps it across restarts and clock steps and drops ids that already have a position. A buy still unfinished at this
   * moment completes after enabling, so it is managed. Throws when the ledger or journal is unavailable. */
  #watermark(agentId: string): PrivatePositionManagedFrom {
    const o = this.#options;
    const recorded = o.positions.managedFrom(agentId);
    if (recorded) return recorded;
    // Owner decision 26: a buy the owner closed out (it may have landed units nothing tracks) is kept unmanaged like a pre-enable buy.
    const buys = o.readAttempts(agentId).flatMap((item) => item.swap.direction === "buy" && (item.state === "completed" || privateSubmissionOwnerClosed(item))
      ? [{ reservationId: item.reservationId, tokenMint: item.swap.outputMint }] : []);
    return o.positions.recordManagedFrom(agentId, buys, this.#now());
  }
  #gate(agentId: string): PrivateExecutionGateRefusal | null {
    let runtime: RunnerAgentState | undefined; let facts: PrivateExecutionLiveFacts | undefined;
    try { runtime = this.#options.readRuntime(agentId); } catch { return "runtime_unavailable"; }
    try { facts = this.#options.readFacts(agentId); } catch { facts = undefined; }
    return privateExecutionGate(runtime, { step: "exit_build", agentId, facts }, this.#options.capabilities ?? PRIVATE_EXECUTION_CAPABILITIES);
  }

  /** One pass; true when it used its whole valuation budget and positions remain (the next pass should follow at once). */
  async #pass(agentId: string): Promise<boolean> {
    // FIRST: the exits capability, before any read. The exits-off rollback build always returns here.
    if (!this.#exits() || this.#closed) return false;
    const o = this.#options; const signal = this.#abort.signal; const state = this.#state(agentId);
    const note = (reason: string | null): void => { state.reason = reason === null ? null : code(reason); };
    // Step 0: the one-time enable watermark (local, no network); it does not wait for the gate.
    try { this.#watermark(agentId); } catch { note("watermark_unavailable"); return false; }
    const blocked = this.#gate(agentId);
    if (blocked) { note(`gate:${blocked}`); return false; }
    // Step 1b: the wallet-balance settlement runs beside this pass, never awaited by it.
    this.#settle(agentId, signal);
    await this.#openPositions(agentId, state, signal);
    if (this.#closed || signal.aborted) return false;
    // Step 3, one in-flight swap per wallet: the sell hold (first match). F2 Step 1: it defers a triggered sell, never valuation.
    let attempts: readonly PrivateSubmissionAttempt[];
    try { attempts = o.readAttempts(agentId); } catch { note("state_unavailable"); return false; }
    let sellHold: string | null = attempts.some(privateSubmissionCopyHeld) ? "copy_unacknowledged"
      : attempts.some(privateSubmissionHoldsWallet) ? "wallet_busy" : null;
    let intents: readonly PrivateExecutionIntent[];
    let reservations: readonly PrivateSpendReservation[];
    try { reservations = o.ledger.status(agentId, this.#now()).open; intents = o.intents.list(agentId); }
    catch { note("state_unavailable"); return false; }
    // A reserved reservation holds unless its journaled attempt is released (F2); one with no journal attempt always holds.
    const released = new Set(attempts.filter(privateSubmissionReleased).map((item) => item.reservationId));
    if (sellHold === null && reservations.some((item) => !released.has(item.reservationId))) sellHold = "wallet_busy";
    if (sellHold === null && intents.some((item) => item.state === "running")) sellHold = "wallet_busy";
    if (sellHold === null && o.dca) {
      let running = false;
      try { running = o.dca.running(agentId); } catch { running = false; }
      if (running) sellHold = "wallet_busy";
    }
    let positions: readonly PrivatePosition[];
    try { positions = o.positions.positions(agentId); } catch { note("state_unavailable"); return false; }
    // Process-local bookkeeping stays bounded by the ledger's own bound.
    const known = new Set(positions.map((item) => item.positionId));
    for (const id of [...state.valuedAt.keys()]) if (!known.has(id)) state.valuedAt.delete(id);
    for (const id of [...state.headroom.keys()]) if (!known.has(id)) state.headroom.delete(id);
    for (const id of [...state.failures.keys()]) if (!known.has(id)) state.failures.delete(id);
    for (const id of [...state.valuationFailures.keys()]) if (!known.has(id)) state.valuationFailures.delete(id);
    for (const id of [...state.deferred]) if (!known.has(id)) state.deferred.delete(id);
    for (const id of [...state.valuations.keys()]) if (!known.has(id)) state.valuations.delete(id);
    const pending = positions.filter((item) => item.state !== "closed" && item.pendingExit !== null);
    // A pending exit without a journal attempt may be signed only in memory (or still in flight): the whole wallet waits.
    const journaled = new Set(attempts.map((item) => item.reservationId));
    if (sellHold === null && pending.some((item) => item.pendingExit !== null && !journaled.has(item.pendingExit.reservationId))) sellHold = "exit_unjournaled";
    // H2: a pending or held exit blocks only positions of the same mint.
    const blockedMints = new Set(pending.map((item) => item.tokenMint));
    // F-M36-D7-B: back-offs and the ranking run on the monotonic clock.
    const now = this.#monotonic();
    if (now < state.unavailableUntil) { note("valuation_backoff"); return false; }
    const free = positions.filter((item) => item.state === "open" && item.pendingExit === null && !blockedMints.has(item.tokenMint));
    // F1: a position in its own exit or valuation back-off is left out of the pick (and of every other position's deadline check).
    const exitBackoff = (item: PrivatePosition): boolean => now < (state.failures.get(item.positionId)?.untilMs ?? 0);
    const valuationBackoff = (item: PrivatePosition): boolean => now < (state.valuationFailures.get(item.positionId)?.untilMs ?? 0);
    const open = this.#ranked(state, free.filter((item) => !exitBackoff(item) && !valuationBackoff(item)), now);
    // A sell hold stays visible as the pass reason while valuation goes on (a deferred sell then records deferred:<hold>).
    note(sellHold ?? (open.length > 0 ? null : free.some(exitBackoff) ? "exit_backoff" : free.length > 0 ? "valuation_backoff"
      : pending.length > 0 ? "exit_pending" : null));
    const batch = open.slice(0, PRIVATE_EXIT_VALUATIONS_PER_PASS);
    for (const position of batch) {
      if (this.#closed || signal.aborted) return false;
      if (await this.#evaluate(agentId, state, position, sellHold, signal) === "stop") return false;
    }
    return open.length > batch.length;
  }
  /** Starts the wallet-balance settlement task for this agent unless one is in flight (step 1b). Never throws, never awaited. */
  #settle(agentId: string, signal: AbortSignal): void {
    const settleHeld = this.#options.settleHeld;
    if (!settleHeld || this.#closed || signal.aborted || this.#settling.has(agentId)) return;
    let started: Promise<void>;
    // The gate is re-checked synchronously before every commit: a halt during the proofs never changes the ledger.
    try { started = settleHeld(agentId, signal, () => !this.#closed && this.#gate(agentId) === null); } catch { return; }
    const work = Promise.resolve(started).then(() => undefined, () => undefined).finally(() => { this.#settling.delete(agentId); });
    this.#settling.set(agentId, work);
  }
  /** L6/S3 order of this pass's valuations. Picks are simulated one per spacing from the next allowed assessment time; at each,
   * the highest (time since the last valuation) x weight(headroom) is taken only if every OTHER position, valued one per
   * spacing in deadline order after it, still meets its deadline (last valuation + PRIVATE_EXIT_MAX_VALUATION_INTERVAL_MS);
   * otherwise the earliest deadline goes (never valued counts as already due, ledger order). A position whose sell was deferred
   * by a wallet hold (F2) scores like never valued, under the same deadline check. Ties: least recently valued
   * first, then ledger order. Only the first PRIVATE_EXIT_VALUATIONS_PER_PASS are simulated; the rest follow in deadline order. */
  #ranked(state: AgentState, positions: readonly PrivatePosition[], now: number): PrivatePosition[] {
    const spacing = Math.max(0, this.#options.spacingMs ?? PRIVATE_EXIT_ASSESSMENT_SPACING_MS);
    type Item = { position: PrivatePosition; index: number; valued: number; deadline: number; weight: number; deferred: boolean };
    const items: Item[] = positions.map((position, index) => {
      const valued = state.valuedAt.get(position.positionId);
      return { position, index, valued: valued ?? -Infinity, deadline: valued === undefined ? -Infinity : valued + PRIVATE_EXIT_MAX_VALUATION_INTERVAL_MS,
        weight: weight(state.headroom.get(position.positionId)), deferred: state.deferred.has(position.positionId) };
    });
    const compare = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
    const byDeadline = (a: Item, b: Item): number => compare(a.deadline, b.deadline) || a.index - b.index;
    let remaining = [...items].sort(byDeadline);
    const order: Item[] = [];
    let at = Math.max(now, state.lastAssessAt + spacing);
    while (remaining.length > 0 && order.length < PRIVATE_EXIT_VALUATIONS_PER_PASS) {
      const when = at;
      // F2 Step 1: a deferred sell scores like never valued, still only when every other position keeps its deadline (feasible).
      const score = (item: Item): number => (item.valued === -Infinity || item.deferred ? Infinity : Math.max(0, when - item.valued) * item.weight);
      const scored = [...remaining].sort((a, b) => compare(score(b), score(a)) || compare(a.valued, b.valued) || a.index - b.index);
      const feasible = (candidate: Item): boolean => {
        let k = 0;
        for (const item of remaining) {
          if (item === candidate) continue;
          k += 1;
          if (when + k * spacing > item.deadline) return false;
        }
        return true;
      };
      const chosen = scored.find(feasible) ?? remaining[0]!;
      order.push(chosen);
      remaining = remaining.filter((item) => item !== chosen);
      at += spacing;
    }
    return [...order, ...remaining].map((item) => item.position);
  }

  /** Opens the positions of completed buys (bounded per pass). Never throws. */
  async #openPositions(agentId: string, state: AgentState, signal: AbortSignal): Promise<void> {
    const o = this.#options;
    let attempts: readonly PrivateSubmissionAttempt[];
    try { attempts = o.readAttempts(agentId); } catch { return; }
    // Evicted ids whose buy has left the journal can never be presented again: forgotten (bounded list), retried on any failure.
    const buys = new Set(attempts.filter((item) => item.swap.direction === "buy").map((item) => item.reservationId));
    try {
      if (o.positions.evicted(agentId).some((id) => !buys.has(id))) o.positions.forgetEvicted(agentId, (id) => buys.has(id), this.#now());
    } catch { /* Kept; the next pass retries. */ }
    // Buys completed before automatic exits were enabled, and buys the owner took off automatic management (owner item 75), are never
    // opened (and never listed as unopened). An owner write after this read is caught by `open` itself (the same snapshot read).
    let preEnable: ReadonlySet<string>;
    try { preEnable = unmanagedBuys(this.#watermark(agentId)); } catch { return; }
    const completed = attempts.filter((item) => item.swap.direction === "buy" && item.state === "completed" && !preEnable.has(item.reservationId));
    const digests = new Set(completed.map((item) => item.buildDigest));
    for (const digest of [...state.opening.keys()]) if (!digests.has(digest)) state.opening.delete(digest);
    let tried = 0;
    for (const attempt of completed) {
      if (this.#closed || signal.aborted || tried >= OPENS_PER_PASS) return;
      let positionId: string;
      try { positionId = privatePositionId(o.localProfileId, agentId, attempt.buildDigest); } catch { continue; }
      let existing: PrivatePosition | undefined;
      try { existing = o.positions.position(agentId, positionId); } catch { return; }
      if (existing) { state.opening.delete(attempt.buildDigest); continue; }
      const record = state.opening.get(attempt.buildDigest);
      if (record && (record.kind === "permanent" || this.#monotonic() < record.nextAt)) continue;
      tried += 1;
      const refusal = await this.#open(agentId, attempt, attempts, signal);
      if (refusal === null) { state.opening.delete(attempt.buildDigest); continue; }
      if (this.#closed || signal.aborted) return;
      const tries = (record?.tries ?? 0) + 1;
      // F-M36-D2-A2: an RPC wait is retried at every pass (it never doubles past the RPC's recovery); every other refusal doubles.
      const wait = OPEN_CHAIN_WAITS.includes(refusal.reason) ? PRIVATE_EXIT_OPEN_CHAIN_RETRY_MS
        : delayFor(PRIVATE_EXIT_OPEN_BASE_MS, PRIVATE_EXIT_OPEN_MAX_MS, tries);
      state.opening.set(attempt.buildDigest, { reason: code(refusal.reason), kind: refusal.kind, tries, nextAt: this.#monotonic() + wait });
    }
  }

  /** Permanent refusals decidable locally: an observed re-signed copy (the journaled signature proves nothing), or a position that
   * was already sold out and evicted (the ledger recorded its entry reservation, or a sell attempt still names it; never re-opened). */
  #refusedLocally(attempt: PrivateSubmissionAttempt, attempts: readonly PrivateSubmissionAttempt[], positionId: string,
    evicted: ReadonlySet<string>): string | null {
    if (attempt.observedSignature !== null) return "observed_copy";
    if (evicted.has(attempt.reservationId)) return "position_evicted";
    if (attempts.some((item) => item.swap.direction === "sell" && item.swap.positionId === positionId)) return "position_evicted";
    return null;
  }
  /** Null once the position is open (or replayed); otherwise the classified reason nothing was opened. Never guesses units. */
  async #open(agentId: string, attempt: PrivateSubmissionAttempt, attempts: readonly PrivateSubmissionAttempt[], signal: AbortSignal): Promise<OpenRefusal | null> {
    const o = this.#options; const swap = attempt.swap;
    if (swap.direction !== "buy") return permanent("not_a_buy");
    const positionId = privatePositionId(o.localProfileId, agentId, attempt.buildDigest);
    let evicted: ReadonlySet<string>;
    try { evicted = new Set(o.positions.evicted(agentId)); } catch { return transient("state_unavailable"); }
    const local = this.#refusedLocally(attempt, attempts, positionId, evicted);
    if (local) return permanent(local);
    // H1a: the cost is the attempt's own validated gross. The spend reservation is a cross-check only while it is still held
    // (the spend ledger drops settled reservations of earlier UTC days): absent is no refusal, present and different is.
    let reservation: PrivateSpendReservation | undefined;
    try { reservation = o.ledger.reservation(agentId, attempt.reservationId); } catch { return transient("state_unavailable"); }
    // K1b DCA: a DCA add opens its OWN lot from its durable add record (its exit snapshot, plan digest and slippage), never from an intent.
    // An unreadable DCA store never keeps a signal buy (one its intent names) from opening its position and stop-loss.
    let dcaAdd: PrivateDcaAdd | undefined; let dcaUnavailable = false;
    if (o.dca) { try { dcaAdd = o.dca.add(agentId, attempt.reservationId); } catch { dcaUnavailable = true; } }
    let exit: unknown; let slippage: number | null; let planHex: string;
    if (dcaAdd) {
      // Running or held: the add's outcome is not recorded yet (the DCA worker records it from the journal); retried.
      if (dcaAdd.state === "running" || dcaAdd.state === "held") return transient("dca_add_unsettled");
      if ((dcaAdd.state !== "submitted" && dcaAdd.state !== "opened") || (dcaAdd.attemptKey !== null && dcaAdd.attemptKey !== attempt.attemptKey)
        || dcaAdd.mint !== swap.outputMint || dcaAdd.walletAddress !== attempt.walletAddress || dcaAdd.amountLamports !== swap.grossInLamports) return permanent("dca_add_mismatch");
      if (reservation && (reservation.state !== "committed" || reservation.jobId !== privateDcaJobId(dcaAdd.planDigest) || reservation.walletAddress !== attempt.walletAddress
        || reservation.amountLamports !== swap.grossInLamports || reservation.planDigest !== dcaAdd.planDigest)) return permanent("reservation_mismatch");
      exit = structuredClone(dcaAdd.exit); slippage = dcaAdd.slippageBps; planHex = dcaAdd.planDigest;
    } else {
      // Provenance: the intent that recorded exactly this attempt, then its job and resolved plan.
      let intents: readonly PrivateExecutionIntent[];
      try { intents = o.intents.list(agentId); } catch { return transient("state_unavailable"); }
      const intent = intents.find((item) => item.attemptKey === attempt.attemptKey);
      // A DCA reservation whose add record is gone has no provenance left: named apart from a signal buy's missing intent.
      if (!intent) {
        if (dcaUnavailable) return transient("dca_unavailable");
        return permanent(reservation?.jobId.startsWith("dca:") ? "dca_add_missing" : "intent_missing");
      }
      const planDigest = intent.planDigest;
      if (intent.state !== "submitted" || planDigest === null || !PLAN_DIGEST.test(planDigest)) return permanent("intent_mismatch");
      if (reservation && (reservation.state !== "committed" || reservation.jobId !== intent.jobId || reservation.walletAddress !== attempt.walletAddress
        || reservation.amountLamports !== swap.grossInLamports || `sha256:${reservation.planDigest}` !== planDigest)) return permanent("reservation_mismatch");
      let job: PrivateSignalJob;
      try { job = await o.readJob(agentId, intent.jobId, signal); }
      catch (error: unknown) {
        return error instanceof PrivateBrainStoreError && error.code === "job_not_found" ? permanent("job_missing") : transient("job_unavailable");
      }
      const plan = job.result?.plan;
      if (job.jobId !== intent.jobId || job.agentId !== agentId || !plan || plan.state !== "resolved" || plan.digest !== planDigest
        || plan.asset.chain !== "solana" || plan.asset.assetId !== swap.outputMint) return permanent("plan_mismatch");
      slippage = plan.slippageBps; planHex = planDigest.slice("sha256:".length);
      exit = plan.exit === null ? null : structuredClone(plan.exit);
    }
    if (slippage === null || !Number.isSafeInteger(slippage) || slippage < 1 || slippage > PRIVATE_POSITION_MAX_SLIPPAGE_BPS) return permanent("plan_slippage_invalid");
    if (!privateExitSnapshotValid(exit)) return permanent("exit_snapshot_invalid");
    if (this.#closed || signal.aborted) return transient("closing");
    let transaction: unknown;
    try { transaction = await o.readTransaction(agentId, attempt.signature, signal); } catch { return transient("rpc_unavailable"); }
    if (this.#closed || signal.aborted) return transient("closing");
    const credit = privateBuyTokenCredit(transaction, { signature: attempt.signature, walletAddress: attempt.walletAddress, tokenMint: swap.outputMint });
    // Not finalized on the runner's own RPC yet, or served without its body or balances (S3): a later read may change these.
    if (credit.outcome === "refused") return TRANSIENT_FACTS.includes(credit.reason) ? transient(`facts:${credit.reason}`) : permanent(`facts:${credit.reason}`);
    // The engine reported completion against this build's minOut: less is a contradiction, never a position.
    if (BigInt(credit.units) < BigInt(swap.minOut)) return permanent("facts:credit_below_min_out");
    try {
      o.positions.open(agentId, { walletAddress: attempt.walletAddress, tokenMint: swap.outputMint, exit,
        entry: { buildDigest: attempt.buildDigest, reservationId: attempt.reservationId, signature: attempt.signature, units: credit.units,
          costLamports: swap.grossInLamports, planDigest: planHex, slippageBps: slippage } }, this.#now());
    } catch (error: unknown) {
      if (!(error instanceof PrivatePositionError)) return transient("position_unavailable");
      return TRANSIENT_POSITION_ERRORS.includes(error.code) ? transient(`position:${error.code}`) : permanent(`position:${error.code}`);
    }
    if (dcaAdd) { try { o.dca?.opened(agentId, dcaAdd.reservationId, credit.units); } catch { /* Reconciled by the DCA worker. */ } }
    return null;
  }

  #request(position: PrivatePosition, units: string): RunnerSellAssessmentRequest {
    return { version: 1, chain: "solana", inputMint: position.tokenMint, outputMint: WSOL_MINT, grossInputAmount: units,
      slippageBps: position.entry.slippageBps, planDigest: position.entry.planDigest };
  }
  async #pace(state: AgentState, signal: AbortSignal): Promise<void> {
    const spacing = this.#options.spacingMs ?? PRIVATE_EXIT_ASSESSMENT_SPACING_MS;
    const wait = state.lastAssessAt + spacing - this.#monotonic();
    if (wait > 0) await (this.#options.delay ?? sleep)(Math.min(wait, spacing), signal);
  }
  /** One paced, re-validated assessment of `positionId`. A failure backs off that position (F1) and, when provider-wide, the
   * whole agent: "position" lets the pass go on with the next position, "agent" (and a gate refusal or close) stops it. */
  async #assess(agentId: string, state: AgentState, positionId: string, request: RunnerSellAssessmentRequest,
    signal: AbortSignal): Promise<{ ok: true; assessment: RunnerSolanaSellAssessment } | { ok: false; scope: "position" | "agent" }> {
    await this.#pace(state, signal);
    if (this.#closed || signal.aborted) return { ok: false, scope: "agent" };
    // Disarm, stop or a lost capability while pacing: nothing is requested.
    const blocked = this.#gate(agentId);
    if (blocked) { state.reason = code(`gate:${blocked}`); return { ok: false, scope: "agent" }; }
    // Monotonic: the pacing and the deadline scheduler's attempt time (the validation below keeps the wall clock).
    const attemptedAt = this.#monotonic();
    state.lastAssessAt = attemptedAt;
    try {
      const supplied = await this.#options.assess(agentId, request, signal);
      const assessment = validateRunnerSolanaSellAssessment(supplied, request, this.#now());
      state.unavailable = 0; state.unavailableUntil = 0; state.valuationFailures.delete(positionId);
      return { ok: true, assessment };
    } catch (error: unknown) {
      if (this.#closed || signal.aborted) return { ok: false, scope: "agent" };
      const wide = providerWide(error);
      // F1: this attempt is the position's valuation time for the deadline scheduler, and the position waits out its own
      // bounded back-off, so an assessment that always fails for one token never holds the earliest-deadline pick.
      state.valuedAt.set(positionId, attemptedAt); state.headroom.set(positionId, null);
      const failures = (state.valuationFailures.get(positionId)?.failures ?? 0) + 1;
      state.valuationFailures.set(positionId, { reason: wide ? "valuation:unavailable" : "valuation:invalid", failures,
        untilMs: this.#monotonic() + delayFor(PRIVATE_EXIT_VALUATION_BACKOFF_BASE_MS, PRIVATE_EXIT_VALUATION_BACKOFF_MAX_MS, failures) });
      if (!wide) { state.reason = "valuation_invalid"; return { ok: false, scope: "position" }; }
      state.unavailable += 1;
      state.unavailableUntil = this.#monotonic() + delayFor(PRIVATE_EXIT_UNAVAILABLE_BASE_MS, PRIVATE_EXIT_UNAVAILABLE_MAX_MS, state.unavailable);
      state.reason = "valuation_unavailable";
      return { ok: false, scope: "agent" };
    }
  }
  /** A refused exit (or an exit decision that could not be evaluated): a growing per-position back-off, capped at
   * PRIVATE_EXIT_PROTECTIVE_BACKOFF_MAX_MS for a stop-loss or trailing stop (F5), PRIVATE_EXIT_BACKOFF_MAX_MS otherwise. */
  #fail(state: AgentState, positionId: string, reason: string, trigger: PrivateExitTrigger | null): void {
    const failures = (state.failures.get(positionId)?.failures ?? 0) + 1;
    const max = trigger !== null && PROTECTIVE_TRIGGERS.includes(trigger) ? PRIVATE_EXIT_PROTECTIVE_BACKOFF_MAX_MS : PRIVATE_EXIT_BACKOFF_MAX_MS;
    state.failures.set(positionId, { reason: code(reason), failures, untilMs: this.#monotonic() + delayFor(PRIVATE_EXIT_BACKOFF_BASE_MS, max, failures) });
    state.reason = code(reason);
  }

  async #evaluate(agentId: string, state: AgentState, position: PrivatePosition, sellHold: string | null, signal: AbortSignal): Promise<Step> {
    const result = await this.#assess(agentId, state, position.positionId, this.#request(position, position.remainingUnits), signal);
    // F2 Step 1: a deferred position leaves the deferred set at its next valuation attempt (re-added below if still deferred); a
    // pass stopped before any request (gate, close) or by a provider-wide failure keeps it.
    if (result.ok || result.scope === "position") state.deferred.delete(position.positionId);
    if (!result.ok) return result.scope === "position" ? "next" : "stop";
    const valued = result.assessment;
    // The scheduler's valuation time is monotonic; the trigger evaluation and the ledger write keep the wall clock.
    state.valuedAt.set(position.positionId, this.#monotonic());
    const now = this.#now();
    const quote = valued.quote;
    const valuation: PrivateExitValuation = valued.status === "complete" && quote
      ? { complete: true, units: position.remainingUnits, valueLamports: netValue(quote), observedAtMs: Number(quote.observedAtMs) }
      : { complete: false, units: position.remainingUnits, valueLamports: "0", observedAtMs: now };
    if (valuation.complete) state.valuations.set(position.positionId, { units: valuation.units, valueLamports: valuation.valueLamports, observedAtMs: valuation.observedAtMs });
    else state.valuations.delete(position.positionId);
    let decision: PrivateExitDecision;
    try { decision = evaluatePrivateExit(position.exit, position, valuation, now); }
    catch { this.#fail(state, position.positionId, "trigger_input_invalid", null); return "next"; }
    if (decision.action === "hold") { state.headroom.set(position.positionId, null); state.reason = code(`hold:${decision.reason}`); return "next"; }
    // Forward-only trailing state, persisted only when it changed.
    if (decision.trailing.trailingArmed !== position.trailingArmed || decision.trailing.highWaterLamports !== position.highWaterLamports) {
      try { this.#options.positions.recordTrailing(agentId, position.positionId, decision.trailing, now, position.exit); }
      catch { state.reason = "state_unavailable"; return "stop"; }
    }
    if (decision.action === "none") {
      let headroom: number | null = null;
      try { headroom = privateExitHeadroomBps(position.exit, { ...position, ...decision.trailing }, valuation.valueLamports); } catch { headroom = null; }
      state.headroom.set(position.positionId, headroom);
      return "next";
    }
    state.headroom.set(position.positionId, null);
    // F2 Step 1: the wallet is held: no beginExit, build or ledger write; the sell runs on the first pass after the hold lifts.
    if (sellHold !== null) { state.deferred.add(position.positionId); state.reason = code(`deferred:${sellHold}`); return "next"; }
    await this.#sell(agentId, state, position, decision, valued, signal);
    return "stop";
  }

  async #sell(agentId: string, state: AgentState, position: PrivatePosition, decision: Extract<PrivateExitDecision, { action: "sell" }>,
    valued: RunnerSolanaSellAssessment, signal: AbortSignal): Promise<void> {
    const o = this.#options; const positionId = position.positionId;
    // The exit names an assessment of exactly its units: a partial sell needs a second, fresh one.
    let assessment = valued;
    if (BigInt(decision.units) < BigInt(position.remainingUnits)) {
      const fresh = await this.#assess(agentId, state, positionId, this.#request(position, decision.units), signal);
      if (!fresh.ok) return;
      const second = fresh.assessment;
      if (second.status !== "complete" || !second.quote) {
        this.#fail(state, positionId, `exit_assessment:${second.reasonCode || "unavailable"}`, decision.trigger); return;
      }
      // Item 6: the exit is sold against THIS assessment, so it must still qualify for exactly the same decision. Otherwise the
      // partial exit is aborted before anything is recorded (no backoff: the next valuation of all units decides afresh).
      let recheck: ReturnType<typeof recheckPrivatePartialExit>;
      try {
        recheck = recheckPrivatePartialExit(position.exit, position, decision, { complete: true, units: decision.units,
          valueLamports: netValue(second.quote), observedAtMs: Number(second.quote.observedAtMs) }, this.#now());
      } catch { recheck = { ok: false, reason: "valuation_unavailable" }; }
      if (!recheck.ok) { state.reason = code(`partial_exit_aborted:${recheck.reason}`); return; }
      assessment = second;
    }
    if (this.#closed || signal.aborted) return;
    // Re-read right before recording: still exactly this open position, and no other exit pending on the same mint.
    let current: readonly PrivatePosition[];
    try { current = o.positions.positions(agentId); } catch { state.reason = "state_unavailable"; return; }
    const latest = current.find((item) => item.positionId === positionId);
    // Owner decision of 21 Nov 2026: an owner re-bind of this position's exits to a newer rule revision between the valuation and here
    // (private-exit-rebind.ts) aborts this decision, made under the old snapshot; the next pass decides under the new one.
    if (!latest || latest.state !== "open" || latest.pendingExit !== null || latest.remainingUnits !== position.remainingUnits
      || latest.takeProfitFired.length !== position.takeProfitFired.length || JSON.stringify(latest.exit) !== JSON.stringify(position.exit)
      || current.some((item) => item.state !== "closed" && item.pendingExit !== null && item.tokenMint === position.tokenMint)) {
      state.reason = "exit_changed"; return;
    }
    const blocked = this.#gate(agentId);
    if (blocked) { state.reason = code(`gate:${blocked}`); return; }
    // K1b DCA: a stop-loss or trailing stop of the mint ends its DCA campaign for good, before the exit is recorded.
    if (o.dca && (decision.trigger === "stop_loss" || decision.trigger === "trailing_stop")) {
      try { o.dca.protectiveExit(agentId, position.tokenMint, decision.trigger); } catch { /* The DCA worker ends it from the pending exit. */ }
    }
    const reservationId = randomUUID();
    try { o.positions.beginExit(agentId, positionId, { reservationId, trigger: decision.trigger, level: decision.level, units: decision.units }, this.#now()); }
    catch (error: unknown) { this.#fail(state, positionId, error instanceof PrivatePositionError ? `begin:${error.code}` : "begin_failed", decision.trigger); return; }
    let built: PrivateExitBuildOutcome;
    try { built = await o.build(agentId, { positionId, assessment }, signal); }
    catch { this.#clearUnsigned(agentId, positionId, reservationId, "build_failed"); this.#fail(state, positionId, "build:failed", decision.trigger); return; }
    if (built.outcome !== "validated") {
      // Nothing can be signed without a validated build: whatever pending exit it left (with no journal attempt) is a proven non-execution.
      this.#clearUnsigned(agentId, positionId, reservationId, built.outcome === "refused" ? `build_${built.reason}` : "build_outcome_unknown");
      // M2: waiting for the wallet lock is not a refusal of this exit; the next pass retries without backoff.
      if (built.outcome === "refused" && WALLET_WAITS.includes(built.reason)) { state.reason = code(`build:${built.reason}`); return; }
      this.#fail(state, positionId, built.outcome === "refused" ? `build:${built.stage}:${built.reason}` : "build:unknown", decision.trigger);
      return;
    }
    let submitted: PrivateExitSubmissionOutcome;
    // A throw here may follow a signature: the pending exit stays (reconciliation or restart recovery proves it).
    try { submitted = await o.submit(agentId, built, signal); } catch { state.reason = "submit_outcome_unknown"; return; }
    if (submitted.outcome === "journaled") { state.failures.delete(positionId); state.reason = null; return; }
    if (submitted.outcome === "refused") {
      if (WALLET_WAITS.includes(submitted.reason)) { state.reason = code(`submit:${submitted.reason}`); return; }
      this.#fail(state, positionId, `submit:${submitted.reason}`, decision.trigger); return;
    }
    state.reason = code(`submit:${submitted.reason}`);
  }
  /** Clears this worker's own pending exit as proven_negative only while the position still carries exactly it and the journal
   * has no attempt for it (no signature can exist). Any doubt leaves it for restart recovery. */
  #clearUnsigned(agentId: string, positionId: string, reservationId: string, reason: string): void {
    const o = this.#options;
    try {
      const position = o.positions.position(agentId, positionId);
      if (!position || position.state !== "open" || position.pendingExit?.reservationId !== reservationId) return;
      if (o.readAttempts(agentId).some((item) => item.reservationId === reservationId)) return;
      o.positions.failExit(agentId, positionId, reservationId, "proven_negative", code(`s5c:worker:${reason}`), this.#now());
    } catch { /* Held: restart recovery clears a never-journaled pending exit. */ }
  }
}

export interface PrivateSellAssessmentOptions {
  directory: string; localProfileId: string; instanceId: string;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  fetchFn?: typeof fetch;
}
function identity(lease: Readonly<RunnerRuntimeActiveLease>): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest, lease.runnerPublicKey, lease.instanceId, lease.epoch]);
}
/** One bounded, read-only sell assessment pinned to the active lease: the runner's fixed-purpose sell-assessment proof signs only
 * exactly this request, and a lease change at any point refuses. It never builds, reserves or signs a transaction. */
export async function queryPrivateSellAssessment(options: PrivateSellAssessmentOptions, agentId: string, request: RunnerSellAssessmentRequest,
  signal?: AbortSignal): Promise<RunnerSolanaSellAssessment> {
  const lease = options.readLease(agentId);
  if (!lease || lease.instanceId !== options.instanceId || !(lease.remainingMs > 0)) throw new Error("lease unavailable");
  const pinned = identity(lease);
  const requestDigest = runnerSellAssessmentRequestDigest(request);
  const live = (): void => {
    const current = options.readLease(agentId);
    if (signal?.aborted || !current || identity(current) !== pinned || !(current.remainingMs > 0)) throw new Error("lease changed");
  };
  const client = new RunnerSellAssessmentClient({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId, bindingDigest: lease.bindingDigest,
    runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, apiBaseUrl: `${lease.frontendOrigin}/api`, timeoutMs: SELL_ASSESSMENT_TIMEOUT_MS,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    signer: (nonce, expected) => {
      live();
      if (runnerSellAssessmentRequestDigest(expected.request) !== requestDigest) throw new Error("request mismatch");
      return signRunnerSellAssessmentProof({ directory: options.directory, localProfileId: options.localProfileId, agentId },
        { instanceId: lease.instanceId, epoch: expected.epoch, request: expected.request, nonce });
    } });
  const response = await client.query(request, lease.epoch, signal);
  live();
  return response.assessment;
}
