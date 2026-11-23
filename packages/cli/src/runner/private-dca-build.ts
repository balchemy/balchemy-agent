/** K1b DCA add build: the S2b/S3 buy build path (private-execution-build.ts) for one durable DCA add record (private-dca-store.ts), in
 * the same order and with the same guarantees, and the same validated result shape, so PrivateSubmissions.submit signs and journals it
 * exactly like a signal buy. Differences, all from the record and never from a signal:
 * - the request is the DCA buy variant (purpose balchemy.local-agent.execution.dca-request.v1): `dca` {parentEntryBuildDigest,
 *   ruleRevisionId, rulesDigest, dcaPlanDigest} replaces the signal provenance; planDigest is the record's plan digest; evidence is
 *   the fresh research binding the worker read for the mint;
 * - the reservationId is the record's own UUID v4 (minted once, durable before this runs), never derived again;
 * - the assessment is always fresh (a DCA add has no saved one): exactly one lease-pinned assessment of the record's mint, amount and
 *   slippage under its plan digest, complete with pre-trade `allow`;
 * - the daily cap must be an amount (the server refuses dca_daily_cap_required for a signed "no cap"; refused here first, so a doomed
 *   build never spends the server's 60 s add spacing);
 * - the proof signer pins the exact request digest and the DCA variant.
 * Every refusal proven before a signature releases the local reservation; an ambiguous exchange releases it too (F3, no bytes reached
 * this process); only a failed release retains it. It never signs a transaction, sends or submits. */
import { isRunnerDcaRequest, RunnerExecutionBuildClient, runnerExecutionRequestDigest, type RunnerAssessmentRequest,
  type RunnerExecutionDcaRequest, type RunnerExecutionResponse } from "@balchemyai/agent-sdk";
import { RunnerKernelLock, RunnerLockError } from "./kernel-lock.js";
import { signRunnerExecutionProof } from "./pairing-identity.js";
import { queryPrivateAssessmentReceipt, type PrivateAssessmentReceipt } from "./private-assessment.js";
import { privateSignalAssessmentEvidence, privateSignalAssessmentRequest, PRIVATE_ASSESSMENT_INPUT_MINT, PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS,
  type PrivateBuyPlanFacts, type PrivateSignalAssessmentEvidence } from "./private-signal-job.js";
import { PrivateSpendLedgerError, type PrivateSpendLedger } from "./private-spend-ledger.js";
import { preparePrivateSolanaSwapSignature, type PrivateSolanaBuyPreflightRpc } from "./private-solana-swap-preflight.js";
import type { PrivateTradingBindingRecord } from "./private-trading-binding.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import type { RunnerAgentState } from "./protocol.js";
import { privateExecutionGate, type PrivateExecutionCapabilities, type PrivateExecutionGatePlan, type PrivateExecutionGateRefusal,
  type PrivateExecutionLiveFacts } from "./private-execution-gate.js";
import { privateFeePolicyRefusal, privateFeeWallets } from "./private-fee-policy.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import { PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS, type PrivateExecutionBuildOutcome, type PrivateExecutionHold } from "./private-execution-build.js";
import { assetRef } from "./private-research-evidence.js";
import { privateDcaJobId, type PrivateDcaEvidence } from "./private-dca.js";
import type { PrivateDcaAdd } from "./private-dca-store.js";

export interface PrivateDcaBuildOptions {
  directory: string; localProfileId: string; instanceId: string;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  readRuntime(agentId: string): RunnerAgentState | undefined;
  readFacts(agentId: string): PrivateExecutionLiveFacts;
  readWallet(agentId: string): TradingWalletStatus;
  readBinding(agentId: string): PrivateTradingBindingRecord | undefined;
  ledger: Pick<PrivateSpendLedger, "status" | "reserve" | "release">;
  readKeptReservations?(agentId: string): readonly string[];
  rpc: PrivateSolanaBuyPreflightRpc;
  assess?(agentId: string, request: RunnerAssessmentRequest, signal?: AbortSignal): Promise<PrivateAssessmentReceipt>;
  fetchFn?: typeof fetch;
  now?(): number;
  capabilities?: PrivateExecutionCapabilities;
}
export interface PrivateDcaBuildInput {
  add: PrivateDcaAdd;
  evidence: readonly PrivateDcaEvidence[];
  /** The confirmed revision's approval facts (the live gate re-checks the revision is still the record's). */
  risks: PrivateExecutionGatePlan["risks"];
  /** The worker's re-check of the add's own gates (pending exit of the mint, parent lot, campaign, typed rules), run before the lease
   * and again right before the reservation; a non-null reason refuses (nothing reserved), a throw refuses state_unavailable. */
  checkAdd?(): string | null;
}
const LEDGER_REFUSALS: readonly string[] = ["limits_missing", "per_trade_cap_exceeded", "daily_cap_exceeded", "reservation_capacity_exhausted",
  "wallet_busy", "reservation_conflict", "reservation_released", "reservation_committed", "clock_rollback"];
