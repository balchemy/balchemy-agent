/** S4 runner side: sign one validated swap locally, fsync it to the submission journal, relay it through Balchemy and
 * settle the local reservation only from server-proven states. `submit` has one production caller, the S8b execution
 * worker (private-execution-intents.ts); recovery never signs. The backend refuses every relay unless its own arming gate
 * passes. The runner never broadcasts to a Solana RPC itself (owner decision) and never re-signs.
 *
 * Order (submit): (a) the build path's single-use validated token; (b) local clearance re-checked synchronously (wallet
 * lock held, reservation reserved, token unexpired, lease, journal room); (c) keystore.sign(token) -> one signature, wire
 * = compact-u16(1) || signature || message; (d) journal `signed` fsynced BEFORE any network call; (e) SDK relay with the
 * fixed-purpose submit proof; (f) submitted_known | submitted_unknown | refusal recorded. A refusal before (c) releases
 * the reservation and the wallet lock; from (c) on nothing is released locally except by a terminal server state.
 *
 * Recovery (daemon start, then every poll while an attempt is unfinished): status (fixed-purpose status proof) moves the
 * journal and ledger: completed -> committed; everything else stays held. A buy Balchemy reports failed_onchain |
 * expired_not_landed releases nothing on the server's word (SF2, below): it stays held, relay closed, until the runner proves the
 * negative on its own RPC.
 * From `signed` or `submitted_unknown`, before lastValidBlockHeight on the runner's own RPC, the identical stored bytes
 * may be relayed again (resendIdentical only once the engine holds them): at most 8 more, at least 2 s apart, each
 * counted in the journal before it is made. The wallet lock is released only at a terminal state.
 *
 * Re-signed copy: status pins this runner's journaled signature (expectedSignature). When Balchemy reports a landed copy
 * of the same message under another signature (observedSignature / resignedCopyObserved), the wallet key was used outside
 * this runner — a security event, although the swap ran. The attempt records the copy with reason observed_resigned_copy,
 * is never relayed again, settles the ledger exactly as the facts say (completed -> committed; nothing is ever released
 * for it: a failed copy is held for the owner), and the wallet takes no new autonomous submission until the owner runs
 * `balchemy runner wallet <agent> acknowledge-copy`.
 *
 * Arming (S8a, private-execution-gate.ts): the one signature needs `entry_sign` (live_armed, entries enabled, the build's
 * runtime revision); every relay of journaled bytes, first or identical resend, needs `relay` (live_armed). A pause of new
 * entries never blocks relaying an already-signed attempt; disarm or stop holds every relay (the bytes stay journaled and
 * status keeps reconciling from server truth, which is never gated). The relay gate is checked again inside the submit
 * proof signer, after the nonce exchange and immediately before the proof exists: a disarm during the nonce fetch means
 * no submit request is ever made (recorded `gate:<code>`, state unchanged).
 *
 * S5c exits (`submitExit`, behind the exits capability; called only by the S5c exit worker): the same steps (b)-(f) for one validated exit sell
 * (private-exit-build.ts) with no spend-ledger reservation: the position's pending exit is the reservation and must still
 * match the build. The one signature needs `exit_sign` (live_armed, armed, idle, exits capability, the build's runtime
 * revision; an entries pause never blocks it). Every refusal before the signature clears the pending exit as
 * proven_negative and releases the wallet lock. Relay, identical resends and status run exactly as for buys; a sell
 * attempt settles its POSITION, never the spend ledger: at a terminal journal state the wallet lock is released and the
 * settlement pass (after each reconcile) moves the position: completed -> completeExit with the proceeds the runner proves
 * from its own finalized getTransaction of the journaled signature (retried while not yet available; a contradiction holds
 * the position for the owner); failed_onchain | expired_not_landed -> proven_negative only on the runner's own finalized
 * evidence (the journaled signature finalized with an error, or, for an expiry, the runner-side expiry proof of
 * `#proveSellExpiry`, which never trusts Balchemy's lastValidBlockHeight alone; a landed success despite the server's state settles from the proof or holds
 * `runner:sell_landed_despite_<state>`); a dispute or an observed copy -> unknown (held). A terminal sell attempt is never evicted from the journal before its position settled.
 * SF8 (M3.6 D18): a terminal sell absent at finalized never waits unnamed. failed_onchain is held
 * runner:failed_onchain_transaction_missing until the runner-side expiry proof holds (then proven_negative); completed is held
 * runner:completed_transaction_missing until it holds, then runner:completed_contradicted_by_expiry (the owner's; never "sold" or
 * "not sold" on either word alone). The settlement pass re-checks the first two itself (PRIVATE_RUNNER_RECHECKED_HOLDS); Balchemy
 * status is not read again for a terminal record (the engine never moves a terminal record).
 *
 * F2 release by proof (owner decision 13 of 11 Nov 2026; docs/product/drafts/M3-F2-VALUATION-FREEZE-DESIGN.md), behind the exits
 * capability, runner disputes only: a relay-closed `runner:` dispute holds its wallet forever (no server state settles it). Each
 * reconcile pass (`#closeLandings`, after the attempt loop, before the settlement pass) tries at most one such attempt per agent,
 * with a per-attempt back-off of 30 s doubling to 10 min: (1) the journaled wire's recentBlockhash equals the stored blockhash
 * (otherwise never, a permanent reason); (2) proof 1 and (3) proof 2 from fresh reads, each checks 1-2 of the expiry proof
 * (privateBlockhashExpired: finalized height > lastValidBlockHeight + 150 and the RPC rejecting the blockhash at or past F), the
 * second F not below the first; (4) synchronously: the `exit_build` gate admits (live_armed, armed, idle, the exits capability and
 * the owner's own RPC class, the same gate as an exit build and the balance settlement) and the journal attempt still equals the
 * proven snapshot; (5) journal.closeLanding (compare-and-set on the whole attempt, write-once), then the in-process wallet lock
 * is closed when this attempt owns it. A refused check is recorded per attempt (`landingReleases`, `releaseChecks`, the
 * `releaseCheck` of `runner trades`); a permanently refused attempt (wire_blockhash_mismatch) no longer keeps S4 polling.
 * The state stays `disputed`; no units, spend or position move; the runner-dispute rules (runnerDisputed, outsideCopyPossible,
 * engineConflict) are unchanged. Release only claims "cannot land after F", never "did not land". Server-stalled attempts are
 * out of its scope (SF R10 covers a buy, SF-A a sell, below). S4 keeps polling for a releasable dispute only while the release can still progress: a disarmed, stopped or
 * exits-less agent cannot re-arm while the dispute is open, so no timer stays armed for it. Every restart disarms the agent, so
 * recoverOnStart records such a refusal (gate_refused) synchronously, without any read, for the readback.
 *
 * SF2 buy negatives (docs/product/drafts/M3-SF1-SF2-HISTORY-AND-RESERVATION-DESIGN.md, R1-R9; the rule sells already follow): a
 * buy whose record Balchemy reports failed_onchain | expired_not_landed (no observed copy) keeps its state, its reservation
 * `reserved` and its wallet lock, with that engineState, relay closed (never resent) and reason s4:negative_unconfirmed (R1, R7).
 * The buy settlement pass (`#settleBuys`, after the attempt loop, before the F2 release) tries at most one such buy per agent per
 * pass, with the F2 back-off (30 s doubling to 10 min). It reads nothing while the runtime is stopped or unreadable, or without the
 * owner's own settlement RPC; it does not need live_armed (it executes nothing, and arming refuses while a reservation is open).
 * Polling follows the proof: such a buy keeps the 5 s timer armed only while its proof can run, its Balchemy status is read only once
 * its back-off has elapsed, and while the gate refuses only a slow watch (PRIVATE_BUY_WATCH_MS) runs, at most one status read per
 * watch. A restart records the refusal at once (gate_refused, no read). It
 * runs privateBuyNegativeProof (private-position-balance.ts) and acts on it, failing closed:
 * - not_landed: an outside credit (dust) first keeps the mint on the position ledger's watermark, then ledger.release
 *   (s4:<state>), the terminal journal write (s4:not_landed_proven), and the wallet lock (R4). A crash between the release and the
 *   journal write completes on the next pass without a new proof (a journaled buy's reservation is released only here);
 * - landed (only the runner's own finalized getTransaction without error): dispute runner:buy_landed_despite_<state> (R5);
 * - unproven: back-off, nothing written. A counted result becomes permanent after RUNNER_BUY_CHECK_PERMANENT_COUNT counted results
 *   at strictly increasing F, the first and the last at least PRIVATE_BUY_CHECK_PERMANENT_SPAN_MS apart, each with the same reason
 *   and balance (a change restarts the count; the count is process-local): dispute runner:buy_negative_unproven:<reason> (R6).
 * Both disputes keep the reservation `reserved`; F2 may then release the wallet lock by proof. A buy the server leaves unresolved
 * never reaches this pass; R10 below covers it, except an unrelayed one (next paragraph).
 *
 * M3.6 D6 K1 (finding F-M36-D6-K1; docs/product/drafts/M3-6-JOINED-HARNESS-DESIGN.md section 3.2, D6 K1): a buy Balchemy never received
 * (privateSubmissionUnrelayedBuy: non-terminal, not disputed, no observed copy, its engine record still `awaiting_signature`), for example
 * one signed and journaled right before a crash. Every restart disarms, relays need live_armed and arming refuses while it is open, so
 * before this rule only the owner's 30-minute close-out could end it. Behind the exits capability (as R10) the same buy settlement pass
 * takes it exactly like a held buy negative: the same gate (#buyReadable: not stopped, runtime readable, the owner's own RPC class; NOT
 * live_armed, since it executes nothing), the same back-off, sighting rule, probe stamp and proof (privateBuyNegativeProof: checks 1-2 of
 * the expiry proof past lastValidBlockHeight + 150, then the history witness or the balance path, then still absent at finalized). Only
 * `not_landed` settles it: ledger.release (s4:awaiting_signature), then the terminal write expired_not_landed (s4:not_landed_proven, relay
 * closed), then the wallet lock. `landed` is the R5 dispute runner:buy_landed_despite_awaiting_signature; a counted unproven result
 * reaches the R6 bound like any other (runner:buy_negative_unproven:<reason>, owner close-out). Anything else keeps it held, non-terminal,
 * under its named buy check (`runner trades`), and arming refuses `submission_unrelayed`. Nothing here relays, resends, builds or signs;
 * Balchemy status keeps being read as for any unfinished attempt. R10 no longer takes such a buy (stallReleasable). Balchemy's own
 * reservation for it stays `built` (the engine never moves an unsigned record): out of the runner's reach.
 * Its sell twin (slice 7 audit B1: a stop-loss sell signed and journaled before a crash, or relayed during an outage longer than the
 * blockhash lifetime, whose engine record still awaits a signature) ends through #settleUnrelayedSells on the expired-sell proof
 * (privateExitExpiryCheck, with the sell's history witnesses, privateSellWitnesses), under the same gate; the settlement pass then clears
 * its pending exit proven_negative on its own proof, so the coins stay in the position and the exit is planned again.
 *
 * Final audit S1 (13 Nov 2026): a sell's expiry proof takes as its history witness the newest earlier completed trade of the wallet
 * (privateSellWitnesses, the buy rule; final audit N1: up to three of them, the entry buy last, in one call), not only the position's
 * entry buy, so an old position no longer needs an RPC history reaching back to its buy. A run that does not hold waits before the next
 * (meanwhile only the sell's own getTransaction runs) instead of 5 RPC reads every 5 s: final audit SF1, only `witness_unproven` (the
 * blockhash dead, the history not shown) backs off 30 s doubling to 10 min; every other result (blockhash not dead yet, RPC unavailable
 * or behind, the sell shown) is retried after PRIVATE_SELL_EXPIRY_RETRY_MS, so an RPC outage never delays a stop-loss past its recovery
 * by more than that. The waits are named: runner:failed_onchain_transaction_missing, runner:expired_not_landed_transaction_missing (before S1
 * unnamed) and runner:completed_transaction_missing. A negative wait that reaches PRIVATE_SELL_EXPIRY_BOUND (the blockhash proven dead at
 * three strictly increasing F over at least 10 minutes, the witness never shown) becomes runner:sell_expiry_unproven: still re-checked at
 * the capped back-off, and the wallet-balance settlement may then prove "not sold" only (checks 1-2 at a fresh F and the wallet still
 * holding the exit's units, private-position-balance.ts evidence `expired`); never "sold" or "not sold" on absence alone. A sell Balchemy
 * never received ends at the same bound with PRIVATE_SELL_EXPIRY_UNPROVEN_REASON (no claim that it did not land) and takes that hold.
 *
 * SF R10 (owner decision 27 of 11 Nov 2026): a buy Balchemy leaves unresolved (privateSubmissionStalledBuy: non-terminal, not
 * disputed, not facts_pending, no observed copy, no completed, negative or finalized-success engine state; e.g. signed or
 * submitted_unknown, a refused or unreachable status, engine:reconcile_blocked_insufficient_providers) frees its
 * wallet lock on the runner's own proof, so other coins' stop-loss sells run. The pass (`#closeStalls`, after the F2 release) uses
 * the F2 release mechanics: behind the exits capability and the `exit_build` gate, at most one attempt per agent per pass, the F2
 * back-off, the wire blockhash check, and, once the buy is PRIVATE_STALL_CHECK_AFTER_MS (2 min) old, (1) proof 1 (checks 1-2,
 * privateBlockhashExpired) starts a process-local clock; (2) at
 * least PRIVATE_STALL_RELEASE_GRACE_MS (30 min) later, proof 2 from fresh reads at an F not below proof 1's; (3) the buy proof
 * (privateBuyNegativeProof, R2) at or past that F returns not_landed (an outside dust credit first keeps the mint on the position
 * ledger's watermark, as in R4); (4) synchronously: the gate still admits and the attempt is exactly the proven snapshot;
 * (5) journal.closeLanding (write-once), then the wallet lock when this attempt owns it. `landed` and `unproven` write nothing;
 * `landed` (buy_landed) is permanent for the process (no later proof runs: a later absence after a finalized read is an
 * inconsistent RPC, never evidence), `unproven` backs off; the readback shows why. A sighting outlives R10's scope until the buy is
 * terminal or a runner dispute, and survives a restart (persisted on the journal attempt, recordSighting, write-once and monotonic): after any R2 read returned the buy (its `sighted` flag: a transaction body or
 * a status for it, whatever reason the result then carries), a not_landed from absence never releases (transaction_appeared, backed off); only
 * one from the returned transaction (landed and failed) does, and `landed` stays buy_landed. `#settleBuys` applies the same rule
 * (and records sightings from its own R2 results, before any stop or gate check): after any sighting its R4 never releases the spend on absence; there
 * such a result is the counted transaction_appeared (R6 bound, then runner:buy_negative_unproven:transaction_appeared). A buy
 * with a `landed` sighting that Balchemy later reports failed_onchain | expired_not_landed becomes the R5 dispute
 * runner:buy_landed_despite_<state> in `#settleBuys` without a new proof, so a later null RPC never releases it. Sightings are
 * rebuilt from the journal on a restart (#sightings), so none of these rules loses a written one; a probe whose sighting never
 * reached the journal (a kill or a failed commit after the reads) left its durable probe stamp, written before the reads, which
 * the restart reads as a `present` sighting (C1, #stamp). Nothing else changes: the reservation stays `reserved` (it still counts against the cap), the
 * state, relay and engine record stay, the buy is never marked terminal, and new buys stay refused three ways (the exit worker's
 * entryHold attempt_released_unsettled, the intents worker's wallet_held on a non-terminal attempt, and the spend ledger's open
 * reservation); the balance settlement keeps refusing the mint (released_same_mint). The released buy still follows server truth:
 * status is read without taking the wallet lock and never resends, a later failed_onchain | expired_not_landed runs R1-R4 under the
 * sighting rule, and a later completed first keeps the mint off the balance settlement for good (outside mints), then commits (the
 * readback notes that it contradicts the runner's proof). Once terminal (completed committed, or R4's proven negative with the spend
 * released) its outcome is settled by evidence: it no longer holds new buys (entryHold, a completed one of an outside mint included),
 * no longer refuses the balance settlement as released_same_mint, is not closable and may be evicted (S4's
 * #retain keeps a completed one until its mint is off the balance settlement). A restart resets the clock (it waits
 * longer, never less); every restart disarms, so the release helps only within one armed run, like F2.
 *
 * Final audit part 3 SF-A (the sell twin of R10): a sell Balchemy relayed and then leaves unresolved (privateSubmissionEngineUnresolvedSell:
 * its engine record stays prepared or submitted, for example because the engine's expiry proof cannot complete: one provider with short
 * history, fewer than two providers, or the copy-scan bounds of a busy wallet) used to hold its wallet lock for good, so every other
 * position's stop-loss of the agent was wallet_busy, under no named reason. #settleStalledSells (behind the exits capability, under the B1
 * gate, also while disarmed: it executes nothing) waits until the runner's own finalized view is past lastValidBlockHeight + 150 and then
 * PRIVATE_SELL_STALL_GRACE_MS (the engine's landing window), holding the position runner:sell_engine_unresolved meanwhile, and decides only
 * on its own RPC: the sell's own finalized transaction (landed or failed: terminal completed | failed_onchain with an s5c:engine_unresolved_
 * reason, relay closed, then the lock; the settlement pass settles the position from its own proof), the four-check expiry proof (terminal
 * expired_not_landed s5c:engine_unresolved_not_landed, relay closed, then the lock, then failExit proven_negative: the units return and the
 * exit is planned again; Balchemy may refuse that sell position_insufficient until it resolves the old one, every other position sells), or
 * the S1 bound (exactly as S1: s5c:expiry_unproven, then runner:sell_expiry_unproven). Nothing is relayed, resent or signed. A later report
 * from Balchemy on a sell the runner ended negative is still read (#watchLateSells, once a minute, recorded once): its own negative settles
 * nothing again; a landing (or a re-signed copy) contradicts the runner's proof and holds the position for the owner
 * (runner:completed_contradicted_by_expiry or runner:observed_copy; #holdLateLandings, or the settlement pass's completed rules while the
 * pending exit is still held), never a sale on Balchemy's word. SF-A review: the same holds for the S1 bound once its pending exit was
 * cleared (the balance path's "not sold", or a later proof) and for the runner's own failed_onchain read (s5c:engine_unresolved_failed,
 * watched too; held runner:sell_facts_transaction_failed). A recorded landing or copy whose hold is not applied yet
 * (privateSubmissionLateHoldOwed: for example a re-planned exit of the position was mid-build, or the ledger write failed) keeps the slow
 * timer armed, so an idle agent still applies it; it ends once the position closed, carries that sell, or the attempt was evicted.
 *
 * Owner close-out (owner decision 26 of 11 Nov 2026, "Sana 'kapat' komutu verelim"; F2 design doc section 8): `closeByOwner`, reached
 * only through the owner socket after the CLI's typed confirmation (`runner trades <agent> close <attempt>`; Hub cannot close), ends the
 * restart deadlock of a runner dispute (released or not; R5/R6 buys included) or a released attempt (F2, SF R10), and (owner decision 44
 * of 12 Nov 2026, "Evet, 30 dk sonra taze kanıtla") of a buy Balchemy left unresolved that R10 did not release (R10 needs an armed run,
 * and every restart disarms) once it is PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS (30 min) old; it always gets the fresh proof. Serialized with the
 * agent's reconcile pass. It needs neither live_armed nor the keystore (nothing is signed or sent), but refuses while the agent is
 * stopped (a halt) or its runtime is unreadable. Unless the attempt is already released (its landingClosed F is reused), it proves on
 * the owner's own RPC class and settlement RPC that the bytes can no longer land: the wire's recentBlockhash equals the stored one,
 * then checks 1-2 of the expiry proof twice from fresh reads, the second F not below the first. Then, synchronously, the gate again,
 * the attempt exactly as proven, and the writes in this order: a buy keeps its mint off automatic management for good (the position
 * ledger's outside mints, when a watermark exists) and commits its spend (it stays counted; a released or missing reservation refuses);
 * a sell's position keeps or takes its runner hold with the pending exit (sold only, so same-mint positions stay out of automatic sells
 * until the balance settlement proves the sale); then journal.closeByOwner (closed_by_owner, compare-and-set) and the wallet lock this
 * attempt owns. A crash between the writes is resumed by the next close-out (each write is idempotent). closed_by_owner is terminal,
 * so arming no longer counts it, but it proves nothing: never "not landed" and never "not sold" (runnerDisputed-equivalent for
 * outsideCopyPossible, engineConflict and the settlement pass). */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RunnerExecutionSubmitClient, runnerSignedTransactionSignature, type RunnerExecutionStatusResponse, type RunnerExecutionSubmission,
  type RunnerExecutionSubmitRequest, type RunnerExecutionSubmitResponse, type RunnerLocalSwapState } from "@balchemyai/agent-sdk";
import { RunnerKernelLock } from "./kernel-lock.js";
import { signRunnerExecutionStatusProof, signRunnerExecutionSubmitProof } from "./pairing-identity.js";
import type { PrivateExecutionBuildOutcome, PrivateExecutionHold } from "./private-execution-build.js";
import type { PrivateExitBuildOutcome } from "./private-exit-build.js";
import { privateBlockhashExpired, privateBuyNegativeProof, privateExitExpiryCheck, privateRunnerHoldRechecked, privateSellWitnesses, PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS,
  type PrivateBuyNegativeContext, type PrivateBuyNegativeProof, type PrivateBuyProofRpc, type PrivateExitExpiryCheck, type PrivateExitExpiryRpc,
  type PrivateRunnerHoldReason } from "./private-position-balance.js";
import { privateSellProceeds } from "./private-position-facts.js";
import { privateOwnerUnmanaged, privatePositionId, privateUnmanagedMints, type PrivatePosition, type PrivatePositionLedger, type PrivatePositionPendingExit } from "./private-positions.js";
import { PrivateSpendLedgerError, type PrivateSpendLedger } from "./private-spend-ledger.js";
import { PRIVATE_ASSESSMENT_INPUT_MINT } from "./private-signal-job.js";
import { consumeValidatedSolanaMessage, isValidatedSolanaMessage } from "./private-solana-validated-message.js";
import { decodeSolanaV0Message, signedSolanaWireTransaction } from "./private-solana-tx-codec.js";
import type { PrivateSolanaRpc } from "./private-solana-rpc.js";
import { privateRpcClassExecutable } from "./private-solana-rpc-settings.js";
import type { PrivateTradingKeystore } from "./private-trading-keystore.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import { isRecord, parseAgentState, RUNNER_BUY_CHECK_PERMANENT_COUNT, RUNNER_EXIT_SUMMARY_RELEASE_LIMIT, RUNNER_LANDING_RELEASE_REASONS, type RunnerAgentState, type RunnerBuyCheckReason,
  type RunnerLandingReleaseReason, type RunnerTradeCloseRefusal } from "./protocol.js";
