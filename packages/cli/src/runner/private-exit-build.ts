/** S5c-2c exit (sell) build path, behind the exits capability (the production capabilities carry it since S5; with
 * PRIVATE_EXIT_EXECUTION_AVAILABLE false, the exits-off rollback build, every exit is refused at the first step, before any
 * lock, read or network call). Its one caller, the S5c exit
 * worker (private-exit-worker.ts, constructed by the daemon only while exits are available), records the one pending exit
 * of an open position (positions.beginExit with a fresh reservation id) and a fresh COMPLETE sell assessment of exactly
 * that exit, then calls `buildPrivateExitCandidate`; this module never
 * begins, invents or re-plans an exit.
 *
 * Mirrors the buy build (private-execution-build.ts): the local choke point (private-execution-gate.ts, step `exit_build`:
 * live_armed, armed, idle, the exits capability, the owner's own RPC; an entries pause never blocks an exit) first and
 * again after the build exchange; a bound, unlocked trading wallet that is the position's own wallet; the active lease;
 * the wallet kernel lock (so an exit waits behind any unfinished buy attempt of the same wallet); the SDK keyless build
 * with the runner's fixed-purpose EXIT proof (signRunnerExitExecutionProof, after re-checking the gate and that the
 * request is exactly the one built here); then the runner's own validation and simulation of those exact bytes
 * (preparePrivateSolanaExitSignature). Its strongest result is one single-use ValidatedSolanaMessage token: it never
 * signs, sends or submits.
 *
 * Pending-exit rules: nothing can be signed for this exit unless a `validated` outcome reaches the S4 submission path,
 * so every other outcome is a proven non-execution of this reservation and clears the pending exit as proven_negative
 * (positions.failExit), unless the journal already holds an attempt for the reservation (then it is never touched), the
 * position is held or no longer carries this exact pending exit, or the refusal precedes any read (`exit: "untouched"`).
 * An ambiguous build exchange (`unknown`) is also cleared: the server may hold an unsigned build for it, which only the
 * runner's own key could ever make executable. A failed clear leaves the pending exit in place (`exit: "retained"`);
 * restart recovery then clears it as never signed. */
import { RunnerExecutionBuildClient, runnerExecutionRequestDigest, validateRunnerSolanaSellAssessment, type RunnerExecutionBuild,
  type RunnerExecutionResponse, type RunnerExitRequest, type RunnerSellAssessmentRequest, type RunnerSolanaSellAssessment } from "@balchemyai/agent-sdk";
import { RunnerKernelLock, RunnerLockError } from "./kernel-lock.js";
import { signRunnerExitExecutionProof } from "./pairing-identity.js";
import { PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS, type PrivateExecutionHold } from "./private-execution-build.js";
import { privateExecutionGate, PRIVATE_EXECUTION_CAPABILITIES, type PrivateExecutionCapabilities, type PrivateExecutionGateRefusal,
  type PrivateExecutionLiveFacts } from "./private-execution-gate.js";