function identity(lease: Readonly<RunnerRuntimeActiveLease>): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest, lease.runnerPublicKey, lease.instanceId, lease.epoch]);
}
function fresh(assessment: PrivateSignalAssessmentEvidence, nowMs: number): boolean {
  return nowMs >= Number(assessment.startedAtMs) && nowMs < Number(assessment.expiresAtMs);
}
function lamportsSol(lamports: string): string {
  const value = BigInt(lamports); const whole = value / 1_000_000_000n; const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
/** The plan facts the assessment and the swap expectation read, from the add record alone. */
export function privateDcaPlanFacts(add: Pick<PrivateDcaAdd, "mint" | "amountLamports" | "slippageBps" | "planDigest">): PrivateBuyPlanFacts {
  return { state: "resolved", asset: assetRef("solana", add.mint), amount: { amountSol: lamportsSol(add.amountLamports), amountBaseUnits: add.amountLamports,
    source: "rule", statementIndex: null }, slippageBps: add.slippageBps, digest: `sha256:${add.planDigest}` };
}

export async function buildPrivateDcaCandidate(options: PrivateDcaBuildOptions, agentId: string, input: PrivateDcaBuildInput,
  signal?: AbortSignal): Promise<PrivateExecutionBuildOutcome> {
  const now = options.now ?? Date.now;
  const refuse = (reason: string, stage: "local" | "server" | "preflight" = "local",
    reservation: "none" | "released" | "retained" = "none"): PrivateExecutionBuildOutcome => Object.freeze({ outcome: "refused" as const, stage, reason, reservation, reassessed: true });
  const add = input.add;
  if (add.state !== "running" || add.mint === PRIVATE_ASSESSMENT_INPUT_MINT || add.slippageBps > PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS
    || input.evidence.length < 1 || input.evidence.length > 2) return refuse("job_not_executable");
  const plan = privateDcaPlanFacts(add);
  const gatePlan: PrivateExecutionGatePlan = { runtimeVersion: add.runtimeVersion, ruleRevisionId: add.ruleRevisionId, risks: input.risks,
    exit: { stopLossBps: add.exit.stopLossBps } };
  const gate = (): PrivateExecutionGateRefusal | null => {
    let runtime: RunnerAgentState | undefined; let facts: PrivateExecutionLiveFacts | undefined;
    try { runtime = options.readRuntime(agentId); } catch { return "runtime_unavailable"; }
    try { facts = options.readFacts(agentId); } catch { facts = undefined; }
    return privateExecutionGate(runtime, { step: "entry_build", agentId, plan: gatePlan, facts }, options.capabilities);
  };
  const own = (): string | null => { if (!input.checkAdd) return null; try { return input.checkAdd(); } catch { return "state_unavailable"; } };
  const evidenceStale = (): boolean => input.evidence.some((item) => !(now() < Date.parse(item.staleAt)));
  const blocked = gate(); if (blocked) return refuse(blocked);
  const first = own(); if (first) return refuse(first);
  if (evidenceStale()) return refuse("evidence_stale");
  const lease = options.readLease(agentId);
  if (!lease || lease.instanceId !== options.instanceId || !(lease.remainingMs > 0)) return refuse("lease_unavailable");
  const pinned = identity(lease);
  const walletRead = (): { address: string } | string => {
    let wallet: TradingWalletStatus;
    try { wallet = options.readWallet(agentId); } catch { return "state_unavailable"; }
    if (wallet.state === "absent") return "wallet_missing";
    if (wallet.state !== "unlocked" || !wallet.addressVerified) return wallet.state === "held" ? "state_unavailable" : "wallet_locked";
    return { address: wallet.address };
  };
  const wallet = walletRead();
  if (typeof wallet === "string") return refuse(wallet);
  if (wallet.address !== add.walletAddress) return refuse("wallet_binding_mismatch");
  let binding: PrivateTradingBindingRecord | undefined;
  try { binding = options.readBinding(agentId); } catch { return refuse("state_unavailable"); }
  if (!binding) return refuse("wallet_unbound");
  if (binding.state === "revoked") return refuse("wallet_revoked");
  const bound = binding.binding;
  if (bound.status !== "active" || bound.walletAddress !== wallet.address || bound.agentId !== lease.agentId || bound.bindingDigest !== lease.bindingDigest
    || bound.runnerPublicKey !== lease.runnerPublicKey || binding.frontendOrigin !== lease.frontendOrigin) return refuse("wallet_binding_mismatch");

  // Evidence of the pre-trade checks: exactly one fresh assessment of this add.
  const derived = privateSignalAssessmentRequest(plan);
  if ("reason" in derived) return refuse("request_unrepresentable");
  const assess = options.assess ?? ((id: string, request: RunnerAssessmentRequest, abort?: AbortSignal): Promise<PrivateAssessmentReceipt> =>
    queryPrivateAssessmentReceipt({ directory: options.directory, localProfileId: options.localProfileId, instanceId: options.instanceId,
      readLease: options.readLease, ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}) }, id, request, abort));
  let assessment: PrivateSignalAssessmentEvidence;
  try {
    const receipt = await assess(agentId, derived.request, signal);
    assessment = privateSignalAssessmentEvidence(plan, receipt.response, receipt.receivedAt);
  } catch { return refuse("assessment_unavailable"); }
  if (assessment.outcome !== "complete" || !assessment.quote || !assessment.pretrade) return refuse("assessment_incomplete");
  if (!fresh(assessment, now())) return refuse("assessment_unavailable");
  if (assessment.pretrade.verdict === "block") return refuse("pretrade_blocked");
  if (assessment.pretrade.verdict !== "allow") return refuse("pretrade_requires_approval");
  const feePolicy = privateFeePolicyRefusal(assessment.fee.rateBps, assessment.fee.recipient, privateFeeWallets(options.capabilities));
  if (feePolicy) return refuse(feePolicy);
  const current = options.readLease(agentId);
  if (!current || identity(current) !== pinned || !(current.remainingMs > 0)) return refuse("lease_unavailable");
  if (signal?.aborted) return refuse("build_unavailable");
  const stillArmed = gate(); if (stillArmed) return refuse(stillArmed);
  const stillOwn = own(); if (stillOwn) return refuse(stillOwn);
  if (evidenceStale()) return refuse("evidence_stale");

  let limits: ReturnType<PrivateDcaBuildOptions["ledger"]["status"]>["limits"];
  try { limits = options.ledger.status(agentId, now()).limits; } catch (error: unknown) {
    return refuse(error instanceof PrivateSpendLedgerError && error.code === "clock_rollback" ? "clock_rollback" : "state_unavailable");
  }
  if (limits.perTrade.kind === "unset" || limits.daily.kind === "unset") return refuse("limits_missing");
  if (limits.daily.kind !== "lamports") return refuse("dca_daily_cap_required");
  const request: RunnerExecutionDcaRequest = { version: 1, chain: "solana", direction: "buy", reservationId: add.reservationId, planDigest: add.planDigest,
    assessmentDigest: assessment.assessmentDigest, dca: { parentEntryBuildDigest: add.parentEntryBuildDigest, ruleRevisionId: add.ruleRevisionId,
      rulesDigest: add.rulesDigest, dcaPlanDigest: add.planDigest },
    evidence: input.evidence.map((item) => ({ kind: item.kind, serverEvidenceId: item.serverEvidenceId, snapshotDigest: item.snapshotDigest, staleAt: item.staleAt })),
    walletAddress: wallet.address, inputMint: PRIVATE_ASSESSMENT_INPUT_MINT, outputMint: add.mint, grossInputAmount: add.amountLamports,
    slippageBps: add.slippageBps, minOutBound: assessment.quote.minOut, maxPriorityFeeLamports: PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS.toString(),
    feeRateBps: assessment.fee.rateBps, feePolicyDigest: assessment.fee.policyDigest, dailyCap: { kind: "lamports", lamports: limits.daily.lamports } };
  let requestDigest: string;
  try { requestDigest = runnerExecutionRequestDigest(request); } catch { return refuse("request_unrepresentable"); }
  let keep: readonly string[];
  try { keep = options.readKeptReservations?.(agentId) ?? []; } catch { return refuse("state_unavailable"); }

  let lock: RunnerKernelLock;
  try { lock = RunnerKernelLock.acquireWallet(options.directory, wallet.address); }
  catch (error: unknown) { return refuse(error instanceof RunnerLockError && error.code === "lock_busy" ? "wallet_busy" : "state_unavailable"); }
  let held = true; let transferred = false;
  const unlock = (): void => { if (held) { held = false; try { lock.close(); } catch { /* Process exit releases it. */ } } };
  try {
    try {
      options.ledger.reserve(agentId, { reservationId: add.reservationId, walletAddress: wallet.address, amountLamports: add.amountLamports,
        jobId: privateDcaJobId(add.planDigest), planDigest: add.planDigest, assessmentDigest: assessment.assessmentDigest, requestDigest }, now(), keep);
    } catch (error: unknown) {
      return refuse(error instanceof PrivateSpendLedgerError && LEDGER_REFUSALS.includes(error.code) ? error.code : "state_unavailable");
    }
    const release = (reason: string, stage: "local" | "server" | "preflight", code: string): PrivateExecutionBuildOutcome => {
      try { options.ledger.release(agentId, add.reservationId, reason, now()); return refuse(code, stage, "released"); }
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
          // Only exactly this DCA add is ever proven (its own request digest, the DCA variant).
          if (expected.request.direction !== "buy" || !isRunnerDcaRequest(expected.request) || runnerExecutionRequestDigest(expected.request) !== requestDigest) {
            throw new Error("intent mismatch");
          }
          const proof = signRunnerExecutionProof({ directory: options.directory, localProfileId: options.localProfileId, agentId },
            { instanceId: lease.instanceId, epoch: expected.epoch, request: expected.request, nonce });
          seen.signed = true;
          return proof;
        } });
      response = await client.build(request, lease.epoch, signal);
    } catch {
      if (!seen.signed) return release("build_not_sent", "local", "build_unavailable");
      let reservation: "released" | "retained" = "retained";
      try { options.ledger.release(agentId, add.reservationId, "build_outcome_unknown", now()); reservation = "released"; } catch { /* Retained. */ }
      unlock();
      return Object.freeze({ outcome: "unknown" as const, reservationId: add.reservationId, reservation });
    }
    if (response.outcome === "refused") return release(`server:${response.reasonCode}`.slice(0, 96), "server", response.reasonCode);
    const build = response.build;
    if (build.walletBindingId !== bound.walletBindingId) return release("build_binding_mismatch", "server", "build_binding_mismatch");
    const after = walletRead();
    const leaseAfter = options.readLease(agentId);
    if (typeof after === "string" || after.address !== wallet.address) return release("wallet_changed", "local", typeof after === "string" ? after : "wallet_locked");
    if (!leaseAfter || identity(leaseAfter) !== pinned) return release("lease_changed", "local", "lease_unavailable");
    const armedAfter = gate();
    if (armedAfter) return release(`gate:${armedAfter}`, "local", armedAfter);
    const ownAfter = own();
    if (ownAfter) return release(`dca:${ownAfter}`.slice(0, 96), "local", ownAfter);
    const verdict = await preparePrivateSolanaSwapSignature(options.rpc, { agentId, wallet: wallet.address, plan, assessment,
      build: { unsignedMessageB64: build.unsignedMessageB64, messageSha256: build.messageSha256, lastValidBlockHeight: build.lastValidBlockHeight,
        expected: structuredClone(build.expected) }, maxPriorityFeeLamports: PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS }, signal, now, options.capabilities);
    if (!verdict.ok) return release(`preflight:${verdict.reason}`.replace(/[^a-z0-9_:]/g, "_").slice(0, 96), "preflight", verdict.reason);
    const hold: PrivateExecutionHold = Object.freeze({ walletAddress: wallet.address, release: unlock,
      assertHeld: (): void => { if (!held) throw new RunnerLockError("unsafe_lock"); lock.assertValid(); } });
    const result = Object.freeze({ outcome: "validated" as const, reservationId: add.reservationId, message: verdict.message, swap: verdict.swap,
      expiresAtMs: verdict.expiresAtMs, build: Object.freeze({ walletBindingId: build.walletBindingId, unsignedMessageB64: build.unsignedMessageB64,
        messageSha256: build.messageSha256, lastValidBlockHeight: build.lastValidBlockHeight, buildDigest: build.buildDigest, expiresAt: build.expiresAt }),
      assessmentDigest: assessment.assessmentDigest, hold, runtimeVersion: add.runtimeVersion, ruleRevisionId: add.ruleRevisionId });
    transferred = true;
    return result;
  } finally { if (!transferred) unlock(); }
}
