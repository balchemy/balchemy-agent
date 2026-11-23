/** S2b/S3 build path. Its one production caller is the S8b execution worker (private-execution-intents.ts), which hands a
 * validated token straight to S4 submission. Since S8a it builds only through the local
 * choke point (private-execution-gate.ts, step `entry_build`): live_armed with entries enabled, re-checked after the
 * build exchange; a shadow, paused, unarmed or entries-paused agent never reserves or builds. From a completed signal job with a resolved buy plan and a
 * fresh complete/allow assessment (re-assessed once when older than its 15 s window), a bound and unlocked trading wallet
 * and the active lease, it takes the wallet lock, reserves locally (journal + reservation in one fsynced commit), asks
 * the backend for a keyless unsigned build (runner-key proof only), and independently validates + simulates those exact
 * bytes on the runner's own RPC. Its strongest result is a single-use ValidatedSolanaMessage token: it never signs,
 * sends or submits; the backend refuses every build unless its own arming gate passes.
 * Reservation rules: any refusal proven before a signature is possible releases the local reservation, and so does an
 * ambiguous build exchange (F3: its bytes never reached this process, and only S4 submit signs); only a failed release keeps
 * it (and so blocks the wallet) until S4 restart recovery releases it. */
import { RunnerExecutionBuildClient, runnerExecutionRequestDigest, type RunnerAssessmentRequest,
  type RunnerExecutionBuild, type RunnerExecutionRequestV2, type RunnerExecutionResponse } from "@balchemyai/agent-sdk";
import { RunnerKernelLock, RunnerLockError } from "./kernel-lock.js";
import { signRunnerExecutionProof } from "./pairing-identity.js";
import { queryPrivateAssessmentReceipt, type PrivateAssessmentReceipt } from "./private-assessment.js";
import { parsePrivateSignalJob, privateSignalAssessmentEvidence, privateSignalAssessmentRequest, PRIVATE_ASSESSMENT_INPUT_MINT,
  PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS, type PrivateSignalAssessmentEvidence, type PrivateSignalJob } from "./private-signal-job.js";
import type { PrivateSignalPlan } from "./private-signal-plan.js";
import { PrivateSpendLedgerError, privateSpendReservationId, type PrivateSpendLedger } from "./private-spend-ledger.js";
import { preparePrivateSolanaSwapSignature, type PrivateSolanaBuyPreflightRpc } from "./private-solana-swap-preflight.js";
import type { ValidatedSolanaMessage } from "./private-solana-validated-message.js";
import type { PrivateSolanaValidatedBuy } from "./private-solana-tx-validator.js";
import type { PrivateTradingBindingRecord } from "./private-trading-binding.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import type { RunnerAgentState } from "./protocol.js";
import { privateExecutionGate, type PrivateExecutionCapabilities, type PrivateExecutionGateRefusal, type PrivateExecutionLiveFacts } from "./private-execution-gate.js";
import { privateFeePolicyRefusal, privateFeeWallets, type PrivateFeePolicyRefusal } from "./private-fee-policy.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";