import { privateExecutionGate, PRIVATE_EXECUTION_CAPABILITIES, type PrivateExecutionCapabilities, type PrivateExecutionGateInput, type PrivateExecutionGateRefusal, type PrivateExecutionLiveFacts } from "./private-execution-gate.js";
import { encodeBase58 } from "./solana-base58.js";
import { isPrivateSubmissionTerminal, privateSubmissionAttemptKey, privateSubmissionCopyHeld, privateSubmissionEngineReportedLanding,
  privateSubmissionEngineUnresolvedSell, privateSubmissionHoldsWallet, privateSubmissionLateContradicted, privateSubmissionLateHoldOwed,
  privateSubmissionLateWatched, privateSubmissionOwnerClosable,
  privateSubmissionOwnerClosed, privateSubmissionReleased, privateSubmissionStalledBuy, privateSubmissionStrongerSighting, privateSubmissionTransitionAllowed,
  privateSubmissionUnrelayed, privateSubmissionUnrelayedBuy, privateSubmissionView, PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON,
  PRIVATE_SELL_ENGINE_UNRESOLVED_LANDED_REASON, PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON, PRIVATE_SUBMISSION_LANDING_ENGINE_STATES,
  PrivateSubmissionJournalError, PRIVATE_SUBMISSION_MAX_RESENDS, PRIVATE_SUBMISSION_OBSERVED_COPY_REASON, PRIVATE_SUBMISSION_READBACK_LIMIT,
  PRIVATE_SUBMISSION_OWNER_CLOSED as PRIVATE_SUBMISSION_OWNER_CLOSED_STATE, PRIVATE_SUBMISSION_RESEND_SPACING_MS,
  type PrivateSubmissionAttempt, type PrivateSubmissionChange, type PrivateSubmissionJournal, type PrivateSubmissionReadback,
  type PrivateSubmissionRetain, type PrivateSubmissionSightingKind, type PrivateSubmissionState } from "./private-submission-journal.js";
import { addRunnerAgent } from "./agent-roster.js";

export type PrivateValidatedExecution = Extract<PrivateExecutionBuildOutcome, { outcome: "validated" }>;
/** S5c: one validated exit sell from private-exit-build.ts. */
export type PrivateValidatedExit = Extract<PrivateExitBuildOutcome, { outcome: "validated" }>;
export const PRIVATE_SUBMISSION_POLL_MS = 5_000;
/** Blocks past Balchemy's lastValidBlockHeight before the runner's finalized chain may prove an expiry. At signing the runner only
 * checks that value is at least its observed height + 20 (private-solana-validated-message.ts), while a blockhash stays valid for
 * up to 150 blocks: a server that understated it could otherwise free the units while the sell can still land. An OVERSTATED
 * value is refused at signing (F3: at most the observed height + PRIVATE_SOLANA_BLOCKHASH_LIFETIME_BLOCKS +
 * PRIVATE_SOLANA_MAX_BLOCK_HEIGHT_SLACK), so this proof always becomes reachable. (Defined with the shared proof in
 * private-position-balance.ts, which the wallet-balance settlement reuses.) */
export { PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS };
/** The agent's own settlement RPC. The balance reads are optional: without them a dropped buy's balance path is not run. */
export type PrivateSettlementRpc = PrivateBuyProofRpc;
export interface PrivateSubmissionOptions {
  directory: string; localProfileId: string; instanceId: string; agentIds: readonly string[];
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  /** The durable local runtime state (live_armed / entries), read at every gate check. */
  readRuntime(agentId: string): RunnerAgentState | undefined;
  /** Live owner facts for the `entry_sign` gate (rules head + shadowMode, RPC class); a throw refuses the signature. */
  readFacts(agentId: string): PrivateExecutionLiveFacts;
  ledger: Pick<PrivateSpendLedger, "reservation" | "status" | "release" | "commit">;
  journal: Pick<PrivateSubmissionJournal, "list" | "forReservation" | "admit" | "record" | "update" | "acknowledgeCopies" | "closeLanding" | "closeByOwner"
    | "recordSighting" | "recordProbe" | "clearProbe"> & Partial<Pick<PrivateSubmissionJournal, "recordLateReport">>;
  /** Only `submit` signs. Recovery never needs (or gets) a signer: it relays stored bytes or nothing. */
  keystore?: Pick<PrivateTradingKeystore, "sign">;
  /** The agent's own RPC, used only for the block height that bounds identical resends. */
  readRpc(agentId: string): Pick<PrivateSolanaRpc, "getBlockHeight"> | undefined;
  fetchFn?: typeof fetch; now?(): number; pollMs?: number;
  /** M3.6 slice 7 (F-M36-D7-B class): the monotonic clock (default performance.now()) of every process-local wait: the F2 and R10
   * release back-offs and the R10 grace, the SF2 buy-check back-off and its permanence span, the S1/B1/SF-A sell expiry back-offs,
   * waits, span and the SF-A grace, and the SF-A late-report watch. A wall-clock step in either direction neither lengthens nor
   * shortens one. `now` (the wall clock) stays the clock of everything persisted or compared with a persisted time: journal,
   * ledger and position writes, createdAt (the R10 check age, owner close-out) and lastSubmitAt (the resend spacing). */
  monotonicNow?(): number;
  /** Test-only seam (see private-execution-gate.ts); production never sets it. */
  capabilities?: PrivateExecutionCapabilities;
  /** S5c: the owner-local position ledger. Exit attempts settle positions through it; without it every exit is refused and
   * no exit settles (buys are unaffected). */
  positions?: Pick<PrivatePositionLedger, "positions" | "position" | "completeExit" | "failExit" | "evicted" | "managedFrom" | "addOutsideMint">
    & Partial<Pick<PrivatePositionLedger, "holdLateExit">>;
  /** S5c: the agent's own RPC, used only for the finalized transaction of a terminal exit's journaled signature and, for an
   * expired exit that never appeared, the runner-side expiry proof (`#proveSellExpiry`). SF2: also the proof of a buy Balchemy
   * reports failed or expired (`#settleBuys`); without it such a buy stays held. Owner decision of 17 Nov 2026: with two
   * Balchemy-provided sources `readClass` picks the policy of the plain reads (private-solana-rpc-sources.ts): `exit` for a sell's own
   * finalized transaction (one source may prove it LANDED without error; anything else needs both), `entry` (the default) both
   * always. Negative proofs run whole on each source whatever the class. */
  readSettlementRpc?(agentId: string, readClass?: "entry" | "exit"): PrivateSettlementRpc | undefined;
  /** Owner decision 26: the agent's own RPC for the close-out proof (checks 1-2 of the expiry proof only), wired with or without the
   * exits capability; without it the settlement RPC is used, and without both a close-out that needs a proof refuses rpc_missing. */
  readCloseRpc?(agentId: string): PrivateExitExpiryRpc | undefined;
}
/** S5c exit submission. `cleared`: proven before any signature, the pending exit was failed as proven_negative. `retained`:
 * a signature may exist, or clearing failed (fail closed; restart recovery clears a never-journaled one). `untouched`:
 * refused before any read. */
export type PrivateExitSubmissionOutcome =
  | { readonly outcome: "refused"; readonly reason: string; readonly exit: "cleared" | "retained" | "untouched" }
  | { readonly outcome: "journaled"; readonly attemptKey: string; readonly state: PrivateSubmissionState; readonly reason: string | null }
  /** Signed, but the journal write failed: nothing was sent; the pending exit and the wallet lock stay held. */
  | { readonly outcome: "unknown"; readonly reservationId: string; readonly reason: "journal_unavailable" };
export type PrivateSubmissionOutcome =
  /** `released`: proven before any signature. `retained`: a signature may exist or releasing failed (fail closed). */
  | { readonly outcome: "refused"; readonly reason: string; readonly reservation: "released" | "retained" }
  | { readonly outcome: "journaled"; readonly attemptKey: string; readonly state: PrivateSubmissionState; readonly reason: string | null }
  /** Signed, but the journal write failed: nothing was sent; reservation and wallet lock stay held. */
  | { readonly outcome: "unknown"; readonly reservationId: string; readonly reason: "journal_unavailable" };

/** Engine state -> journal state. awaiting_signature means the engine does not hold the bytes yet. build_revoked (S5, a sell
 * build revoked by the engine position re-check before it was returned) has no journaled signature, so #apply disputes it
 * before this map is consulted (runner:signature_mismatch, fail closed); its entry exists only to keep the map exhaustive. */
const JOURNAL_STATE: Readonly<Record<RunnerLocalSwapState, PrivateSubmissionState>> = Object.freeze({ awaiting_signature: "signed",
  prepared: "submitted_unknown", submitted_known: "submitted_known", submitted_unknown: "submitted_unknown",
  finalized_facts_pending: "facts_pending", finalized_facts_disputed: "disputed", completed: "completed", failed_onchain: "failed_onchain",
  expired_not_landed: "expired_not_landed", build_revoked: "signed" });
const ENGINE_HOLDS: readonly RunnerLocalSwapState[] = ["prepared", "submitted_known", "submitted_unknown"];
/** Relay refusals no identical resend can change; status keeps running. */
const RELAY_FINAL = ["trading_wallet_unbound", "trading_wallet_is_identity_wallet", "reservation_not_found", "reservation_build_expired",
  "reservation_released", "reservation_committed", "build_digest_mismatch", "wallet_binding_mismatch", "signed_transaction_invalid",
  "invalid_local_submit_request", "local_swap_not_found", "local_submit_binding_mismatch", "local_submit_blockhash_expired",
  "local_submit_attempt_conflict", "local_submit_conflict"];
/** local_submit_build_unavailable:<r> (S5: sell_signing_window_elapsed | build_revoked) is final too: the stored build can never be journaled. */
const RELAY_FINAL_PREFIX = /^(?:local_submit_signature_invalid|local_submit_resend_refused|local_submit_build_unavailable):/;
const BLOCKED_REASON = "engine:reconcile_blocked_insufficient_providers";
/** F2 release: per-attempt back-off after a proof that did not hold (30 s doubling to 10 min). */
export const PRIVATE_LANDING_RELEASE_BACKOFF_BASE_MS = 30_000;
export const PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS = 600_000;
/** SF2: journal reason of a buy Balchemy reports failed or expired that the runner has not proven yet (R1). */
export const PRIVATE_BUY_NEGATIVE_UNCONFIRMED_REASON = "s4:negative_unconfirmed";
/** SF2: journal reason of the terminal write after the runner proved a buy did not land (R4). */
export const PRIVATE_BUY_NOT_LANDED_REASON = "s4:not_landed_proven";
/** M3.6 slice 7 (B1): journal reason of the terminal write after the runner proved that a sell Balchemy never received did not land. */
export const PRIVATE_SELL_NOT_LANDED_REASON = "s5c:not_landed_proven";
/** Final audit S1: journal reason of the terminal write that ends a sell Balchemy never received once its expiry bound is reached (its
 * blockhash proven dead at strictly increasing F over PRIVATE_BUY_CHECK_PERMANENT_SPAN_MS, the history witness never proven). It claims
 * only "cannot land after F", never "did not land": the settlement pass then holds runner:sell_expiry_unproven at once. */
export const PRIVATE_SELL_EXPIRY_UNPROVEN_REASON = "s5c:expiry_unproven";
/** SF2: the first and the last counted result of a permanent unproven buy negative are at least this far apart (R2). */
export const PRIVATE_BUY_CHECK_PERMANENT_SPAN_MS = 600_000;
/** SF2: the slow watch of a held buy negative whose proof cannot run (stopped, or not the owner's own RPC; #schedule). */
export const PRIVATE_BUY_WATCH_MS = 600_000;
/** SF R10: the wait between the first expiry proof of a buy Balchemy leaves unresolved and the proof that may release its wallet. */
export const PRIVATE_STALL_RELEASE_GRACE_MS = 30 * 60_000;
/** SF R10: an unresolved buy is checked only once it is this old (a blockhash lives about 150 blocks, and the proof needs 150 more), so
 * a buy Balchemy resolves normally never shows a release check. */
export const PRIVATE_STALL_CHECK_AFTER_MS = 2 * 60_000;
/** Owner decision 26: the spend ledger reason of a buy's reservation committed by the owner's close-out (the spend stays counted). */
export const PRIVATE_OWNER_CLOSE_SPEND_REASON = "owner:closed_by_owner";
/** Owner decision 26: a close-out waits at most this many 50 ms steps for this agent's running reconcile pass, then refuses busy. */
export const PRIVATE_OWNER_CLOSE_BUSY_STEPS = 200;
/** Owner decision 26: the outcome of one owner close-out. `closed` carries the finalized slot F after which the bytes cannot land. */
export type PrivateSubmissionCloseOut = { readonly attemptKey: string; readonly outcome: "closed"; readonly finalizedSlot: string }
  | { readonly attemptKey: string; readonly outcome: "refused"; readonly reason: RunnerTradeCloseRefusal };
/** F2 release refusals no later pass can clear without a re-arm, which arming refuses while the dispute is open: S4 stops polling. */
const RELEASE_STALLED: readonly PrivateExecutionGateRefusal[] = ["runtime_stopped", "runtime_not_armed", "exits_unavailable"];
type WalletLock = { assertValid(): void; close(): void };
/** An in-process wallet lock and the attempt that owns it: only that attempt's terminal write or release closes it. */
type OwnedWalletLock = { attemptKey: string; lock: WalletLock };

function reasonText(prefix: string, code: string): string { return `${prefix}:${code}`.replace(/[^a-z0-9_:]/g, "_").slice(0, 96); }
function identity(lease: Readonly<RunnerRuntimeActiveLease>): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest, lease.runnerPublicKey, lease.instanceId, lease.epoch]);
}
function strictBase64(value: string): Buffer | undefined {
  const bytes = Buffer.from(value, "base64"); return value.length > 0 && bytes.toString("base64") === value ? bytes : undefined;
}
const unfinished = (attempt: PrivateSubmissionAttempt): boolean => !isPrivateSubmissionTerminal(attempt.state);
/** A position held for the owner on a runner-observed contradiction; no later pass settles it automatically. */
const runnerHeld = (position: PrivatePosition): boolean => position.state === "held" && (position.holdReason ?? "").startsWith("runner:");
/** SF8: a pending exit the settlement pass still works on: not held for the owner, or held with a hold it re-checks itself
 * (PRIVATE_RUNNER_RECHECKED_HOLDS: the runner's own proof of a terminal state Balchemy reported is still outstanding). */
/** SF-A review: the owner hold a contradicted runner-negative sell owes (#holdLateLandings), from the existing hold table only:
 * - an observed re-signed copy: runner:observed_copy (as #settleExit names it);
 * - the runner's own failed_onchain read (s5c:engine_unresolved_failed) contradicted by Balchemy's landing: runner:sell_facts_transaction_failed.
 *   Its row (evidence `present`, outcomes ["sold"]) is exactly this case: Balchemy says landed, the runner READ the sell present at finalized
 *   with an error, so its single RPC can never reopen the position, a later absent read is an inconsistent RPC (evidence_conflict), and only a
 *   later read showing it landed (with the balance agreeing) is a sale. #settleExit gives this very name when Balchemy's landing arrives while
 *   the pending exit is still attached (privateSellProceeds: transaction_failed). runner:completed_contradicted_by_expiry (evidence `absent`)
 *   would claim an expiry proof and an absent read the runner never made;
 * - otherwise (the not-landed proof, or the S1 bound after its exit was cleared): runner:completed_contradicted_by_expiry. */
function lateHoldReason(attempt: PrivateSubmissionAttempt): PrivateRunnerHoldReason {
  if (attempt.observedSignature !== null) return "runner:observed_copy";
  if (attempt.state === "failed_onchain" && attempt.reason === PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON) return "runner:sell_facts_transaction_failed";
  return "runner:completed_contradicted_by_expiry";
}
const settling = (position: PrivatePosition): boolean => position.pendingExit !== null && position.state !== "closed"
  && (!runnerHeld(position) || privateRunnerHoldRechecked(position.holdReason));
const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** A runner-observed contradiction is held for the owner; no later server state settles it automatically. */
const runnerDisputed = (attempt: PrivateSubmissionAttempt): boolean => attempt.state === "disputed" && (attempt.reason ?? "").startsWith("runner:");
/** F2: a runner dispute the release proof may still close (relay closed, not released yet). */
const releasable = (attempt: PrivateSubmissionAttempt): boolean => runnerDisputed(attempt) && attempt.relay === "closed" && attempt.landingClosed === null;
/** SF R10: a buy Balchemy leaves unresolved whose wallet lock the release proof may still free (not released yet). M3.6 D6 K1: never a buy
 * Balchemy never received (privateSubmissionUnrelayedBuy): the buy settlement pass proves and settles it in full instead. */
const stallReleasable = (attempt: PrivateSubmissionAttempt): boolean => privateSubmissionStalledBuy(attempt) && !privateSubmissionReleased(attempt)
  && !privateSubmissionUnrelayedBuy(attempt);
const negativeState = (state: RunnerLocalSwapState | null): state is "failed_onchain" | "expired_not_landed" =>
  state === "failed_onchain" || state === "expired_not_landed";
/** SF2: a buy Balchemy reports failed or expired that the runner has not proven yet (R1): non-terminal, no runner dispute, no
 * observed copy, relay closed. */
export const privateBuyNegativeUnconfirmed = (attempt: PrivateSubmissionAttempt): boolean => attempt.swap.direction === "buy"
  && !isPrivateSubmissionTerminal(attempt.state) && !runnerDisputed(attempt) && attempt.observedSignature === null && attempt.relay === "closed"
  && negativeState(attempt.engineState);
/** Final audit S3: a completed buy (no observed copy) whose position is not open yet and may still open: managed (not bought before
 * automatic exits were enabled, not taken off automatic management by the owner (owner item 75), not an SF R10 released buy Balchemy later completed whose mint is now an outside mint), not evicted after
 * selling out, and no position recorded under its id. Before the enable watermark is recorded every completed buy counts (it may still
 * be needed for the watermark). Its journal attempt (S4 #retain) and its execution intent (the intent store's `retain`, daemon) are
 * kept from eviction while this holds: the attempt is the only key to the finalized credit the position opens from, the intent the
 * only provenance of its plan. The exit worker's entry hold keeps new buys held meanwhile (position_unopened, or buy_unprotected once
 * the opening was refused permanently). Read-only; a throw is the caller's (both callers retain on a throw). */
export function privateBuyAwaitingPosition(attempt: PrivateSubmissionAttempt, positions: Pick<PrivatePositionLedger, "position" | "evicted" | "managedFrom">,
  localProfileId: string, agentId: string): boolean {
  if (attempt.swap.direction !== "buy" || attempt.state !== "completed" || attempt.observedSignature !== null) return false;
  const managed = positions.managedFrom(agentId);
  if (!managed) return true;
  if (managed.preEnable.includes(attempt.reservationId)) return false;
  // Owner item 75: a buy the owner took off automatic management never opens, so it is no longer retained for its position (S3).
  if (privateOwnerUnmanaged(managed, attempt.reservationId)) return false;
  if (privateSubmissionReleased(attempt) && (managed.outsideMints ?? []).includes(attempt.swap.outputMint)) return false;
  if (positions.evicted(agentId).includes(attempt.reservationId)) return false;
  return positions.position(agentId, privatePositionId(localProfileId, agentId, attempt.buildDigest)) === undefined;
}
/** The recentBlockhash of the journaled wire (one signature + a v0 message), or undefined when it does not decode. */
function wireBlockhash(wireB64: string): string | undefined {
  try {
    const wire = Buffer.from(wireB64, "base64");
    if (wire.length < 66 || wire[0] !== 1) return undefined;
    return encodeBase58(decodeSolanaV0Message(wire.subarray(65)).recentBlockhash);
  } catch { return undefined; }
}
/** Process-local F2 release status per attempt: failures and the next allowed try, or a permanent reason (never retried). */
export type PrivateLandingRelease = { failures: number; untilMs: number; reason: RunnerLandingReleaseReason; permanent: boolean };
/** SF2: process-local proof status of one held buy negative: the last result and its back-off, and the running count of counted
 * results (reason, balance, last F and the time of the first one). */
export type PrivateBuyCheck = { failures: number; untilMs: number; reason: RunnerBuyCheckReason; counted: number; countedReason: RunnerBuyCheckReason | null;
  balance: string | null; lastSlot: string | null; firstAt: number };
/** Final audit S1: process-local status of one sell's expiry proof (a terminal sell absent at finalized, #settleExit, or a sell Balchemy
 * never received, #settleUnrelayedSells): the F2 back-off fields, plus the count toward the bound (PRIVATE_SELL_EXPIRY_BOUND): results with
 * the blockhash proven dead and the history witness unproven, at strictly increasing F (`lastSlot`), the first at `firstAt`. */
export type PrivateSellExpiryCheck = PrivateLandingRelease & { counted: number; lastSlot: string | null; firstAt: number };
/** Final audit S1: the bound of a sell's expiry proof, the R6 rule of buys (RUNNER_BUY_CHECK_PERMANENT_COUNT counted results at strictly
 * increasing F, the first and the last at least PRIVATE_BUY_CHECK_PERMANENT_SPAN_MS apart). */
export const PRIVATE_SELL_EXPIRY_BOUND = Object.freeze({ count: RUNNER_BUY_CHECK_PERMANENT_COUNT, spanMs: PRIVATE_BUY_CHECK_PERMANENT_SPAN_MS });
/** Final audit SF1: the wait after a sell expiry proof that did not hold for any reason but `witness_unproven` (the blockhash not dead
 * yet, the RPC unavailable or behind, the sell shown): fixed, never doubled, so the next proof follows an RPC's recovery within it. Its
 * cost is at most the four proof reads per sell per 15 s while the RPC is down or the blockhash still valid. */
export const PRIVATE_SELL_EXPIRY_RETRY_MS = 15_000;
/** Final audit part 3 SF-A: the wait between the runner's first proof that a sell Balchemy leaves unresolved can no longer land (checks 1-2
 * past lastValidBlockHeight + PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS on its own finalized view) and its own proof of the outcome. The engine's
 * landing window (balchemy-trading-engine local_swap_repository.rs RECONCILE_LANDING_WINDOW_MS, 7 min after the build: every observation
 * inside it is re-checked every sweep, never backed off). The clock starts after the build (the blockhash dies about 150 blocks after it,
 * and the proof needs 150 more), so the engine's whole normal window has passed before the runner decides anything. */