import type { PrivatePosition, PrivatePositionLedger, PrivatePositionPendingExit } from "./private-positions.js";
import type { PrivateSolanaSellSimulationEvidence } from "./private-solana-simulation.js";
import { preparePrivateSolanaExitSignature, type PrivateSolanaPreflightRpc } from "./private-solana-swap-preflight.js";
import { privateFeePolicyRefusal, privateFeeWallets } from "./private-fee-policy.js";
import type { PrivateSolanaValidatedSell } from "./private-solana-tx-validator.js";
import type { ValidatedSolanaMessage } from "./private-solana-validated-message.js";
import type { PrivateSubmissionJournal } from "./private-submission-journal.js";
import type { PrivateTradingBindingRecord } from "./private-trading-binding.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import type { RunnerAgentState } from "./protocol.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const POSITION_ID = /^pos:[0-9a-f]{32}$/;
export interface PrivateExitBuildOptions {
  directory: string; localProfileId: string; instanceId: string;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  readRuntime(agentId: string): RunnerAgentState | undefined;
  /** Live owner facts for the choke point (RPC class); a throw refuses. */
  readFacts(agentId: string): PrivateExecutionLiveFacts;
  /** Keystore status: only `unlocked` with a verified address that is the position's wallet proceeds. */
  readWallet(agentId: string): TradingWalletStatus;
  readBinding(agentId: string): PrivateTradingBindingRecord | undefined;
  /** The owner-local position ledger: read the position, clear a proven-negative pending exit. */
  positions: Pick<PrivatePositionLedger, "position" | "failExit">;
  /** The S4 journal, read only: a reservation that already has an attempt is never built again nor cleared here. */
  journal: Pick<PrivateSubmissionJournal, "forReservation">;
  /** The agent's own configured Solana RPC. */
  rpc: PrivateSolanaPreflightRpc;
  fetchFn?: typeof fetch;
  now?(): number;
  /** Test-only seam (see private-execution-gate.ts); production never sets it, so every exit is refused. */
  capabilities?: PrivateExecutionCapabilities;
}
export interface PrivateExitBuildInput { positionId: string; assessment: RunnerSolanaSellAssessment }
/** `cleared`: the pending exit was failed as proven_negative. `retained`: it stays (an attempt exists, the position is held,
 * or clearing failed). `untouched`: refused before the position was read, or it no longer carries this exact pending exit. */
export type PrivateExitPendingDisposition = "cleared" | "retained" | "untouched";
export type PrivateExitBuildOutcome =
  | { readonly outcome: "validated"; readonly positionId: string; readonly reservationId: string; readonly units: string;
    readonly message: ValidatedSolanaMessage; readonly swap: PrivateSolanaValidatedSell; readonly simulation: PrivateSolanaSellSimulationEvidence;
    readonly expiresAtMs: number;
    readonly build: Readonly<Pick<RunnerExecutionBuild, "walletBindingId" | "unsignedMessageB64" | "messageSha256" | "lastValidBlockHeight" | "buildDigest" | "expiresAt">>;
    readonly assessmentDigest: string; readonly hold: PrivateExecutionHold;
    /** The armed runtime revision this build ran under; signing requires the same revision (gate step `exit_sign`). */
    readonly runtimeVersion: number }
  | { readonly outcome: "refused"; readonly stage: "local" | "server" | "preflight"; readonly reason: string; readonly exit: PrivateExitPendingDisposition }
  | { readonly outcome: "unknown"; readonly positionId: string; readonly reservationId: string; readonly exit: "cleared" | "retained" };

function identity(lease: Readonly<RunnerRuntimeActiveLease>): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest, lease.runnerPublicKey, lease.instanceId, lease.epoch]);
}
function reasonText(code: string): string { return code.replace(/[^a-z0-9_:]/g, "_").slice(0, 96) || "refused"; }
function samePending(a: PrivatePositionPendingExit, b: PrivatePositionPendingExit): boolean {
  return a.reservationId === b.reservationId && a.trigger === b.trigger && a.level === b.level && a.units === b.units && a.createdAt === b.createdAt;
}