/** The runner's own priority-fee ceiling sent to the engine and enforced again by the validator (<= its 0.001 SOL bound). */
export const PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS = 100_000n;
export interface PrivateExecutionBuildOptions {
  directory: string; localProfileId: string; instanceId: string;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  readRuntime(agentId: string): RunnerAgentState | undefined;
  /** Live owner facts for the choke point (confirmed rules head + shadowMode, RPC class); a throw refuses. */
  readFacts(agentId: string): PrivateExecutionLiveFacts;
  /** Keystore status: only `unlocked` with a verified address proceeds. */
  readWallet(agentId: string): TradingWalletStatus;
  readBinding(agentId: string): PrivateTradingBindingRecord | undefined;
  ledger: Pick<PrivateSpendLedger, "status" | "reserve" | "release">;
  /** C2: the reservation ids the reservation's compaction must keep (privateSubmissionKeptReservations of the agent's journal); a
   * throw refuses state_unavailable before any reservation. Omitted: nothing extra is kept. */
  readKeptReservations?(agentId: string): readonly string[];
  /** The agent's own configured Solana RPC. */
  rpc: PrivateSolanaBuyPreflightRpc;
  /** Defaults to the real lease-pinned assessment query. */
  assess?(agentId: string, request: RunnerAssessmentRequest, signal?: AbortSignal): Promise<PrivateAssessmentReceipt>;
  fetchFn?: typeof fetch;
  now?(): number;
  /** Test-only seam (see private-execution-gate.ts); production never sets it. */
  capabilities?: PrivateExecutionCapabilities;
  /** K1b typed rules and K4 launchpad provenance at the choke point (private-typed-rules.ts, private-launchpads.ts): the confirmed
   * revision's never-buy lists, per-token buy limit and trades-per-day limit against the live position ledger and journal, and a
   * launchpad signal's subscription, catalog and freshness. Run before the lease, wallet and reservation and again right before the
   * reservation; a non-null reason refuses (nothing reserved), a throw refuses `state_unavailable`. `facts.symbol`: readEntrySymbol's answer. */
  checkEntry?(agentId: string, job: PrivateSignalJob, facts: { symbol: string | null }): string | null;
  /** The never-buy symbol fact of this job: the one symbol its bound research reports carry (null when unknown, or when no rule needs
   * it). Read once, before the first choke-point check, so both checks see the same fact; a throw is unknown. */
  readEntrySymbol?(agentId: string, job: PrivateSignalJob, signal?: AbortSignal): Promise<string | null>;
}
/** Released by the caller (S4) at a terminal outcome. The ledger reservation is never released by this. `assertHeld`
 * throws once released or when the lock file's identity changed. */
export interface PrivateExecutionHold { readonly walletAddress: string; assertHeld(): void; release(): void }
export type PrivateExecutionLocalRefusal = "job_not_executable" | "slippage_above_bound" | PrivateExecutionGateRefusal | "lease_unavailable"
  | "identity_changed" | "wallet_missing" | "wallet_locked" | "wallet_unbound" | "wallet_revoked" | "wallet_binding_mismatch" | "wallet_busy"
  | "assessment_unavailable" | "assessment_incomplete" | "pretrade_requires_approval" | "pretrade_blocked" | "limits_missing"
  | "per_trade_cap_exceeded" | "daily_cap_exceeded" | "reservation_capacity_exhausted" | "reservation_conflict" | "reservation_released"
  | "reservation_committed" | "clock_rollback" | "state_unavailable" | "request_unrepresentable" | "build_unavailable" | "build_binding_mismatch"
  | PrivateFeePolicyRefusal;
export type PrivateExecutionBuildOutcome =
  | { readonly outcome: "validated"; readonly reservationId: string; readonly message: ValidatedSolanaMessage; readonly swap: PrivateSolanaValidatedBuy;
    readonly expiresAtMs: number; readonly build: Readonly<Pick<RunnerExecutionBuild, "walletBindingId" | "unsignedMessageB64" | "messageSha256" | "lastValidBlockHeight" | "buildDigest" | "expiresAt">>;
    readonly assessmentDigest: string; readonly hold: PrivateExecutionHold;
    /** The armed runtime revision this build ran under; signing requires the same revision (gate step `entry_sign`). */
    readonly runtimeVersion: number;
    /** The plan's confirmed rule revision; signing requires it to still be the confirmed head. */
    readonly ruleRevisionId: string | null }
  /** `reservation`: none was made, it was released, or releasing failed and it is retained (fail closed). */
  | { readonly outcome: "refused"; readonly stage: "local" | "server" | "preflight"; readonly reason: string;
    readonly reservation: "none" | "released" | "retained"; readonly reassessed: boolean }
  /** The build exchange's outcome is unknown (the proof was sent). `reservation`: released (F3: no bytes reached this process), or
   * retained when releasing failed. Neither permits the same build again. */
  | { readonly outcome: "unknown"; readonly reservationId: string; readonly reservation: "released" | "retained" };

/** Server refusals on decision provenance (signal event, source authorization/approval, evidence freshness/binding). Each is
 * proven before any bytes exist, so the local reservation is released and the server code is reported verbatim. */