export const PRIVATE_SELL_STALL_GRACE_MS = 7 * 60_000;
/** SF-A: how often Balchemy's report on a sell the runner ended while Balchemy left it unresolved is read again (one status read). */
export const PRIVATE_SELL_LATE_WATCH_MS = 60_000;
/** SF-A: the position hold named while the runner proves such a sell (a re-checked hold, private-position-balance.ts). */
export const PRIVATE_SELL_ENGINE_UNRESOLVED_HOLD = "runner:sell_engine_unresolved";
export { PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON, PRIVATE_SELL_ENGINE_UNRESOLVED_LANDED_REASON, PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON };
/** SF-A: process-local proof status of one sell Balchemy leaves unresolved: the S1 fields, plus when the grace clock started (null until
 * checks 1-2 first held). */
export type PrivateStalledSellCheck = PrivateSellExpiryCheck & { graceFrom: number | null };
/** SF R10: process-local release status of one buy Balchemy leaves unresolved: the F2 fields, plus when proof 1 held and its F (null
 * until it held). */
export type PrivateStallRelease = PrivateLandingRelease & { firstAt: number | null; firstSlot: string | null };
/** SF R10: what the runner's own RPC has shown of one buy (`landed` supersedes `present`); persisted on the journal attempt. */
type PrivateBuySighting = PrivateSubmissionSightingKind;
/** Key-order-independent JSON of an attempt without its sighting, probe stamp and updatedAt: what a sighting or stamp write may change. */
function unsighted(attempt: PrivateSubmissionAttempt): string {
  const canon = (value: unknown): unknown => Array.isArray(value) ? value.map(canon)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])])) : value;
  const { sighting: _sighting, probePending: _stamp, updatedAt: _updatedAt, ...rest } = attempt;
  return JSON.stringify(canon(rest));
}