export async function buildPrivateExitCandidate(options: PrivateExitBuildOptions, agentId: string, input: PrivateExitBuildInput,
  signal?: AbortSignal): Promise<PrivateExitBuildOutcome> {
  const refused = (reason: string, stage: "local" | "server" | "preflight", exit: PrivateExitPendingDisposition): PrivateExitBuildOutcome =>
    Object.freeze({ outcome: "refused" as const, stage, reason, exit });
  // FIRST: the exits capability, before any lock, read or network call. The exits-off rollback build always refuses here.
  const capabilities = options.capabilities ?? PRIVATE_EXECUTION_CAPABILITIES;
  if (typeof capabilities !== "object" || capabilities === null || capabilities.exits !== true) return refused("exits_unavailable", "local", "untouched");
  const now = options.now ?? Date.now;
  const positionId = input?.positionId;
  if (typeof positionId !== "string" || !POSITION_ID.test(positionId) || typeof input.assessment !== "object" || input.assessment === null) {
    return refused("exit_not_executable", "local", "untouched");
  }
  // The pending exit this build is for, once read; cleared only while the position still carries exactly it.
  let pending: PrivatePositionPendingExit | undefined;
  const readOpen = (): PrivatePosition | undefined => {
    const current = options.positions.position(agentId, positionId);
    return current && current.state === "open" && current.pendingExit ? current : undefined;
  };
  /** Proven non-execution of this reservation: fail its pending exit as proven_negative (never when an attempt exists). */
  const clear = (reason: string): "cleared" | "retained" | "untouched" => {
    try {
      const current = readOpen();
      const target = pending ?? current?.pendingExit ?? undefined;
      if (!current || !target || !current.pendingExit || !samePending(current.pendingExit, target)) return "untouched";
      if (options.journal.forReservation(agentId, target.reservationId) !== undefined) return "retained";
      options.positions.failExit(agentId, positionId, target.reservationId, "proven_negative", reasonText(`s5c:${reason}`), now());
      return "cleared";
    } catch { return "retained"; }
  };
  const refuse = (code: string, stage: "local" | "server" | "preflight" = "local", reason: string = code): PrivateExitBuildOutcome =>
    refused(code, stage, clear(reason));
  // The runtime revision the first gate saw; a re-arm in between is a different authority.
  let runtimeVersion: number | undefined;
  const gate = (): PrivateExecutionGateRefusal | null => {
    let runtime: RunnerAgentState | undefined; let facts: PrivateExecutionLiveFacts | undefined;
    try { runtime = options.readRuntime(agentId); } catch { return "runtime_unavailable"; }
    try { facts = options.readFacts(agentId); } catch { facts = undefined; }
    const blocked = privateExecutionGate(runtime, { step: "exit_build", agentId, facts }, capabilities);
    if (blocked || !runtime) return blocked ?? "runtime_unavailable";
    if (runtimeVersion === undefined) runtimeVersion = runtime.version;
    return runtime.version === runtimeVersion ? null : "runtime_changed";
  };
  const blocked = gate();
  if (blocked) return refuse(blocked);
  const lease = options.readLease(agentId);
  if (!lease || lease.instanceId !== options.instanceId || !(lease.remainingMs > 0)) return refuse("lease_unavailable");
  const pinned = identity(lease);

  // The position: open, with a pending exit, on a wallet and mint this exit can sell.
  let found: PrivatePosition | undefined;
  try { found = options.positions.position(agentId, positionId); } catch { return refused("state_unavailable", "local", "retained"); }
  if (!found) return refused("position_missing", "local", "untouched");
  if (found.state === "held") return refused("position_held", "local", "retained");
  if (found.state !== "open" || !found.pendingExit) return refused("exit_missing", "local", "untouched");
  const position: PrivatePosition = found;
  const exit: PrivatePositionPendingExit = found.pendingExit;
  pending = exit;
  // An attempt for this reservation means a signature may exist: never build again, never clear here.
  try { if (options.journal.forReservation(agentId, exit.reservationId) !== undefined) return refused("attempt_exists", "local", "retained"); }
  catch { return refused("state_unavailable", "local", "retained"); }

  // Evidence: a COMPLETE sell assessment for exactly (position mint -> WSOL, the pending units, the entry plan digest and slippage),
  // inside its window by the local clock.
  let assessment: Readonly<RunnerSolanaSellAssessment>;
  try {
    const supplied = input.assessment;
    // Balchemy binds an exit to its entry plan: the assessment must name exactly the position's entry plan and slippage.
    if (supplied.planDigest !== position.entry.planDigest || supplied.slippageBps !== position.entry.slippageBps) throw new Error("entry plan mismatch");
    const sellRequest: RunnerSellAssessmentRequest = { version: 1, chain: "solana", inputMint: position.tokenMint, outputMint: WSOL_MINT,
      grossInputAmount: exit.units, slippageBps: supplied.slippageBps, planDigest: supplied.planDigest };
    assessment = validateRunnerSolanaSellAssessment(supplied, sellRequest, now());
  } catch { return refuse("assessment_invalid"); }
  const quote = assessment.quote;
  if (assessment.status !== "complete" || !quote || !assessment.accounts) return refuse("assessment_incomplete");
  // The runner's own fee policy (at most 150 bps, to an allow-listed fee wallet), before any lock or build request.
  const feePolicy = privateFeePolicyRefusal(assessment.fee.rateBps, assessment.fee.recipient, privateFeeWallets(capabilities));
  if (feePolicy) return refuse(feePolicy);

  // Wallet: the verified, unlocked trading wallet is the position's own wallet, bound to this lease's identity.
  const walletRead = (): string => {
    let wallet: TradingWalletStatus;
    try { wallet = options.readWallet(agentId); } catch { return "state_unavailable"; }
    if (wallet.state === "absent") return "wallet_missing";
    if (wallet.state !== "unlocked" || !wallet.addressVerified) return wallet.state === "held" ? "state_unavailable" : "wallet_locked";
    return wallet.address === position.walletAddress ? "" : "wallet_mismatch";
  };
  const walletRefusal = walletRead();
  if (walletRefusal) return refuse(walletRefusal);
  const walletAddress = position.walletAddress;
  let binding: PrivateTradingBindingRecord | undefined;
  try { binding = options.readBinding(agentId); } catch { return refuse("state_unavailable"); }
  if (!binding) return refuse("wallet_unbound");
  if (binding.state === "revoked") return refuse("wallet_revoked");
  const bound = binding.binding;
  if (bound.status !== "active" || bound.walletAddress !== walletAddress || bound.agentId !== lease.agentId || bound.bindingDigest !== lease.bindingDigest
    || bound.runnerPublicKey !== lease.runnerPublicKey || binding.frontendOrigin !== lease.frontendOrigin) return refuse("wallet_binding_mismatch");

  // Closed exit request (SDK key order): the pending exit's own reservation, the entry that opened the position, the assessed
  // trigger observation, the runner's own priority ceiling, and the assessment's slippage and fee policy.
  const request: RunnerExitRequest = { version: 1, chain: "solana", direction: "sell", reservationId: exit.reservationId,
    planDigest: assessment.planDigest, assessmentDigest: assessment.assessmentDigest, positionMint: position.tokenMint, grossTokenUnits: exit.units,
    exitTrigger: exit.trigger, triggerObservation: { sellAssessmentDigest: assessment.assessmentDigest, observedOutLamports: quote.outAmount,
      observedAtMs: quote.observedAtMs }, entryBuildDigests: [position.entry.buildDigest], walletAddress, slippageBps: assessment.slippageBps,
    minOutBound: quote.minOut, maxPriorityFeeLamports: PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS.toString(), feeRateBps: assessment.fee.rateBps,
    feePolicyDigest: assessment.fee.policyDigest };
  let requestDigest: string;
  try { requestDigest = runnerExecutionRequestDigest(request); } catch { return refuse("request_unrepresentable"); }

  // The wallet lock: an unfinished attempt (a buy or another exit) of this wallet holds it until its terminal state.
  let lock: RunnerKernelLock;
  try { lock = RunnerKernelLock.acquireWallet(options.directory, walletAddress); }
  catch (error: unknown) { return refuse(error instanceof RunnerLockError && error.code === "lock_busy" ? "wallet_busy" : "state_unavailable"); }
  let held = true; let transferred = false;
  const unlock = (): void => { if (held) { held = false; try { lock.close(); } catch { /* Process exit releases it. */ } } };
  try {
    const current = options.readLease(agentId);
    if (!current || identity(current) !== pinned || !(current.remainingMs > 0)) return refuse("lease_unavailable");
    if (!(now() < Number(assessment.expiresAtMs))) return refuse("assessment_expired");
    if (signal?.aborted) return refuse("build_unavailable");
    const seen: { signed: boolean } = { signed: false };
    let response: RunnerExecutionResponse;
    try {
      const client = new RunnerExecutionBuildClient({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId, bindingDigest: lease.bindingDigest,
        runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, apiBaseUrl: `${lease.frontendOrigin}/api`, timeoutMs: 20_000,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        signer: (nonce, expected) => {
          const live = options.readLease(agentId);
          if (signal?.aborted || !live || identity(live) !== pinned || !(live.remainingMs > 0)) throw new Error("lease changed");
          // Disarm, stop or a re-arm during the nonce exchange: the proof is never made, so no build request is ever sent.
          if (gate()) throw new Error("exit gate closed");
          // Only exactly the exit request built here: never a buy, never another exit.
          if (expected.request.direction !== "sell" || runnerExecutionRequestDigest(expected.request) !== requestDigest) throw new Error("intent mismatch");
          const signature = signRunnerExitExecutionProof({ directory: options.directory, localProfileId: options.localProfileId, agentId },
            { instanceId: lease.instanceId, epoch: expected.epoch, request: expected.request, nonce });
          seen.signed = true;
          return signature;
        } });
      response = await client.build(request, lease.epoch, signal);
    } catch {
      // Before the runner proof existed no build request could have been sent.
      if (!seen.signed) return refuse("build_unavailable", "local", "build_not_sent");
      const exitState = clear("build_outcome_unknown");
      return Object.freeze({ outcome: "unknown" as const, positionId, reservationId: exit.reservationId, exit: exitState === "cleared" ? "cleared" as const : "retained" as const });
    }
    // Every server refusal precedes any bytes: clear and report the code verbatim.
    if (response.outcome === "refused") return refuse(response.reasonCode, "server", `server:${response.reasonCode}`);
    const build = response.build;
    if (build.walletBindingId !== bound.walletBindingId) return refuse("build_binding_mismatch", "server");
    // Re-read local authority after the network exchange; a changed wallet, lease, runtime or position never yields a token.
    const after = walletRead();
    if (after) return refuse(after, "local", `wallet_changed:${after}`);
    const leaseAfter = options.readLease(agentId);
    if (!leaseAfter || identity(leaseAfter) !== pinned) return refuse("lease_unavailable", "local", "lease_changed");
    const armedAfter = gate();
    if (armedAfter) return refuse(armedAfter, "local", `gate:${armedAfter}`);
    let latest: PrivatePosition | undefined;
    try { latest = readOpen(); } catch { return refused("state_unavailable", "local", "retained"); }
    if (!latest || !latest.pendingExit || !samePending(latest.pendingExit, exit) || latest.remainingUnits !== position.remainingUnits) {
      return refused("exit_changed", "local", "untouched");
    }
    const verdict = await preparePrivateSolanaExitSignature(options.rpc, { agentId, wallet: walletAddress, position: latest, pendingExit: latest.pendingExit,
      assessment, build: { unsignedMessageB64: build.unsignedMessageB64, messageSha256: build.messageSha256, lastValidBlockHeight: build.lastValidBlockHeight,
        expected: structuredClone(build.expected) }, maxPriorityFeeLamports: PRIVATE_EXECUTION_MAX_PRIORITY_FEE_LAMPORTS }, signal, now, capabilities);
    // Validator-refused bytes can never reach the keystore: nothing can be sold for this reservation.
    if (!verdict.ok) return refuse(verdict.reason, "preflight", `preflight:${verdict.reason}`);
    const version = runtimeVersion;
    if (version === undefined) return refuse("runtime_unavailable");
    const hold: PrivateExecutionHold = Object.freeze({ walletAddress, release: unlock,
      assertHeld: (): void => { if (!held) throw new RunnerLockError("unsafe_lock"); lock.assertValid(); } });
    const result = Object.freeze({ outcome: "validated" as const, positionId, reservationId: exit.reservationId, units: exit.units, message: verdict.message,
      swap: verdict.swap, simulation: verdict.simulation, expiresAtMs: verdict.expiresAtMs,
      build: Object.freeze({ walletBindingId: build.walletBindingId, unsignedMessageB64: build.unsignedMessageB64, messageSha256: build.messageSha256,
        lastValidBlockHeight: build.lastValidBlockHeight, buildDigest: build.buildDigest, expiresAt: build.expiresAt }),
      assessmentDigest: assessment.assessmentDigest, hold, runtimeVersion: version });
    transferred = true;
    return result;
  } finally { if (!transferred) unlock(); }
}