/** M3.2 S5: the backend's signed-cap gate refuses a buy with no matching owner wallet approval (`owner_approval_missing`) or with
 * a reported cap above the signed one (`owner_cap_exceeded`). Like every server refusal it precedes any bytes: the local
 * reservation is released and the code is reported verbatim (privateExecutionReasonText explains it to the owner). */
export const PRIVATE_EXECUTION_OWNER_APPROVAL_REFUSALS = ["owner_approval_missing", "owner_cap_exceeded"] as const;
export const PRIVATE_EXECUTION_PROVENANCE_REFUSALS = ["signal_event_mismatch", "source_authorization_changed", "source_approval_required",
  "evidence_stale", "evidence_mismatch"] as const;
const LEDGER_REFUSALS: readonly PrivateExecutionLocalRefusal[] = ["limits_missing", "per_trade_cap_exceeded", "daily_cap_exceeded",
  "reservation_capacity_exhausted", "wallet_busy", "reservation_conflict", "reservation_released", "reservation_committed", "clock_rollback"];
function planHex(plan: PrivateSignalPlan): string { return plan.digest.slice("sha256:".length); }
function identity(lease: Readonly<RunnerRuntimeActiveLease>): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest, lease.runnerPublicKey, lease.instanceId, lease.epoch]);
}
/** Fresh means inside the assessment's own 15 s window (expiresAtMs = startedAtMs + 15000) by the local clock. */
function fresh(assessment: PrivateSignalAssessmentEvidence, nowMs: number): boolean {
  return nowMs >= Number(assessment.startedAtMs) && nowMs < Number(assessment.expiresAtMs);
}