export class PrivateSubmissions {
  readonly #options: PrivateSubmissionOptions;
  readonly #agentIds: string[];
  readonly #locks = new Map<string, OwnedWalletLock>();
  /** Build holds already owned as an attempt's wallet lock; a repeated presentation never releases them. */
  readonly #adopted = new WeakSet<object>();
  readonly #busy = new Set<string>();
  /** Attempts with a relay call in flight; a concurrent pass leaves them alone. */
  readonly #inflight = new Set<string>();
  /** F2: release attempts per agent, then per attemptKey (process-local, bounded by each agent's journal). Keyed by agent so one
   * agent's pass prunes only its own entries and never resets another agent's back-off. */
  readonly #landing = new Map<string, Map<string, PrivateLandingRelease>>();
  /** SF2: buy-negative proof status per agent, then per attemptKey (process-local, bounded by each agent's journal). */
  readonly #buys = new Map<string, Map<string, PrivateBuyCheck>>();
  /** SF R10: release status per agent, then per attemptKey, of buys Balchemy leaves unresolved (process-local, bounded by the journal). */
  readonly #stalls = new Map<string, Map<string, PrivateStallRelease>>();
  /** SF R10 and SF2 sightings per agent, then per attemptKey (process-local, bounded by the journal): what the runner's own RPC
   * returned for a buy. `present`: some R2 read returned the transaction or a status for it (the proof's `sighted` flag, whatever
   * reason the result carries: a status below F, a malformed body before expiry, a stop or an outage right after the read), in
   * #closeStalls or #settleBuys; `landed`: an R2 finalized getTransaction without error (in #settleBuys also the R5 dispute). Kept when the buy leaves R10's scope (a later negative engine state), and dropped only once
   * the buy is terminal, a runner dispute or gone. One rule in both passes: after any sighting, a not_landed from absence (one with
   * its own F) never releases anything (transaction_appeared, backed off; counted toward R6 in #settleBuys), because a later
   * absence on a load-balanced or pruned RPC is never evidence against a sighting; a `landed` sighting makes a later Balchemy negative the R5 dispute without a new proof.
   * Persisted (fund-safety follow-up, 12 Nov 2026): each sighting is also written to its journal attempt (recordSighting, write-once
   * and monotonic) at the moment it is recorded here, before any stop or gate check; recoverOnStart rebuilds this map from the
   * journal, and every rule reads the stronger of this map and the attempt's own `sighting` (#sighting), so a restart never loses
   * a written one. A failed write keeps it here and fails the pass closed (journal_unavailable). Only a failure that leaves the
   * journal open is written again by the next pass (#pruneSightings). A failed commit (ENOSPC, EIO, a replaced file) holds the
   * agent's journal for the rest of the process: every later list or change is state_unavailable, so this process decides nothing
   * on that buy, but the sighting is never written. Probe stamp (C1, closes the former residual risk): before the proof's reads
   * each probe writes a durable stamp (#stamp, journal.recordProbe; no stamp, no proof in that pass), removed only once the probe's
   * outcome is persisted (the sighting write itself, or #unstamp when it sighted nothing and this process holds no sighting). The
   * restart that clears a hold (or follows a kill) finds the stamp and reads it as a `present` sighting (#sighting, #rebuildSightings),
   * so it never releases on absence, and its absence-based results count toward R6. Pinned by the test "a real sighting commit failure". */
  readonly #sightings = new Map<string, Map<string, PrivateBuySighting>>();
  /** M3.6 slice 7 (B1): proof status per agent, then per attemptKey, of sells Balchemy never received (process-local, bounded by the
   * journal): the named hold `runner trades` shows until the proof holds. */
  readonly #sells = new Map<string, Map<string, PrivateSellExpiryCheck>>();
  /** Final audit S1: expiry-proof status per agent, then per attemptKey, of terminal sells absent at finalized (#settleExit; process-local,
   * pruned with the settling positions): the back-off that replaces the former 5-second re-proof, and the count toward the bound. */
  readonly #expiries = new Map<string, Map<string, PrivateSellExpiryCheck>>();
  /** SF-A: proof status per agent, then per attemptKey, of sells Balchemy relayed and leaves unresolved (process-local, bounded by the
   * journal): the grace clock, the S1 back-off and the count toward the bound; `runner trades` shows the reason. */
  readonly #stalledSells = new Map<string, Map<string, PrivateStalledSellCheck>>();
  /** SF-A: when Balchemy's report on each watched sell (privateSubmissionLateWatched) is read next, per agent (process-local). */
  readonly #late = new Map<string, Map<string, number>>();
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  /** SF2: the armed #timer is the slow watch (PRIVATE_BUY_WATCH_MS), not the poll; #schedule replaces it once work is pending. */
  #timerSlow = false;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(options: PrivateSubmissionOptions) { this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds }; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  /** The clock of every process-local wait (PrivateSubmissionOptions.monotonicNow); never persisted, never compared with a stored time. */
  #monotonic(): number { return (this.#options.monotonicNow ?? (() => performance.now()))(); }
  #exits(): boolean {
    const capabilities = this.#options.capabilities ?? PRIVATE_EXECUTION_CAPABILITIES;
    return typeof capabilities === "object" && capabilities !== null && capabilities.exits === true;
  }
  /** A buy the settlement pass (#settleBuys) proves: a held buy negative (SF2), or, behind the exits capability like SF R10, a buy Balchemy
   * never received (M3.6 D6 K1, privateSubmissionUnrelayedBuy). */
  #proofPending(attempt: PrivateSubmissionAttempt): boolean {
    return privateBuyNegativeUnconfirmed(attempt) || (this.#exits() && privateSubmissionUnrelayedBuy(attempt));
  }
  #gate(input: PrivateExecutionGateInput): PrivateExecutionGateRefusal | null {
    let state: RunnerAgentState | undefined;
    try { state = this.#options.readRuntime(input.agentId); } catch { return "runtime_unavailable"; }
    return privateExecutionGate(state, input, this.#options.capabilities);
  }

  /** Steps (b)-(f) for one validated build. The token is spent here whatever the outcome. */
  /** `expiry` (the execution worker's stale-intent cutoff) is re-checked synchronously right before the signature. */
  async submit(agentId: string, built: PrivateValidatedExecution, signal?: AbortSignal, expiry?: () => string | null): Promise<PrivateSubmissionOutcome> {
    const o = this.#options; const now = this.#now(); const wallet = built.hold.walletAddress;
    const spend = (): void => { consumeValidatedSolanaMessage(built.message, { agentId, signerAddress: wallet }, now)?.fill(0); };
    const retained = (reason: string): PrivateSubmissionOutcome => Object.freeze({ outcome: "refused" as const, reason, reservation: "retained" as const });
    // A build already presented once (its hold now guards a signature) is never re-signed or released here.
    if (this.#adopted.has(built.hold)) { spend(); return retained("attempt_exists"); }
    // An attempt already journaled for this reservation is never re-signed, and its reservation is never released here.
    // The fresh hold is adopted for an unfinished attempt that has no process lock yet; otherwise dropped (the ledger still blocks).
    let existing: PrivateSubmissionAttempt | undefined;
    try { existing = o.journal.forReservation(agentId, built.reservationId); } catch { spend(); built.hold.release(); return retained("state_unavailable"); }
    if (existing) {
      spend();
      if (privateSubmissionHoldsWallet(existing) && existing.walletAddress === wallet && !this.#locks.has(wallet)) {
        this.#locks.set(wallet, { attemptKey: existing.attemptKey, lock: this.#holdLock(built) });
      }
      else built.hold.release();
      return retained("attempt_exists");
    }
    // Until the keystore returns a signature, every refusal is a proven non-spend: release the reservation and the lock.
    const release = (reason: string): PrivateSubmissionOutcome => {
      spend();
      let reservation: "released" | "retained" = "retained";
      try { o.ledger.release(agentId, built.reservationId, reasonText("submit", reason), now); reservation = "released"; } catch { /* Held. */ }
      built.hold.release();
      return Object.freeze({ outcome: "refused" as const, reason, reservation });
    };
    if (this.#closed || signal?.aborted) return release("closing");
    if (!o.keystore) return release("signer_unavailable");
    try { built.hold.assertHeld(); } catch { return release("wallet_lock_lost"); }
    let reserved: ReturnType<PrivateSubmissionOptions["ledger"]["reservation"]>;
    try { reserved = o.ledger.reservation(agentId, built.reservationId); } catch { return release("state_unavailable"); }
    if (!reserved || reserved.state !== "reserved" || reserved.walletAddress !== wallet || built.swap.wallet !== wallet) return release("reservation_unavailable");
    if (!(now < built.expiresAtMs) || !isValidatedSolanaMessage(built.message)) return release("token_expired");
    const lease = o.readLease(agentId);
    if (!lease || lease.instanceId !== o.instanceId || !(lease.remainingMs > 0)) return release("lease_unavailable");
    // Disarm, stop, an entries pause or a re-arm since the build: never signed. Synchronous from here to the signature.
    let facts: PrivateExecutionLiveFacts | undefined;
    try { facts = o.readFacts(agentId); } catch { facts = undefined; }
    const notArmed = this.#gate({ step: "entry_sign", agentId, runtimeVersion: built.runtimeVersion, ruleRevisionId: built.ruleRevisionId, facts });
    if (notArmed) return release(notArmed);
    let expired: string | null;
    try { expired = expiry ? expiry() : null; } catch { expired = "expired_intent:unavailable"; }
    if (expired) return release(expired);
    const message = strictBase64(built.build.unsignedMessageB64);
    const digest = built.build.messageSha256;
    if (!message || createHash("sha256").update(message).digest("hex") !== digest || built.message.messageSha256 !== digest
      || built.swap.messageSha256 !== digest) return release("message_mismatch");
    const gross = BigInt(reserved.amountLamports);
    if (gross !== BigInt(built.swap.inAmount) + BigInt(built.swap.feeAmount)) return release("amount_mismatch");
    let attemptKey: string;
    try {
      attemptKey = privateSubmissionAttemptKey({ localProfileId: o.localProfileId, agentId, reservationId: built.reservationId,
        buildDigest: built.build.buildDigest, messageSha256: digest });
      o.journal.admit(agentId, built.reservationId, wallet, this.#retain(agentId));
    } catch (error: unknown) {
      return release(error instanceof PrivateSubmissionJournalError && ["journal_full", "wallet_busy", "attempt_conflict", "copy_unacknowledged"].includes(error.code)
        ? error.code : "state_unavailable");
    }

    // (c) The only signature. From here the reservation and the wallet lock are released only by a terminal server state.
    let signature: Buffer;
    try { signature = o.keystore.sign(agentId, built.message); } catch { return release("signer_refused"); }
    this.#locks.set(wallet, { attemptKey, lock: this.#holdLock(built) });
    let wireB64: string; let signatureText: string;
    try {
      wireB64 = signedSolanaWireTransaction(message, signature).toString("base64"); signatureText = encodeBase58(signature);
    } catch { return retained("wire_unavailable"); }
    finally { signature.fill(0); }
    if (runnerSignedTransactionSignature(wireB64) !== signatureText) return retained("wire_unavailable");
    // (d) Durable before any network call.
    let attempt: PrivateSubmissionAttempt;
    try {
      attempt = o.journal.record(agentId, { attemptKey, reservationId: built.reservationId, buildDigest: built.build.buildDigest,
        walletBindingId: built.build.walletBindingId, walletAddress: wallet, messageSha256: digest, signature: signatureText, wireB64,
        blockhash: built.swap.blockhash, lastValidBlockHeight: built.build.lastValidBlockHeight,
        swap: { direction: "buy", inputMint: PRIVATE_ASSESSMENT_INPUT_MINT, outputMint: built.swap.outputMint,
          grossInLamports: gross.toString(), feeLamports: built.swap.feeAmount, netInLamports: built.swap.inAmount, quotedOut: built.swap.quotedOut,
          minOut: built.swap.minOut, priorityFeeLamports: built.swap.priorityFeeLamports } }, now, this.#retain(agentId));
    } catch { return Object.freeze({ outcome: "unknown" as const, reservationId: built.reservationId, reason: "journal_unavailable" as const }); }
    this.#schedule();
    // (e)/(f) Relay only while live_armed (entries pause does not matter); otherwise the signed bytes stay journaled.
    const relayHeld = this.#gate({ step: "relay", agentId });
    if (relayHeld) {
      const kept = this.#change(agentId, attempt, { reason: reasonText("gate", relayHeld) });
      return Object.freeze({ outcome: "journaled" as const, attemptKey, state: kept.state, reason: kept.reason });
    }
    const settled = await this.#relay(agentId, attempt, lease, false, signal);
    return Object.freeze({ outcome: "journaled" as const, attemptKey, state: settled.state, reason: settled.reason });
  }

  /** S5c steps (b)-(f) for one validated exit sell. The token is spent here whatever the outcome. No spend-ledger reservation:
   * the position's pending exit is the reservation and must still be exactly the one the build was made for. */
  async submitExit(agentId: string, built: PrivateValidatedExit, signal?: AbortSignal): Promise<PrivateExitSubmissionOutcome> {
    const o = this.#options; const now = this.#now(); const wallet = built.hold.walletAddress;
    const spend = (): void => { consumeValidatedSolanaMessage(built.message, { agentId, signerAddress: wallet }, now)?.fill(0); };
    const refused = (reason: string, exit: "cleared" | "retained" | "untouched"): PrivateExitSubmissionOutcome =>
      Object.freeze({ outcome: "refused" as const, reason, exit });
    // A build already presented once (its hold now guards a signature) is never re-signed or released here.
    if (this.#adopted.has(built.hold)) { spend(); return refused("attempt_exists", "retained"); }
    // Without the exits capability (the exits-off rollback build) every exit is refused before any read.
    const capabilities = o.capabilities ?? PRIVATE_EXECUTION_CAPABILITIES;
    if (typeof capabilities !== "object" || capabilities === null || capabilities.exits !== true) {
      spend(); built.hold.release(); return refused("exits_unavailable", "untouched");
    }
    const positions = o.positions;
    if (!positions) { spend(); built.hold.release(); return refused("positions_unavailable", "retained"); }
    // An attempt already journaled for this reservation is never re-signed, and its pending exit is never cleared here.
    let existing: PrivateSubmissionAttempt | undefined;
    try { existing = o.journal.forReservation(agentId, built.reservationId); } catch { spend(); built.hold.release(); return refused("state_unavailable", "retained"); }
    if (existing) {
      spend();
      if (privateSubmissionHoldsWallet(existing) && existing.walletAddress === wallet && !this.#locks.has(wallet)) {
        this.#locks.set(wallet, { attemptKey: existing.attemptKey, lock: this.#holdLock(built) });
      }
      else built.hold.release();
      return refused("attempt_exists", "retained");
    }
    // Until the keystore returns a signature, every refusal is a proven non-execution: clear the pending exit (only while the
    // position still carries exactly this one; failExit refuses any other) and release the lock.
    const release = (reason: string): PrivateExitSubmissionOutcome => {
      spend();
      let exit: "cleared" | "retained" = "retained";
      try { positions.failExit(agentId, built.positionId, built.reservationId, "proven_negative", reasonText("s5c:submit", reason), now); exit = "cleared"; }
      catch { /* Held: another pending exit, or the ledger is unavailable. */ }
      built.hold.release();
      return refused(reason, exit);
    };
    if (this.#closed || signal?.aborted) return release("closing");
    if (!o.keystore) return release("signer_unavailable");
    try { built.hold.assertHeld(); } catch { return release("wallet_lock_lost"); }
    let position: PrivatePosition | undefined;
    try { position = positions.position(agentId, built.positionId); } catch { return release("state_unavailable"); }
    const pending: PrivatePositionPendingExit | null | undefined = position?.pendingExit;
    if (!position || position.state !== "open" || !pending || pending.reservationId !== built.reservationId || pending.units !== built.units
      || position.walletAddress !== wallet || built.swap.wallet !== wallet || built.swap.inputMint !== position.tokenMint
      || built.swap.inAmount !== pending.units || BigInt(pending.units) > BigInt(position.remainingUnits)) return release("exit_mismatch");
    if (!(now < built.expiresAtMs) || !isValidatedSolanaMessage(built.message)) return release("token_expired");
    const lease = o.readLease(agentId);
    if (!lease || lease.instanceId !== o.instanceId || !(lease.remainingMs > 0)) return release("lease_unavailable");
    // Disarm, stop, a re-arm since the build or a closed exits capability: never signed. Synchronous from here to the signature.
    let facts: PrivateExecutionLiveFacts | undefined;
    try { facts = o.readFacts(agentId); } catch { facts = undefined; }
    const notArmed = this.#gate({ step: "exit_sign", agentId, runtimeVersion: built.runtimeVersion, facts });
    if (notArmed) return release(notArmed);
    const message = strictBase64(built.build.unsignedMessageB64);
    const digest = built.build.messageSha256;
    if (!message || createHash("sha256").update(message).digest("hex") !== digest || built.message.messageSha256 !== digest
      || built.swap.messageSha256 !== digest) return release("message_mismatch");
    let attemptKey: string;
    try {
      attemptKey = privateSubmissionAttemptKey({ localProfileId: o.localProfileId, agentId, reservationId: built.reservationId,
        buildDigest: built.build.buildDigest, messageSha256: digest });
      o.journal.admit(agentId, built.reservationId, wallet, this.#retain(agentId));
    } catch (error: unknown) {
      return release(error instanceof PrivateSubmissionJournalError && ["journal_full", "wallet_busy", "attempt_conflict", "copy_unacknowledged"].includes(error.code)
        ? error.code : "state_unavailable");
    }

    // (c) The only signature. From here the pending exit and the wallet lock are settled only by server-proven states.
    let signature: Buffer;
    try { signature = o.keystore.sign(agentId, built.message); } catch { return release("signer_refused"); }
    this.#locks.set(wallet, { attemptKey, lock: this.#holdLock(built) });
    let wireB64: string; let signatureText: string;
    try {
      wireB64 = signedSolanaWireTransaction(message, signature).toString("base64"); signatureText = encodeBase58(signature);
    } catch { return refused("wire_unavailable", "retained"); }
    finally { signature.fill(0); }
    if (runnerSignedTransactionSignature(wireB64) !== signatureText) return refused("wire_unavailable", "retained");
    // (d) Durable, with the sell facts, before any network call.
    let attempt: PrivateSubmissionAttempt;
    try {
      attempt = o.journal.record(agentId, { attemptKey, reservationId: built.reservationId, buildDigest: built.build.buildDigest,
        walletBindingId: built.build.walletBindingId, walletAddress: wallet, messageSha256: digest, signature: signatureText, wireB64,
        blockhash: built.swap.blockhash, lastValidBlockHeight: built.build.lastValidBlockHeight,
        swap: { direction: "sell", positionId: built.positionId, inputMint: built.swap.inputMint, outputMint: WSOL_MINT, grossInUnits: built.swap.inAmount,
          quotedOut: built.swap.quotedOut, minOut: built.swap.minOut, platformFeeBps: built.swap.platformFeeBps,
          priorityFeeLamports: built.swap.priorityFeeLamports, wsolAccount: built.swap.destinationAta } }, now, this.#retain(agentId));
    } catch { return Object.freeze({ outcome: "unknown" as const, reservationId: built.reservationId, reason: "journal_unavailable" as const }); }
    this.#schedule();
    // (e)/(f) Relay only while live_armed (an entries pause does not matter); otherwise the signed bytes stay journaled.
    const relayHeld = this.#gate({ step: "relay", agentId });
    if (relayHeld) {
      const kept = this.#change(agentId, attempt, { reason: reasonText("gate", relayHeld) });
      return Object.freeze({ outcome: "journaled" as const, attemptKey, state: kept.state, reason: kept.reason });
    }
    const settled = await this.#relay(agentId, attempt, lease, false, signal);
    return Object.freeze({ outcome: "journaled" as const, attemptKey, state: settled.state, reason: settled.reason });
  }

  /** One status/resend pass over this agent's unfinished attempts (serialized per agent). */
  async reconcile(agentId: string, signal?: AbortSignal): Promise<readonly PrivateSubmissionAttempt[]> {
    if (!this.#closed && !this.#busy.has(agentId)) {
      this.#busy.add(agentId);
      try {
        for (const attempt of this.#options.journal.list(agentId).filter(unfinished)) {
          if (signal?.aborted || this.#closed) break;
          try { await this.#reconcileAttempt(agentId, attempt, signal); } catch { /* Held; the next pass retries. */ }
        }
        // SF2: at most one buy Balchemy reports failed or expired is proven per pass (R3).
        try { await this.#settleBuys(agentId, signal); } catch { /* Held; the next pass retries. */ }
        // F2: at most one runner dispute per pass is released by proof (no-op without the exits capability).
        try { await this.#closeLandings(agentId, signal); } catch { /* Held; the next pass retries. */ }
        // SF R10: at most one buy Balchemy leaves unresolved per pass frees its wallet lock by proof (no-op without the exits capability).
        try { await this.#closeStalls(agentId, signal); } catch { /* Held; the next pass retries. */ }
        // B1: at most one sell Balchemy never received per pass ends on the runner's own proof (no-op without the exits capability);
        // the settlement pass right after it then clears its pending exit on the same proof.
        try { await this.#settleUnrelayedSells(agentId, signal); } catch { /* Held; the next pass retries. */ }
        // SF-A: at most one sell Balchemy relayed and leaves unresolved per pass ends on the runner's own proof (no-op without the exits
        // capability); then Balchemy's later report on such a sell is read, and a contradicting one holds its position again.
        try { await this.#settleStalledSells(agentId, signal); } catch { /* Held; the next pass retries. */ }
        try { await this.#watchLateSells(agentId, signal); } catch { /* Held; the next pass retries. */ }
        try { this.#holdLateLandings(agentId); } catch { /* Held; the next pass retries. */ }
        // S5c: positions settle from their exit attempts (no-op without a position ledger).
        try { await this.#settleExits(agentId, signal); } catch { /* Held; the next pass retries. */ }
      } finally { this.#busy.delete(agentId); }
    }
    return this.#options.journal.list(agentId);
  }

  /** Daemon start only, before any build: a `reserved` local reservation with no journal attempt was never signed and
   * persisted (the signature could only have lived in the dead process, and nothing is relayed unjournaled), so it is
   * released. S5c: likewise an open position's pending exit with no journal attempt was never signed: proven_negative.
   * Then polling starts for unfinished attempts and for terminal exit attempts whose position has not settled yet. */
  recoverOnStart(): void {
    const now = this.#now();
    for (const agentId of this.#options.agentIds) {
      try {
        const attempts = this.#options.journal.list(agentId);
        for (const open of this.#options.ledger.status(agentId, now).open) {
          if (!attempts.some((item) => item.reservationId === open.reservationId)) {
            try { this.#options.ledger.release(agentId, open.reservationId, "s4:recovery_never_signed", now); } catch { /* Held. */ }
          }
        }
      } catch { /* A held journal or ledger keeps its wallet blocked. */ }
      const positions = this.#options.positions;
      if (!positions) continue;
      try {
        const attempts = this.#options.journal.list(agentId);
        for (const position of positions.positions(agentId)) {
          const pending = position.pendingExit;
          if (position.state !== "open" || !pending || attempts.some((item) => item.reservationId === pending.reservationId)) continue;
          try { positions.failExit(agentId, position.positionId, pending.reservationId, "proven_negative", "s5c:recovery_never_signed", now); } catch { /* Held. */ }
        }
      } catch { /* A held journal or position ledger keeps every pending exit as it is. */ }
    }
    // Persisted sightings come back before anything reads them (the refusals below, every later pass).
    for (const agentId of this.#options.agentIds) { try { this.#rebuildSightings(agentId); } catch { /* Each rule still reads the attempt's own. */ } }
    for (const agentId of this.#options.agentIds) { try { this.#recordRefusals(agentId); } catch { /* Readback only. */ } }
    this.#schedule();
  }

  /** F2 readback: process-local release reasons of runner disputes not released yet (empty without the exits capability). */
  landingReleases(): ReadonlyArray<{ agentId: string; attemptKey: string } & PrivateLandingRelease> {
    // untilMs is shown as a wall-clock instant of this moment (an integer; Infinity stays Infinity for a permanent refusal).
    const wall = this.#now(); const monotonic = this.#monotonic();
    const until = (deadline: number): number => (Number.isFinite(deadline) ? Math.max(0, Math.round(wall + (deadline - monotonic))) : deadline);
    return [...this.#landing].flatMap(([agentId, entries]) => [...entries].map(([attemptKey, item]) => ({ agentId, attemptKey, ...item, untilMs: until(item.untilMs) })));
  }
  /** F2 `runner status`: this agent's release checks, permanent refusals first, at most RUNNER_EXIT_SUMMARY_RELEASE_LIMIT (the full
   * list is `runner trades`). Public facts only: the attempt key and a closed reason. */
  releaseChecks(agentId: string): Array<{ attemptKey: string; reason: RunnerLandingReleaseReason }> {
    // SF R10: the release checks of buys Balchemy leaves unresolved are listed beside the F2 ones.
    return [...(this.#landing.get(agentId) ?? []), ...(this.#stalls.get(agentId) ?? [])].sort(([a, x], [b, y]) => Number(y.permanent) - Number(x.permanent) || (a < b ? -1 : 1))
      .slice(0, RUNNER_EXIT_SUMMARY_RELEASE_LIMIT).map(([attemptKey, item]) => ({ attemptKey, reason: item.reason }));
  }
  /** Unacknowledged observed copies in this agent's journal (each holds its wallet); 0 when the journal is absent. */
  copyHolds(agentId: string): number { return this.#options.journal.list(agentId).filter(privateSubmissionCopyHeld).length; }
  /** Owner acknowledgement (acknowledge-copy): lifts the wallet hold; the attempts, ledger and history stay unchanged. */
  acknowledgeCopies(agentId: string): number { return this.#options.journal.acknowledgeCopies(agentId, this.#now()); }

  /** Owner close-out (owner decision 26; module comment): the owner's typed confirmation reached the daemon over the owner socket.
   * Serialized with this agent's reconcile pass. Never signs, sends or relays; needs neither live_armed nor the keystore. */
  async closeByOwner(agentId: string, attemptKey: string, signal?: AbortSignal): Promise<PrivateSubmissionCloseOut> {
    const refuse = (reason: RunnerTradeCloseRefusal): PrivateSubmissionCloseOut => Object.freeze({ attemptKey, outcome: "refused" as const, reason });
    if (this.#closed) return refuse("closing");
    if (!this.#options.agentIds.includes(agentId)) return refuse("attempt_missing");
    for (let step = 0; this.#busy.has(agentId); step += 1) {
      if (this.#closed) return refuse("closing");
      if (step >= PRIVATE_OWNER_CLOSE_BUSY_STEPS || signal?.aborted) return refuse("busy");
      await new Promise((resolve) => { setTimeout(resolve, 50).unref(); });
    }
    if (this.#closed) return refuse("closing");
    this.#busy.add(agentId);
    try { return await this.#closeOut(agentId, attemptKey, refuse, signal); }
    finally { this.#busy.delete(agentId); }
  }
  async #closeOut(agentId: string, attemptKey: string, refuse: (reason: RunnerTradeCloseRefusal) => PrivateSubmissionCloseOut,
    signal?: AbortSignal): Promise<PrivateSubmissionCloseOut> {
    const o = this.#options;
    const find = (): PrivateSubmissionAttempt | undefined => o.journal.list(agentId).find((item) => item.attemptKey === attemptKey);
    let attempt: PrivateSubmissionAttempt | undefined;
    try { attempt = find(); } catch { return refuse("state_unavailable"); }
    if (!attempt) return refuse("attempt_missing");
    if (isPrivateSubmissionTerminal(attempt.state)) return refuse("terminal");
    if (privateSubmissionCopyHeld(attempt)) return refuse("copy_unacknowledged");
    // A relay-closed runner dispute (released or not), a released attempt, or (owner decision 44) a buy Balchemy left unresolved that
    // the runner has not released, once it is PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS old (it gets the fresh proof below). Never a server
    // dispute, a younger unresolved buy, or an attempt with a relay in flight.
    if (!privateSubmissionOwnerClosable(attempt, this.#now()) || this.#inflight.has(attemptKey)) return refuse("not_closable");
    const released = attempt.landingClosed;
    // A halt (stopped) or an unreadable runtime refuses; live_armed is not needed (nothing is signed or executed). A fresh proof needs
    // the owner's own RPC class, as every runner-side proof does.
    const gate = (): RunnerTradeCloseRefusal | null => {
      try {
        const state = o.readRuntime(agentId);
        const current = state ? parseAgentState(state) : undefined;
        if (!current || current.agentId !== agentId || current.lifecycle !== "idle") return "runtime_not_idle";
      } catch { return "runtime_not_idle"; }
      if (released !== null) return null;
      // Owner decision of 17 Nov 2026: the two Balchemy-provided sources qualify too (the proof then holds only on both).
      try { return privateRpcClassExecutable(o.readFacts(agentId).rpcClass) ? null : "rpc_not_owned"; } catch { return "rpc_not_owned"; }
    };
    const before = gate(); if (before) return refuse(before);
    let slot: string;
    if (released !== null) slot = released.finalizedSlot;
    else {
      // The wire's own lifetime is the stored blockhash (no durable nonce is possible: private-solana-tx-validator.ts).
      if (wireBlockhash(attempt.wireB64) !== attempt.blockhash) return refuse("wire_blockhash_mismatch");
      let rpc: PrivateExitExpiryRpc | undefined;
      try { rpc = o.readCloseRpc?.(agentId) ?? o.readSettlementRpc?.(agentId); } catch { rpc = undefined; }
      if (!rpc) return refuse("rpc_missing");
      const stop = (): boolean => signal?.aborted === true || this.#closed;
      // Owner decision 44, closable only through the 30-minute rule (not a runner dispute, not released): "Balchemy left it unresolved"
      // is otherwise only what the local journal last saw. ONE status read first (no relay, no resend; this close-out holds the busy
      // marker, and an attempt with a relay in flight was refused above). No lease, a refused read or one that throws: the stalled case
      // this decision exists for, so the close-out goes on. A record is applied exactly as a reconcile pass would; any journal change
      // (completed, facts_pending, a negative state, a dispute) refuses attempt_changed, so the owner reviews the trade again.
      if (!privateSubmissionOwnerClosable(attempt)) {
        const lease = this.#lease(agentId);
        let response: RunnerExecutionStatusResponse | undefined;
        if (lease) {
          try { response = await this.#client(agentId, lease, attempt).status({ reservationId: attempt.reservationId, buildDigest: attempt.buildDigest }, lease.epoch, signal,
            attempt.signature); }
          catch { response = undefined; }
        }
        if (this.#closed) return refuse("closing");
        if (response && response.outcome !== "refused") {
          this.#apply(agentId, attempt, response.submission);
          let read: PrivateSubmissionAttempt | undefined;
          try { read = find(); } catch { return refuse("state_unavailable"); }
          if (!read || JSON.stringify(read) !== JSON.stringify(attempt)) return refuse("attempt_changed");
        }
      }
      let first: bigint | null; let second: bigint | null;
      try {
        // Checks 1-2 of the expiry proof twice, from fresh reads, the second at a finalized slot not below the first.
        first = await privateBlockhashExpired(rpc, attempt, stop, signal);
        if (!stop() && first !== null) second = await privateBlockhashExpired(rpc, attempt, stop, signal); else second = null;
      } catch { return refuse(this.#closed ? "closing" : "rpc_unavailable"); }
      if (this.#closed) return refuse("closing");
      if (signal?.aborted) return refuse("rpc_unavailable");
      if (first === null || second === null) return refuse("expiry_unproven");
      if (second < first) return refuse("proof_regressed");
      slot = second.toString();
    }
    // Synchronously from here to the last write: the gate still admits and the journal attempt is exactly the one proven.
    const after = gate(); if (after) return refuse(after);
    let current: PrivateSubmissionAttempt | undefined;
    try { current = find(); } catch { return refuse("state_unavailable"); }
    if (!current || JSON.stringify(current) !== JSON.stringify(attempt)) return refuse("attempt_changed");
    const now = this.#now();
    // The same `now` the writes use: a clock stepped back since the first check refuses here, before any write (never after the mint or spend writes).
    if (!privateSubmissionOwnerClosable(current, now)) return refuse("not_closable");
    if (attempt.swap.direction === "buy") {
      // A buy's spend stays counted: the reservation is committed (an earlier close-out that committed it and then failed is resumed).
      // A released or missing reservation cannot be counted again: the trade stays held for the owner (fail closed).
      let reservation: ReturnType<PrivateSubmissionOptions["ledger"]["reservation"]>;
      try { reservation = o.ledger.reservation(agentId, attempt.reservationId); } catch { return refuse("state_unavailable"); }
      if (!reservation) return refuse("spend_missing");
      if (reservation.state === "released") return refuse("spend_released");
      // Its mint is kept off automatic management for good, first (it may have landed units nothing tracks). Without a recorded
      // watermark the closed buy stays in the journal (#retain) and the exit worker adds its mint when it records the watermark.
      const positions = o.positions;
      let tainted = false;
      if (positions) {
        try { if (positions.managedFrom(agentId)) { positions.addOutsideMint(agentId, attempt.swap.outputMint, now); tainted = true; } }
        catch { return refuse("mint_unavailable"); }
      }
      if (reservation.state === "reserved") {
        try { o.ledger.commit(agentId, attempt.reservationId, PRIVATE_OWNER_CLOSE_SPEND_REASON, now); }
        catch (error: unknown) {
          if (!(error instanceof PrivateSpendLedgerError && error.code === "reservation_committed")) {
            // After the mint write, or after a commit that may have landed, the close-out is partly applied (never "nothing changed"):
            // the attempt stays held and the next close-out completes it (every write is idempotent).
            if (!tainted && error instanceof PrivateSpendLedgerError && error.code === "reservation_released") return refuse("spend_released");
            return refuse("partly_applied");
          }
        }
      }
    } else {
      // A sell follows the hold table: its position keeps (or takes) the runner hold, sold only, with the pending exit, so the same
      // mint stays out of automatic sells (H2) until the balance settlement proves the sale.
      const positions = o.positions;
      if (!positions) return refuse("position_unavailable");
      try {
        const position = positions.position(agentId, attempt.swap.positionId);
        const reason = attempt.observedSignature !== null ? "runner:observed_copy" : "runner:exit_disputed";
        if (position && position.state !== "closed" && position.pendingExit?.reservationId === attempt.reservationId && !runnerHeld(position)) {
          positions.failExit(agentId, position.positionId, attempt.reservationId, "unknown", reason, now);
        }
      } catch { return refuse("position_unavailable"); }
    }
    try { o.journal.closeByOwner(agentId, attemptKey, attempt, slot, Math.max(now, attempt.updatedAt)); }
    catch {
      // The lock closes only once the journal durably shows the close-out (a failure after the commit); otherwise nothing more changes.
      let durable = false;
      try { durable = find()?.state === PRIVATE_SUBMISSION_OWNER_CLOSED_STATE; } catch { durable = false; }
      if (!durable) return refuse("journal_unavailable");
    }
    for (const map of [this.#landing, this.#stalls, this.#buys, this.#sightings, this.#sells, this.#expiries, this.#stalledSells, this.#late]) {
      const entries = map.get(agentId); entries?.delete(attemptKey); if (entries?.size === 0) map.delete(agentId);
    }
    this.#releaseLock(attempt);
    return Object.freeze({ attemptKey, outcome: "closed" as const, finalizedSlot: slot });
  }

  /** Readback: unacknowledged observed copies first, then released runner disputes (F2: the owner must review them, so newer
   * attempts never push them out of the bounded readback), then newest; never the wire bytes. A runner dispute S4 tried and
   * did not release carries its process-local release check. */
  list(agentId: string): PrivateSubmissionReadback {
    // Owner decision 26: every attempt the owner may close out (a runner dispute, released or not, or a released attempt that is not
    // terminal; owner decision 44: a buy Balchemy left unresolved for 30 minutes) is pinned too. A terminal released attempt is settled
    // and needs no review.
    const now = this.#now();
    const pinned = (item: PrivateSubmissionAttempt): number => (privateSubmissionCopyHeld(item) ? 2
      : privateSubmissionOwnerClosable(item, now) ? 1 : 0);
    const attempts = [...this.#options.journal.list(agentId)].sort((a, b) => pinned(b) - pinned(a) || b.createdAt - a.createdAt
      || (a.attemptKey < b.attemptKey ? -1 : 1));
    const checks = this.#landing.get(agentId); const buys = this.#buys.get(agentId); const stalls = this.#stalls.get(agentId); const sells = this.#sells.get(agentId);
    return { agentId, total: attempts.length, attempts: attempts.slice(0, PRIVATE_SUBMISSION_READBACK_LIMIT).map((attempt) => {
      const view = privateSubmissionView(attempt); const check = checks?.get(attempt.attemptKey); const buy = buys?.get(attempt.attemptKey);
      if (buy && view.direction === "buy" && this.#proofPending(attempt)) {
        return { ...view, buyCheck: { reason: buy.reason, counted: buy.countedReason === buy.reason ? buy.counted : 0 } };
      }
      // SF R10: why a buy Balchemy leaves unresolved has not freed its wallet yet.
      const stall = stalls?.get(attempt.attemptKey);
      if (stall && stallReleasable(attempt)) return { ...view, releaseCheck: stall.reason };
      // B1: why a sell Balchemy never received is not settled yet.
      const sell = sells?.get(attempt.attemptKey);
      if (sell && view.direction === "sell" && privateSubmissionUnrelayed(attempt)) return { ...view, releaseCheck: sell.reason };
      // SF-A: why a sell Balchemy relayed and leaves unresolved is not settled yet.
      const stalled = this.#stalledSells.get(agentId)?.get(attempt.attemptKey);
      if (stalled && view.direction === "sell" && privateSubmissionEngineUnresolvedSell(attempt)) return { ...view, releaseCheck: stalled.reason };
      return check && releasable(attempt) ? { ...view, releaseCheck: check.reason } : view;
    }) };
  }

  async close(): Promise<void> {
    this.#closed = true; this.#abort.abort();
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; this.#timerSlow = false; }
    await this.#running?.catch(() => undefined);
    // Process-local only: the durable reservation keeps every unfinished wallet blocked across restarts.
    for (const held of this.#locks.values()) { try { held.lock.close(); } catch { /* Process exit releases it. */ } }
    this.#locks.clear();
  }

  #schedule(): void {
    if (this.#closed || this.#running) return;
    const poll = this.#options.pollMs ?? PRIVATE_SUBMISSION_POLL_MS;
    if (this.#timer) {
      // SF2 (re-audit): an armed slow watch never delays new work. Another agent's submit (buy or exit) that finds only a held,
      // stopped agent's watch armed replaces it with the normal poll; a pending timer already at the poll interval stays as it is.
      if (!this.#timerSlow || !this.#pending()) return;
      clearTimeout(this.#timer); this.#timer = undefined; this.#timerSlow = false;
    }
    // SF2: a held buy negative whose proof cannot run (stopped, or not the owner's own RPC) arms no 5 s timer. The agent can be
    // resumed (or its RPC fixed) in this process, so a slow watch at PRIVATE_BUY_WATCH_MS notices it; it reads no RPC while the
    // gate still refuses, and Balchemy status at most once per watch (#reconcileAttempt, #refuseBuys).
    const pending = this.#pending();
    // SF-A: a sell the runner ended while Balchemy left it unresolved keeps a watch at PRIVATE_SELL_LATE_WATCH_MS for Balchemy's report,
    // and so does a recorded late landing or copy whose position hold is still owed (#lateWork; findings 4 of the SF-A review).
    const delay = pending ? poll : this.#lateWaiting() ? Math.max(poll, PRIVATE_SELL_LATE_WATCH_MS)
      : this.#buysWaiting() ? Math.max(poll, PRIVATE_BUY_WATCH_MS) : undefined;
    if (delay === undefined) return;
    this.#timerSlow = !pending;
    this.#timer = setTimeout(() => {
      this.#timer = undefined; this.#timerSlow = false;
      this.#running = (async () => {
        for (const agentId of this.#options.agentIds) {
          try {
            if (this.#options.journal.list(agentId).some(unfinished) || this.#exitsPending(agentId) || this.#lateWork(agentId)) await this.reconcile(agentId, this.#abort.signal);
          } catch { /* Held. */ }
        }
      })().finally(() => { this.#running = undefined; this.#schedule(); });
    }, delay);
    this.#timer.unref();
  }
  #pending(): boolean {
    return this.#options.agentIds.some((agentId) => {
      // F2: under the exits capability a releasable runner dispute keeps polling too (its release proof still has work), unless its
      // release was refused permanently (never retried, so nothing is left to poll for).
      // A disarmed, stopped or exits-less agent cannot re-arm while the dispute is open (submission_unresolved), so its release can
      // never progress in this process: it arms no timer (gate_refused, recorded by the pass or at start by #recordRefusals, is the
      // readback of the same refusal).
      // SF2: a held buy negative counts only while its proof can run (#buyReadable); otherwise only the slow watch runs (#schedule).
      try {
        const landing = this.#landing.get(agentId);
        let progress: boolean | undefined; let readable: boolean | undefined;
        const releaseMayProgress = (): boolean => (progress ??= this.#exits() && !RELEASE_STALLED.includes(this.#releaseGate(agentId) as PrivateExecutionGateRefusal));
        const buyMayProgress = (): boolean => (readable ??= this.#buyReadable(agentId));
        return this.#options.journal.list(agentId).some((item) => (unfinished(item) && !runnerDisputed(item) && (!this.#proofPending(item) || buyMayProgress()))
          || (releasable(item) && landing?.get(item.attemptKey)?.permanent !== true && releaseMayProgress()))
          || this.#exitsPending(agentId);
      }
      catch { return false; }
    });
  }
  /** SF-A: this agent has a sell whose later Balchemy report is still read (#watchLateSells; behind the exits capability). */
  #lateWatched(agentId: string): boolean {
    if (!this.#exits()) return false;
    try { return this.#options.journal.list(agentId).some(privateSubmissionLateWatched); } catch { return false; }
  }
  /** SF-A review finding 4: this agent has a recorded late landing or copy whose position hold is owed and not applied yet
   * (privateSubmissionLateHoldOwed; #holdLateLandings applies it). A position ledger that cannot be read counts as still owed, so the watch
   * is never dropped on a read error; a journal that cannot be read shows no such sell (it holds every attempt of the agent anyway). */
  #lateHoldOwed(agentId: string): boolean {
    const positions = this.#options.positions;
    if (!this.#exits() || !positions || !positions.holdLateExit) return false;
    let attempts: readonly PrivateSubmissionAttempt[];
    try { attempts = this.#options.journal.list(agentId); } catch { return false; }
    return attempts.some((attempt) => {
      if (attempt.swap.direction !== "sell" || !privateSubmissionLateContradicted(attempt)) return false;
      try { return privateSubmissionLateHoldOwed(attempt, positions.position(agentId, attempt.swap.positionId)); } catch { return true; }
    });
  }
  /** SF-A: work the slow late watch (PRIVATE_SELL_LATE_WATCH_MS) exists for: a report still read, or a hold still owed. */
  #lateWork(agentId: string): boolean { return this.#lateWatched(agentId) || this.#lateHoldOwed(agentId); }
  #lateWaiting(): boolean { return this.#options.agentIds.some((agentId) => this.#lateWork(agentId)); }
  /** SF2: some agent holds a buy negative (whether or not its proof can run now). */
  #buysWaiting(): boolean {
    return this.#options.agentIds.some((agentId) => {
      try { return this.#options.journal.list(agentId).some((item) => this.#proofPending(item)); } catch { return false; }
    });
  }
  /** S5c: a pending exit (not held for the owner) whose attempt is journaled: the settlement pass still has work. */
  #exitsPending(agentId: string): boolean {
    const positions = this.#options.positions;
    if (!positions) return false;
    try {
      return positions.positions(agentId).some((position) => position.pendingExit !== null && settling(position)
        && this.#options.journal.forReservation(agentId, position.pendingExit.reservationId) !== undefined);
    } catch { return false; }
  }
  /** S5c journal eviction guard: a terminal exit attempt stays while its position still carries its pending exit (its journaled
   * signature is the only key to the finalized proof). Undefined without a position ledger: eviction is unchanged. */
  #retain(agentId: string): PrivateSubmissionRetain | undefined {
    const positions = this.#options.positions;
    return (attempt) => {
      // Owner decision 26: a buy the owner closed out may have landed units nothing tracks. It stays in the journal until its mint is
      // durably kept off automatic management on the position ledger's watermark (the exit worker records a closed buy's mint with the
      // watermark when it records it later). SF R10: so does a released buy Balchemy then reported completed (its record contradicts
      // the runner's release proof; #apply adds its mint first, and a watermark recorded later takes it as a pre-enable buy).
      if (attempt.swap.direction === "buy" && (privateSubmissionOwnerClosed(attempt) || (privateSubmissionReleased(attempt) && attempt.state === "completed"))) {
        const unmanaged = positions ? privateUnmanagedMints(positions.managedFrom(agentId)) : null;
        if (unmanaged === null || !unmanaged.includes(attempt.swap.outputMint)) return true;
      }
      // Final audit S3: a completed buy whose position has not opened is the only route to its stop-loss (the exit worker opens it from
      // this attempt's signature, and its entry hold keeps new buys held meanwhile): kept until the position opens.
      if (positions && privateBuyAwaitingPosition(attempt, positions, this.#options.localProfileId, agentId)) return true;
      if (!positions || attempt.swap.direction !== "sell") return false;
      const position = positions.position(agentId, attempt.swap.positionId);
      return position?.pendingExit?.reservationId === attempt.reservationId;
    };
  }

  /** S5c settlement pass: every pending exit (not held for the owner, or held with a hold it re-checks itself) whose attempt is
   * journaled moves only on proven facts. */
  async #settleExits(agentId: string, signal?: AbortSignal): Promise<void> {
    const positions = this.#options.positions;
    if (!positions) return;
    const open = positions.positions(agentId).filter(settling);
    // S1: only this agent's expiry checks are pruned, and only those whose sell no longer settles a position.
    const expiries = this.#expiries.get(agentId);
    if (expiries) {
      const live = new Set(open.flatMap((item) => item.pendingExit ? [item.pendingExit.reservationId] : []));
      let attempts: readonly PrivateSubmissionAttempt[] = [];
      try { attempts = this.#options.journal.list(agentId); } catch { attempts = []; }
      for (const key of [...expiries.keys()]) if (!attempts.some((item) => item.attemptKey === key && live.has(item.reservationId))) expiries.delete(key);
      if (expiries.size === 0) this.#expiries.delete(agentId);
    }
    for (const position of open) {
      if (signal?.aborted || this.#closed) return;
      const pending = position.pendingExit;
      if (!pending) continue;
      const attempt = this.#options.journal.forReservation(agentId, pending.reservationId);
      // Not journaled yet: a build or signature is in flight (restart recovery resolves an interrupted one).
      if (!attempt) continue;
      try { await this.#settleExit(agentId, positions, position, pending, attempt, signal); } catch { /* Held; the next pass retries. */ }
    }
  }
  async #settleExit(agentId: string, positions: NonNullable<PrivateSubmissionOptions["positions"]>, position: PrivatePosition,
    pending: PrivatePositionPendingExit, attempt: PrivateSubmissionAttempt, signal?: AbortSignal): Promise<void> {
    /** Unknown outcome: the position is held with its pending exit (no new trigger). A `runner:` reason is one of
     * PrivateRunnerHoldReason (typed, so the wallet-balance settlement's hold table stays exhaustive). */
    const hold = (reason: PrivateRunnerHoldReason | `s5c:${string}`): void => { positions.failExit(agentId, position.positionId, pending.reservationId, "unknown", reason, this.#now()); };
    const swap = attempt.swap;
    if (swap.direction !== "sell" || swap.positionId !== position.positionId || attempt.walletAddress !== position.walletAddress
      || swap.inputMint !== position.tokenMint || swap.grossInUnits !== pending.units) { hold("runner:exit_attempt_mismatch"); return; }
    // A landed copy signed outside this runner: a security event the owner resolves; the journaled signature proves nothing.
    if (attempt.observedSignature !== null) { hold("runner:observed_copy"); return; }
    // Owner decision 26: a sell the owner closed out was a runner dispute; its outcome stays unknown (sold only, never "not sold").
    if (privateSubmissionOwnerClosed(attempt)) { hold("runner:exit_disputed"); return; }
    if (attempt.state === "disputed") { hold(runnerDisputed(attempt) ? "runner:exit_disputed" : "s5c:exit_disputed"); return; }
    // SF-A: Balchemy reported a landing after the runner itself had written this sell terminal-negative (recordLateReport): never "not
    // sold" on the runner's earlier word, never "sold" on Balchemy's: the completed rules below apply (the sale only from the sell's own
    // finalized transaction; absent, the expiry proof makes it runner:completed_contradicted_by_expiry).
    const lateLanding = isPrivateSubmissionTerminal(attempt.state) && attempt.state !== "completed" && privateSubmissionEngineReportedLanding(attempt);
    const negative = !lateLanding && (attempt.state === "failed_onchain" || attempt.state === "expired_not_landed");
    if (!negative && attempt.state !== "completed" && !lateLanding) return;
    // Every terminal state settles only on the runner's own finalized evidence for exactly the journaled signature (retried
    // while not yet available): a wrong server failed/expired status can never free the units for a second sell.
    const rpc = this.#options.readSettlementRpc?.(agentId, "exit");
    if (!rpc) return;
    let transaction: unknown;
    try { transaction = await rpc.getTransaction(attempt.signature, { commitment: "finalized" }, signal); } catch { return; }
    if (signal?.aborted || this.#closed) return;
    const prove = (): ReturnType<typeof privateSellProceeds> => privateSellProceeds(transaction, { signature: attempt.signature,
      walletAddress: attempt.walletAddress, tokenMint: swap.inputMint, units: pending.units, wsolAccount: swap.wsolAccount });
    if (negative) {
      if (transaction === null || transaction === undefined) {
        // A failed transaction lands on chain: absent means not finalized yet. An expired one is proven only by the
        // runner-side expiry proof (#proveSellExpiry); anything less keeps the exit pending.
        // SF8: a failed_onchain sell absent at finalized waits under a named hold (re-checked by this pass) for the same proof: once
        // these bytes provably can never land, Balchemy's negative and the runner's own proof agree. S1: so does an expired_not_landed
        // one (before S1 it waited unnamed), and either keeps runner:sell_expiry_unproven once its bound was reached (also when the
        // runner itself ended a sell Balchemy never received at that bound, PRIVATE_SELL_EXPIRY_UNPROVEN_REASON).
        const bounded = position.holdReason === "runner:sell_expiry_unproven" || attempt.reason === PRIVATE_SELL_EXPIRY_UNPROVEN_REASON;
        hold(bounded ? "runner:sell_expiry_unproven"
          : attempt.state === "failed_onchain" ? "runner:failed_onchain_transaction_missing" : "runner:expired_not_landed_transaction_missing");
        const proof = await this.#proveSellExpiry(agentId, rpc, attempt, position, signal);
        if (proof === null || signal?.aborted || this.#closed) return;
        if (proof === "proven") positions.failExit(agentId, position.positionId, pending.reservationId, "proven_negative", `s5c:${attempt.state}`, this.#now());
        // S1: the bound reached: an owner hold with a named way out (the wallet balance, or an RPC whose history reaches the witness).
        else if (proof === "bound") hold("runner:sell_expiry_unproven");
        return;
      }
      const body = isRecord(transaction) && isRecord(transaction.transaction) ? transaction.transaction : undefined;
      const meta = isRecord(transaction) && isRecord(transaction.meta) ? transaction.meta : undefined;
      const signatures = body?.signatures;
      if (!meta || !("err" in meta) || !Array.isArray(signatures)) { hold("s5c:sell_facts_transaction_malformed"); return; }
      if (signatures.length !== 1 || signatures[0] !== attempt.signature) { hold("runner:sell_facts_signature_mismatch"); return; }
      if (meta.err !== null) {
        positions.failExit(agentId, position.positionId, pending.reservationId, "proven_negative", `s5c:${attempt.state}`, this.#now());
        return;
      }
      // It landed without error despite the server's negative state: settle from the proof, else hold for the owner.
      const landed = prove();
      if (landed.ok) {
        positions.completeExit(agentId, position.positionId, pending.reservationId, { soldUnits: pending.units, proceedsLamports: landed.proceedsLamports }, this.#now());
        return;
      }
      hold(attempt.state === "failed_onchain" ? "runner:sell_landed_despite_failed_onchain" : "runner:sell_landed_despite_expired_not_landed");
      return;
    }
    // Completed: the runner's own finalized proof of exactly the journaled signature.
    const proof = prove();
    if (!proof.ok) {
      if (proof.reason === "transaction_missing") {
        // SF8: absent at finalized. Named while the runner's own expiry proof is outstanding (re-checked every pass). Once it
        // holds, Balchemy's completed contradicts the runner's proof: never "sold" and never "not sold" on either word alone,
        // so the owner resolves it (a later finalized read showing the sell landed still settles it: the hold table's "sold").
        // S1: re-checked with the same back-off; past the bound it stays named completed_transaction_missing (Balchemy's completed
        // forbids "not sold", so no balance path opens for it) and is re-checked at the capped back-off.
        hold("runner:completed_transaction_missing");
        if ((await this.#proveSellExpiry(agentId, rpc, attempt, position, signal)) !== "proven" || signal?.aborted || this.#closed) return;
        hold("runner:completed_contradicted_by_expiry");
        return;
      }
      // Unreadable evidence is retried (held meanwhile); a contradiction of what was signed is held for the owner.
      hold(proof.reason === "transaction_malformed" || proof.reason === "balances_missing" ? `s5c:sell_facts_${proof.reason}` : `runner:sell_facts_${proof.reason}`);
      return;
    }
    positions.completeExit(agentId, position.positionId, pending.reservationId, { soldUnits: pending.units, proceedsLamports: proof.proceedsLamports }, this.#now());
  }

  /** F2 release by proof (module comment): at most one releasable runner dispute of this agent per pass. Never throws past a
   * read; any failed check writes nothing. */
  async #closeLandings(agentId: string, signal?: AbortSignal): Promise<void> {
    if (!this.#exits()) return;
    const o = this.#options;
    const attempts = o.journal.list(agentId);
    const keys = new Set(attempts.map((item) => item.attemptKey));
    // Only this agent's entries are pruned: another agent's back-off survives this pass.
    let landing = this.#landing.get(agentId);
    if (landing) {
      for (const key of [...landing.keys()]) if (!keys.has(key)) landing.delete(key);
      if (landing.size === 0) { this.#landing.delete(agentId); landing = undefined; }
    }
    const open = attempts.filter((item) => releasable(item) && !this.#inflight.has(item.attemptKey) && !landing?.get(item.attemptKey)?.permanent);
    if (open.length === 0) return;
    const entries = (): Map<string, PrivateLandingRelease> => {
      let found = this.#landing.get(agentId);
      if (!found) { found = new Map(); this.#landing.set(agentId, found); }
      return found;
    };
    // The exit_build gate, as for an exit build and the balance settlement: live_armed, armed, idle, the exits capability and the
    // owner's own RPC class (facts read fresh at each check; a failed read refuses).
    const admitted = (): boolean => this.#releaseGate(agentId) === null;
    // Halted, disarmed or not the owner's own RPC: no read at all (re-checked synchronously before the write). Every open dispute
    // then shows gate_refused (#refuseReleases), so the readback never claims a retry the gate forbids.
    if (!admitted()) { this.#refuseReleases(agentId, open); return; }
    const now = this.#monotonic();
    const attempt = open.find((item) => now >= (landing?.get(item.attemptKey)?.untilMs ?? 0));
    if (!attempt) return;
    const key = attempt.attemptKey;
    const permanent = (reason: RunnerLandingReleaseReason): void => { entries().set(key, { failures: 0, untilMs: Infinity, reason, permanent: true }); };
    const retry = (reason: RunnerLandingReleaseReason): void => {
      const failures = (this.#landing.get(agentId)?.get(key)?.failures ?? 0) + 1;
      const delay = Math.min(PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS, PRIVATE_LANDING_RELEASE_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20));
      entries().set(key, { failures, untilMs: this.#monotonic() + delay, reason, permanent: false });
    };
    // 1. The wire's own lifetime is the stored blockhash (no durable nonce is possible: private-solana-tx-validator.ts).
    if (wireBlockhash(attempt.wireB64) !== attempt.blockhash) { permanent("wire_blockhash_mismatch"); return; }
    const rpc = o.readSettlementRpc?.(agentId);
    if (!rpc) { retry("rpc_missing"); return; }
    const stop = (): boolean => signal?.aborted === true || this.#closed;
    let first: bigint | null; let second: bigint | null;
    try {
      // 2. Proof 1, then 3. proof 2 from fresh reads at a finalized slot not below proof 1's.
      first = await privateBlockhashExpired(rpc, attempt, stop, signal);
      if (first === null || stop()) { if (!stop()) retry("expiry_unproven"); return; }
      second = await privateBlockhashExpired(rpc, attempt, stop, signal);
      if (second === null || stop()) { if (!stop()) retry("expiry_unproven"); return; }
    } catch { if (!stop()) retry("rpc_unavailable"); return; }
    if (second < first) { retry("proof_regressed"); return; }
    // 4. Synchronously from here to the lock close: the exit_build gate still admits, and the journal attempt is still exactly the
    // proven snapshot.
    if (!admitted()) { retry("gate_refused"); return; }
    let current: PrivateSubmissionAttempt | undefined;
    try { current = o.journal.list(agentId).find((item) => item.attemptKey === key); } catch { retry("state_unavailable"); return; }
    if (!current || JSON.stringify(current) !== JSON.stringify(attempt)) { retry("attempt_changed"); return; }
    // 5. The write-once compare-and-set, then the in-process wallet lock (this attempt was the wallet's only holder).
    try {
      o.journal.closeLanding(agentId, key, attempt, second.toString(), Math.max(this.#now(), attempt.updatedAt));
    } catch {
      // The lock closes only once the journal durably shows this release (a failure after the commit); otherwise it stays held.
      let durable = false;
      try { durable = o.journal.list(agentId).some((item) => item.attemptKey === key && item.landingClosed !== null && item.landingClosed !== undefined); }
      catch { durable = false; }
      if (!durable) { retry("journal_unavailable"); return; }
    }
    const done = this.#landing.get(agentId);
    done?.delete(key);
    if (done?.size === 0) this.#landing.delete(agentId);
    this.#releaseLock(attempt);
  }

  /** SF R10 (module comment): at most one buy Balchemy leaves unresolved of this agent per pass frees its wallet lock on the runner's own
   * proof. Never throws past a read; any failed check writes nothing; the reservation, state, relay and engine record never change. */
  async #closeStalls(agentId: string, signal?: AbortSignal): Promise<void> {
    if (!this.#exits()) return;
    const o = this.#options;
    const attempts = this.#pruneSightings(agentId, o.journal.list(agentId));
    // Only this agent's entries are pruned (and only those no longer unresolved and unreleased: their clock ends with them).
    let stalls = this.#stalls.get(agentId);
    if (stalls) {
      for (const key of [...stalls.keys()]) if (!attempts.some((item) => item.attemptKey === key && stallReleasable(item))) stalls.delete(key);
      if (stalls.size === 0) { this.#stalls.delete(agentId); stalls = undefined; }
    }
    const now = this.#now();
    const open = attempts.filter((item) => stallReleasable(item) && now - item.createdAt >= PRIVATE_STALL_CHECK_AFTER_MS && !this.#inflight.has(item.attemptKey)
      && !stalls?.get(item.attemptKey)?.permanent);
    if (open.length === 0) return;
    const entries = (): Map<string, PrivateStallRelease> => {
      let found = this.#stalls.get(agentId);
      if (!found) { found = new Map(); this.#stalls.set(agentId, found); }
      return found;
    };
    // The F2 release gate (exit_build): halted, disarmed, exits-less or not the owner's own RPC reads nothing.
    const admitted = (): boolean => this.#releaseGate(agentId) === null;
    if (!admitted()) { this.#refuseStalls(agentId, open); return; }
    // The check age above is wall clock (createdAt is persisted); the back-off and the grace below are monotonic.
    const monotonicNow = this.#monotonic();
    const due = open.find((item) => monotonicNow >= (stalls?.get(item.attemptKey)?.untilMs ?? 0));
    if (!due) return;
    let attempt = due;
    const key = attempt.attemptKey;
    const prior = this.#stalls.get(agentId)?.get(key);
    const clock = { firstAt: prior?.firstAt ?? null, firstSlot: prior?.firstSlot ?? null };
    const permanent = (reason: RunnerLandingReleaseReason): void => {
      entries().set(key, { failures: 0, untilMs: Infinity, reason, permanent: true, firstAt: null, firstSlot: null });
    };
    // A failed check keeps the clock: the next proof is again a fresh read.
    const retry = (reason: RunnerLandingReleaseReason): void => {
      const failures = (this.#stalls.get(agentId)?.get(key)?.failures ?? 0) + 1;
      const delay = Math.min(PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS, PRIVATE_LANDING_RELEASE_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20));
      entries().set(key, { failures, untilMs: this.#monotonic() + delay, reason, permanent: false, ...clock });
    };
    // The runner's own RPC already showed it landed (this process or, persisted, an earlier one): buy_landed, no read.
    if (this.#sighting(agentId, attempt) === "landed") { permanent("buy_landed"); return; }
    // 1. The wire's own lifetime is the stored blockhash.
    if (wireBlockhash(attempt.wireB64) !== attempt.blockhash) { permanent("wire_blockhash_mismatch"); return; }
    let rpc: PrivateSettlementRpc | undefined;
    try { rpc = o.readSettlementRpc?.(agentId); } catch { rpc = undefined; }
    if (!rpc) { retry("rpc_missing"); return; }
    const stop = (): boolean => signal?.aborted === true || this.#closed;
    let slot: bigint | null;
    try { slot = await privateBlockhashExpired(rpc, attempt, stop, signal); } catch { if (!stop()) retry("rpc_unavailable"); return; }
    if (stop()) return;
    if (slot === null) { retry("expiry_unproven"); return; }
    // 2. Proof 1 starts the clock; nothing is released before PRIVATE_STALL_RELEASE_GRACE_MS after it.
    if (clock.firstAt === null || clock.firstSlot === null) {
      const at = this.#monotonic();
      entries().set(key, { failures: 0, untilMs: at + PRIVATE_STALL_RELEASE_GRACE_MS, reason: "stall_grace", permanent: false, firstAt: at, firstSlot: slot.toString() });
      return;
    }
    if (this.#monotonic() - clock.firstAt < PRIVATE_STALL_RELEASE_GRACE_MS) {
      entries().set(key, { failures: 0, untilMs: clock.firstAt + PRIVATE_STALL_RELEASE_GRACE_MS, reason: "stall_grace", permanent: false, ...clock });
      return;
    }
    // Proof 2 at an F not below proof 1's.
    if (slot < BigInt(clock.firstSlot)) { retry("proof_regressed"); return; }
    // 3. The runner-side buy proof (R2) at or past proof 2's F. Only not_landed releases; landed and unproven write nothing.
    // C1: the durable probe stamp first; without it no proof runs in this pass.
    const stamped = this.#stamp(agentId, attempt);
    if (!stamped) { retry("journal_unavailable"); return; }
    attempt = stamped;
    let context: PrivateBuyNegativeContext;
    try {
      const positions = o.positions;
      context = { attempt, attempts, positions: positions ? positions.positions(agentId) : null, evicted: positions ? positions.evicted(agentId) : [],
        unmanagedMints: positions ? privateUnmanagedMints(positions.managedFrom(agentId)) : null };
    } catch { retry("state_unavailable"); return; }
    const proof = await privateBuyNegativeProof(rpc, context, signal, stop);
    // Any read of this proof that returned the buy (a transaction body or a status, even below F, before the blockhash expired or
    // right before a stop or an outage) is a sighting, whatever the result's reason: recorded before the stop, in this process and
    // durably on the journal attempt (replacing the stamp). A failed write keeps it in this process and the stamp on disk, and
    // decides nothing (journal_unavailable). Without a sighting the stamp is removed (#unstamp) before anything is decided.
    const persisted = this.#persistProbe(agentId, attempt, proof);
    if (!persisted) { if (!stop()) retry("journal_unavailable"); return; }
    attempt = persisted;
    if (stop()) return;
    // The runner's own RPC saw it land: sticky for the process (a later null from a load-balanced or pruned node, or the owner
    // having moved the tokens, is never evidence against a finalized read; private-position-balance.ts). A restart disarms anyway.
    if (proof.outcome === "landed") { permanent("buy_landed"); return; }
    if (proof.outcome === "unproven") {
      retry((RUNNER_LANDING_RELEASE_REASONS as readonly string[]).includes(proof.reason) ? proof.reason as RunnerLandingReleaseReason : "rpc_unavailable");
      return;
    }
    // After a sighting, absence is never evidence: only a not_landed from a transaction actually returned (landed and failed,
    // meta.err; the only not_landed without an F of its own, private-position-balance.ts) may release. One from absence backs off.
    if (proof.finalizedSlot !== null && this.#sighting(agentId, attempt) !== undefined) { retry("transaction_appeared"); return; }
    // A failed landing (meta.err) carries no F of its own: proof 2's F stands.
    const proven = proof.finalizedSlot === null ? slot : BigInt(proof.finalizedSlot);
    if (proven < slot) { retry("proof_regressed"); return; }
    // 4. Synchronously from here to the lock close: the exit_build gate still admits, and the journal attempt is exactly the proven snapshot.
    if (!admitted()) { retry("gate_refused"); return; }
    let current: PrivateSubmissionAttempt | undefined;
    try { current = o.journal.list(agentId).find((item) => item.attemptKey === key); } catch { retry("state_unavailable"); return; }
    if (!current || JSON.stringify(current) !== JSON.stringify(attempt)) { retry("attempt_changed"); return; }
    // An outside dust credit keeps its mint on the watermark first (as in R4), so the balance settlement never reads that mint again.
    if (proof.outsideUnits !== null) {
      try {
        if (!o.positions) throw new Error("position ledger unavailable");
        o.positions.addOutsideMint(agentId, attempt.swap.outputMint, this.#now());
      } catch { retry("state_unavailable"); return; }
    }
    // 5. The write-once compare-and-set, then the in-process wallet lock (when this attempt owns it).
    try {
      o.journal.closeLanding(agentId, key, attempt, proven.toString(), Math.max(this.#now(), attempt.updatedAt));
    } catch {
      // The lock closes only once the journal durably shows this release (a failure after the commit); otherwise it stays held.
      let durable = false;
      try { durable = o.journal.list(agentId).some((item) => item.attemptKey === key && privateSubmissionReleased(item)); }
      catch { durable = false; }
      if (!durable) { retry("journal_unavailable"); return; }
    }
    const done = this.#stalls.get(agentId);
    done?.delete(key);
    if (done?.size === 0) this.#stalls.delete(agentId);
    this.#releaseLock(attempt);
  }

  /** F2: the open releasable disputes show gate_refused (no read; no failure counted; the back-off unchanged). */
  #refuseReleases(agentId: string, open: readonly PrivateSubmissionAttempt[]): void {
    if (open.length === 0) return;
    let entries = this.#landing.get(agentId);
    if (!entries) { entries = new Map(); this.#landing.set(agentId, entries); }
    for (const item of open) {
      const prior = entries.get(item.attemptKey);
      entries.set(item.attemptKey, { failures: prior?.failures ?? 0, untilMs: prior?.untilMs ?? 0, reason: "gate_refused", permanent: false });
    }
  }
  /** Sightings outlive R10's scope (a later negative engine state, #settleBuys); they end only with a terminal state, a runner
   * dispute or the journal entry. Pruned by both passes that record them (#settleBuys runs without the exits capability). Returns the
   * attempts to work on: re-read when a sighting was written again here. */
  #pruneSightings(agentId: string, attempts: readonly PrivateSubmissionAttempt[]): readonly PrivateSubmissionAttempt[] {
    const sightings = this.#sightings.get(agentId);
    if (!sightings) return attempts;
    let wrote = false;
    for (const [key, kind] of [...sightings]) {
      const item = attempts.find((candidate) => candidate.attemptKey === key && !isPrivateSubmissionTerminal(candidate.state) && !runnerDisputed(candidate));
      if (!item) { sightings.delete(key); continue; }
      // A sighting whose journal write failed earlier is written again (best effort; the pass reads this process's copy meanwhile).
      // This helps only when that failure left the journal open: after a failed commit the journal is held for the process and the
      // list above already threw; the probe stamp on disk then carries it across the restart (C1, #sightings).
      if (privateSubmissionStrongerSighting(item.sighting?.kind, kind) !== item.sighting?.kind) {
        // Re-read afterwards whatever the outcome (a write may fail after its commit).
        wrote = true;
        try { this.#options.journal.recordSighting(agentId, key, item.signature, kind, Math.max(this.#now(), item.updatedAt)); } catch { /* Kept here. */ }
      }
    }
    if (sightings.size === 0) this.#sightings.delete(agentId);
    return wrote ? this.#options.journal.list(agentId) : attempts;
  }
  /** SF R10 and SF2: records what the runner's own RPC showed of a buy, in this process and then durably on its journal attempt
   * (recordSighting); `landed` is never downgraded to `present`. Returns the attempt to keep proving against: `attempt` with the
   * written sighting, re-read from the journal, or `attempt` itself when anything else changed meanwhile (the snapshot check then
   * refuses attempt_changed). Undefined when the write failed: the sighting stays in this process and the pass fails closed. */
  #sight(agentId: string, attempt: PrivateSubmissionAttempt, kind: PrivateBuySighting): PrivateSubmissionAttempt | undefined {
    this.#remember(agentId, attempt.attemptKey, kind);
    const strongest = this.#sighting(agentId, attempt) ?? kind;
    // A write that fails after its commit is durable all the same: what counts is what the journal holds afterwards.
    try { this.#options.journal.recordSighting(agentId, attempt.attemptKey, attempt.signature, strongest, Math.max(this.#now(), attempt.updatedAt)); }
    catch { /* Checked below. */ }
    try {
      const fresh = this.#options.journal.list(agentId).find((item) => item.attemptKey === attempt.attemptKey);
      const durable = fresh?.sighting?.kind;
      // Durable only when the journal now holds at least this sighting (it may already hold a stronger one).
      if (!fresh || durable === undefined || privateSubmissionStrongerSighting(durable, strongest) !== durable) return undefined;
      this.#remember(agentId, attempt.attemptKey, durable);
      return unsighted(fresh) === unsighted(attempt) ? fresh : attempt;
    } catch { return undefined; }
  }
  /** C1: the durable probe stamp, written right before a buy proof's reads (journal.recordProbe). A stamp already on the attempt is
   * an earlier probe whose outcome never reached the journal (a kill, or a failed write): it is a `present` sighting, made durable
   * first. A durable sighting needs no stamp. Returns the attempt to prove against (re-read), or undefined when neither the stamp nor
   * a sighting is durable: no proof runs in this pass. */
  #stamp(agentId: string, attempt: PrivateSubmissionAttempt): PrivateSubmissionAttempt | undefined {
    let current = attempt;
    if (current.probePending !== undefined) {
      const sighted = this.#sight(agentId, current, "present");
      if (!sighted) return undefined;
      current = sighted;
    }
    if (current.sighting !== undefined) return current;
    // A write that fails after its commit is durable all the same: what counts is what the journal holds afterwards.
    try { this.#options.journal.recordProbe(agentId, current.attemptKey, current.signature, Math.max(this.#now(), current.createdAt)); }
    catch { /* Checked below. */ }
    try {
      const fresh = this.#options.journal.list(agentId).find((item) => item.attemptKey === current.attemptKey);
      if (!fresh || (fresh.probePending === undefined && fresh.sighting === undefined) || unsighted(fresh) !== unsighted(current)) return undefined;
      return fresh;
    } catch { return undefined; }
  }
  /** C1: persists the outcome of one buy proof before anything reads it. A sighting (this proof's, or one this process still holds
   * that the journal lacks) is written by #sight, which also removes the stamp; otherwise the stamp is removed (#unstamp). Undefined
   * when that write is not durable: the stamp (or the sighting) stays and the pass decides nothing. */
  #persistProbe(agentId: string, attempt: PrivateSubmissionAttempt, proof: PrivateBuyNegativeProof): PrivateSubmissionAttempt | undefined {
    const seen: PrivateBuySighting | null = proof.outcome === "landed" ? "landed" : proof.sighted ? "present" : null;
    const held = seen ?? this.#sightings.get(agentId)?.get(attempt.attemptKey) ?? null;
    if (held !== null) return this.#sight(agentId, attempt, held);
    return this.#unstamp(agentId, attempt);
  }
  /** C1: removes this probe's stamp once it sighted nothing (journal.clearProbe, compare-and-set on its `at`). Undefined when the
   * journal still holds it afterwards (fail closed: it then stands for a `present` sighting). */
  #unstamp(agentId: string, attempt: PrivateSubmissionAttempt): PrivateSubmissionAttempt | undefined {
    const stamp = attempt.probePending;
    if (stamp === undefined) return attempt;
    try { this.#options.journal.clearProbe(agentId, attempt.attemptKey, attempt.signature, stamp.at); } catch { /* Checked below. */ }
    try {
      const fresh = this.#options.journal.list(agentId).find((item) => item.attemptKey === attempt.attemptKey);
      if (!fresh || fresh.probePending !== undefined || unsighted(fresh) !== unsighted(attempt)) return undefined;
      return fresh;
    } catch { return undefined; }
  }
  #remember(agentId: string, attemptKey: string, kind: PrivateBuySighting): void {
    let entries = this.#sightings.get(agentId);
    if (!entries) { entries = new Map(); this.#sightings.set(agentId, entries); }
    entries.set(attemptKey, privateSubmissionStrongerSighting(entries.get(attemptKey), kind) ?? kind);
  }
  /** The sighting every rule uses: the strongest of this process's, the one persisted on the journal attempt and, C1, a probe stamp
   * left on it (read as `present`: that probe's outcome never reached the journal). */
  #sighting(agentId: string, attempt: PrivateSubmissionAttempt): PrivateBuySighting | undefined {
    const durable = privateSubmissionStrongerSighting(attempt.sighting?.kind, attempt.probePending !== undefined ? "present" : undefined);
    return privateSubmissionStrongerSighting(this.#sightings.get(agentId)?.get(attempt.attemptKey), durable);
  }
  /** Daemon start: the sightings of every buy a rule may still read (non-terminal, not a runner dispute) come back from the journal.
   * SF R10: a `landed` one is again buy_landed, permanent for the process, without a read (as it was before the restart). */
  #rebuildSightings(agentId: string): void {
    let attempts: readonly PrivateSubmissionAttempt[];
    try { attempts = this.#options.journal.list(agentId); } catch { return; }
    for (const item of attempts) {
      // C1: a probe stamp found at start is an earlier probe whose outcome never reached the journal: a `present` sighting (the
      // next pass writes it, #pruneSightings, which removes the stamp).
      const kind = item.sighting?.kind ?? (item.probePending !== undefined ? "present" : undefined);
      if (kind === undefined || item.swap.direction !== "buy" || isPrivateSubmissionTerminal(item.state) || runnerDisputed(item)) continue;
      this.#remember(agentId, item.attemptKey, kind);
      if (kind === "landed" && this.#exits() && stallReleasable(item)) {
        let stalls = this.#stalls.get(agentId);
        if (!stalls) { stalls = new Map(); this.#stalls.set(agentId, stalls); }
        stalls.set(item.attemptKey, { failures: 0, untilMs: Infinity, reason: "buy_landed", permanent: true, firstAt: null, firstSlot: null });
      }
    }
  }
  /** SF R10: the open unresolved buys show gate_refused (no read; no failure counted; the back-off and the clock unchanged). */
  #refuseStalls(agentId: string, open: readonly PrivateSubmissionAttempt[]): void {
    if (open.length === 0) return;
    let entries = this.#stalls.get(agentId);
    if (!entries) { entries = new Map(); this.#stalls.set(agentId, entries); }
    for (const item of open) {
      const prior = entries.get(item.attemptKey);
      entries.set(item.attemptKey, { failures: prior?.failures ?? 0, untilMs: prior?.untilMs ?? 0, reason: "gate_refused", permanent: false,
        firstAt: prior?.firstAt ?? null, firstSlot: prior?.firstSlot ?? null });
    }
  }
  /** SF2: the held buy negatives show gate_refused (no read; no failure counted; the count unchanged). The first refusal moves the
   * next try at least PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS ahead: nothing can progress while the gate refuses, and the status read
   * of a held buy negative (#reconcileAttempt) runs only once its back-off has elapsed. A hold already refused keeps its due time
   * (re-audit): pushing it on every pass would starve its status read while another agent keeps the 5 s timer armed; only that
   * read moves it (#reconcileAttempt), so it runs about once per watch. */
  #refuseBuys(agentId: string, open: readonly PrivateSubmissionAttempt[]): void {
    if (open.length === 0) return;
    let entries = this.#buys.get(agentId);
    if (!entries) { entries = new Map(); this.#buys.set(agentId, entries); }
    const due = this.#monotonic() + PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS;
    for (const item of open) {
      const prior = entries.get(item.attemptKey);
      if (prior?.reason === "gate_refused") continue;
      const base = prior ?? { failures: 0, untilMs: 0, counted: 0, countedReason: null, balance: null, lastSlot: null, firstAt: 0 };
      entries.set(item.attemptKey, { ...base, untilMs: Math.max(base.untilMs, due), reason: "gate_refused" });
    }
  }
  /** Restart readback (every agent starts disarmed): a releasable dispute whose release gate refuses and a held buy negative of an
   * agent that cannot read arm no 5 s timer, so no pass would ever record their refusal. It is recorded here, synchronously and
   * without any RPC read, exactly as the pass would record it. */
  #recordRefusals(agentId: string): void {
    let attempts: readonly PrivateSubmissionAttempt[];
    try { attempts = this.#options.journal.list(agentId); } catch { return; }
    // The gates read live facts (the rules head among them), so they are read only when there is something to record.
    const landing = this.#landing.get(agentId);
    const disputes = attempts.filter((item) => releasable(item) && !landing?.get(item.attemptKey)?.permanent);
    if (disputes.length > 0 && this.#exits() && this.#releaseGate(agentId) !== null) this.#refuseReleases(agentId, disputes);
    // SF R10: a buy Balchemy leaves unresolved shows the same refusal (no read; its clock is process-local, so it starts after the restart).
    const stalls = this.#stalls.get(agentId);
    const now = this.#now();
    const stalled = attempts.filter((item) => stallReleasable(item) && now - item.createdAt >= PRIVATE_STALL_CHECK_AFTER_MS && !stalls?.get(item.attemptKey)?.permanent);
    if (stalled.length > 0 && this.#exits() && this.#releaseGate(agentId) !== null) this.#refuseStalls(agentId, stalled);
    const held = attempts.filter((item) => this.#proofPending(item));
    if (held.length > 0 && !this.#buyReadable(agentId)) this.#refuseBuys(agentId, held);
  }
  /** The F2 release gate (exit_build: live_armed, armed, idle, the exits capability and the owner's own RPC class), facts read fresh. */
  #releaseGate(agentId: string): PrivateExecutionGateRefusal | null {
    let facts: PrivateExecutionLiveFacts | undefined;
    try { facts = this.#options.readFacts(agentId); } catch { facts = undefined; }
    return this.#gate({ step: "exit_build", agentId, facts });
  }
  /** SF2 R3 gate: no read while the runtime is stopped or unreadable, and only on the owner's own RPC class. live_armed is NOT required:
   * proving a buy did not land executes nothing, and arming refuses while a reservation is open. */
  #buyReadable(agentId: string): boolean {
    try {
      const state = this.#options.readRuntime(agentId);
      if (!state) return false;
      const current = parseAgentState(state);
      if (current.agentId !== agentId || current.lifecycle !== "idle") return false;
      return privateRpcClassExecutable(this.#options.readFacts(agentId).rpcClass);
    } catch { return false; }
  }

  /** SF2 buy settlement (module comment, R3-R6): at most one held buy negative of this agent per pass. Never throws past a read; a
   * proof that does not hold writes nothing. */
  async #settleBuys(agentId: string, signal?: AbortSignal): Promise<void> {
    const o = this.#options;
    const attempts = this.#pruneSightings(agentId, o.journal.list(agentId));
    const open = attempts.filter((item) => this.#proofPending(item) && !this.#inflight.has(item.attemptKey));
    // Only this agent's entries are pruned (and only those no longer held as a buy negative or an unrelayed buy).
    let checks = this.#buys.get(agentId);
    if (checks) {
      for (const key of [...checks.keys()]) if (!open.some((item) => item.attemptKey === key)) checks.delete(key);
      if (checks.size === 0) { this.#buys.delete(agentId); checks = undefined; }
    }
    if (open.length === 0) return;
    const entries = (): Map<string, PrivateBuyCheck> => {
      let found = this.#buys.get(agentId);
      if (!found) { found = new Map(); this.#buys.set(agentId, found); }
      return found;
    };
    const blank = { failures: 0, untilMs: 0, counted: 0, countedReason: null, balance: null, lastSlot: null, firstAt: 0 };
    // Stopped, unreadable or not the owner's own RPC: no read and no write; every held buy negative shows gate_refused (#refuseBuys).
    if (!this.#buyReadable(agentId)) { this.#refuseBuys(agentId, open); return; }
    const now = this.#monotonic();
    const found = open.find((item) => now >= (checks?.get(item.attemptKey)?.untilMs ?? 0));
    const state = found?.engineState;
    if (!found || !state || found.swap.direction !== "buy" || (!negativeState(state) && state !== "awaiting_signature")) return;
    // The snapshot proven against; a sighting written below moves it to the journal's own copy (#sight).
    let attempt: PrivateSubmissionAttempt = found;
    const key = found.attemptKey; const mint = found.swap.outputMint;
    // M3.6 D6 K1: a buy Balchemy never received ends expired_not_landed (its blockhash is dead on the runner's own RPC) and its relay closes.
    const unrelayed = state === "awaiting_signature";
    const next: PrivateSubmissionState = unrelayed ? "expired_not_landed" : JOURNAL_STATE[state];
    const retry = (reason: RunnerBuyCheckReason): void => {
      const prior = entries().get(key) ?? { ...blank, reason };
      const failures = prior.failures + 1;
      const delay = Math.min(PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS, PRIVATE_LANDING_RELEASE_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20));
      entries().set(key, { ...prior, failures, untilMs: this.#monotonic() + delay, reason });
    };
    const settled = (): void => { const done = this.#buys.get(agentId); done?.delete(key); if (done?.size === 0) this.#buys.delete(agentId); };
    const dispute = (reason: string): void => {
      const written = this.#change(agentId, attempt, { state: "disputed", relay: "closed", reason: reasonText("runner", reason.replace(/^runner:/, "")) });
      if (written.state === "disputed") settled(); else retry("journal_unavailable");
    };
    // R4, last two steps: the terminal journal write, then the wallet lock this attempt owns.
    const finish = (): void => {
      const done = this.#change(agentId, attempt, { state: next, reason: PRIVATE_BUY_NOT_LANDED_REASON, ...(unrelayed ? { relay: "closed" as const } : {}) });
      if (done.state !== next) { retry("journal_unavailable"); return; }
      settled(); this.#releaseLock(attempt);
    };
    // A crash after the release and before the terminal write: a journaled buy's reservation is released only by R4 (after a proof),
    // so the next pass completes it without a new proof.
    let reservation: ReturnType<PrivateSubmissionOptions["ledger"]["reservation"]>;
    try { reservation = o.ledger.reservation(agentId, attempt.reservationId); } catch { retry("state_unavailable"); return; }
    if (!reservation) { dispute("runner:ledger:reservation_missing"); return; }
    if (reservation.state === "committed") { dispute("runner:ledger:reservation_committed"); return; }
    if (reservation.state === "released") { finish(); return; }
    // SF R10 carried across the scope change: the runner's own finalized read already showed this buy landed while Balchemy left it
    // unresolved (#closeStalls), or an earlier settlement pass did, in this process or (persisted on the attempt) before a restart.
    // A later null is never evidence against it, so no proof runs: R5 at once.
    if (this.#sighting(agentId, attempt) === "landed") { dispute(`runner:buy_landed_despite_${state}`); return; }
    let rpc: PrivateSettlementRpc | undefined;
    try { rpc = o.readSettlementRpc?.(agentId); } catch { rpc = undefined; }
    if (!rpc) { retry("rpc_missing"); return; }
    // C1: the durable probe stamp before the proof's reads; without it no proof runs in this pass.
    const stamped = this.#stamp(agentId, attempt);
    if (!stamped) { retry("journal_unavailable"); return; }
    attempt = stamped;
    let context: PrivateBuyNegativeContext;
    try {
      const positions = o.positions;
      context = { attempt, attempts, positions: positions ? positions.positions(agentId) : null, evicted: positions ? positions.evicted(agentId) : [],
        unmanagedMints: positions ? privateUnmanagedMints(positions.managedFrom(agentId)) : null };
    } catch { retry("state_unavailable"); return; }
    // The gate stops every proof read by read: after a stop no further read starts.
    const stop = (): boolean => signal?.aborted === true || this.#closed || !this.#buyReadable(agentId);
    const proof: PrivateBuyNegativeProof = await privateBuyNegativeProof(rpc, context, signal, stop);
    // As in R10: any read of this proof that returned the buy is a sighting, recorded in this process and durably on the journal
    // attempt (replacing the stamp) before every stop or gate check (a halt, an outage or a lagging status right after such a read
    // would otherwise drop it). `landed` is the R5 dispute below once the gate admits; until then it stays a `landed` sighting, so the
    // next pass (after a restart too) disputes it without a proof. A failed write keeps it in this process and the stamp on disk, and
    // decides nothing (journal_unavailable). Without a sighting the stamp is removed (#unstamp) before anything is decided.
    const persisted = this.#persistProbe(agentId, attempt, proof);
    if (!persisted) { if (!signal?.aborted && !this.#closed) retry("journal_unavailable"); return; }
    attempt = persisted;
    if (signal?.aborted || this.#closed) return;
    // Synchronously from here to the writes: the gate still admits and the journal attempt is exactly the proven snapshot.
    if (!this.#buyReadable(agentId)) { entries().set(key, { ...blank, ...entries().get(key), reason: "gate_refused" }); return; }
    let current: PrivateSubmissionAttempt | undefined;
    try { current = o.journal.list(agentId).find((item) => item.attemptKey === key); } catch { retry("state_unavailable"); return; }
    if (!current || JSON.stringify(current) !== JSON.stringify(attempt)) { retry("attempt_changed"); return; }
    if (proof.outcome === "landed") { dispute(`runner:buy_landed_despite_${state}`); return; }
    // R6: one counted result toward the permanent bound (same reason and balance at a strictly increasing F; the first and the last
    // counted result at least PRIVATE_BUY_CHECK_PERMANENT_SPAN_MS apart), then the dispute, else the back-off.
    const count = (reason: RunnerBuyCheckReason, slot: string, balance: string | null): void => {
      const prior = entries().get(key) ?? { ...blank, reason };
      const same = prior.countedReason === reason && prior.balance === balance && prior.lastSlot !== null;
      // F did not increase (a stuck or lagging finalized view): not counted, and never the moment the hold becomes permanent. The
      // bound is on the first and the LAST COUNTED result, so permanence is checked only when this result is counted (now is then
      // the time of the last counted result).
      if (same && BigInt(slot) <= BigInt(prior.lastSlot!)) { retry(reason); return; }
      const tally: Pick<PrivateBuyCheck, "counted" | "countedReason" | "balance" | "lastSlot" | "firstAt"> = same
        ? { ...prior, counted: prior.counted + 1, lastSlot: slot }
        : { counted: 1, countedReason: reason, balance, lastSlot: slot, firstAt: this.#monotonic() };
      entries().set(key, { ...prior, ...tally });
      if (tally.counted >= RUNNER_BUY_CHECK_PERMANENT_COUNT && this.#monotonic() - tally.firstAt >= PRIVATE_BUY_CHECK_PERMANENT_SPAN_MS) {
        dispute(`runner:buy_negative_unproven:${reason}`);
        return;
      }
      retry(reason);
    };
    // One sighting rule for R10 and SF2: after any sighting (R10's or this pass's own), absence is never evidence. Only a not_landed
    // from a transaction actually returned (landed and failed, meta.err: the only not_landed without an F of its own) may release
    // the spend; one from absence is transaction_appeared and never releases (fail closed: the spend stays reserved, Balchemy's
    // later record still applies, and the sighting is persisted on the attempt). It is COUNTED at its F (the bytes can no longer land), so
    // a sighting followed by a consistently null RPC reaches the R6 bound and becomes the dispute
    // runner:buy_negative_unproven:transaction_appeared (the owner's close-out and F2 handle it) instead of a hold forever.
    if (proof.outcome === "not_landed" && proof.finalizedSlot !== null && this.#sighting(agentId, attempt) !== undefined) {
      count("transaction_appeared", proof.finalizedSlot, null);
      return;
    }
    if (proof.outcome === "unproven") {
      if (!proof.counted || proof.finalizedSlot === null) { retry(proof.reason); return; }
      count(proof.reason, proof.finalizedSlot, proof.balance);
      return;
    }
    // R4: an outside credit keeps its mint on the watermark first, then the release, the terminal write and the lock.
    if (proof.outsideUnits !== null) {
      try {
        if (!o.positions) throw new Error("position ledger unavailable");
        o.positions.addOutsideMint(agentId, mint, this.#now());
      } catch { retry("state_unavailable"); return; }
    }
    try {
      o.ledger.release(agentId, attempt.reservationId, proof.outsideUnits !== null ? `s4:${state}:outside_${proof.outsideUnits}` : `s4:${state}`, this.#now());
    } catch (error: unknown) {
      if (error instanceof PrivateSpendLedgerError && (error.code === "reservation_committed" || error.code === "reservation_missing")) {
        dispute(`runner:ledger:${error.code}`);
        return;
      }
      retry("state_unavailable");
      return;
    }
    finish();
  }

  /** M3.6 slice 7, B1 (the sell twin of D6 K1): a sell Balchemy never received (privateSubmissionUnrelayed: its engine record still
   * awaits a signature) ends on the runner's own proof, also while the agent is disarmed. Behind the exits capability and a position
   * ledger; the gate is the buy settlement's (#buyReadable: not stopped, runtime readable, the owner's own RPC class; never live_armed: it
   * only reads and writes local state, never relays, resends, builds or signs). At most one per agent per pass, with the F2 back-off.
   * (1) The journaled wire's recentBlockhash is the stored one (otherwise never: permanent wire_blockhash_mismatch). (2) The position
   * still carries exactly this pending exit. (3) privateExitExpiryCheck (the expired_not_landed sell proof, #proveSellExpiry): the
   * blockhash is dead past lastValidBlockHeight + 150 on the runner's RPC, and one response at or past F shows the sell absent while the
   * one of its history witnesses (S1 and N1: privateSellWitnesses, the newest earlier completed trades of the wallet, the position's entry
   * buy last) is found finalized, and the sell is still absent at finalized. (4) Synchronously: the gate still admits and the attempt and the pending exit
   * are exactly as proven. (5) The terminal write expired_not_landed (s5c:not_landed_proven, relay closed), then the wallet lock. The
   * settlement pass right after it (#settleExit) proves the expiry again and fails the pending exit proven_negative, so the units return
   * to the position and the exit is planned again. Any failed check writes nothing and keeps the attempt held under its named check
   * (`runner trades`); arming refuses `submission_unrelayed` meanwhile.
   * Final audit S1, the bound: once PRIVATE_SELL_EXPIRY_BOUND is reached (#bookSellExpiry: the blockhash proven dead at three strictly
   * increasing F over at least 10 minutes, the witness never shown), steps (4)-(5) run with the reason PRIVATE_SELL_EXPIRY_UNPROVEN_REASON
   * instead: the bytes provably cannot land after F (the F2 release claim, never "did not land"), so the wallet lock may go, as F2 frees it
   * for a runner dispute; the settlement pass then holds the position runner:sell_expiry_unproven at once, whose only automatic way out is
   * the runner's own proof again, a sale found on chain, or the wallet balance ("not sold" only). */
  async #settleUnrelayedSells(agentId: string, signal?: AbortSignal): Promise<void> {
    if (!this.#exits()) return;
    const o = this.#options; const positions = o.positions;
    if (!positions) return;
    const open = o.journal.list(agentId).filter((item) => item.swap.direction === "sell" && privateSubmissionUnrelayed(item) && !this.#inflight.has(item.attemptKey));
    let sells = this.#sells.get(agentId);
    if (sells) {
      for (const key of [...sells.keys()]) if (!open.some((item) => item.attemptKey === key)) sells.delete(key);
      if (sells.size === 0) { this.#sells.delete(agentId); sells = undefined; }
    }
    if (open.length === 0) return;
    const entries = (): Map<string, PrivateSellExpiryCheck> => {
      let found = this.#sells.get(agentId);
      if (!found) { found = new Map(); this.#sells.set(agentId, found); }
      return found;
    };
    const blank = { failures: 0, untilMs: 0, permanent: false, counted: 0, lastSlot: null, firstAt: 0 };
    // Stopped, unreadable or not the owner's own RPC: no read; every such sell shows gate_refused (its back-off and count unchanged).
    if (!this.#buyReadable(agentId)) {
      for (const item of open) {
        const prior = entries().get(item.attemptKey);
        if (!prior?.permanent) entries().set(item.attemptKey, { ...blank, ...prior, reason: "gate_refused" });
      }
      return;
    }
    const now = this.#monotonic();
    const attempt = open.find((item) => now >= (sells?.get(item.attemptKey)?.untilMs ?? 0));
    if (!attempt || attempt.swap.direction !== "sell") return;
    const key = attempt.attemptKey; const positionId = attempt.swap.positionId;
    // The count toward the S1 bound survives every other failure (a failed check only backs off).
    const retry = (reason: RunnerLandingReleaseReason): void => {
      const prior = this.#sells.get(agentId)?.get(key);
      const failures = (prior?.failures ?? 0) + 1;
      const delay = Math.min(PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS, PRIVATE_LANDING_RELEASE_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20));
      entries().set(key, { ...blank, ...prior, failures, untilMs: this.#monotonic() + delay, reason, permanent: false });
    };
    // 1. The wire's own lifetime is the stored blockhash (no durable nonce is possible: private-solana-tx-validator.ts).
    if (wireBlockhash(attempt.wireB64) !== attempt.blockhash) { entries().set(key, { ...blank, untilMs: Infinity, reason: "wire_blockhash_mismatch", permanent: true }); return; }
    // 2. The position still carries exactly this pending exit (its entry buy is the fallback history witness).
    const pendingOf = (): PrivatePosition | undefined => {
      const position = positions.position(agentId, positionId);
      return position && position.state !== "closed" && position.pendingExit?.reservationId === attempt.reservationId ? position : undefined;
    };
    let position: PrivatePosition | undefined;
    try { position = pendingOf(); } catch { retry("state_unavailable"); return; }
    if (!position) { retry("state_unavailable"); return; }
    let rpc: PrivateSettlementRpc | undefined;
    try { rpc = o.readSettlementRpc?.(agentId, "exit"); } catch { rpc = undefined; }
    if (!rpc) { retry("rpc_missing"); return; }
    // 3. The expired sell proof (S1: the sell witness rule); the gate stops it read by read.
    const stop = (): boolean => signal?.aborted === true || this.#closed || !this.#buyReadable(agentId);
    let witness: readonly string[];
    try { witness = privateSellWitnesses(attempt, o.journal.list(agentId), position); } catch { retry("state_unavailable"); return; }
    const result = await privateExitExpiryCheck(rpc, attempt, witness, signal, stop);
    if (signal?.aborted || this.#closed) return;
    if (!this.#buyReadable(agentId)) { entries().set(key, { ...blank, ...entries().get(key), reason: "gate_refused" }); return; }
    // S1: a proof that did not hold backs off (#bookSellExpiry); only its bound ends the sell, with a reason that claims no more.
    let ended: string = PRIVATE_SELL_NOT_LANDED_REASON;
    if (result.outcome !== "proven") {
      // The bound ends it only from a run that itself proved the blockhash dead (checks 1-2 at its F).
      if (!this.#bookSellExpiry(entries(), key, result) || result.deadSlot === null) return;
      ended = PRIVATE_SELL_EXPIRY_UNPROVEN_REASON;
    }
    // 4. Synchronously from here to the lock close: the attempt and the pending exit are exactly as proven.
    let current: PrivateSubmissionAttempt | undefined; let still: PrivatePosition | undefined;
    try { current = o.journal.list(agentId).find((item) => item.attemptKey === key); still = pendingOf(); } catch { retry("state_unavailable"); return; }
    if (!current || JSON.stringify(current) !== JSON.stringify(attempt) || !still || JSON.stringify(still.pendingExit) !== JSON.stringify(position.pendingExit)) {
      retry("attempt_changed"); return;
    }
    // 5. The terminal write, then the wallet lock this attempt owns; the settlement pass clears the pending exit on its own proof.
    const done = this.#change(agentId, attempt, { state: "expired_not_landed", relay: "closed", reason: ended });
    if (done.state !== "expired_not_landed") { retry("journal_unavailable"); return; }
    const finished = this.#sells.get(agentId); finished?.delete(key); if (finished?.size === 0) this.#sells.delete(agentId);
    this.#releaseLock(attempt);
  }

  /** Final audit part 3 SF-A (the sell twin of R10; module comment): at most one sell Balchemy relayed and leaves unresolved
   * (privateSubmissionEngineUnresolvedSell) per agent per pass ends on the runner's own proof. Behind the exits capability and a position
   * ledger, under the B1 gate (#buyReadable: not stopped, runtime readable, the owner's own RPC class; never live_armed: it only reads and
   * writes local state, never relays, resends, builds or signs, and arming refuses while the sell is open, so it must run disarmed).
   * (1) The journaled wire's recentBlockhash is the stored one (otherwise never: permanent wire_blockhash_mismatch).
   * (2) Grace: checks 1-2 of the expiry proof (privateBlockhashExpired: finalized height > lastValidBlockHeight + 150, the blockhash rejected
   *     at or past F) start a process-local clock; nothing is decided before PRIVATE_SELL_STALL_GRACE_MS after it (`stall_grace`). From then
   *     the position is held runner:sell_engine_unresolved (re-checked; a sale only from the sell's own finalized transaction).
   * (3) The sell's own finalized getTransaction: present with exactly the journaled signature and meta.err null -> terminal `completed`
   *     (s5c:engine_unresolved_landed), with an error -> terminal `failed_onchain` (s5c:engine_unresolved_failed), relay closed, then the
   *     wallet lock (the bytes landed: nothing more can land). The settlement pass right after settles the position from its own proof of
   *     that transaction exactly as for Balchemy's terminal states (completeExit only with privateSellProceeds' exact debit).
   * (4) Absent: the position must still carry exactly this pending exit; privateExitExpiryCheck with privateSellWitnesses (S1/N1, four
   *     checks). `proven` -> (5); every other result is booked by #bookSellExpiry (SF1: only witness_unproven doubles and counts) and, at
   *     PRIVATE_SELL_EXPIRY_BOUND, ends exactly as S1: terminal with PRIVATE_SELL_EXPIRY_UNPROVEN_REASON, the lock, and the settlement pass
   *     holds runner:sell_expiry_unproven (its balance path, "not sold" only).
   * (5) Synchronously: the gate still admits, the attempt and the pending exit are exactly as proven; the terminal write expired_not_landed
   *     (s5c:engine_unresolved_not_landed, relay closed, never resent); then the wallet lock; then failExit proven_negative, so the units
   *     return and the exit is planned again (a failed failExit is redone by the settlement pass on its own proof). The engine still
   *     counts the sell as pending (local_position.rs), so a new sell of THIS position may be refused position_insufficient until Balchemy
   *     resolves it; every other position's sells run again. Balchemy's later report is read by #watchLateSells. */
  async #settleStalledSells(agentId: string, signal?: AbortSignal): Promise<void> {
    if (!this.#exits()) return;
    const o = this.#options; const positions = o.positions;
    if (!positions) return;
    const open = o.journal.list(agentId).filter((item) => privateSubmissionEngineUnresolvedSell(item) && !this.#inflight.has(item.attemptKey));
    let checks = this.#stalledSells.get(agentId);
    if (checks) {
      for (const key of [...checks.keys()]) if (!open.some((item) => item.attemptKey === key)) checks.delete(key);
      if (checks.size === 0) { this.#stalledSells.delete(agentId); checks = undefined; }
    }
    if (open.length === 0) return;
    const entries = (): Map<string, PrivateStalledSellCheck> => {
      let found = this.#stalledSells.get(agentId);
      if (!found) { found = new Map(); this.#stalledSells.set(agentId, found); }
      return found;
    };
    const blank: Omit<PrivateStalledSellCheck, "reason"> = { failures: 0, untilMs: 0, permanent: false, counted: 0, lastSlot: null, firstAt: 0, graceFrom: null };
    // Stopped, unreadable or not the owner's own RPC: no read; every such sell shows gate_refused (its clock, back-off and count unchanged).
    if (!this.#buyReadable(agentId)) {
      for (const item of open) {
        const prior = entries().get(item.attemptKey);
        if (!prior?.permanent) entries().set(item.attemptKey, { ...blank, ...prior, reason: "gate_refused" });
      }
      return;
    }
    const now = this.#monotonic();
    const attempt = open.find((item) => now >= (checks?.get(item.attemptKey)?.untilMs ?? 0));
    if (!attempt || attempt.swap.direction !== "sell") return;
    const key = attempt.attemptKey; const positionId = attempt.swap.positionId;
    const prior = (): PrivateStalledSellCheck | undefined => this.#stalledSells.get(agentId)?.get(key);
    // A local-state failure backs off (F2 doubling); the grace clock and the count toward the S1 bound survive it.
    const retry = (reason: RunnerLandingReleaseReason): void => {
      const failures = (prior()?.failures ?? 0) + 1;
      const delay = Math.min(PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS, PRIVATE_LANDING_RELEASE_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20));
      entries().set(key, { ...blank, ...prior(), failures, untilMs: this.#monotonic() + delay, reason, permanent: false });
    };
    // An RPC wait (unavailable, behind, the blockhash not dead yet, an unreadable answer) is retried after PRIVATE_SELL_EXPIRY_RETRY_MS (SF1).
    const wait = (reason: RunnerLandingReleaseReason): void => {
      entries().set(key, { ...blank, ...prior(), untilMs: this.#monotonic() + PRIVATE_SELL_EXPIRY_RETRY_MS, reason, permanent: false });
    };
    // 1. The wire's own lifetime is the stored blockhash (no durable nonce is possible: private-solana-tx-validator.ts).
    if (wireBlockhash(attempt.wireB64) !== attempt.blockhash) { entries().set(key, { ...blank, untilMs: Infinity, reason: "wire_blockhash_mismatch", permanent: true }); return; }
    let rpc: PrivateSettlementRpc | undefined;
    try { rpc = o.readSettlementRpc?.(agentId, "exit"); } catch { rpc = undefined; }
    if (!rpc) { retry("rpc_missing"); return; }
    const stop = (): boolean => signal?.aborted === true || this.#closed || !this.#buyReadable(agentId);
    const halted = (): boolean => {
      if (signal?.aborted || this.#closed) return true;
      if (!this.#buyReadable(agentId)) { entries().set(key, { ...blank, ...prior(), reason: "gate_refused" }); return true; }
      return false;
    };
    const pendingOf = (): PrivatePosition | undefined => {
      const position = positions.position(agentId, positionId);
      return position && position.state !== "closed" && position.pendingExit?.reservationId === attempt.reservationId ? position : undefined;
    };
    // 2. The grace clock: started by checks 1-2 on the runner's own finalized view, then PRIVATE_SELL_STALL_GRACE_MS.
    const graceFrom = prior()?.graceFrom ?? null;
    if (graceFrom === null) {
      let slot: bigint | null;
      try { slot = await privateBlockhashExpired(rpc, attempt, stop, signal); } catch { if (!halted()) wait("rpc_unavailable"); return; }
      if (halted()) return;
      if (slot === null) { wait("expiry_unproven"); return; }
      const at = this.#monotonic();
      entries().set(key, { ...blank, ...prior(), graceFrom: at, untilMs: at + PRIVATE_SELL_STALL_GRACE_MS, reason: "stall_grace", permanent: false });
      return;
    }
    if (this.#monotonic() < graceFrom + PRIVATE_SELL_STALL_GRACE_MS) {
      entries().set(key, { ...blank, ...prior(), untilMs: graceFrom + PRIVATE_SELL_STALL_GRACE_MS, reason: "stall_grace", permanent: false });
      return;
    }
    // The wait is named on the position from here (a re-checked hold; the pending exit stays, so no second sell of it).
    try {
      const position = pendingOf();
      if (position && position.state === "open") {
        positions.failExit(agentId, positionId, attempt.reservationId, "unknown", PRIVATE_SELL_ENGINE_UNRESOLVED_HOLD, this.#now());
      }
    } catch { /* Readback only; the proof below does not depend on it. */ }
    // 3. The sell's own finalized transaction on the runner's RPC.
    let transaction: unknown;
    try { transaction = await rpc.getTransaction(attempt.signature, { commitment: "finalized" }, signal); } catch { if (!halted()) wait("rpc_unavailable"); return; }
    if (halted()) return;
    // Synchronously from each decision to its writes: the attempt is exactly the one proven against.
    const unchanged = (): boolean => {
      try { return JSON.stringify(o.journal.list(agentId).find((item) => item.attemptKey === key)) === JSON.stringify(attempt); } catch { return false; }
    };
    if (transaction !== null && transaction !== undefined) {
      const body = isRecord(transaction) && isRecord(transaction.transaction) ? transaction.transaction : undefined;
      const meta = isRecord(transaction) && isRecord(transaction.meta) ? transaction.meta : undefined;
      const signatures = body?.signatures;
      if (!meta || !("err" in meta) || !Array.isArray(signatures) || signatures.length !== 1 || signatures[0] !== attempt.signature) {
        wait("transaction_malformed"); return;
      }
      const state: PrivateSubmissionState = meta.err === null ? "completed" : "failed_onchain";
      if (!unchanged()) { retry("attempt_changed"); return; }
      const done = this.#change(agentId, attempt, { state, relay: "closed",
        reason: state === "completed" ? PRIVATE_SELL_ENGINE_UNRESOLVED_LANDED_REASON : PRIVATE_SELL_ENGINE_UNRESOLVED_FAILED_REASON });
      if (done.state !== state) { retry("journal_unavailable"); return; }
      const finished = this.#stalledSells.get(agentId); finished?.delete(key); if (finished?.size === 0) this.#stalledSells.delete(agentId);
      this.#releaseLock(attempt);
      return;
    }
    // 4. Absent: the four-check expiry proof against the position's pending exit (its entry buy is the fallback history witness).
    let position: PrivatePosition | undefined; let witness: readonly string[];
    try {
      position = pendingOf();
      if (!position) { retry("state_unavailable"); return; }
      witness = privateSellWitnesses(attempt, o.journal.list(agentId), position);
    } catch { retry("state_unavailable"); return; }
    const result = await privateExitExpiryCheck(rpc, attempt, witness, signal, stop);
    if (halted()) return;
    let ended: string = PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON;
    if (result.outcome !== "proven") {
      const graceKept = prior()?.graceFrom ?? graceFrom;
      const bound = this.#bookSellExpiry(entries(), key, result);
      const booked = prior();
      if (booked) entries().set(key, { ...booked, graceFrom: graceKept });
      // The bound ends it only from a run that itself proved the blockhash dead (checks 1-2 at its F).
      if (!bound || result.deadSlot === null) return;
      ended = PRIVATE_SELL_EXPIRY_UNPROVEN_REASON;
    }
    // 5. Synchronously from here to the last write: the gate admits, the attempt and the pending exit are exactly as proven.
    if (!this.#buyReadable(agentId)) { entries().set(key, { ...blank, ...prior(), reason: "gate_refused" }); return; }
    let still: PrivatePosition | undefined;
    try { still = pendingOf(); } catch { retry("state_unavailable"); return; }
    if (!unchanged() || !still || JSON.stringify(still.pendingExit) !== JSON.stringify(position.pendingExit)) { retry("attempt_changed"); return; }
    const done = this.#change(agentId, attempt, { state: "expired_not_landed", relay: "closed", reason: ended });
    if (done.state !== "expired_not_landed") { retry("journal_unavailable"); return; }
    const finished = this.#stalledSells.get(agentId); finished?.delete(key); if (finished?.size === 0) this.#stalledSells.delete(agentId);
    this.#releaseLock(attempt);
    // Only the proof frees the units; the bound leaves the settlement pass to hold runner:sell_expiry_unproven.
    if (ended !== PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON) return;
    try { positions.failExit(agentId, positionId, attempt.reservationId, "proven_negative", PRIVATE_SELL_ENGINE_UNRESOLVED_NOT_LANDED_REASON, this.#now()); }
    catch { /* The settlement pass proves it again and clears the exit then. */ }
  }

  /** SF-A: Balchemy's later report on a sell the runner itself ended while Balchemy left it unresolved (privateSubmissionLateWatched: the
   * not-landed proof or the S1 bound, engine record still unresolved). At most one status read per agent per pass, each watched sell at
   * most once per PRIVATE_SELL_LATE_WATCH_MS, without the wallet lock and never relayed, resent or gated (status is server truth, as for
   * every attempt). The record is pinned to the journaled signature and lastValidBlockHeight; a landing (completed or a finalized-success
   * state), the engine's own negative, or an observed re-signed copy is recorded once (journal.recordLateReport), which ends the watch.
   * Nothing is settled here: a landing is the contradiction the settlement pass and #holdLateLandings hold for the owner, a negative
   * agrees with the runner's proof and settles nothing again. A journal that evicts the attempt ends the watch too. */
  async #watchLateSells(agentId: string, signal?: AbortSignal): Promise<void> {
    if (!this.#exits()) return;
    const o = this.#options;
    const watched = o.journal.list(agentId).filter((item) => privateSubmissionLateWatched(item) && !this.#inflight.has(item.attemptKey));
    let due = this.#late.get(agentId);
    if (due) {
      for (const key of [...due.keys()]) if (!watched.some((item) => item.attemptKey === key)) due.delete(key);
      if (due.size === 0) { this.#late.delete(agentId); due = undefined; }
    }
    const now = this.#monotonic();
    const attempt = watched.find((item) => now >= (due?.get(item.attemptKey) ?? 0));
    if (!attempt) return;
    const lease = this.#lease(agentId); if (!lease) return;
    let entries = this.#late.get(agentId);
    if (!entries) { entries = new Map(); this.#late.set(agentId, entries); }
    entries.set(attempt.attemptKey, now + PRIVATE_SELL_LATE_WATCH_MS);
    let response: RunnerExecutionStatusResponse;
    try { response = await this.#client(agentId, lease, attempt).status({ reservationId: attempt.reservationId, buildDigest: attempt.buildDigest }, lease.epoch, signal,
      attempt.signature); }
    catch { return; }
    if (signal?.aborted || this.#closed || response.outcome === "refused") return;
    const record = response.submission;
    // A record for other bytes is never applied (and a terminal attempt is never disputed).
    if (record.signature !== attempt.signature || record.lastValidBlockHeight !== attempt.lastValidBlockHeight) return;
    const observed = record.observedSignature !== "" && record.observedSignature !== attempt.signature ? record.observedSignature : null;
    if (observed === null && !PRIVATE_SUBMISSION_LANDING_ENGINE_STATES.includes(record.state) && record.state !== "failed_onchain"
      && record.state !== "expired_not_landed") return;
    // SF-A: the daemon wires the journal itself; a view without this write records nothing (the watch then reads again later).
    if (!o.journal.recordLateReport) return;
    try { o.journal.recordLateReport(agentId, attempt.attemptKey, attempt, { engineState: record.state, observedSignature: observed }, Math.max(this.#now(), attempt.updatedAt)); }
    catch { /* Read again after the next interval. */ }
  }

  /** SF-A: a sell the runner itself ended negative while Balchemy left it unresolved (privateSubmissionLateContradicted: the not-landed
   * proof, s5c:engine_unresolved_not_landed; the S1 bound, s5c:expiry_unproven, once its pending exit was cleared by the balance path's
   * "not sold" or a later proof; or the runner's own failed_onchain read, s5c:engine_unresolved_failed, whose units returned) that Balchemy
   * later reported landed, or landed as a re-signed copy: the runner's word is contradicted, so its position is held for the owner again
   * (positions.holdLateExit: that sell is its pending exit again) with lateHoldReason's reason. Never a sale and never "not sold" on
   * either word: the hold table's rows decide (a sale only from the sell's own finalized transaction). Only an open position with no
   * pending exit is held; otherwise it is tried again on a later pass (a later exit of the position first settles on its own proof; the
   * slow timer keeps such passes coming while the hold is owed, privateSubmissionLateHoldOwed). While the position still carries the sell
   * (the bound before any balance settlement, or a failed read before the settlement pass ran) the settlement pass's completed rules
   * name it instead. Local reads and at most one ledger write per sell; nothing is read from the network. */
  #holdLateLandings(agentId: string): void {
    const positions = this.#options.positions; const holdLateExit = positions?.holdLateExit?.bind(positions);
    if (!this.#exits() || !positions || !holdLateExit) return;
    for (const attempt of this.#options.journal.list(agentId)) {
      if (attempt.swap.direction !== "sell" || !privateSubmissionLateContradicted(attempt)) continue;
      try {
        const position = positions.position(agentId, attempt.swap.positionId);
        if (!privateSubmissionLateHoldOwed(attempt, position) || !position || position.state !== "open" || position.pendingExit !== null) continue;
        holdLateExit(agentId, position.positionId, { reservationId: attempt.reservationId, units: attempt.swap.grossInUnits }, lateHoldReason(attempt), this.#now());
      } catch { /* Tried again on a later pass (the slow timer keeps them coming while the hold is owed). */ }
    }
  }

  /** Runner-side proof that an expired exit sell never landed and never can, from the agent's own RPC only (privateExitExpiryCheck,
   * private-position-balance.ts, shared with the wallet-balance settlement): checks 1-2 (the blockhash dead past lastValidBlockHeight +
   * PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS on a finalized bank F, and rejected by a backend at or past F), 3 (one response at or past F shows the
   * sell absent and a history witness finalized without error; S1 and N1: privateSellWitnesses, the newest earlier completed trades of the
   * wallet, no longer only the position's entry buy), 4 (still absent at finalized). Final audit S1: every result is booked
   * (#bookSellExpiry): proven clears the check; anything else waits (SF1: witness_unproven 30 s doubling to 10 min, every other reason
   * PRIVATE_SELL_EXPIRY_RETRY_MS; no proof read meanwhile; #settleExit still reads the sell itself), and "bound" once
   * PRIVATE_SELL_EXPIRY_BOUND is reached. Null when stopped (nothing booked). */
  async #proveSellExpiry(agentId: string, rpc: PrivateSettlementRpc, attempt: PrivateSubmissionAttempt, position: PrivatePosition,
    signal?: AbortSignal): Promise<"proven" | "bound" | "unproven" | null> {
    // S1: inside the back-off the expiry proof reads nothing (the one getTransaction of #settleExit still runs every pass, so a sell that
    // appears at finalized settles at once); before S1 these four reads ran every 5 s for as long as the sell stayed absent.
    const backoff = this.#expiries.get(agentId)?.get(attempt.attemptKey);
    if (backoff && this.#monotonic() < backoff.untilMs) return "unproven";
    const stop = (): boolean => signal?.aborted === true || this.#closed;
    let witness: readonly string[];
    try { witness = privateSellWitnesses(attempt, this.#options.journal.list(agentId), position); } catch { witness = [position.entry.signature]; }
    const result = await privateExitExpiryCheck(rpc, attempt, witness, signal, stop);
    if (stop()) return null;
    if (result.outcome === "proven") {
      const done = this.#expiries.get(agentId); done?.delete(attempt.attemptKey); if (done?.size === 0) this.#expiries.delete(agentId);
      return "proven";
    }
    let entries = this.#expiries.get(agentId);
    if (!entries) { entries = new Map(); this.#expiries.set(agentId, entries); }
    return this.#bookSellExpiry(entries, attempt.attemptKey, result) ? "bound" : "unproven";
  }
  /** Final audit S1: books one expiry proof that did not hold into its process-local check: its wait and the count toward
   * PRIVATE_SELL_EXPIRY_BOUND. SF1: only `witness_unproven` (the blockhash dead, the history witness not shown: an RPC whose history
   * is short, which a quick retry will not change) backs off, 30 s doubling to 10 min (`failures` counts these, plus the local-state
   * retries of #settleUnrelayedSells); every other reason (expiry_unproven: the blockhash not dead yet; rpc_unavailable, rpc_lagging:
   * the RPC down or behind; transaction_appeared) waits PRIVATE_SELL_EXPIRY_RETRY_MS and adds no failure, so a stop-loss is re-proven
   * soon after the RPC recovers. Counted only `witness_unproven` with the blockhash proven dead, at an F above the last counted one (a
   * stuck finalized view never counts); a `transaction_appeared` (the RPC showed the sell) restarts the count and the doubling; any other
   * reason neither counts nor restarts it. True once the bound is reached: RUNNER_BUY_CHECK_PERMANENT_COUNT counted results, the first
   * and the last at least PRIVATE_BUY_CHECK_PERMANENT_SPAN_MS apart (the waits never shorten that span). The count is process-local: a
   * restart starts it again (it waits longer, never less). */
  #bookSellExpiry(entries: Map<string, PrivateSellExpiryCheck>, key: string, result: Extract<PrivateExitExpiryCheck, { outcome: "unproven" }>): boolean {
    const prior = entries.get(key); const now = this.#monotonic();
    const witness = result.reason === "witness_unproven";
    const failures = result.reason === "transaction_appeared" ? 0 : (prior?.failures ?? 0) + (witness ? 1 : 0);
    const delay = witness ? Math.min(PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS, PRIVATE_LANDING_RELEASE_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20))
      : PRIVATE_SELL_EXPIRY_RETRY_MS;
    let counted = prior?.counted ?? 0; let lastSlot = prior?.lastSlot ?? null; let firstAt = prior?.firstAt ?? 0;
    if (result.reason === "transaction_appeared") { counted = 0; lastSlot = null; firstAt = 0; }
    else if (witness && result.deadSlot !== null && (lastSlot === null || result.deadSlot > BigInt(lastSlot))) {
      if (counted === 0) firstAt = now;
      counted += 1; lastSlot = result.deadSlot.toString();
    }
    entries.set(key, { failures, untilMs: now + delay, reason: result.reason, permanent: false, counted, lastSlot, firstAt });
    return counted >= PRIVATE_SELL_EXPIRY_BOUND.count && now - firstAt >= PRIVATE_SELL_EXPIRY_BOUND.spanMs;
  }

  async #reconcileAttempt(agentId: string, attempt: PrivateSubmissionAttempt, signal?: AbortSignal): Promise<void> {
    if (runnerDisputed(attempt) || this.#inflight.has(attempt.attemptKey)) return;
    // SF R10: a buy released while Balchemy left it unresolved no longer holds its wallet: its status is still read, without the lock
    // (another attempt of the wallet, a sell, may own it now), and it is never resent.
    // The wallet lock is re-taken after a restart and kept until a terminal state.
    if (!privateSubmissionReleased(attempt)) {
      const held = this.#locks.get(attempt.walletAddress);
      if (held) {
        try { held.lock.assertValid(); }
        catch { this.#locks.delete(attempt.walletAddress); try { held.lock.close(); } catch { /* Released. */ } return; }
      }
      else {
        try { this.#locks.set(attempt.walletAddress, { attemptKey: attempt.attemptKey, lock: RunnerKernelLock.acquireWallet(this.#options.directory, attempt.walletAddress) }); }
        catch { return; }
      }
    }
    // SF2: a held buy negative reads Balchemy status at the settlement cadence only: never inside its #settleBuys back-off. A refused
    // hold (gate_refused: its proof cannot run) reads it once per watch, whatever other agents keep armed: the read itself moves the
    // next one a full PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS ahead (#refuseBuys keeps it), and it is due up to one production poll
    // interval early, because the watch timer may fire a few ms before its due time. A later server `completed` is still seen.
    if (privateBuyNegativeUnconfirmed(attempt)) {
      const entries = this.#buys.get(agentId); const check = entries?.get(attempt.attemptKey); const now = this.#monotonic();
      const refused = check?.reason === "gate_refused";
      if (check && now + (refused ? PRIVATE_SUBMISSION_POLL_MS : 0) < check.untilMs) return;
      if (entries && check && refused && !this.#buyReadable(agentId)) entries.set(attempt.attemptKey, { ...check, untilMs: now + PRIVATE_LANDING_RELEASE_BACKOFF_MAX_MS });
    }
    const lease = this.#lease(agentId); if (!lease) return;
    let response: RunnerExecutionStatusResponse;
    // The journaled signature is pinned: a record for other bytes is never applied.
    try { response = await this.#client(agentId, lease, attempt).status({ reservationId: attempt.reservationId, buildDigest: attempt.buildDigest }, lease.epoch, signal,
      attempt.signature); }
    catch { return; }
    if (response.outcome === "refused") { this.#change(agentId, attempt, { reason: reasonText("status", response.reasonCode) }); return; }
    const current = this.#apply(agentId, attempt, response.submission);
    // An observed copy already landed: these bytes are never relayed again.
    // SF2 R7: never resent after Balchemy reported the buy failed or expired (R1 also closed its relay).
    // SF R10: a released buy is never resent (its bytes provably cannot land after its F).
    if (!unfinished(current) || runnerDisputed(current) || privateSubmissionReleased(current) || current.observedSignature !== null
      || (current.state !== "signed" && current.state !== "submitted_unknown") || negativeState(current.engineState) || current.relay !== "open") return;
    // Phase 1 audit M1: the blockhash-expiry relay close runs BEFORE the resend count and spacing, so an attempt whose resends are
    // exhausted still has its relay closed once its blockhash expired (before, it returned here first, its relay stayed open forever
    // and exits-only arming after a restart was refused for it). The close is a local fact; it releases nothing.
    const rpc = this.#options.readRpc(agentId); if (!rpc) return;
    let height: bigint;
    try { height = await rpc.getBlockHeight({ commitment: "confirmed" }, signal); } catch { return; }
    if (height >= BigInt(current.lastValidBlockHeight)) { this.#change(agentId, current, { relay: "closed", reason: "runner_blockhash_expired" }); return; }
    if (current.submits >= 1 + PRIVATE_SUBMISSION_MAX_RESENDS || !(this.#now() - current.lastSubmitAt >= PRIVATE_SUBMISSION_RESEND_SPACING_MS)) return;
    const live = this.#lease(agentId); if (!live || identity(live) !== identity(lease) || signal?.aborted || this.#closed) return;
    // An identical resend is a relay: held while disarmed or stopped (an entries pause never holds it).
    const relayHeld = this.#gate({ step: "relay", agentId });
    if (relayHeld) { if (current.reason !== reasonText("gate", relayHeld)) this.#change(agentId, current, { reason: reasonText("gate", relayHeld) }); return; }
    // Counted and timed durably before the call; the bytes are the stored ones, never re-signed.
    const counted = this.#change(agentId, current, { submits: current.submits + 1, lastSubmitAt: Math.max(this.#now(), current.lastSubmitAt) });
    if (counted.submits !== current.submits + 1) return;
    await this.#relay(agentId, counted, live, current.engineState !== null && ENGINE_HOLDS.includes(current.engineState), signal);
  }

  /** One relay of the stored bytes (already counted in the journal). Every outcome is journaled; nothing is released. */
  async #relay(agentId: string, attempt: PrivateSubmissionAttempt, lease: Readonly<RunnerRuntimeActiveLease>, resendIdentical: boolean,
    signal?: AbortSignal): Promise<PrivateSubmissionAttempt> {
    const request: RunnerExecutionSubmitRequest = { reservationId: attempt.reservationId, buildDigest: attempt.buildDigest,
      walletBindingId: attempt.walletBindingId, signedTransactionB64: attempt.wireB64, attemptKey: attempt.attemptKey, resendIdentical };
    let response: RunnerExecutionSubmitResponse;
    const held: { refusal: PrivateExecutionGateRefusal | null } = { refusal: null };
    this.#inflight.add(attempt.attemptKey);
    try { response = await this.#client(agentId, lease, attempt, held).submit(request, lease.epoch, signal); }
    catch {
      // The signer refused before any submit proof existed: no submit request was made, so nothing is unknown.
      if (held.refusal) return this.#change(agentId, attempt, { reason: reasonText("gate", held.refusal) });
      return this.#change(agentId, attempt, { state: attempt.state === "signed" ? "submitted_unknown" : attempt.state, reason: "submit_outcome_unknown" });
    } finally { this.#inflight.delete(attempt.attemptKey); }
    if (response.outcome === "refused") {
      const code = response.reasonCode;
      return this.#change(agentId, attempt, { reason: reasonText("submit", code),
        ...(RELAY_FINAL.includes(code) || RELAY_FINAL_PREFIX.test(code) ? { relay: "closed" as const } : {}) });
    }
    return this.#apply(agentId, attempt, response.submission);
  }

  /** Applies one server-proven engine record. Settlement precedes the terminal journal write; the lock goes last. */
  #apply(agentId: string, attempt: PrivateSubmissionAttempt, submission: Readonly<RunnerExecutionSubmission>): PrivateSubmissionAttempt {
    if (runnerDisputed(attempt) || isPrivateSubmissionTerminal(attempt.state)) return attempt;
    // A landed copy signed outside this runner: recorded once, and then always reported by the server.
    const observed = submission.observedSignature !== "" ? submission.observedSignature : null;
    const copy = observed !== null && attempt.observedSignature === null ? { observedSignature: observed } : {};
    const dispute = (reason: string): PrivateSubmissionAttempt => this.#change(agentId, attempt, { state: "disputed", engineState: submission.state, relay: "closed",
      reason, ...copy });
    if (submission.state !== "awaiting_signature" && submission.signature !== attempt.signature) return dispute("runner:signature_mismatch");
    if (submission.lastValidBlockHeight !== attempt.lastValidBlockHeight) return dispute("runner:block_height_mismatch");
    if (submission.resignedCopyObserved !== (observed !== null) || (attempt.observedSignature !== null && observed !== attempt.observedSignature)) {
      return dispute("runner:observed_signature_mismatch");
    }
    // Nothing is released for a record with an observed copy: a failed copy is held for the owner, never settled here.
    if (observed !== null && (submission.state === "failed_onchain" || submission.state === "expired_not_landed")) return dispute("runner:observed_copy_not_landed");
    const next = JOURNAL_STATE[submission.state];
    if (!privateSubmissionTransitionAllowed(attempt.state, next)) return this.#change(agentId, attempt, { engineState: submission.state, ...copy });
    // SF2 R1: a buy's server-reported negative releases nothing until the runner proves it on its own RPC (#settleBuys). The
    // attempt keeps its state and wallet lock, its reservation stays reserved, and its relay closes (R7).
    if (attempt.swap.direction === "buy" && negativeState(submission.state)) {
      return this.#change(agentId, attempt, { engineState: submission.state, relay: "closed", reason: PRIVATE_BUY_NEGATIVE_UNCONFIRMED_REASON, ...copy });
    }
    if (isPrivateSubmissionTerminal(next)) {
      const now = this.#now();
      // S5c: an exit sell has no spend reservation; its position settles in the settlement pass after the terminal write.
      if (attempt.swap.direction === "buy") {
        // SF R10: Balchemy's `completed` for a buy the runner released on its own proof contradicts that proof. Its mint is kept off
        // the balance settlement for good first (the watermark's outside mints; without a watermark, the exit worker records this
        // completed buy as pre-enable, and #retain keeps it journaled until then). A failure writes nothing: the buy stays released
        // and non-terminal (new buys stay held) and the next status read retries.
        const positions = this.#options.positions;
        if (privateSubmissionReleased(attempt) && positions) {
          try { if (positions.managedFrom(agentId)) positions.addOutsideMint(agentId, attempt.swap.outputMint, now); }
          catch { return attempt; }
        }
        try {
          // Only `completed` reaches here for a buy (SF2 R1 above holds its negatives).
          this.#options.ledger.commit(agentId, attempt.reservationId, "s4:completed", now);
        } catch (error: unknown) {
          if (error instanceof PrivateSpendLedgerError && ["reservation_committed", "reservation_released", "reservation_missing"].includes(error.code)) {
            return dispute(reasonText("runner:ledger", error.code));
          }
          return attempt;
        }
      }
      const done = this.#change(agentId, attempt, { state: next, engineState: submission.state,
        reason: observed !== null ? PRIVATE_SUBMISSION_OBSERVED_COPY_REASON : null, ...copy });
      if (done.state === next) this.#releaseLock(attempt);
      return done;
    }
    // A reason is replaced only when the state moves (or a copy is first observed), so a relay refusal stays readable while
    // status repeats. An observed copy keeps observed_resigned_copy as the reason.
    // reconcile_blocked_insufficient_providers: Balchemy holds the record with no release path until it has two
    // independent providers; it replaces the last reason so the owner sees why nothing settles.
    const blocked = observed === null && submission.reasonCode === "reconcile_blocked_insufficient_providers" ? BLOCKED_REASON : null;
    const reason = observed !== null ? PRIVATE_SUBMISSION_OBSERVED_COPY_REASON : blocked ?? (next === "disputed" ? "engine:finalized_facts_disputed" : null);
    const replace = next !== attempt.state || "observedSignature" in copy || (blocked !== null && attempt.reason !== blocked);
    return this.#change(agentId, attempt, { state: next, engineState: submission.state, ...(replace ? { reason } : {}), ...copy });
  }
  /** Closes the in-process wallet lock only when this attempt owns it: another attempt's lock on the same wallet (one admitted
   * beside a released attempt) stays held. */
  #releaseLock(attempt: PrivateSubmissionAttempt): void {
    const held = this.#locks.get(attempt.walletAddress);
    if (!held || held.attemptKey !== attempt.attemptKey) return;
    this.#locks.delete(attempt.walletAddress);
    try { held.lock.close(); } catch { /* Process exit releases it. */ }
  }
  #holdLock(built: { readonly hold: PrivateExecutionHold }): WalletLock {
    this.#adopted.add(built.hold); return { assertValid: () => built.hold.assertHeld(), close: () => built.hold.release() };
  }

  /** Journal update; on failure the previous attempt stands (held, retried by the next pass). */
  #change(agentId: string, attempt: PrivateSubmissionAttempt, change: PrivateSubmissionChange): PrivateSubmissionAttempt {
    try { return this.#options.journal.update(agentId, attempt.attemptKey, change, Math.max(this.#now(), attempt.updatedAt)); } catch { return attempt; }
  }
  #lease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined {
    const lease = this.#options.readLease(agentId);
    return lease && lease.instanceId === this.#options.instanceId && lease.remainingMs > 0 ? lease : undefined;
  }
  /** Both proofs re-read the lease and accept only this attempt's exact stored request. */
  #client(agentId: string, lease: Readonly<RunnerRuntimeActiveLease>, attempt: PrivateSubmissionAttempt,
    held?: { refusal: PrivateExecutionGateRefusal | null }): RunnerExecutionSubmitClient {
    const o = this.#options; const pinned = identity(lease);
    const live = (): void => { const current = o.readLease(agentId); if (!current || identity(current) !== pinned || !(current.remainingMs > 0)) throw new Error("lease changed"); };
    const identityOptions = { directory: o.directory, localProfileId: o.localProfileId, agentId };
    return new RunnerExecutionSubmitClient({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId, bindingDigest: lease.bindingDigest,
      runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, apiBaseUrl: `${lease.frontendOrigin}/api`, timeoutMs: 20_000,
      ...(o.fetchFn ? { fetchFn: o.fetchFn } : {}),
      submitSigner: (nonce, expected) => {
        live();
        // Disarm or stop during the nonce exchange: the submit proof is never made, so the relay request is never sent.
        const refusal = this.#gate({ step: "relay", agentId });
        if (refusal) { if (held) held.refusal = refusal; throw new Error("relay held"); }
        if (expected.request.signedTransactionB64 !== attempt.wireB64 || expected.request.attemptKey !== attempt.attemptKey
          || expected.request.reservationId !== attempt.reservationId || expected.request.buildDigest !== attempt.buildDigest) throw new Error("request changed");
        return signRunnerExecutionSubmitProof(identityOptions, { instanceId: lease.instanceId, epoch: expected.epoch, request: expected.request, nonce });
      },
      statusSigner: (nonce, expected) => {
        live();
        if (expected.request.reservationId !== attempt.reservationId || expected.request.buildDigest !== attempt.buildDigest) throw new Error("request changed");
        return signRunnerExecutionStatusProof(identityOptions, { instanceId: lease.instanceId, epoch: expected.epoch, request: expected.request, nonce });
      } });
  }
}