export async function buildPrivateExecutionCandidate(options: PrivateExecutionBuildOptions, agentId: string, input: PrivateSignalJob,
  signal?: AbortSignal): Promise<PrivateExecutionBuildOutcome> {
  const now = options.now ?? Date.now;
  let reassessed = false;
  const refuse = (reason: string, stage: "local" | "server" | "preflight" = "local",
    reservation: "none" | "released" | "retained" = "none"): PrivateExecutionBuildOutcome => Object.freeze({ outcome: "refused" as const, stage, reason, reservation, reassessed });
  let job: PrivateSignalJob;
  try { job = parsePrivateSignalJob(input); } catch { return refuse("job_not_executable"); }
  const plan = job.result?.plan; const admission = job.result?.admission;
  if (!admission || job.agentId !== agentId || job.state !== "completed" || job.result?.decision.action !== "buy" || !plan || plan.state !== "resolved"
    || plan.asset.chain !== "solana" || !plan.amount || plan.slippageBps === null || plan.asset.assetId === PRIVATE_ASSESSMENT_INPUT_MINT) return refuse("job_not_executable");
  // The shared execution bound (admission refuses it first): above it no exit-protected position could ever open.
  if (plan.slippageBps > PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS) return refuse("slippage_above_bound");
  const gatePlan = { runtimeVersion: plan.runtimeVersion, ruleRevisionId: plan.rule?.revisionId ?? null,
    risks: plan.risks ? { confirmBeforeTrade: plan.risks.confirmBeforeTrade, requireApprovalAboveUsd: plan.risks.requireApprovalAboveUsd,
      requireApprovalForNewTokens: plan.risks.requireApprovalForNewTokens } : null, exit: plan.exit ? { stopLossBps: plan.exit.stopLossBps } : null };
  const gate = (): PrivateExecutionGateRefusal | null => {
    let runtime: RunnerAgentState | undefined; let facts: PrivateExecutionLiveFacts | undefined;
    try { runtime = options.readRuntime(agentId); } catch { return "runtime_unavailable"; }
    try { facts = options.readFacts(agentId); } catch { facts = undefined; }
    return privateExecutionGate(runtime, { step: "entry_build", agentId, plan: gatePlan, facts }, options.capabilities);
  };
  const blocked = gate();
  if (blocked) return refuse(blocked);
  let symbol: string | null = null;
  if (options.checkEntry && options.readEntrySymbol) {
    try { symbol = await options.readEntrySymbol(agentId, job, signal); } catch { symbol = null; }
  }
  const entryRules = (): string | null => {
    if (!options.checkEntry) return null;
    try { return options.checkEntry(agentId, job, { symbol }); } catch { return "state_unavailable"; }
  };
  const ruleRefusal = entryRules();
  if (ruleRefusal) return refuse(ruleRefusal);
  const lease = options.readLease(agentId);
  if (!lease || lease.instanceId !== options.instanceId || !(lease.remainingMs > 0)) return refuse("lease_unavailable");
  if (lease.agentId !== job.receipt.serverAgentId || lease.bindingDigest !== job.receipt.bindingDigest
    || lease.frontendOrigin !== job.receipt.frontendOrigin) return refuse("identity_changed");
  const pinned = identity(lease);
  const walletRead = (): { address: string } | PrivateExecutionLocalRefusal => {
    let wallet: TradingWalletStatus;
    try { wallet = options.readWallet(agentId); } catch { return "state_unavailable"; }
    if (wallet.state === "absent") return "wallet_missing";
    if (wallet.state !== "unlocked" || !wallet.addressVerified) return wallet.state === "held" ? "state_unavailable" : "wallet_locked";
    return { address: wallet.address };
  };
  const wallet = walletRead();
  if (typeof wallet === "string") return refuse(wallet);
  let binding: PrivateTradingBindingRecord | undefined;
  try { binding = options.readBinding(agentId); } catch { return refuse("state_unavailable"); }
  if (!binding) return refuse("wallet_unbound");
  if (binding.state === "revoked") return refuse("wallet_revoked");
  const bound = binding.binding;
  if (bound.status !== "active" || bound.walletAddress !== wallet.address || bound.agentId !== lease.agentId || bound.bindingDigest !== lease.bindingDigest
    || bound.runnerPublicKey !== lease.runnerPublicKey || binding.frontendOrigin !== lease.frontendOrigin) return refuse("wallet_binding_mismatch");

  // Evidence: the job's own assessment while inside its window, else exactly one re-assessment of the same plan.
  let assessment = job.result?.assessment;
  if (!assessment || assessment.outcome !== "complete" || !fresh(assessment, now())) {
    const derived = privateSignalAssessmentRequest(plan);
    if ("reason" in derived) return refuse("request_unrepresentable");
    reassessed = true;
    const assess = options.assess ?? ((id: string, request: RunnerAssessmentRequest, abort?: AbortSignal): Promise<PrivateAssessmentReceipt> =>
      queryPrivateAssessmentReceipt({ directory: options.directory, localProfileId: options.localProfileId, instanceId: options.instanceId,
        readLease: options.readLease, ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}) }, id, request, abort));
    try {
      const receipt = await assess(agentId, derived.request, signal);
      assessment = privateSignalAssessmentEvidence(plan, receipt.response, receipt.receivedAt);
    } catch { return refuse("assessment_unavailable"); }
  }
  if (assessment.outcome !== "complete" || !assessment.quote || !assessment.pretrade) return refuse("assessment_incomplete");
  if (!fresh(assessment, now())) return refuse("assessment_unavailable");
  if (assessment.pretrade.verdict === "block") return refuse("pretrade_blocked");
  if (assessment.pretrade.verdict !== "allow") return refuse("pretrade_requires_approval");
  // The runner's own fee policy (at most 150 bps, to an allow-listed fee wallet), before any reservation or build request.
  const feePolicy = privateFeePolicyRefusal(assessment.fee.rateBps, assessment.fee.recipient, privateFeeWallets(options.capabilities));
  if (feePolicy) return refuse(feePolicy);
  const evidence = assessment;
  const current = options.readLease(agentId);
  if (!current || identity(current) !== pinned || !(current.remainingMs > 0)) return refuse("lease_unavailable");
  if (signal?.aborted) return refuse("build_unavailable");
  const stillArmed = gate();
  if (stillArmed) return refuse(stillArmed);
  const stillAllowed = entryRules();
  if (stillAllowed) return refuse(stillAllowed);

  // Closed v2 request (SDK key order). The daily cap is the runner's own (an amount or "none"), mirrored to the server reservation;
  // whether the server accepts it is decided by the owner's signed approval (signed-cap gate), never by this runner.
  let limits: ReturnType<PrivateExecutionBuildOptions["ledger"]["status"]>["limits"];
  try { limits = options.ledger.status(agentId, now()).limits; } catch (error: unknown) {
    return refuse(error instanceof PrivateSpendLedgerError && error.code === "clock_rollback" ? "clock_rollback" : "state_unavailable");
  }
  // `unset` (never answered) refuses every build; `none` travels as `dailyCap: {kind: "none"}` (v2, M3.2 S5).
  if (limits.perTrade.kind === "unset" || limits.daily.kind === "unset") return refuse("limits_missing");
  const dailyCap: RunnerExecutionRequestV2["dailyCap"] = limits.daily.kind === "none" ? { kind: "none" }
    : { kind: "lamports", lamports: limits.daily.lamports };
  const reservationId = privateSpendReservationId({ localProfileId: options.localProfileId, agentId, jobId: job.jobId,
    planDigest: planHex(plan), assessmentDigest: evidence.assessmentDigest });
  // Provenance comes only from the completed job's own receipt and admission (sequence is runner-local and never sent).
  const delivered = job.receipt.signal;
  const request: RunnerExecutionRequestV2 = { version: 1, chain: "solana", direction: "buy", reservationId, planDigest: planHex(plan),
    assessmentDigest: evidence.assessmentDigest, eventId: admission.signalId, eventDigest: delivered.eventDigest, sourceId: delivered.sourceId,
    sourceRevision: delivered.sourceRevision, evidence: admission.evidence.map((item) => ({ kind: item.kind,
      serverEvidenceId: item.serverEvidenceId, snapshotDigest: item.snapshotDigest, staleAt: item.staleAt })), walletAddress: wallet.address, inputMint: PRIVATE_ASSESSMENT_INPUT_MINT,
    outputMint: plan.asset.assetId, grossInputAmount: plan.amount.amountBaseUnits, slippageBps: plan.slippageBps,
    minOutBound: evidence.quote?.minOut ?? "", maxPriorityFeeLamports: PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS.toString(),
    feeRateBps: evidence.fee.rateBps, feePolicyDigest: evidence.fee.policyDigest, dailyCap };
  let requestDigest: string;
  try { requestDigest = runnerExecutionRequestDigest(request); } catch { return refuse("request_unrepresentable"); }
  let keep: readonly string[];
  try { keep = options.readKeptReservations?.(agentId) ?? []; } catch { return refuse("state_unavailable"); }

  // Wallet lock, then the reservation, in one synchronous section: a concurrent build sees one or the other.
  let lock: RunnerKernelLock;
  try { lock = RunnerKernelLock.acquireWallet(options.directory, wallet.address); }
  catch (error: unknown) { return refuse(error instanceof RunnerLockError && error.code === "lock_busy" ? "wallet_busy" : "state_unavailable"); }
  let held = true; let transferred = false;
  const unlock = (): void => { if (held) { held = false; try { lock.close(); } catch { /* Process exit releases it. */ } } };
  try {
    try {
      options.ledger.reserve(agentId, { reservationId, walletAddress: wallet.address, amountLamports: request.grossInputAmount, jobId: job.jobId,
        planDigest: request.planDigest, assessmentDigest: request.assessmentDigest, requestDigest }, now(), keep);
    } catch (error: unknown) {
      const code = error instanceof PrivateSpendLedgerError && (LEDGER_REFUSALS as readonly string[]).includes(error.code) ? error.code : "state_unavailable";
      return refuse(code);
    }
    const release = (reason: string, stage: "local" | "server" | "preflight", code: string): PrivateExecutionBuildOutcome => {
      try { options.ledger.release(agentId, reservationId, reason, now()); return refuse(code, stage, "released"); }
      catch { return refuse(code, stage, "retained"); }
    };
    const seen: { signed: boolean } = { signed: false };
    let response: RunnerExecutionResponse;
    try {
      const client = new RunnerExecutionBuildClient({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId, bindingDigest: lease.bindingDigest,
        runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, apiBaseUrl: `${lease.frontendOrigin}/api`, timeoutMs: 20_000,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        signer: (nonce, expected) => {
          const live = options.readLease(agentId);
          if (signal?.aborted || !live || identity(live) !== pinned || !(live.remainingMs > 0)) throw new Error("lease changed");
          // This path builds BUYS only (S5c adds exits through their own path): never sign a proof for any other intent.
          if (expected.request.direction !== "buy") throw new Error("intent mismatch");
          const signature = signRunnerExecutionProof({ directory: options.directory, localProfileId: options.localProfileId, agentId },
            { instanceId: lease.instanceId, epoch: expected.epoch, request: expected.request, nonce });
          seen.signed = true;
          return signature;
        } });
      response = await client.build(request, lease.epoch, signal);
    } catch {
      // Before the runner proof existed no build request could have been sent: nothing was reserved server-side.
      if (!seen.signed) return release("build_not_sent", "local", "build_unavailable");
      // F3 of the flip review: whatever the server did, no bytes reached this process and only S4 submit signs, so this is the
      // ledger's "no bytes" non-spend: release it here (like the exit build's own unknown), or every sell of the wallet waits for a
      // restart. A failed release retains it (restart recovery releases it). Released never permits the same build again (the
      // ledger refuses reservation_released for this id).
      let reservation: "released" | "retained" = "retained";
      try { options.ledger.release(agentId, reservationId, "build_outcome_unknown", now()); reservation = "released"; } catch { /* Retained. */ }
      unlock();
      return Object.freeze({ outcome: "unknown" as const, reservationId, reservation });
    }
    // Every server refusal (including PRIVATE_EXECUTION_PROVENANCE_REFUSALS) precedes any bytes: release and report the code.
    if (response.outcome === "refused") return release(`server:${response.reasonCode}`.slice(0, 96), "server", response.reasonCode);
    const build = response.build;
    if (build.walletBindingId !== bound.walletBindingId) return release("build_binding_mismatch", "server", "build_binding_mismatch");
    // Re-read local authority after the network exchange; a changed wallet or lease never yields a token.
    const after = walletRead();
    const leaseAfter = options.readLease(agentId);
    if (typeof after === "string" || after.address !== wallet.address) return release("wallet_changed", "local", typeof after === "string" ? after : "wallet_locked");
    if (!leaseAfter || identity(leaseAfter) !== pinned) return release("lease_changed", "local", "lease_unavailable");
    // Disarm, stop or an entries pause during the exchange: no token is ever produced (nothing exists to sign).
    const armedAfter = gate();
    if (armedAfter) return release(`gate:${armedAfter}`, "local", armedAfter);
    const verdict = await preparePrivateSolanaSwapSignature(options.rpc, { agentId, wallet: wallet.address, plan, assessment: evidence,
      build: { unsignedMessageB64: build.unsignedMessageB64, messageSha256: build.messageSha256, lastValidBlockHeight: build.lastValidBlockHeight,
        expected: structuredClone(build.expected) }, maxPriorityFeeLamports: PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS }, signal, now, options.capabilities);
    // Validator-refused bytes can never reach the keystore, so nothing can be spent: the reservation is released.
    if (!verdict.ok) return release(`preflight:${verdict.reason}`.replace(/[^a-z0-9_:]/g, "_").slice(0, 96), "preflight", verdict.reason);
    const hold: PrivateExecutionHold = Object.freeze({ walletAddress: wallet.address, release: unlock,
      assertHeld: (): void => { if (!held) throw new RunnerLockError("unsafe_lock"); lock.assertValid(); } });
    const result = Object.freeze({ outcome: "validated" as const, reservationId, message: verdict.message, swap: verdict.swap, expiresAtMs: verdict.expiresAtMs,
      build: Object.freeze({ walletBindingId: build.walletBindingId, unsignedMessageB64: build.unsignedMessageB64, messageSha256: build.messageSha256, lastValidBlockHeight: build.lastValidBlockHeight,
        buildDigest: build.buildDigest, expiresAt: build.expiresAt }), assessmentDigest: evidence.assessmentDigest, hold, runtimeVersion: plan.runtimeVersion,
      ruleRevisionId: gatePlan.ruleRevisionId });
    transferred = true;
    return result;
  } finally { if (!transferred) unlock(); }
}
