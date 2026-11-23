import { RunnerRpcAccessClient, type RunnerBrainObservation, type RunnerKeystoreObservation } from "@balchemyai/agent-sdk";
import { deriveBehaviorRuleExecutionPolicy, isBehaviorRuleApprovalAutomatic, toBehaviorRuleExecutionBinding } from "@balchemyai/agent-rules";
import { PRIVATE_DCA_ENABLED, PRIVATE_RULE_EXECUTION_OPTIONS, privateBuildEntryRefusal, privateHeldMints, privateStatedMaxPositions,
  type PrivateMaxPositions } from "./private-typed-rules.js";
import { readPrivateHolderShares } from "./private-holder-share.js";
import { PrivateLaunchpadError, PrivateLaunchpads, privateLaunchpadView } from "./private-launchpads.js";
import { parsePrivateLaunchpadRequest, privateLaunchpadFailure, privateLaunchpadSuccess, PRIVATE_LAUNCHPAD_TIMEOUT_MS,
  type PrivateLaunchpadResponse } from "./private-launchpad-protocol.js";
import type { PrivateSignalJob } from "./private-signal-job.js";
import { privateSetupContext, privateSetupRpc, readPrivateSetupFacts } from "./private-setup-context.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { PACKAGE_VERSION } from "../package-version.js";
import { encodeFrame, failure, FrameReader, isId, isRecord, PACKAGE_VERSION_PATTERN, parseLocalRequest, RUNNER_DCA_STATUS_MAX_HOLDS, type RunnerDaemonState, type RunnerExecutionStatus,
  type RunnerRegisterRequest, type RunnerRequest, type RunnerResponse } from "./protocol.js";
import { RunnerStateStore } from "./state.js";
import { RunnerRuntimeBridge } from "./runtime-bridge.js";
import { RunnerControlBridge } from "./control-bridge.js";
import { RunnerSignalsBridge } from "./signals-bridge.js";
import { PrivateDecisionOutbox, RunnerDecisionReportBridge } from "./private-decision-outbox.js";
import { PrivateBrainService } from "./private-brain-service.js";
import { parsePrivateBrainRequest, privateBrainFailure, type PrivateBrainResponse } from "./private-brain-protocol.js";
import { queryPrivateResearchReceipt } from "./private-research.js";
import { PrivateAssessmentPacer, queryPrivateAssessmentReceipt } from "./private-assessment.js";
import { PrivateRuleService } from "./private-rule-service.js";
import { parsePrivateRuleRequest, privateRuleFailure, privateRuleSuccess, type PrivateRuleResponse } from "./private-rule-protocol.js";
import { PrivateIntentService } from "./private-intent-service.js";
import { parsePrivateIntentRequest, privateIntentFailure, type PrivateIntentResponse } from "./private-intent-protocol.js";
import { parsePrivateSignalRequest, privateSignalFailure, privateSignalSuccess, PRIVATE_SIGNAL_READ_ERRORS,
  type PrivateSignalReadError, type PrivateSignalResponse } from "./private-signal-protocol.js";
import { PrivateBrainStoreError } from "./private-brain-store.js";
import { parsePrivateAutonomyRequest, privateAutonomyFailure, type PrivateAutonomyResponse } from "./private-autonomy-protocol.js";
import { parsePrivateModelBudgetRequest, privateModelBudgetFailure, type PrivateModelBudgetResponse } from "./private-model-budget-protocol.js";
import { parsePrivateSizingRequest, privateSizingFailure, privateSizingSuccess, type PrivateSizingResponse } from "./private-sizing-protocol.js";
import { PrivateTradingKeystore } from "./private-trading-keystore.js";
import { parsePrivateTradingWalletRequest, privateTradingWalletFailure, TRADING_WALLET_UNLOCK_TIMEOUT_MS,
  type PrivateTradingWalletResponse } from "./private-trading-keystore-protocol.js";
import { readPairingAdoption, readPairingOwnerApprovalIdentity, readPairingWallet, signRunnerRpcAccessProof } from "./pairing-identity.js";
import { PrivateTradingBindings } from "./private-trading-binding.js";
import { parsePrivateTradingBindingRequest, privateTradingBindingFailure, TRADING_BINDING_TIMEOUT_MS,
  type PrivateTradingBindingResponse } from "./private-trading-binding-protocol.js";
import { PrivateSolanaRpcSettings, PrivateSolanaRpcSettingsError, type PrivateEffectiveRpcStatus } from "./private-solana-rpc-settings.js";
import { parsePrivateSolanaRpcRequest, privateSolanaRpcFailure, privateSolanaRpcSuccess, PRIVATE_SOLANA_RPC_CHANNEL_ERRORS,
  type PrivateSolanaRpcChannelError, type PrivateSolanaRpcResponse } from "./private-solana-rpc-protocol.js";
import { PrivateSolanaRpc } from "./private-solana-rpc.js";
import { PrivateDualSolanaRpc, PRIVATE_POSITION_OPENING_READ_CLASS, type PrivateDualSolanaSource, type PrivateRpcReadClass,
  type PrivateSolanaReader } from "./private-solana-rpc-sources.js";
import { PrivateBalchemyRpcAccess, type PrivateBalchemyRpcAccessOptions } from "./private-balchemy-rpc.js";
import { PrivateSpendLedger } from "./private-spend-ledger.js";
import { PrivateSubmissionJournal } from "./private-submission-journal.js";
import { privateBuyAwaitingPosition, PrivateSubmissions, type PrivateSubmissionCloseOut } from "./private-submission.js";
import { parsePrivateSubmissionRequest, privateSubmissionFailure, privateSubmissionSuccess, privateTradeClosePhrase, PRIVATE_TRADE_CLOSE_TIMEOUT_MS,
  type PrivateSubmissionResponse } from "./private-submission-protocol.js";
import { privateSubmissionArmingCounts, privateSubmissionKeptReservations } from "./private-submission-journal.js";
import { PrivateSpendCapProposals } from "./private-spend-cap-proposals.js";
import { PrivateArming, privateArmingSubmissionCounts, privateDisarmForOwnerChange } from "./private-arming.js";
import { parsePrivateKeepAwakeRequest, PrivateKeepAwake, PRIVATE_KEEP_AWAKE_POLL_MS, privateKeepAwakeReply, type PrivateKeepAwakeOptions,
  type PrivateKeepAwakeResponse } from "./private-keep-awake.js";
import { PrivateOwnerApprovals, privateOwnerApprovalTransport } from "./private-owner-approvals.js";
import { PrivateAutoBind } from "./private-auto-bind.js";
import { PrivateCeilingWorker, privateCeilingReadTransport, type PrivateCeilingReadTransport } from "./private-first-enable-ceiling.js";
import { parsePrivateSetupRequest, privateSetupFailure, privateSetupSuccess, type PrivateSetupResponse } from "./private-setup-protocol.js";
import { parsePrivateArmingRequest, privateArmingFailure, privateArmingSuccess, PRIVATE_ARMING_TIMEOUT_MS, type PrivateArmingResponse } from "./private-arming-protocol.js";
import { PrivateChangeHolds, privateRpcSetRefusal, type PrivateChangeEntries, type PrivateChangeHold } from "./private-change-entries.js";
import type { RunnerKernelLock } from "./kernel-lock.js";
import { buildPrivateExecutionCandidate, type PrivateExecutionBuildOutcome } from "./private-execution-build.js";
import { PRIVATE_EXECUTION_CAPABILITIES, privateExecutionLiveFacts, type PrivateExecutionCapabilities, type PrivateExecutionLiveFacts } from "./private-execution-gate.js";
import { PrivateExecutionIntents, PrivateExecutionWorker } from "./private-execution-intents.js";
import { buildPrivateExitCandidate, type PrivateExitBuildOutcome } from "./private-exit-build.js";
import { PrivateExitWorker, queryPrivateSellAssessment, type PrivateExitDcaHooks } from "./private-exit-worker.js";
import { PrivateDcaStore } from "./private-dca-store.js";
import { PrivateDcaWorker, type PrivateDcaRules } from "./private-dca-worker.js";
import { buildPrivateDcaCandidate } from "./private-dca-build.js";
import { PrivatePositionLedger } from "./private-positions.js";
import { PrivatePositionRecovery } from "./private-position-recovery.js";
import { PrivateExitRebind, PrivateExitRebindRefused, type PrivateExitRebindRules } from "./private-exit-rebind.js";
import { parsePrivateExitRebindRequest, privateExitRebindFailure, privateExitRebindSuccess,
  type PrivateExitRebindResponse } from "./private-exit-rebind-protocol.js";
import { readPrivatePositionsWithoutExits } from "./private-position-exits-off.js";
import { parsePrivatePositionRequest, privatePositionFailure, privatePositionSuccess, PRIVATE_POSITION_PROOF_TIMEOUT_MS,
  type PrivatePositionResponse } from "./private-position-protocol.js";
import { autonomyRaise, budgetRaise, capsRaise, classifySocketFrame, launchpadRaise, priceRaise, PRIVATE_SOCKET_PROOF_ENFORCED, ruleConfirmRaise,
  sizingRaise, socketProofEntry, type PrivateAuthorityField, type PrivateSocketProofError, type SocketProofChannel } from "./private-socket-proof.js";
import { PrivateOwnerPins } from "./private-owner-pin.js";
import { parsePrivateAuthorityCurrent, PrivateAuthoritySeals, privateAuthorityView, privateAuthorityViewDigest, privateLaunchpadsWithinProven,
  type PrivateAuthorityCheck, type PrivateAuthorityCurrent } from "./private-authority-seal.js";
import { parsePrivateOwnerPinRequest, privateOwnerPinFailure, privateOwnerPinSuccess, PRIVATE_OWNER_PIN_CHANNEL_ERRORS,
  type PrivateOwnerPinChannelError, type PrivateOwnerPinRequest, type PrivateOwnerPinResponse } from "./private-owner-pin-protocol.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import type { PrivateBuyAmountPolicy } from "./private-sizing.js";
import type { PrivateModelBudgetStatus } from "./private-model-budget.js";
import type { PrivateAutonomyStatus } from "./private-autonomy.js";

export const SOCKET_FILE = "control.sock";
/** How often the Balchemy-provided RPC grants are checked for a first fetch or a refresh (each request is itself spaced). */
const BALCHEMY_RPC_PASS_MS = 2_000;
/** K2 setup workers (automatic link, spend ceiling): each pass only starts what is due (each worker spaces its own requests). */
const SETUP_PASS_MS = 1_000;
const CONNECTION_TIMEOUT_MS = 3_000;
const MAX_CONNECTIONS = 32;

export class RunnerDaemonError extends Error {
  constructor(readonly code: "unsupported_platform" | "socket_path_too_long" | "socket_unavailable") {
    super(`Local runner ${code}`);
    this.name = "RunnerDaemonError";
  }
}

export function requireUnixPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux" && platform !== "darwin") throw new RunnerDaemonError("unsupported_platform");
}

/** A2a socket gate (plan section A2): the closed refusals it answers on every gated channel. */
type SocketProofRefusal = PrivateSocketProofError | "state_unavailable" | "closing";
/** One owner-socket frame as the gate sees it. `passphrase`: the frame's socket-proof field only (never arm's or the model vault's own
 * passphrase). `raises`: the comparator of a `compare` entry against the STORED value (a throw counts as raising). */
interface SocketProofFrame {
  channel: SocketProofChannel; action: string; agentId: string; passphrase: string | undefined;
  raises?: () => boolean | Promise<boolean>;
}
/** `gated`: the gate ran (enforced, or a proof field was present); `proven`: the trading-wallet passphrase was verified for this frame. */
interface SocketProofPass { gated: boolean; proven: boolean }
/** A copy of a parsed frame without its socket-proof field: each service re-parses its input, and the passphrase never reaches a store. */
function withoutProof(frame: object, field: "passphrase" | "walletPassphrase"): Record<string, unknown> {
  const { [field]: _proof, ...rest } = frame as Record<string, unknown>;
  void _proof;
  return rest;
}
/** A keystore refusal of the passphrase check, as a closed gate code. */
function proofRefusal(error: unknown): SocketProofRefusal {
  const code = isRecord(error) ? error.code : undefined;
  return code === "unlock_failed" ? "passphrase_rejected" : code === "throttled" ? "proof_throttled" : code === "wallet_locked" ? "wallet_locked"
    : code === "busy" ? "busy" : code === "cancelled" ? "cancelled" : code === "closing" ? "closing" : "state_unavailable";
}

export interface RunnerDaemonHandle {
  readonly socketPath: string;
  readonly instanceId: string;
  readonly closed: Promise<void>;
  /** Closes only this daemon's listener, clients and store lock. Idempotent. */
  close(): Promise<void>;
}

/** No process signals or terminal ownership: the host decides daemon lifetime. */
export async function startRunnerDaemon(options: {
  directory: string;
  ownerId: string;
  agentIds: string[];
  instanceId?: string;
  /** The host owns an inherited writer until its final metadata cleanup. */
  writerLock?: RunnerKernelLock;
  /** Test-only capability seam (see private-execution-gate.ts), for example the exits-off rollback build's `{ exits: false }`:
   * forwarded, only when set, to every service built here that takes the same seam. Production callers (host.ts) never pass it,
   * and nothing at runtime (no env var, file or IPC) can set it; absent, this daemon runs under PRIVATE_EXECUTION_CAPABILITIES. */
  capabilities?: PrivateExecutionCapabilities;
  /** Phase 1 keep-awake: the host passes the real inhibitor spawn (host.ts); tests pass a fake one or nothing. Absent, no inhibitor
   * is ever started (an in-process test daemon never keeps the test machine awake) and `runner status` reads it as not reported. */
  keepAwake?: Pick<PrivateKeepAwakeOptions, "spawn" | "platform" | "exists" | "pid" | "now" | "retryMs">;
  /** Owner decision of 17 Nov 2026: the Balchemy-provided Solana RPC grant (two providers). The host enables it (host.ts); a test passes
   * its own `fetchGrant` (and pin table) or nothing. Absent, no grant is ever requested, so an in-process test daemon never calls a
   * Hub fixture's rpc-access route, and agents without their own RPC have none. */
  balchemyRpc?: { enabled: true } | (Pick<PrivateBalchemyRpcAccessOptions, "fetchGrant" | "hosts" | "now">
    & Partial<Pick<PrivateBalchemyRpcAccessOptions, "readGenesisHash">>);
  /** K2 one-visit setup (owner decisions of 19 Nov 2026): the automatic trading-wallet link after pairing and the spend-ceiling
   * worker. The host enables them (host.ts); a test passes its own proposal-read transport (and clocks) or nothing. Absent, neither
   * worker exists, so an in-process test daemon never binds or reads a proposal by itself, and `private_setup` answers
   * setup_unavailable. */
  setup?: { enabled: true } | { ceilingTransport: PrivateCeilingReadTransport; now?: () => number; monotonicNow?: () => number };
  /** A2a test-only seam: turns the socket-proof requirement on. Since A2a T4 the shipped PRIVATE_SOCKET_PROOF_ENFORCED is true, so this is
   * redundant; it can only switch the requirement on, never off. Production callers (host.ts) never pass it, and nothing at runtime (no
   * env var, file or IPC) can set it. */
  enforceSocketProof?: true;
}): Promise<RunnerDaemonHandle> {
  requireUnixPlatform();
  const instanceId = options.instanceId ?? randomUUID();
  if (!isId(instanceId)) throw new RunnerDaemonError("socket_unavailable");
  const store = new RunnerStateStore(options);
  const socketPath = path.join(store.directory, SOCKET_FILE);
  if (Buffer.byteLength(socketPath) > 100) {
    store.close();
    throw new RunnerDaemonError("socket_path_too_long");
  }
  const connections = new Set<net.Socket>();
  // A2a: the socket-proof requirement (private-socket-proof.ts); the test seam can only switch it on.
  const proofEnforced = PRIVATE_SOCKET_PROOF_ENFORCED || options.enforceSocketProof === true;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let privateBrain: PrivateBrainService | undefined;
  let privateRules: PrivateRuleService | undefined;
  let privateIntents: PrivateIntentService | undefined;
  let tradingKeystore: PrivateTradingKeystore | undefined;
  let tradingKeystoreUnavailable = false;
  let tradingBindings: PrivateTradingBindings | undefined;
  let solanaRpcSettings: PrivateSolanaRpcSettings | undefined;
  let decisionOutbox: PrivateDecisionOutbox | undefined;
  let decisionOutboxUnavailable = false;
  let spendLedger: PrivateSpendLedger | undefined;
  let submissionJournal: PrivateSubmissionJournal | undefined;
  let submissionService: PrivateSubmissions | undefined;
  let armingService: PrivateArming | undefined;
  let ownerApprovalStore: PrivateOwnerApprovals | undefined;
  let executionIntents: PrivateExecutionIntents | undefined;
  let executionWorker: PrivateExecutionWorker | undefined;
  let executionStarted = false;
  // M3.6: every assessment of an agent (arming fee probe, signal decision, build re-assessment) goes through one pacer, so a
  // signal is never refused by Balchemy's one-assessment-per-agent-per-5-s window because the arm probe just used it.
  const assessmentPacer = new PrivateAssessmentPacer();
  // S5c exits: wired only when the exits capability is available (the production capabilities since S5). On the exits-off
  // rollback build (false) no position ledger or exit worker is ever constructed and the submission service is built without
  // positions/retain.
  const exitsAvailable = (options.capabilities ?? PRIVATE_EXECUTION_CAPABILITIES).exits === true;
  // The test-only seam, spread into each service's options only when a test set it (absent in production).
  const capabilitySeam = options.capabilities ? { capabilities: options.capabilities } : {};
  let positionLedger: PrivatePositionLedger | undefined;
  let exitWorker: PrivateExitWorker | undefined;
  let exitStarted = false;
  let positionRecovery: PrivatePositionRecovery | undefined;
  // K1b DCA: constructed only when this build declares dca.v1 (PRIVATE_DCA_ENABLED) and exits are available.
  let dcaStore: PrivateDcaStore | undefined;
  let dcaWorker: PrivateDcaWorker | undefined;
  // P3-2: per-agent owner-config guard shared by arming and every rules/RPC/sizing/limits change. `busy` counts changes in
  // flight; `generation` moves when each starts and ends, so an arm that overlapped any change refuses.
  const configGuards = new Map<string, { busy: number; generation: number }>();
  const configGuard = (agentId: string): { busy: boolean; generation: number } => {
    const entry = configGuards.get(agentId); return { busy: (entry?.busy ?? 0) > 0, generation: entry?.generation ?? 0 };
  };
  const beginConfig = (agentId: string): (() => void) => {
    const entry = configGuards.get(agentId) ?? { busy: 0, generation: 0 }; configGuards.set(agentId, entry);
    entry.busy += 1; entry.generation += 1; let done = false;
    return () => { if (done) return; done = true; entry.busy -= 1; entry.generation += 1; };
  };
  // Bounded per-decision reports (owner decision of 11 Nov 2026). A store that cannot be constructed disables reports only.
  const reportOutbox = (): PrivateDecisionOutbox | undefined => {
    if (!decisionOutbox && !decisionOutboxUnavailable) {
      try {
        decisionOutbox = new PrivateDecisionOutbox({ directory: store.directory, localProfileId: options.ownerId,
          agentIds: store.agentIds() ?? [], assertAvailable: () => {
            if (closing || !store.isAvailable()) throw new Error("private writer unavailable");
          } });
      } catch { decisionOutboxUnavailable = true; }
    }
    return decisionOutbox;
  };
  // Created on first use; the full URL never leaves this store except to the agent's own RPC client.
  const solanaRpc = (): PrivateSolanaRpcSettings => {
    solanaRpcSettings ??= new PrivateSolanaRpcSettings({ directory: store.directory, localProfileId: options.ownerId,
      agentIds: store.agentIds() ?? [], assertAvailable: () => {
        if (closing || !store.isAvailable()) throw new Error("private writer unavailable");
      } });
    return solanaRpcSettings;
  };
  // Owner decision of 17 Nov 2026: users are never asked for an RPC. Balchemy provides two providers; each agent's grant is fetched
  // once its live lease exists, held in memory only and pinned to the runner's own host table (private-balchemy-rpc.ts).
  const balchemyRpcSeam = options.balchemyRpc && "fetchGrant" in options.balchemyRpc ? options.balchemyRpc : undefined;
  const balchemyRpc = new PrivateBalchemyRpcAccess({ agentIds: store.agentIds() ?? [], readLease: (agentId) => runtimeBridge.activeLease(agentId),
    ...(balchemyRpcSeam?.hosts ? { hosts: balchemyRpcSeam.hosts } : {}), ...(balchemyRpcSeam?.now ? { now: balchemyRpcSeam.now } : {}),
    // Audit L7: each new source URL must answer Solana mainnet-beta's genesis hash before its grant is adopted.
    readGenesisHash: balchemyRpcSeam?.readGenesisHash ?? ((source, signal) => new PrivateSolanaRpc({ endpoint: source.url, headers: source.headers }).getGenesisHash(signal)),
    fetchGrant: balchemyRpcSeam ? balchemyRpcSeam.fetchGrant : (agentId, lease, signal) => new RunnerRpcAccessClient({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId,
      bindingDigest: lease.bindingDigest, runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, apiBaseUrl: `${lease.frontendOrigin}/api`,
      signer: (nonce, expected) => {
        const current = runtimeBridge.activeLease(agentId);
        if (!current || current.agentId !== lease.agentId || current.bindingDigest !== lease.bindingDigest || current.epoch !== expected.epoch) {
          throw new Error("lease changed");
        }
        return signRunnerRpcAccessProof({ directory: store.directory, localProfileId: options.ownerId, agentId },
          { instanceId: lease.instanceId, epoch: expected.epoch, nonce });
      } }).grant(lease.epoch, signal) });
  /** The RPC an agent executes on (the one place that decides it): an owner endpoint of the owner class keeps today's single
   * source; otherwise a held, pinned Balchemy grant (two providers) is `balchemy_provided`; otherwise the owner's public endpoint
   * (shadow only) or none. Display-safe: hosts or provider names only. */
  const effectiveRpc = (agentId: string): PrivateEffectiveRpcStatus => {
    const own = solanaRpc().status(agentId).endpoint;
    if (own?.class === "owner_configured") return { agentId, endpoint: own };
    const grant = balchemyRpc.grant(agentId);
    if (grant) return { agentId, endpoint: { class: "balchemy_provided", host: `balchemy:${grant.sources[0].provider}:${grant.sources[1].provider}`, revision: 0 } };
    return { agentId, endpoint: own };
  };
  /** The single RPC factory: every read of every reader goes through it, so the class policy applies everywhere. `readClass` is the
   * policy of the call site (private-solana-rpc-sources.ts): `entry` both sources must agree; `exit` one source may prove a positive
   * result when the other is unavailable; `display` the first answer. Owner endpoint: one source, as before. */
  const rpcReader = (agentId: string, readClass: PrivateRpcReadClass, height?: "max" | "min"): PrivateSolanaReader | undefined => {
    const own = solanaRpc().endpoint(agentId);
    if (own?.class === "owner_configured") return new PrivateSolanaRpc({ endpoint: own.url });
    const grant = balchemyRpc.grant(agentId);
    if (grant) {
      const source = (index: 0 | 1): PrivateDualSolanaSource => {
        const held = grant.sources[index];
        return { id: held.id, provider: held.provider, rpc: new PrivateSolanaRpc({ endpoint: held.url, headers: held.headers }),
          // Audit follow-up: a reader built from an older grant never uses its URLs once a new grant is adopted.
          available: () => balchemyRpc.grant(agentId) === grant && balchemyRpc.sourceAvailable(agentId, held.id) };
      };
      // Audit M2: the lag-pass memory is the agent's (held by balchemyRpc), never this per-read instance's.
      const lagPositives = balchemyRpc.lagPositives(agentId);
      return new PrivateDualSolanaRpc({ readClass, ...(height ? { height } : {}), sources: [source(0), source(1)],
        onFailure: (id, code) => balchemyRpc.reportFailure(agentId, id, code),
        onDisagree: () => balchemyRpc.reportDisagreement(agentId), ...(lagPositives ? { lagPositives } : {}) });
    }
    return own ? new PrivateSolanaRpc({ endpoint: own.url }) : undefined;
  };
  // Created on first wallet use, always locked: a new instance holds no key until explicit unlock.
  const tradingWallets = (): PrivateTradingKeystore => {
    if (tradingKeystoreUnavailable) throw new Error("trading keystore unavailable");
    if (!tradingKeystore) {
      try {
        tradingKeystore = new PrivateTradingKeystore({ directory: store.directory, localProfileId: options.ownerId,
          agentIds: store.agentIds() ?? [], assertAvailable: () => {
            if (closing || !store.isAvailable()) throw new Error("private writer unavailable");
          }, readPairingWallet: (agentId) => readPairingWallet({ directory: store.directory, localProfileId: options.ownerId, agentId }),
          // The possession signer compares every bind field with the daemon's own adopted identity and current lease.
          readBindingTarget: (agentId) => {
            const lease = runtimeBridge.activeLease(agentId);
            return lease ? Object.freeze({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId, bindingDigest: lease.bindingDigest,
              runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, epoch: lease.epoch }) : undefined;
          } });
      } catch { tradingKeystoreUnavailable = true; throw new Error("trading keystore unavailable"); }
    }
    return tradingKeystore;
  };
  // A2a (plan section B, amendments section C): the sealed owner pin and the authority watermark, both purpose-fixed tags of the trading
  // wallet's unlocked key. Created on first use; a read never creates a file (only the owner's proven seal step writes them).
  let ownerPinStore: PrivateOwnerPins | undefined;
  let authoritySealStore: PrivateAuthoritySeals | undefined;
  const pins = (): PrivateOwnerPins => (ownerPinStore ??= new PrivateOwnerPins({ directory: store.directory, localProfileId: options.ownerId,
    agentIds: store.agentIds() ?? [], assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); },
    keystore: tradingWallets(),
    // The plaintext pairing record is what a seal pins and what identity() compares against; it is never the authority itself.
    readIdentity: (agentId) => readPairingOwnerApprovalIdentity({ directory: store.directory, localProfileId: options.ownerId, agentId }) }));
  const seals = (): PrivateAuthoritySeals => (authoritySealStore ??= new PrivateAuthoritySeals({ directory: store.directory,
    localProfileId: options.ownerId, agentIds: store.agentIds() ?? [],
    assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); }, keystore: tradingWallets() }));
  // Created on first binding use; status of a never-bound agent creates no file.
  const bindings = (): PrivateTradingBindings => {
    tradingBindings ??= new PrivateTradingBindings({ directory: store.directory, localProfileId: options.ownerId, instanceId,
      agentIds: store.agentIds() ?? [], assertAvailable: () => {
        if (closing || !store.isAvailable()) throw new Error("private writer unavailable");
      }, keystore: tradingWallets(), readLease: (agentId) => runtimeBridge.activeLease(agentId),
      readPairingWallet: (agentId) => readPairingWallet({ directory: store.directory, localProfileId: options.ownerId, agentId }) });
    return tradingBindings;
  };
  // S4 relay, recovery and readback. The keystore signer is reachable only through PrivateSubmissions.submit, whose one
  // caller is the S8b execution worker (armed agents, every choke-point step), and, only while the exits capability is
  // available, PrivateSubmissions.submitExit from the S5c exit worker; recovery relays stored bytes or nothing.
  const readRuntimeState = (agentId: string) => {
    const result = store.control({ version: 1, id: randomUUID(), action: "status", agentId });
    return result.ok ? result.state : undefined;
  };
  // The one spend ledger (owner caps + reservations) of this daemon writer, shared by limits, arming and submissions.
  const ledger = (): PrivateSpendLedger => {
    spendLedger ??= new PrivateSpendLedger({ directory: store.directory, localProfileId: options.ownerId, agentIds: store.agentIds() ?? [],
      assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); } });
    return spendLedger;
  };
  // S5c: the owner-local position ledger, only while exits are available (never constructed otherwise).
  const positions = (): PrivatePositionLedger | undefined => {
    if (!exitsAvailable) return undefined;
    positionLedger ??= new PrivatePositionLedger({ directory: store.directory, localProfileId: options.ownerId, agentIds: store.agentIds() ?? [],
      assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); } });
    return positionLedger;
  };
  const submissions = (): PrivateSubmissions => {
    if (!submissionService) {
      const assertAvailable = (): void => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); };
      const agentIds = store.agentIds() ?? [];
      spendLedger = ledger();
      submissionJournal ??= new PrivateSubmissionJournal({ directory: store.directory, localProfileId: options.ownerId, agentIds, assertAvailable });
      const exitPositions = positions();
      submissionService = new PrivateSubmissions({ directory: store.directory, localProfileId: options.ownerId, instanceId, agentIds,
        readLease: (agentId) => runtimeBridge.activeLease(agentId), ledger: spendLedger, journal: submissionJournal,
        readRuntime: readRuntimeState, readFacts: (agentId) => executionFacts(agentId),
        keystore: { sign: (agentId, message) => tradingWallets().sign(agentId, message) },
        // The resend check of a buy (closes its relay once the blockhash is past): with two sources, both and the LOWER height.
        readRpc: (agentId) => rpcReader(agentId, "entry", "min"),
        // Owner decision 26: the owner close-out's expiry proof reads the agent's own RPC with or without the exits capability.
        readCloseRpc: (agentId) => rpcReader(agentId, "exit"),
        // S5c settlement only while exits are available; otherwise these keys are absent and the buy path is unchanged.
        ...(exitPositions ? { positions: exitPositions, readSettlementRpc: (agentId: string, readClass?: "entry" | "exit") => rpcReader(agentId, readClass ?? "entry") }
          : {}), ...capabilitySeam });
    }
    return submissionService;
  };
  // S8b: the one execution intent store. Final audit S3: an intent whose completed buy has not opened its position yet is kept from
  // eviction (it is that position's only plan provenance); without the exits capability there is no position ledger and eviction is
  // unchanged. A throw (the journal unavailable) retains.
  const intentStore = (): PrivateExecutionIntents => {
    executionIntents ??= new PrivateExecutionIntents({ directory: store.directory, localProfileId: options.ownerId, agentIds: store.agentIds() ?? [],
      assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); },
      retain: (agentId) => {
        const ledgerPositions = positions();
        if (!ledgerPositions) return () => false;
        submissions(); if (!submissionJournal) throw new Error("journal unavailable");
        const awaiting = new Set(submissionJournal.list(agentId).filter((item) => privateBuyAwaitingPosition(item, ledgerPositions, options.ownerId, agentId))
          .map((item) => item.attemptKey));
        return (intent) => intent.attemptKey !== null && awaiting.has(intent.attemptKey);
      } });
    return executionIntents;
  };
  // K4: the agent's launchpad signal sources (catalog cache and the stored runner-signed subscription).
  let launchpadStore: PrivateLaunchpads | undefined;
  const launchpads = (): PrivateLaunchpads => (launchpadStore ??= new PrivateLaunchpads({ directory: store.directory, localProfileId: options.ownerId,
    instanceId, agentIds: store.agentIds() ?? [], readLease: (agentId) => runtimeBridge.activeLease(agentId),
    assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); } }));
  /** K4 execution provenance of a launchpad signal (subscribed at its revision under its binding, live in a fresh catalog). */
  const launchpadAdmitted = (agentId: string, receipt: { frontendOrigin: string; bindingDigest: string;
    signal: { platform: string; sourceId: string; sourceRevision: number } }): boolean => {
    try { return launchpads().admitted(agentId, receipt.frontendOrigin, { platform: receipt.signal.platform, sourceId: receipt.signal.sourceId,
      sourceRevision: receipt.signal.sourceRevision, bindingDigest: receipt.bindingDigest }); } catch { return false; }
  };
  /** K1b typed rules at the build choke point (never for exits): never-buy lists, per-token buys in the current holding and the rolling
   * 24-hour trade count, from the confirmed revision the plan names; and a launchpad signal's provenance. */
  const checkEntry = (agentId: string, job: PrivateSignalJob, facts: { symbol: string | null }): string | null => {
    if (job.receipt.signal.platform === "launchpad" && !launchpadAdmitted(agentId, job.receipt)) return "launchpad_unavailable";
    const plan = job.result?.plan;
    const { head, revision } = rules().readConfirmedRevision(agentId, "solana");
    if (!plan || !revision || head.revisionId !== plan.rule?.revisionId || revision.revisionId !== head.revisionId) return "rules_changed";
    const typed = revision.rules;
    if (!typed.avoid && typed.risk.maxBuysPerToken === undefined && typed.risk.maxTradesPerDay === undefined) return null;
    submissions(); if (!submissionJournal) throw new Error("journal unavailable");
    const attempts = submissionJournal.list(agentId);
    const ledgerPositions = positions();
    const mint = plan.asset.assetId;
    // The symbol the decision's own bound reports carry (entrySymbol); unknown refuses rule_fact_unknown:symbol. No creator fact exists
    // yet, so a creator list holds every buy (rule_fact_unknown:creator).
    return privateBuildEntryRefusal(typed, { mint, symbol: facts.symbol, positions: ledgerPositions ? ledgerPositions.positions(agentId) : null, attempts,
      evictedRecentAt: submissionJournal.evictedRecentAt(agentId), nowMs: Date.now() });
  };
  // The owner's max positions at a time: the mints held or being bought. Unknown (no position ledger, no watermark yet, a held journal)
  // refuses every new buy.
  const heldMints = (agentId: string): ReadonlySet<string> | null => {
    const ledgerPositions = positions();
    if (!ledgerPositions) return null;
    const managed = ledgerPositions.managedFrom(agentId);
    if (!managed) return null;
    submissions(); if (!submissionJournal) throw new Error("journal unavailable");
    const outside = new Set([...ledgerPositions.evicted(agentId), ...managed.preEnable, ...(managed.ownerUnmanaged ?? []).map((item) => item.reservationId)]);
    return privateHeldMints(ledgerPositions.positions(agentId), submissionJournal.list(agentId), outside);
  };
  // Owner decision of 21 Nov 2026: the max positions limit applies only when the owner's rules state one. Read from the confirmed head,
  // and only for the revision a plan is bound to (any other revision is unknown and refuses).
  const statedMaxPositions = (agentId: string, ruleRevisionId: string): PrivateMaxPositions | null => {
    const { head, revision } = rules().readConfirmedRevision(agentId, "solana");
    if (head.state !== "compiled" || !revision || revision.revisionId !== head.revisionId || revision.revisionId !== ruleRevisionId) return null;
    return privateStatedMaxPositions(revision);
  };
  // Read only when the confirmed rules list never-buy symbols (the brain's working set is not opened otherwise).
  const entrySymbol = async (agentId: string, job: PrivateSignalJob, signal?: AbortSignal): Promise<string | null> => {
    const plan = job.result?.plan;
    const { revision } = rules().readConfirmedRevision(agentId, "solana");
    if (!plan || !revision?.rules.avoid?.symbols.length) return null;
    return brain().entrySymbol(agentId, plan.asset.refId, plan.evidence, signal);
  };
  let spendCapProposalStore: PrivateSpendCapProposals | undefined;
  const spendCapProposals = (): PrivateSpendCapProposals => (spendCapProposalStore ??= new PrivateSpendCapProposals(store.agentIds() ?? []));
  // S6 moment 3: the owner's wallet approval of this computer, verified locally against the pinned pairing record. A2a (plan section
  // B4): the identity every verify, accept and cover uses is the sealed owner pin's (a missing or broken pin, or a locked wallet, fails
  // closed); the plaintext pairing record is only compared against it.
  const ownerApprovals = (): PrivateOwnerApprovals => (ownerApprovalStore ??= new PrivateOwnerApprovals({ directory: store.directory,
    localProfileId: options.ownerId, agentIds: store.agentIds() ?? [],
    assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); },
    readIdentity: (agentId) => pins().identity(agentId),
    transport: privateOwnerApprovalTransport({ directory: store.directory, localProfileId: options.ownerId, instanceId,
      readLease: (agentId) => runtimeBridge.activeLease(agentId) }) }));
  // K2 one-visit setup: only when the host (or a test) enables it. Both workers read only through the lazy stores above.
  const setupSeam = options.setup && "ceilingTransport" in options.setup ? options.setup : undefined;
  const ceilingWorker = options.setup ? new PrivateCeilingWorker({ agentIds: store.agentIds() ?? [],
    // A2a: the sealed owner pin (no pin yet or a locked wallet reads as not ready).
    readIdentity: (agentId) => pins().identity(agentId),
    readBinding: (agentId) => bindings().record(agentId), approvals: ownerApprovals,
    transport: setupSeam?.ceilingTransport ?? privateCeilingReadTransport({ directory: store.directory, localProfileId: options.ownerId, instanceId,
      readLease: (agentId) => runtimeBridge.activeLease(agentId) }),
    ...(setupSeam?.now ? { now: setupSeam.now } : {}), ...(setupSeam?.monotonicNow ? { monotonicNow: setupSeam.monotonicNow } : {}) }) : undefined;
  const autoBind = options.setup ? new PrivateAutoBind({ agentIds: store.agentIds() ?? [],
    readPaired: (agentId) => readPairingAdoption({ directory: store.directory, localProfileId: options.ownerId, agentId }) !== undefined,
    readWallet: (agentId) => tradingWallets().status(agentId), readBinding: (agentId) => bindings().status(agentId),
    readLease: (agentId) => runtimeBridge.activeLease(agentId),
    bind: (agentId, signal) => bindings().bind(agentId, signal),
    onBound: (agentId) => ceilingWorker?.opened(agentId),
    ...(setupSeam?.monotonicNow ? { monotonicNow: setupSeam.monotonicNow } : {}) }) : undefined;
  // S8a arming (CLI-only; the server and the web never reach this channel) and the owner's spend limits.
  const arming = (): PrivateArming => {
    armingService ??= new PrivateArming({ localProfileId: options.ownerId, instanceId, agentIds: store.agentIds() ?? [], ...capabilitySeam,
      readState: readRuntimeState,
      readPaired: (agentId) => readPairingAdoption({ directory: store.directory, localProfileId: options.ownerId, agentId }) !== undefined,
      readLease: (agentId) => runtimeBridge.activeLease(agentId),
      readWallet: (agentId) => tradingWallets().status(agentId),
      readBinding: (agentId) => bindings().record(agentId),
      readRpc: (agentId) => effectiveRpc(agentId),
      readRules: (agentId) => rules().readConfirmedRevision(agentId, "solana"),
      readSizing: (agentId, signal) => readSizingPolicy(agentId, signal),
      ledger: ledger(),
      // S4: one read-only balance read at `confirmed`, to fix a percentage cap at confirmation (two sources must agree on the lamports)
      // or to show the balance (the first source that answers).
      readBalance: async (agentId, walletAddress, signal, purpose) => {
        const rpc = rpcReader(agentId, purpose === "display" ? "display" : "entry");
        if (!rpc) throw new Error("rpc unavailable");
        const account = await rpc.getAccountInfo(walletAddress, { commitment: "confirmed" }, signal);
        return account ? account.lamports : 0n;
      },
      readProposal: (agentId, proposalId, nowMs) => spendCapProposals().get(agentId, proposalId, nowMs),
      readSubmissions: (agentId) => {
        submissions();
        const attempts = submissionJournal?.list(agentId);
        if (!attempts) throw new Error("journal unavailable");
        return privateArmingSubmissionCounts(attempts);
      },
      // Phase 1 exits-only arming: the internal entries hold/release (never a wire control) and an immediate ensure-disarm.
      holdEntries: (agentId) => store.holdEntries(agentId),
      releaseEntries: (agentId, expectedVersion) => store.releaseEntries(agentId, expectedVersion),
      disarm: (agentId) => privateDisarmForOwnerChange(agentId, readRuntimeState, applyControl),
      // Reported at once; held: a reconcile pass now runs the releases that need the armed exit gate (F2, SF R10).
      onExitsOnly: (agentId, phase) => { runtimeBridge.nudge(agentId); if (phase === "held") protectionPass(); },
      // Owner `entries_resume`: the settings-change hold this daemon run placed (its hold version), so an owner resume never lifts it;
      // the released state is reported with the next heartbeat at once.
      readChangeHold: (agentId) => changeHolds.heldVersion(agentId),
      onEntriesResumed: (agentId) => { runtimeBridge.nudge(agentId); },
      // The display-only fee probe never waits long behind another assessment: the precheck answer has a 25 s deadline.
      assessFee: (agentId, request, signal, timeoutMs) => queryPrivateAssessmentReceipt({ directory: store.directory, localProfileId: options.ownerId,
        instanceId, readLease: (id) => runtimeBridge.activeLease(id), pacer: assessmentPacer, pacingMaxWaitMs: 6_000 },
        agentId, request, signal, timeoutMs),
      verifyPassphrase: (agentId, passphrase, signal) => tradingWallets().verifyPassphrase(agentId, passphrase, signal),
      ownerApprovals: ownerApprovals(),
      // A2a: the sealed owner pin (refusals named before the approval coverage) and the authority watermark (missing or looser arms for
      // exits only; entries resume only under sealed settings).
      readOwnerPin: (agentId) => { pins().identity(agentId); },
      verifyAuthority: (agentId, signal) => verifyAuthority(agentId, signal),
      readConfigGuard: configGuard,
      // M3.6 F-M36-1: report the arm with the next heartbeat (about 1 s), not at the 10 s interval, like every control change.
      arm: (input) => {
        const result = store.arm(input);
        if (result.ok) { runtimeBridge.nudge(input.agentId); protectionChanged(); }
        return result;
      } });
    return armingService;
  };
  // Live owner facts for every entry and exit step (choke point): confirmed rules head + shadowMode, RPC class. Owner decision of 23 Nov
  // 2026: an unreadable rule store reads the rules fields null (entries refuse rules_unavailable; exits, which need only the RPC class,
  // continue). A closing or unavailable private store still fails the whole read, as before (every step refuses). Besides exit_build/exit_sign,
  // the same facts also let these RPC-class-only reconciliation checks run while the rule store is unreadable: the owner close-out proof
  // (private-submission.ts), the F2/stall releases, the proof that a buy did not land (#buyReadable), and the exit worker's balance
  // settlement and position opening (private-exit-worker.ts); none of them signs or relays.
  const executionFacts = (agentId: string): PrivateExecutionLiveFacts => {
    return privateExecutionLiveFacts(() => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); }, () => {
      const { head, revision } = rules().readConfirmedRevision(agentId, "solana");
      const policy = head.state === "compiled" && revision && revision.revisionId === head.revisionId ? deriveBehaviorRuleExecutionPolicy(revision, PRIVATE_RULE_EXECUTION_OPTIONS) : null;
      return { ruleRevisionId: head.revisionId, rulesShadowMode: policy ? policy.shadowMode : null };
    }, () => effectiveRpc(agentId).endpoint?.class ?? null);
  };
  // K1b DCA: the durable add records and the add worker (run inside the execution drain). Undefined, and never constructed, unless
  // this build declares dca.v1 and exits are available (an add needs its lot's stop-loss).
  const dcaRecords = (): PrivateDcaStore | undefined => {
    if (!PRIVATE_DCA_ENABLED || !exitsAvailable) return undefined;
    dcaStore ??= new PrivateDcaStore({ directory: store.directory, localProfileId: options.ownerId, agentIds: store.agentIds() ?? [],
      assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); } });
    return dcaStore;
  };
  const dcaRules = (agentId: string): PrivateDcaRules | null => {
    const { head, revision } = rules().readConfirmedRevision(agentId, "solana");
    if (head.state !== "compiled" || !revision || revision.revisionId !== head.revisionId) return null;
    const policy = deriveBehaviorRuleExecutionPolicy(revision, PRIVATE_RULE_EXECUTION_OPTIONS);
    const binding = policy?.dca ? toBehaviorRuleExecutionBinding(policy) : null;
    if (!policy || !binding) return null;
    return { revisionId: revision.revisionId, rulesDigest: binding.rulesDigest.replace(/^sha256:/, ""), rules: revision.rules,
      exit: binding.exitSnapshot, risks: policy.approval, maxPositions: privateStatedMaxPositions(revision) };
  };
  const dcaAdds = (): PrivateDcaWorker | undefined => {
    const records = dcaRecords(); const ledgerPositions = positions();
    if (!records || !ledgerPositions) return undefined;
    dcaWorker ??= new PrivateDcaWorker({ localProfileId: options.ownerId, store: records, readRules: dcaRules, readRuntime: readRuntimeState,
      readWallet: (agentId) => tradingWallets().status(agentId), readPositions: (agentId) => ledgerPositions.positions(agentId),
      readManagedFrom: (agentId) => ledgerPositions.managedFrom(agentId), readEvicted: (agentId) => ledgerPositions.evicted(agentId),
      readAttempts: (agentId) => { submissions(); if (!submissionJournal) throw new Error("journal unavailable"); return submissionJournal.list(agentId); },
      readEvictedRecentAt: (agentId) => { submissions(); if (!submissionJournal) throw new Error("journal unavailable"); return submissionJournal.evictedRecentAt(agentId); },
      ledger: ledger(),
      readValuation: (agentId, positionId) => exits()?.valuation(agentId, positionId),
      readExitWanted: (agentId, mint) => exits()?.exitWanted(agentId, mint) ?? true,
      readEvidence: (agentId, mint, signal) => brain().dcaEvidence(agentId, mint, signal),
      // The signal buy's top-holder facts, from the same entry-class reads (both Balchemy sources in agreement).
      readHolderShares: (agentId, mint, counts, signal) => readPrivateHolderShares(rpcReader(agentId, "entry"), mint, counts, signal),
      build: async (agentId, input, signal) => {
        // A2a entry choke point: a DCA add is a new buy, so it needs the sealed settings too (before any reservation).
        const unsealed = await entryAuthorityRefusal(agentId, signal);
        if (unsealed) {
          const refused: PrivateExecutionBuildOutcome = { outcome: "refused", stage: "local", reason: unsealed, reservation: "none", reassessed: false };
          return refused;
        }
        const rpc = rpcReader(agentId, "entry");
        if (!rpc) {
          const refused: PrivateExecutionBuildOutcome = { outcome: "refused", stage: "local", reason: "rpc_missing", reservation: "none", reassessed: false };
          return refused;
        }
        return buildPrivateDcaCandidate({ directory: store.directory, localProfileId: options.ownerId, instanceId, ...capabilitySeam,
          readLease: (id) => runtimeBridge.activeLease(id), readRuntime: readRuntimeState, readFacts: executionFacts,
          readWallet: (id) => tradingWallets().status(id), readBinding: (id) => bindings().record(id), ledger: ledger(),
          readKeptReservations: (id) => {
            submissions(); if (!submissionJournal) throw new Error("journal unavailable");
            return privateSubmissionKeptReservations(submissionJournal.list(id));
          },
          rpc, assess: (id, request, abort) => queryPrivateAssessmentReceipt({ directory: store.directory, localProfileId: options.ownerId,
            instanceId, readLease: (agent) => runtimeBridge.activeLease(agent), pacer: assessmentPacer }, id, request, abort) }, agentId, input, signal);
      },
      submit: (agentId, built, signal, expiry) => submissions().submit(agentId, built, signal, expiry) });
    return dcaWorker;
  };
  /** The exit worker's DCA hooks (absent unless dca.v1 is declared). */
  const dcaExitHooks = (): PrivateExitDcaHooks | undefined => {
    const records = dcaRecords();
    if (!records) return undefined;
    return { add: (agentId, reservationId) => records.add(agentId, reservationId),
      opened: (agentId, reservationId, units) => { records.update(agentId, reservationId, "submitted", { state: "opened", units }, Date.now()); },
      protectiveExit: (agentId, mint, trigger) => { records.end(agentId, mint, trigger, Date.now()); },
      running: (agentId) => records.read(agentId).adds.some((item) => item.state === "running") };
  };
  // S8b: the autonomous execution queue. Completed buy decisions are admitted by the brain's completion hook; one worker
  // drain per agent runs choke point -> build -> the one signature (submission) -> relay; S4 owns settlement.
  const execution = (): PrivateExecutionWorker => {
    if (!executionWorker) {
      const agentIds = store.agentIds() ?? [];
      const intents = intentStore();
      const service = submissions();
      executionWorker = new PrivateExecutionWorker({ agentIds, intents, ...capabilitySeam,
        readJob: (agentId, jobId, signal) => brain().readSignal(agentId, jobId, signal),
        readRuntime: readRuntimeState, readFacts: executionFacts, readWallet: (agentId) => tradingWallets().status(agentId),
        readRpc: (agentId) => effectiveRpc(agentId), ledger: ledger(),
        readAttempts: (agentId) => { submissions(); if (!submissionJournal) throw new Error("journal unavailable"); return submissionJournal.list(agentId); },
        readHeldMints: heldMints, readMaxPositions: statedMaxPositions,
        build: async (agentId, job, signal) => {
          // A2a entry choke point (amendments section C): every new buy runs under settings the owner sealed (equal or tighter), checked
          // before any reservation. Exits are never checked here.
          const unsealed = await entryAuthorityRefusal(agentId, signal);
          if (unsealed) {
            const refused: PrivateExecutionBuildOutcome = { outcome: "refused", stage: "local", reason: unsealed, reservation: "none", reassessed: false };
            return refused;
          }
          // Entry-deciding: with two Balchemy-provided sources every preflight read needs both, in agreement.
          const rpc = rpcReader(agentId, "entry");
          if (!rpc) {
            const refused: PrivateExecutionBuildOutcome = { outcome: "refused", stage: "local", reason: "rpc_missing", reservation: "none", reassessed: false };
            return refused;
          }
          return buildPrivateExecutionCandidate({ directory: store.directory, localProfileId: options.ownerId, instanceId, ...capabilitySeam,
            readLease: (id) => runtimeBridge.activeLease(id), readRuntime: readRuntimeState, readFacts: executionFacts,
            readWallet: (id) => tradingWallets().status(id), readBinding: (id) => bindings().record(id), ledger: ledger(),
            // C2: compaction never folds a reservation a non-terminal or released journal attempt still references.
            readKeptReservations: (id) => {
              submissions(); if (!submissionJournal) throw new Error("journal unavailable");
              return privateSubmissionKeptReservations(submissionJournal.list(id));
            },
            rpc, checkEntry, readEntrySymbol: entrySymbol,
            assess: (id, request, abort) => queryPrivateAssessmentReceipt({ directory: store.directory, localProfileId: options.ownerId,
              instanceId, readLease: (agent) => runtimeBridge.activeLease(agent), pacer: assessmentPacer }, id, request, abort) }, agentId, job, signal);
        },
        submit: (agentId, built, signal, expiry) => service.submit(agentId, built, signal, expiry),
        // M3.6: a build waits for Balchemy's mirror of this armed state and for the signal's answered ACK (bounded).
        readServerArmed: (agentId) => runtimeBridge.acceptedArmedVersion(agentId),
        readSignalAcknowledged: (agentId, eventId, eventDigest) => signalsBridge.acknowledged(agentId, eventId, eventDigest),
        // S5c entry hold, only while exits are available (since S5; absent on the exits-off rollback build, whose buys the gate
        // refuses). Each use also retries a failed exit-worker start; an unavailable worker refuses the buy (fail closed).
        ...(exitsAvailable ? { entryHold: (agentId: string): string | null => {
          const worker = exits(); return worker ? worker.entryHold(agentId) : "unavailable";
        } } : {}),
        // K1b DCA adds run in this drain after the signal queue (only when dca.v1 is declared).
        ...((): { dca?: PrivateDcaWorker } => { const worker = dcaAdds(); return worker ? { dca: worker } : {}; })() });
    }
    // Started exactly once, lazily retried: a start that threw (or never ran) is repeated on the next use, including the
    // resolution of interrupted `running` intents (the worker also re-runs that resolution before each agent's drain).
    if (!executionStarted) { executionWorker.start(); executionStarted = true; }
    return executionWorker;
  };
  // S5c: the exit worker (gate -> position opening -> valuation -> trigger -> exit build -> the one exit signature -> relay).
  // Undefined, and never constructed, on the exits-off rollback build.
  const exits = (): PrivateExitWorker | undefined => {
    const exitPositions = positions();
    if (!exitPositions) return undefined;
    if (!exitWorker) {
      const agentIds = store.agentIds() ?? [];
      const service = submissions();
      const journal = submissionJournal;
      if (!journal) throw new Error("journal unavailable");
      const intents = intentStore();
      // Exit-deciding: with two Balchemy-provided sources a sell may proceed on one when the other is unavailable (never on a
      // disagreement). Opening a position from the buy's finalized transaction is the same positive read (it gives the position its
      // stop-loss): one source showing it landed without error is enough; a disagreement or a lone "not found" opens nothing.
      const rpcFor = (agentId: string, readClass: PrivateRpcReadClass): PrivateSolanaReader | undefined => rpcReader(agentId, readClass);
      exitWorker = new PrivateExitWorker({ localProfileId: options.ownerId, agentIds, positions: exitPositions, ...capabilitySeam,
        readAttempts: (agentId) => journal.list(agentId), ledger: ledger(), intents,
        readJob: (agentId, jobId, signal) => brain().readSignal(agentId, jobId, signal),
        readRuntime: readRuntimeState, readFacts: executionFacts,
        readTransaction: async (agentId, signature, signal) => {
          const rpc = rpcFor(agentId, PRIVATE_POSITION_OPENING_READ_CLASS); if (!rpc) throw new Error("rpc unavailable");
          // Audit M2 (b): the only read that opts in to accepting a lasting single-source lag (a landed buy opens its position).
          return rpc.getTransaction(signature, { commitment: "finalized", acceptLagPositive: true }, signal);
        },
        assess: (agentId, request, signal) => queryPrivateSellAssessment({ directory: store.directory, localProfileId: options.ownerId, instanceId,
          readLease: (id) => runtimeBridge.activeLease(id) }, agentId, request, signal),
        build: async (agentId, input, signal) => {
          const rpc = rpcFor(agentId, "exit");
          if (!rpc) { const refused: PrivateExitBuildOutcome = { outcome: "refused", stage: "local", reason: "rpc_missing", exit: "untouched" }; return refused; }
          return buildPrivateExitCandidate({ directory: store.directory, localProfileId: options.ownerId, instanceId, ...capabilitySeam,
            readLease: (id) => runtimeBridge.activeLease(id), readRuntime: readRuntimeState, readFacts: executionFacts,
            readWallet: (id) => tradingWallets().status(id), readBinding: (id) => bindings().record(id), positions: exitPositions, journal, rpc },
          agentId, input, signal);
        },
        submit: (agentId, built, signal) => service.submitExit(agentId, built, signal),
        // Owner decision of 11 Nov 2026: `runner:` holds settle automatically from the wallet's finalized balance (reads and one
        // ledger commit; never a signature, relay or journal write). Started only by a pass the exit gate admitted, never awaited by
        // it; `admitted` re-checks the gate before every commit.
        settleHeld: async (agentId, signal, admitted) => { await recovery()?.settleHeld(agentId, signal, admitted); },
        ...((): { dca?: PrivateExitDcaHooks } => { const hooks = dcaExitHooks(); return hooks ? { dca: hooks } : {}; })() });
    }
    if (!exitStarted) { exitWorker.start(); exitStarted = true; }
    return exitWorker;
  };
  // Owner decision of 21 Nov 2026: the owner's re-bind of open positions' exits to the current confirmed head (private-exit-rebind.ts).
  // Undefined on the exits-off rollback build (no position ledger exists there). The head is derived exactly as arming and DCA derive it.
  const exitRebindRules = (agentId: string): PrivateExitRebindRules | null => {
    const { head, revision } = rules().readConfirmedRevision(agentId, "solana");
    if (head.state !== "compiled" || !head.revisionId || !revision || revision.revisionId !== head.revisionId || revision.chain !== "solana") return null;
    const policy = deriveBehaviorRuleExecutionPolicy(revision, PRIVATE_RULE_EXECUTION_OPTIONS);
    const binding = policy ? toBehaviorRuleExecutionBinding(policy) : null;
    if (!policy || !binding) return null;
    return { revisionId: revision.revisionId, rulesDigest: binding.rulesDigest.replace(/^sha256:/, ""), exit: binding.exitSnapshot };
  };
  const exitRebind = (): PrivateExitRebind | undefined => {
    const ledgerPositions = positions();
    if (!ledgerPositions) return undefined;
    submissions();
    const journal = submissionJournal;
    if (!journal) throw new Error("journal unavailable");
    const intents = intentStore(); const records = dcaRecords();
    return new PrivateExitRebind({ positions: ledgerPositions, readRules: exitRebindRules, readAttempts: (agentId) => journal.list(agentId),
      readIntents: (agentId) => intents.list(agentId), ...(records ? { readDcaAdds: (agentId: string) => records.read(agentId).adds } : {}) });
  };
  // M3: position readback and the owner's resolution of `runner:` holds over the same ledger, journal and own RPC the settlement
  // uses. Undefined, and never constructed, on the exits-off rollback build (no position ledger exists there).
  const recovery = (): PrivatePositionRecovery | undefined => {
    const ledgerPositions = positions();
    if (!ledgerPositions) return undefined;
    if (!positionRecovery) {
      submissions();
      const journal = submissionJournal;
      if (!journal) throw new Error("journal unavailable");
      positionRecovery = new PrivatePositionRecovery({ agentIds: store.agentIds() ?? [], positions: ledgerPositions,
        readAttempts: (agentId) => journal.list(agentId),
        // A held sell's own finalized transaction (one source may prove it landed; anything else both) and the balance settlement
        // (a negative proof: whole on each source).
        readRpc: (agentId) => rpcReader(agentId, "exit"),
        readBalanceRpc: (agentId) => rpcReader(agentId, "exit"),
        readWorker: (agentId) => {
          // A worker that cannot start holds every buy (the execution worker's entry hold refuses "unavailable").
          let worker: PrivateExitWorker | undefined;
          try { worker = exits(); } catch { return { status: { reason: null, opening: [], backoff: [] }, entryHold: "unavailable" }; }
          if (!worker) return undefined;
          let hold: ReturnType<PrivateExitWorker["entryHold"]> | "unavailable";
          try { hold = worker.entryHold(agentId); } catch { hold = "unavailable"; }
          const entryHold = hold === null || hold === "attempt_released_unsettled" || hold === "position_held" || hold === "exit_pending"
            || hold === "position_unopened" || hold === "buy_unprotected" || hold === "ledger_full" ? hold : "unavailable";
          return { status: worker.status(agentId), entryHold };
        } });
    }
    return positionRecovery;
  };
  /** Heartbeat and status view of the keystore lock plus this build's fixed exit capability: closed enums only. A restarted
   * daemon reports a configured wallet "locked" until the owner unlocks it in the CLI; "held" (unverifiable local record) and
   * any read failure are "unavailable". */
  const keystoreObservation = (agentId: string): RunnerKeystoreObservation => {
    const exits = exitsAvailable ? "available" : "unavailable";
    try {
      if (closing) return { lock: "unavailable", exits };
      const state = tradingWallets().status(agentId).state;
      return { lock: state === "absent" ? "not_configured" : state === "locked" || state === "unlocked" ? state : "unavailable", exits };
    } catch { return { lock: "unavailable", exits }; }
  };
  const executionSummary = (agentId: string): RunnerExecutionStatus => {
    let keystore: RunnerExecutionStatus["keystore"] = "unavailable";
    try { keystore = tradingWallets().status(agentId).state; } catch { /* Unavailable. */ }
    let limits: RunnerExecutionStatus["limits"] = "unavailable";
    try {
      const spend = ledger().status(agentId, Date.now());
      limits = { perTrade: spend.limits.perTrade, daily: spend.limits.daily, remaining: spend.remaining };
    } catch { /* Unavailable. */ }
    let queue: RunnerExecutionStatus["queue"] = "unavailable";
    try { queue = execution().status(agentId); } catch { /* Unavailable. */ }
    // S5c: a failed exit-worker start is retried on the next use, like execution() (a no-op on the exits-off rollback build).
    try { exits(); } catch { /* Retried on the next use. */ }
    // M3: the exits summary only while the exits capability is available (the key is absent on the exits-off rollback build).
    let exitsSummary: RunnerExecutionStatus["exits"];
    try { const service = recovery(); if (service) exitsSummary = service.summary(agentId); } catch { exitsSummary = "unavailable"; }
    // F2: the runner disputes S4 has not released yet and why (bounded; omitted when there is none or the journal is held).
    if (exitsSummary && exitsSummary !== "unavailable") {
      try { const releaseChecks = submissions().releaseChecks(agentId); if (releaseChecks.length > 0) exitsSummary = { ...exitsSummary, releaseChecks }; }
      catch { /* Omitted; runner trades shows them. */ }
    }
    // K1b DCA: why the add worker waits, while DCA adds run here (absent otherwise; omitted when it cannot be read).
    let dca: RunnerExecutionStatus["dca"];
    try {
      const worker = dcaAdds();
      if (worker) {
        const status = worker.status(agentId);
        dca = { reason: status.reason, holds: status.holds.slice(0, RUNNER_DCA_STATUS_MAX_HOLDS).map((item) => ({ mint: item.mint, reason: item.reason })) };
      }
    } catch { dca = undefined; }
    return { keystore, limits, queue, ...(exitsSummary ? { exits: exitsSummary } : {}), ...(dca ? { dca } : {}) };
  };
  const rules = (): PrivateRuleService => {
    privateRules ??= new PrivateRuleService({ directory: store.directory, localProfileId: options.ownerId,
      instanceId, agentIds: store.agentIds() ?? [], assertAvailable: () => {
        if (closing || !store.isAvailable()) throw new Error("private writer unavailable");
      } });
    return privateRules;
  };
  const brain = (): PrivateBrainService => {
    // The owner-local model and working journal keep one daemon writer.
    privateBrain ??= new PrivateBrainService({ directory: store.directory, localProfileId: options.ownerId,
      instanceId, agentIds: store.agentIds() ?? [], assertAvailable: () => {
        if (closing || !store.isAvailable()) throw new Error("private writer unavailable");
      }, readState: (agentId) => store.control({ version: 1, id: randomUUID(), action: "status", agentId }).state,
      readLease: (agentId) => runtimeBridge.activeLease(agentId),
      onSignalCompleted: (job) => { execution().enqueue(job); },
      // Deferred past the decision and execution admission; the job is already durable, and enqueue never throws.
      onSignalTerminal: (job) => { setImmediate(() => { if (!closing) reportOutbox()?.enqueue(job); }); },
      readConfirmedRules: (agentId, chain) => rules().readConfirmedRevision(agentId, chain),
      // K1: entry-class reads for the top-N holder share (two Balchemy-provided sources must agree).
      readEntryRpc: (agentId) => rpcReader(agentId, "entry"),
      // K4: launchpad signals are decided only for a subscribed, live launchpad.
      launchpads: { prepare: (agentId, bindingDigest, signal) => launchpads().prepare(agentId, bindingDigest, signal),
        admitted: (agentId, receipt) => launchpadAdmitted(agentId, receipt) },
      researchReceipt: (agentId, input, signal) => queryPrivateResearchReceipt({ directory: store.directory,
        localProfileId: options.ownerId, instanceId, readLease: (id) => runtimeBridge.activeLease(id) }, agentId, input, signal),
      assessmentReceipt: (agentId, input, signal, timeoutMs) => queryPrivateAssessmentReceipt({ directory: store.directory,
        localProfileId: options.ownerId, instanceId, readLease: (id) => runtimeBridge.activeLease(id), pacer: assessmentPacer },
        agentId, input, signal, timeoutMs),
      rules: { read: (agentId, chain) => rules().readForConversation(agentId, chain),
        propose: (jobId, view, source) => rules().proposeForConversation(jobId, view, source) },
      // S4: the owner's chat may only propose caps; the proposal store has no ledger access.
      spendCaps: { propose: (agentId, caps) => spendCapProposals().propose(agentId, caps, Date.now()) },
      // The cockpit guide's view of the setup: the same readers arming checks, reduced to closed values and public facts.
      readSetup: async (agentId, signal) => privateSetupContext(await readPrivateSetupFacts({
        paired: () => readPairingAdoption({ directory: store.directory, localProfileId: options.ownerId, agentId }) !== undefined,
        wallet: () => tradingWallets().status(agentId),
        walletLinked: () => bindings().record(agentId)?.state === "active",
        rpc: () => privateSetupRpc(solanaRpc().status(agentId).endpoint?.class ?? null, balchemyRpc.status(agentId).state),
        rpcSourcesDisagree: () => balchemyRpc.status(agentId).reason === "rpc_sources_disagree",
        limits: () => { const spend = ledger().status(agentId, Date.now()); return spend.configured && spend.limits.perTrade.kind !== "unset" && spend.limits.daily.kind !== "unset"; },
        rules: () => { const { head, revision } = rules().readConfirmedRevision(agentId, "solana");
          return { present: head.state !== "empty", automatic: revision !== null && isBehaviorRuleApprovalAutomatic(revision, PRIVATE_RULE_EXECUTION_OPTIONS) }; },
        sizing: async () => {
          const response = await brain().handleSizing(parsePrivateSizingRequest({ channel: "private_sizing", version: 1, id: randomUUID(),
            localProfileId: options.ownerId, instanceId, agentId, action: "status" }), signal);
          if (!response.ok || response.data.kind !== "status") throw new Error("sizing unavailable");
          return response.data.status.policy !== null;
        },
        armed: () => readRuntimeState(agentId)?.mode === "live_armed",
      })),
    });
    return privateBrain;
  };
  const brainObservation = (agentId: string): RunnerBrainObservation => {
    const observedRules = rules().observeConfirmedHead(agentId);
    try {
      if (closing || !store.isAvailable()) throw new Error("unavailable");
      return privateBrain?.observeBrain(observedRules, agentId) ?? Object.freeze({ version: 1, model: "locked",
        rules: observedRules, activity: "idle", lastTerminal: "none" });
    } catch {
      return Object.freeze({ version: 1, model: "unavailable", rules: observedRules, activity: "idle", lastTerminal: "none" });
    }
  };
  const intents = (): PrivateIntentService => {
    privateIntents ??= new PrivateIntentService({ directory: store.directory, localProfileId: options.ownerId,
      instanceId, agentIds: store.agentIds() ?? [], assertAvailable: () => {
        if (closing || !store.isAvailable()) throw new Error("private writer unavailable");
      }, readRuntime: (agentId) => store.control({ version: 1, id: randomUUID(), action: "status", agentId }).state,
      readRules: (agentId) => rules().readConfirmedRevision(agentId, "solana"),
      readEvidence: (agentId, refId, nowMs, signal) => brain().readIntentEvidence(agentId, refId, nowMs, signal) });
    return privateIntents;
  };
  // ---- A2a: the stored values the socket gate and the authority watermark compare against -----------------------------------------
  const readSizingPolicy = async (agentId: string, signal?: AbortSignal): Promise<PrivateBuyAmountPolicy | null> => {
    const response = await brain().handleSizing(parsePrivateSizingRequest({ channel: "private_sizing", version: 1, id: randomUUID(),
      localProfileId: options.ownerId, instanceId, agentId, action: "status" }), signal);
    if (!response.ok || response.data.kind !== "status") throw new Error("sizing unavailable");
    return response.data.status.policy;
  };
  const budgetStatus = async (agentId: string): Promise<PrivateModelBudgetStatus> => {
    const response = await brain().handleModelBudget(parsePrivateModelBudgetRequest({ channel: "private_model_budget", version: 1, id: randomUUID(),
      localProfileId: options.ownerId, instanceId, agentId, action: "status" }));
    if (!response.ok || response.data.kind !== "status") throw new Error("budget unavailable");
    return response.data.status;
  };
  const autonomyStatus = async (agentId: string, signal?: AbortSignal): Promise<PrivateAutonomyStatus> => {
    const response = await brain().handleAutonomy(parsePrivateAutonomyRequest({ channel: "private_autonomy", version: 1, id: randomUUID(),
      localProfileId: options.ownerId, instanceId, agentId, action: "status" }), signal);
    if (!response.ok || response.data.kind !== "status") throw new Error("call allowance unavailable");
    return response.data.status;
  };
  /** The launchpad baseline of the socket gate: only the local mirror exists (one signed query per exchange); revision 0 or a
   * subscription of another binding (or no lease to tell) is an empty baseline. */
  const launchpadBaseline = (agentId: string): readonly string[] => {
    const record = launchpads().subscription(agentId);
    const lease = runtimeBridge.activeLease(agentId);
    return record && record.revision > 0 && lease && record.bindingDigest === lease.bindingDigest ? record.launchpadIds : [];
  };
  /** Every current value the authority watermark covers (private-authority-seal.ts PrivateAuthorityCurrent). The model is the active
   * model, else the saved (vault) one, so a restart (model locked until unlocked) compares the same saved model. Throws when any of it
   * cannot be read (every caller fails closed). */
  const authorityCurrent = async (agentId: string, signal?: AbortSignal): Promise<PrivateAuthorityCurrent> => {
    const limits = ledger().status(agentId, Date.now()).limits;
    const sizing = await readSizingPolicy(agentId, signal);
    const { head, revision } = rules().readConfirmedRevision(agentId, "solana");
    const headProposal = head.revisionId ? rules().readHeadProposalKind(agentId, "solana") : null;
    const endpoint = solanaRpc().endpoint(agentId);
    const modelReply = brain().handle(parsePrivateBrainRequest({ channel: "private_brain", version: 1, id: randomUUID(), localProfileId: options.ownerId,
      instanceId, agentId, action: "model_status" }));
    const active = modelReply.ok ? modelReply.model : undefined; const vault = modelReply.ok ? modelReply.vault : undefined;
    if (!active || !vault || (active.state !== "ready" && vault.saved === "unavailable")) throw new Error("model unavailable");
    const model = active.state === "ready" ? { provider: active.provider, model: active.model }
      : vault.saved === true ? { provider: vault.provider, model: vault.model } : null;
    const budget = await budgetStatus(agentId);
    const autonomy = await autonomyStatus(agentId, signal);
    const subscription = launchpads().subscription(agentId);
    const price = budget.modelPrice;
    return { caps: { perTrade: limits.perTrade, daily: limits.daily, perTradeBasis: limits.perTradeBasis, dailyBasis: limits.dailyBasis },
      sizing: sizing ? { amountSol: sizing.amountSol, slippageBps: sizing.slippageBps } : null,
      rules: { revisionId: head.revisionId, parentRevisionId: revision ? revision.parentRevisionId : null, headProposal,
        approvalMode: revision ? (isBehaviorRuleApprovalAutomatic(revision, PRIVATE_RULE_EXECUTION_OPTIONS) ? "automatic_within_limits" : "approval_required") : null },
      rpc: endpoint ? { url: endpoint.url } : null, model,
      budget: { dailyLimitMicroUsd: budget.policy.dailyLimitMicroUsd },
      modelPrice: price ? { provider: price.provider, model: price.model, inputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
        outputMicroUsdPerMillion: price.outputMicroUsdPerMillion } : null,
      autonomy: { dailyCallLimit: autonomy.policy.dailyCallLimit },
      launchpads: { ids: subscription && subscription.revision > 0 ? [...subscription.launchpadIds] : [] } };
  };
  /** The watermark check of arming, the owner's entries resume and the entry choke point. Never throws: anything unreadable is
   * `state_unavailable` (never covered: arming then arms exits-only, so a corrupt vault or mirror never blocks stop-loss and take-profit,
   * while every new buy and entries_resume stay refused until it reads again). */
  const verifyAuthority = async (agentId: string, signal?: AbortSignal): Promise<PrivateAuthorityCheck> => {
    try { return seals().verify(agentId, await authorityCurrent(agentId, signal)); }
    catch { return { ok: false, code: "state_unavailable" }; }
  };
  /** The entry choke point's refusal reason (null: covered). The stores keep their snapshot in memory once opened, but a record absent
   * at arm (an RPC, budget, launchpad or seal file) is probed on disk again at each read, so a file planted mid-run is caught here. */
  const entryAuthorityRefusal = async (agentId: string, signal?: AbortSignal): Promise<string | null> => {
    const check = await verifyAuthority(agentId, signal);
    return check.ok ? null : check.code;
  };
  /** Amendments section C re-seal, after a successful write of a gated frame (never on the byte-identical path): a valid seal the current
   * values still satisfy is re-sealed at them (a tightening, `onlyIfTighter`); after a PROVEN raising change it is re-sealed only when the
   * looser fields are exactly that frame's own fields (`fields`), so nothing else is ever sealed by the way; a looser launchpad field only
   * when the current mirror ids are within the proven frame's ids (`proven`), else the hold stays and the seal card shows it. A missing or invalid seal is
   * never created here (the owner's seal step is the only first seal), and a locked wallet leaves it as it was. Never throws. */
  const resealAuthority = async (agentId: string, fields: readonly PrivateAuthorityField[], proof: SocketProofPass,
    proven?: { launchpadIds: readonly string[] }): Promise<void> => {
    if (!proof.gated || closing) return;
    try {
      // No seal record (a partial one counts as present): nothing can be re-sealed here, so none of the other stores is read for it.
      if (!seals().exists(agentId)) return;
      const current = await authorityCurrent(agentId);
      if (closing) return;
      const sealStore = seals();
      const check = sealStore.verify(agentId, current);
      if (check.ok) { sealStore.seal(agentId, current, { onlyIfTighter: true }); return; }
      if (proof.proven && check.code === "authority_unsealed" && check.reason === "looser" && check.looser.every((field) => fields.includes(field))
        // The launchpad field is re-sealed only at ids the proven frame named: the mirror read now may already be another (proof-free) refresh.
        && (!check.looser.includes("launchpads") || (proven !== undefined && privateLaunchpadsWithinProven(current.launchpads.ids, proven.launchpadIds)))) {
        sealStore.seal(agentId, current);
      }
    } catch { /* The seal stays as it was: arming and new buys report authority_unsealed until the owner's seal step. */ }
  };
  /** Plan section A2: the socket proof of one frame (owner socket only; never applyControl, which is also the Hub path). Order: classify
   * against the stored value; a frame that raises nothing passes without any passphrase check (no free oracle); a raising frame needs the
   * trading-wallet passphrase while the wallet is unlocked (`proof_required`, `passphrase_rejected`, `proof_throttled`), refuses
   * `wallet_locked` while it is locked and `state_unavailable` while it is held. No wallet: a frame that sets a watermark-sealed value is
   * allowed (bootstrap) only while no owner pin, authority seal or trading binding record exists for the agent (a moved envelope must not
   * open the exception); a one-shot frame is never exempt (`proof_required`). Enforced (the shipped constant since
   * A2a T4); with the requirement off (no shipped build) a frame without the field never reaches this and a supplied passphrase is still
   * checked while the wallet is unlocked. */
  const socketProof = async (frame: SocketProofFrame, signal: AbortSignal): Promise<{ ok: true; proven: boolean } | { ok: false; code: SocketProofRefusal }> => {
    let raising = true;
    if (frame.raises) { try { raising = await frame.raises(); } catch { raising = true; } }
    if (closing) return { ok: false, code: "closing" };
    if (classifySocketFrame(frame.channel, frame.action, () => raising) !== "raising") return { ok: true, proven: false };
    const lax = !proofEnforced;
    let wallet: TradingWalletStatus;
    try { wallet = tradingWallets().status(frame.agentId); } catch { return lax ? { ok: true, proven: false } : { ok: false, code: "state_unavailable" }; }
    if (wallet.state === "absent") {
      if (lax) return { ok: true, proven: false };
      // The bootstrap exemption covers only a stored setting the watermark seals (its first values before any wallet exists). A one-shot
      // frame (a position resolve or unmanage, a submission acknowledge_copy or close, an exit re-bind apply, entries_resume) acts on
      // trades a wallet made, so without a wallet it is never exempt: the proof it needs cannot be given yet.
      const entry = socketProofEntry(frame.channel, frame.action);
      if (!entry || (entry.kind !== "raising" && entry.kind !== "compare") || !Array.isArray(entry.authority)) return { ok: false, code: "proof_required" };
      // A pin, a seal or a trading binding record of this agent means a wallet existed: a moved or deleted envelope must not open the
      // exception (a held or unreadable record counts as present).
      let recorded = true;
      try { recorded = pins().exists(frame.agentId) || seals().exists(frame.agentId) || bindings().status(frame.agentId).state !== "unbound"; }
      catch { recorded = true; }
      return recorded ? { ok: false, code: "state_unavailable" } : { ok: true, proven: false };
    }
    if (wallet.state === "held") return lax ? { ok: true, proven: false } : { ok: false, code: "state_unavailable" };
    if (wallet.state === "locked") return lax ? { ok: true, proven: false } : { ok: false, code: "wallet_locked" };
    if (frame.passphrase === undefined) return { ok: false, code: "proof_required" };
    try { await tradingWallets().verifyPassphrase(frame.agentId, frame.passphrase, signal); }
    catch (error: unknown) { return { ok: false, code: proofRefusal(error) }; }
    // A verified proof covers this frame whatever the stored value became meanwhile; the CAS of each service pins the rest.
    if (closing) return { ok: false, code: "closing" };
    return { ok: true, proven: true };
  };
  /** Plan section B3 (amendments section C): the owner's seal step. `status` shows what the card shows; `seal` needs the trading-wallet
   * passphrase regardless of PRIVATE_SOCKET_PROOF_ENFORCED, re-reads everything and refuses any difference from what was shown, then pins
   * the owner wallet and seals the settings in one synchronous section (nothing is written when any check fails). */
  const ownerPinExchange = async (request: PrivateOwnerPinRequest, signal: AbortSignal): Promise<PrivateOwnerPinResponse> => {
    const refusedWith = (error: unknown): PrivateOwnerPinResponse => {
      const code = isRecord(error) ? error.code : undefined;
      return privateOwnerPinFailure(request, typeof code === "string" && (PRIVATE_OWNER_PIN_CHANNEL_ERRORS as readonly string[]).includes(code)
        ? code as PrivateOwnerPinChannelError : "state_unavailable");
    };
    const agentId = request.agentId;
    try {
      const pinStore = pins(); const sealStore = seals();
      if (request.action === "status") {
        const current = await authorityCurrent(agentId, signal);
        return privateOwnerPinSuccess(request, { kind: "status", pin: pinStore.status(agentId), authority: sealStore.status(agentId, current) });
      }
      const wallet = tradingWallets().status(agentId);
      if (wallet.state === "absent") return privateOwnerPinFailure(request, "wallet_missing");
      if (wallet.state === "held") return privateOwnerPinFailure(request, "state_unavailable");
      if (wallet.state === "locked") return privateOwnerPinFailure(request, "wallet_locked");
      if (request.passphrase === undefined) return privateOwnerPinFailure(request, "proof_required");
      try { await tradingWallets().verifyPassphrase(agentId, request.passphrase, signal); }
      catch (error: unknown) { return privateOwnerPinFailure(request, proofRefusal(error)); }
      const current = parsePrivateAuthorityCurrent(await authorityCurrent(agentId, signal));
      if (closing) return privateOwnerPinFailure(request, "closing");
      // Synchronous from here: the shown settings, then the pin (it re-reads the pairing record, checks every shown pairing field (address,
      // digest, Hub origin, Hub agent id, network id, runner key fingerprint) and the last six characters), then the watermark at exactly the
      // values just compared.
      if (privateAuthorityViewDigest(privateAuthorityView(current)) !== request.authorityDigest) return privateOwnerPinFailure(request, "shown_mismatch");
      const pin = pinStore.seal(agentId, { ownerAddress: request.ownerAddress, bindingDigest: request.bindingDigest, frontendOrigin: request.frontendOrigin,
        serverAgentId: request.serverAgentId, chainId: request.chainId, runnerFingerprint: request.runnerFingerprint, suffix: request.suffix });
      let authority: ReturnType<PrivateAuthoritySeals["seal"]>;
      // The pin is already written: a watermark that could not be written leaves an unknown outcome (the card shows the status again).
      try { authority = sealStore.seal(agentId, current, { shownDigest: request.authorityDigest }); }
      catch { return privateOwnerPinFailure(request, "write_outcome_unknown"); }
      try { return privateOwnerPinSuccess(request, { kind: "sealed", pin, authority }); }
      catch { return privateOwnerPinFailure(request, "write_outcome_unknown"); }
    } catch (error: unknown) { return refusedWith(error); }
  };
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const applyControl = (request: RunnerRequest): RunnerResponse => {
    const prior = request.action === "stop" || request.action === "pause" ? store.lookupControlReceipt(request) : undefined;
    const result = store.control(request);
    // A historical receipt is not a new stop. Both CLI and web use this path,
    // so replaying an old stop after resume cannot cancel a newer private job.
    if (result.ok && prior?.kind === "missing") {
      try { privateBrain?.cancelAgent(request.agentId); } catch { /* The control receipt remains durable. */ }
    }
    // The next heartbeat reports the new state now (a disarm must not wait for the heartbeat interval).
    if (result.ok && request.action !== "status") { runtimeBridge.nudge(request.agentId); protectionChanged(); }
    return result;
  };
  // An RPC change of an armed agent without an open or unsettled trade disarms it first; still armed refuses the change.
  const disarmForChange = (agentId: string): boolean => privateDisarmForOwnerChange(agentId, readRuntimeState, applyControl);
  // Owner decision of 17 Nov 2026: a change to rules, caps or sizing of an armed agent pauses new entries only (exits keep
  // running) and resumes them after a confirmed save when every entry prerequisite still holds (private-change-entries.ts). The
  // config guard (beginConfig) is held from before the hold until after the release. No brain job is cancelled here: the cockpit
  // chat may be the one making the change; the version bump already ends any in-flight signal job (runtime_changed).
  const changeHolds = new PrivateChangeHolds({ readState: readRuntimeState,
    hold: (agentId) => store.holdEntries(agentId),
    release: (agentId, expectedVersion) => store.releaseEntries(agentId, expectedVersion),
    check: (agentId) => arming().entriesResumeRefusal(agentId),
    onChanged: (agentId) => runtimeBridge.nudge(agentId),
    exitsOnly: (agentId) => armingService?.exitsOnlyHeld(agentId) === true });
  // Positions open, pending an exit, held or not opened yet, plus unfinished trades and open reservations: what an RPC change of an
  // armed agent could leave without its stop-loss. Throws when any of it cannot be read (the change is then refused).
  const tradeExposure = (agentId: string): number => {
    const summary = recovery()?.summary(agentId);
    submissions();
    const attempts = submissionJournal?.list(agentId);
    if (!attempts) throw new Error("journal unavailable");
    const open = summary ? summary.open + summary.pending + summary.held + summary.unopened : 0;
    return open + privateSubmissionArmingCounts(attempts).unfinished + ledger().status(agentId, Date.now()).open.length;
  };
  /** The saved reply of a change with its entries outcome attached when the agent was armed (otherwise unchanged). Never throws. */
  const settleChange = <T>(change: PrivateChangeHold | undefined, saved: boolean, response: T, attach: (entries: PrivateChangeEntries) => T): T => {
    if (!change) return response;
    const entries = change.finish(saved);
    if (!saved || !entries) return response;
    try { return attach(entries); } catch { return response; }
  };
  /** Owner decision of 19 Nov 2026: adds an agent to this running daemon (owner socket only). The control snapshot is written first
   * (what a restart reads), then every per-agent store and worker ALREADY BUILT learns the id; one built later reads it from
   * store.agentIds() like every agent. The new agent is shadow, idle and unarmed at version 1; no other agent's state, version, entries,
   * arming, keys, positions, reservations or keep-awake need changes, and nothing is rebuilt. Synchronous from the write to the reply:
   * no other request (another agent's arm, owner change or exit pass) interleaves, and nothing is held across an await. Each extension
   * is idempotent, so registering an existing id also completes any extension an earlier attempt missed (and changes nothing else).
   * Removal is not supported. */
  const registerAgent = (request: RunnerRegisterRequest): RunnerResponse => {
    const result = store.registerAgent(request.agentId);
    if (result.kind === "refused") return failure(request.id, result.error);
    // Stores first, then the services over them, then the workers (the exit and execution workers run the new agent's first pass at
    // once, reading the stores above), then the Hub bridges.
    const extended: ReadonlyArray<{ addAgent(agentId: string): void } | undefined> = [decisionOutbox, solanaRpcSettings, balchemyRpc,
      tradingKeystore, ownerPinStore, authoritySealStore, tradingBindings, spendLedger, positionLedger, submissionJournal, executionIntents, dcaStore, spendCapProposalStore, ownerApprovalStore, launchpadStore,
      privateRules, privateBrain, privateIntents, submissionService, armingService, positionRecovery, executionWorker, exitWorker,
      autoBind, ceilingWorker, runtimeBridge, controlBridge, signalsBridge, decisionReports];
    let complete = true;
    // A store that could not learn the id keeps refusing it (unknown_agent): fail closed for that store only; a retry completes it.
    for (const target of extended) { try { target?.addAgent(request.agentId); } catch { complete = false; } }
    if (!complete) return failure(request.id, "state_unavailable");
    // The new agent's first heartbeat (not paired yet) goes out with the next poll.
    if (result.kind === "added") runtimeBridge.nudge(request.agentId);
    return { version: 1, id: request.id, ok: true, state: result.state, registration: result.kind };
  };
  const daemonState = (): RunnerDaemonState => ({ instanceId, process: closing ? "stopping" : "running", pairing: "unpaired", brain: "not_attached", execution: "unavailable", armed: false });
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (closing || connections.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    connections.add(socket);
    let deadline = setTimeout(() => socket.destroy(), CONNECTION_TIMEOUT_MS);
    deadline.unref();
    const reader = new FrameReader();
    let finished = false;
    const reply = (response: RunnerResponse | PrivateBrainResponse | PrivateRuleResponse | PrivateIntentResponse | PrivateSignalResponse
      | PrivateAutonomyResponse | PrivateModelBudgetResponse | PrivateSizingResponse | PrivateTradingWalletResponse | PrivateSolanaRpcResponse | PrivateTradingBindingResponse
      | PrivateSubmissionResponse | PrivateArmingResponse | PrivatePositionResponse | PrivateSetupResponse | PrivateLaunchpadResponse
      | PrivateExitRebindResponse | PrivateOwnerPinResponse): void => {
      if (finished || socket.destroyed) return;
      finished = true;
      socket.end(encodeFrame(response), () => socket.destroy());
    };
    // A2a: the gate's passphrase check ends with this connection.
    const proofAbort = new AbortController();
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { clearTimeout(deadline); connections.delete(socket); proofAbort.abort(); });
    /** A frame that carries a proof gets the arming deadline (one serialized scrypt); a branch's own longer deadline is set after it. */
    const proofDeadline = (): void => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.destroy(), PRIVATE_ARMING_TIMEOUT_MS);
      deadline.unref(); socket.setTimeout(PRIVATE_ARMING_TIMEOUT_MS);
    };
    /** Plan section A2 in one place for every gated branch: after the branch's binding checks, before any side effect. A frame without a
     * proof field runs synchronously, exactly as before, when the requirement is off or its action raises nothing by definition; anything
     * else waits for `socketProof`. `run` strips the field and re-parses before beginConfig, a change hold, a disarm or the service. */
    const gated = (frame: SocketProofFrame, refuse: (code: SocketProofRefusal) => void, run: (proof: SocketProofPass) => void): void => {
      const entry = socketProofEntry(frame.channel, frame.action);
      const fixed = entry !== undefined && entry.kind !== "raising" && entry.kind !== "compare";
      if (frame.passphrase === undefined && (!proofEnforced || fixed)) { run({ gated: false, proven: false }); return; }
      if (frame.passphrase !== undefined) proofDeadline();
      void socketProof(frame, proofAbort.signal).then((outcome) => {
        if (!outcome.ok) { refuse(outcome.code); return; }
        try { run({ gated: true, proven: outcome.proven }); } catch { refuse("state_unavailable"); }
      }, () => refuse("state_unavailable"));
    };
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      try { reader.push(chunk); }
      catch { reply(failure(null, "invalid_request")); }
    });
    socket.on("end", () => {
      if (finished) return;
      try {
        const raw: unknown = reader.finish();
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_keep_awake") {
          // Phase 1 keep-awake readback (read-only: no agent, no secret, nothing changes). Its frame is answered here directly.
          let answer: PrivateKeepAwakeResponse;
          try {
            const request = parsePrivateKeepAwakeRequest(raw);
            answer = privateKeepAwakeReply(raw, closing ? "closing" : request.localProfileId !== options.ownerId ? "profile_conflict"
              : request.instanceId !== instanceId ? "instance_conflict" : keepAwake ? keepAwake.status() : "state_unavailable");
          } catch { answer = privateKeepAwakeReply(raw, "invalid_request"); }
          if (!finished && !socket.destroyed) { finished = true; socket.end(encodeFrame(answer), () => socket.destroy()); }
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_trading_wallet") {
          // The frame carries an envelope or a passphrase, never a secret key. Nothing here is logged.
          const request = parsePrivateTradingWalletRequest(raw);
          if (closing) { reply(privateTradingWalletFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateTradingWalletFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateTradingWalletFailure(request, "instance_conflict")); return; }
          // Lock must reach a keystore that may hold a key even when the control store is held;
          // the keystore checks its own fixed agent list and clears the key before any other check.
          const lockExisting = request.action === "lock" && tradingKeystore !== undefined;
          if (!lockExisting && !store.agentIds()?.includes(request.agentId)) { reply(privateTradingWalletFailure(request, "unknown_agent")); return; }
          if (request.action === "unlock") {
            // scrypt N=2^17 is serialized in the keystore; give it a bounded, longer deadline.
            clearTimeout(deadline);
            deadline = setTimeout(() => socket.destroy(), TRADING_WALLET_UNLOCK_TIMEOUT_MS);
            deadline.unref(); socket.setTimeout(TRADING_WALLET_UNLOCK_TIMEOUT_MS);
          }
          let keystore: PrivateTradingKeystore;
          try { keystore = tradingWallets(); } catch { reply(privateTradingWalletFailure(request, "state_unavailable")); return; }
          const operation = new AbortController(); const abort = (): void => operation.abort();
          socket.once("close", abort);
          void keystore.handle(request, operation.signal).then(reply,
            () => reply(privateTradingWalletFailure(request, "state_unavailable"))).finally(() => {
            socket.off("close", abort);
            // The next heartbeat reports the new lock state now, not at the next interval (Hub's restart-lock warning).
            if (request.action !== "status" && !closing) runtimeBridge.nudge(request.agentId);
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_trading_binding") {
          // Public binding facts only; proofs and signatures stay inside the SDK exchange and are never logged or replied.
          const request = parsePrivateTradingBindingRequest(raw);
          if (closing) { reply(privateTradingBindingFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateTradingBindingFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateTradingBindingFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateTradingBindingFailure(request, "unknown_agent")); return; }
          if (request.action === "bind") {
            clearTimeout(deadline);
            deadline = setTimeout(() => socket.destroy(), TRADING_BINDING_TIMEOUT_MS);
            deadline.unref(); socket.setTimeout(TRADING_BINDING_TIMEOUT_MS);
          }
          let service: PrivateTradingBindings;
          try { service = bindings(); } catch { reply(privateTradingBindingFailure(request, "state_unavailable")); return; }
          const operation = new AbortController(); const abort = (): void => operation.abort();
          socket.once("close", abort);
          void service.handle(request, operation.signal).then(reply,
            () => reply(privateTradingBindingFailure(request, request.action === "bind" ? "outcome_unknown" : "state_unavailable")))
            .finally(() => socket.off("close", abort));
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_setup") {
          // K2 setup readback (public facts only). `watch` only keeps the ceiling worker polling the owner's proposal.
          const request = parsePrivateSetupRequest(raw);
          if (closing) { reply(privateSetupFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateSetupFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateSetupFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateSetupFailure(request, "unknown_agent")); return; }
          if (!autoBind || !ceilingWorker) { reply(privateSetupFailure(request, "setup_unavailable")); return; }
          try {
            if (request.action === "watch") ceilingWorker.watch(request.agentId);
            reply(privateSetupSuccess(request, { link: autoBind.status(request.agentId), ceiling: ceilingWorker.status(request.agentId) }));
          } catch { reply(privateSetupFailure(request, "state_unavailable")); }
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_launchpads") {
          // K4 launchpad sources: the public catalog and the runner-signed subscription (no wallet signature; public facts only).
          const request = parsePrivateLaunchpadRequest(raw);
          if (closing) { reply(privateLaunchpadFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateLaunchpadFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateLaunchpadFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateLaunchpadFailure(request, "unknown_agent")); return; }
          // A2a gate: a set adding any id to the stored subscription raises (a subset is tightening).
          const proof = request.action === "set" ? request.passphrase : undefined;
          const ids = request.action === "set" ? request.launchpadIds : undefined;
          gated({ channel: "private_launchpads", action: request.action, agentId: request.agentId, passphrase: proof,
            ...(ids ? { raises: () => launchpadRaise(launchpadBaseline(request.agentId), ids) } : {}) },
          (code) => reply(privateLaunchpadFailure(request, code)), (gate) => {
            const active = proof === undefined ? request : parsePrivateLaunchpadRequest(withoutProof(request, "passphrase"));
            clearTimeout(deadline);
            deadline = setTimeout(() => socket.destroy(), PRIVATE_LAUNCHPAD_TIMEOUT_MS);
            deadline.unref(); socket.setTimeout(PRIVATE_LAUNCHPAD_TIMEOUT_MS);
            let service: PrivateLaunchpads;
            try { service = launchpads(); } catch { reply(privateLaunchpadFailure(active, "launchpads_unavailable")); return; }
            const operation = new AbortController(); const abort = (): void => operation.abort();
            socket.once("close", abort);
            // One runner-signed query per exchange (Balchemy issues one nonce per agent per second): a set answers with its own result.
            void (async () => {
              const record = active.action === "set" ? await service.set(active.agentId, active.launchpadIds, operation.signal)
                : await service.refresh(active.agentId, operation.signal);
              if (active.action === "set") await resealAuthority(active.agentId, ["launchpads"], gate, { launchpadIds: active.launchpadIds });
              return privateLaunchpadView(await service.catalog(active.agentId, operation.signal), record);
            })().then((view) => reply(privateLaunchpadSuccess(active, view)),
              (error: unknown) => reply(privateLaunchpadFailure(active, error instanceof PrivateLaunchpadError ? error.code : "state_unavailable")))
              .finally(() => socket.off("close", abort));
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_arming") {
          // An arm frame carries the trading-keystore passphrase once; it is verified, discarded and never logged or replied.
          const request = parsePrivateArmingRequest(raw);
          if (closing) { reply(privateArmingFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateArmingFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateArmingFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateArmingFailure(request, "unknown_agent")); return; }
          // A2a gate: limits_set raising either cap (higher, `none`, or over `unset`) and every entries_resume need the proof; arm's own
          // passphrase is the arm's (self-proving), never a gate field and never stripped.
          const proof = request.action === "limits_set" || request.action === "entries_resume" ? request.passphrase : undefined;
          const caps = request.action === "limits_set" ? { perTrade: request.perTrade, daily: request.daily } : undefined;
          gated({ channel: "private_arming", action: request.action, agentId: request.agentId, passphrase: proof,
            ...(caps ? { raises: () => capsRaise(ledger().status(request.agentId, Date.now()).limits, caps) } : {}) },
          (code) => reply(privateArmingFailure(request, code)), (gate) => {
            const active = proof === undefined ? request : parsePrivateArmingRequest(withoutProof(request, "passphrase"));
            if (active.action === "precheck" || active.action === "arm" || active.action === "limits_quote" || active.action === "wallet_balance"
              || active.action === "approval_request" || active.action === "approval_poll" || active.action === "entries_resume") {
              // One bounded fee probe, one scrypt passphrase check, one balance read, one spaced owner-approval exchange or (A2a) the
              // watermark's store reads: a longer, still bounded deadline.
              clearTimeout(deadline);
              deadline = setTimeout(() => socket.destroy(), PRIVATE_ARMING_TIMEOUT_MS);
              deadline.unref(); socket.setTimeout(PRIVATE_ARMING_TIMEOUT_MS);
            }
            const end = active.action === "limits_set" ? beginConfig(active.agentId) : () => undefined;
            // Caps of an armed agent: new entries pause until the save settles (an unreadable state or a failed hold refuses).
            const change = active.action === "limits_set" ? changeHolds.begin(active.agentId) : undefined;
            if (change === null) { end(); reply(privateArmingFailure(active, "state_unavailable")); return; }
            let service: PrivateArming;
            try { service = arming(); } catch { change?.finish(false); end(); reply(privateArmingFailure(active, "state_unavailable")); return; }
            const operation = new AbortController(); const abort = (): void => operation.abort();
            socket.once("close", abort);
            void service.handle(active, operation.signal).then(async (response) => {
              const saved = response.ok && response.data.kind === "limits_set";
              if (saved) await resealAuthority(active.agentId, ["caps"], gate);
              reply(settleChange(change, saved, response, (entries) => response.ok && response.data.kind === "limits_set"
                ? privateArmingSuccess(active, { ...response.data, entries }) : response));
            }, () => { change?.finish(false); reply(privateArmingFailure(active, "state_unavailable")); })
              .finally(() => { end(); socket.off("close", abort); });
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_submissions") {
          // Read-only public journal facts; wire bytes, keys and proofs never leave the journal.
          const request = parsePrivateSubmissionRequest(raw);
          if (closing) { reply(privateSubmissionFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateSubmissionFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateSubmissionFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateSubmissionFailure(request, "unknown_agent")); return; }
          // A2a gate: acknowledge_copy lifts a security hold and close ends an attempt: both need the proof (list is a read).
          const proof = request.action === "acknowledge_copy" || request.action === "close" ? request.passphrase : undefined;
          gated({ channel: "private_submissions", action: request.action, agentId: request.agentId, passphrase: proof },
          (code) => reply(privateSubmissionFailure(request, code)), () => {
            const active = proof === undefined ? request : parsePrivateSubmissionRequest(withoutProof(request, "passphrase"));
            // acknowledge_copy (owner-typed confirmation in the CLI) only lifts the hold of observed re-signed copies.
            if (active.action === "close") {
              // Owner decision 26: the owner's close-out of one attempt (owner socket only; Hub has no path here). The typed confirmation
              // is checked again; the proof reads the owner's own RPC, so the deadline is longer and a closed socket aborts the reads.
              let service: PrivateSubmissions;
              try { service = submissions(); } catch { reply(privateSubmissionFailure(active, "state_unavailable")); return; }
              const respond = (closeOut: PrivateSubmissionCloseOut): void => {
                try { reply(privateSubmissionSuccess(active, service.list(active.agentId), closeOut)); }
                catch { reply(privateSubmissionFailure(active, "state_unavailable")); }
              };
              if (active.confirmation !== privateTradeClosePhrase(active.attemptKey)) {
                respond({ attemptKey: active.attemptKey, outcome: "refused", reason: "confirmation_mismatch" }); return;
              }
              clearTimeout(deadline);
              deadline = setTimeout(() => socket.destroy(), PRIVATE_TRADE_CLOSE_TIMEOUT_MS);
              deadline.unref(); socket.setTimeout(PRIVATE_TRADE_CLOSE_TIMEOUT_MS);
              const operation = new AbortController(); const abort = (): void => operation.abort();
              socket.once("close", abort);
              void service.closeByOwner(active.agentId, active.attemptKey, operation.signal).then(respond,
                () => reply(privateSubmissionFailure(active, "state_unavailable"))).finally(() => { socket.off("close", abort); });
              return;
            }
            try {
              const service = submissions();
              if (active.action === "acknowledge_copy") service.acknowledgeCopies(active.agentId);
              reply(privateSubmissionSuccess(active, service.list(active.agentId)));
            } catch { reply(privateSubmissionFailure(active, "state_unavailable")); }
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_positions") {
          // M3: position readback, a read-only chain proof of one held position, and the owner's typed resolution (one ledger
          // write on a proven readback; nothing signed or sent). Public facts only; never keys, wire bytes, proofs or RPC URLs.
          const request = parsePrivatePositionRequest(raw);
          if (closing) { reply(privatePositionFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privatePositionFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privatePositionFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privatePositionFailure(request, "unknown_agent")); return; }
          // A2a gate: resolve rewrites a held position's outcome and unmanage drops its exit protection: both need the proof.
          const proof = request.action === "resolve" || request.action === "unmanage" ? request.passphrase : undefined;
          gated({ channel: "private_positions", action: request.action, agentId: request.agentId, passphrase: proof },
          (code) => reply(privatePositionFailure(request, code)), () => {
            const active = proof === undefined ? request : parsePrivatePositionRequest(withoutProof(request, "passphrase"));
            let service: PrivatePositionRecovery | undefined;
            try { service = recovery(); } catch { reply(privatePositionFailure(active, "state_unavailable")); return; }
            if (active.action === "list") {
              try {
                // F-M36-D15-SF11: without the exits capability, the positions a build with it left are read from the ledger file, read
                // only (its own instance per readback, closed at once; never positions(), recovery, submissions or an exit worker).
                const listed = service ? service.list(active.agentId) : readPrivatePositionsWithoutExits({ directory: store.directory,
                  localProfileId: options.ownerId, agentIds: store.agentIds() ?? [],
                  assertAvailable: () => { if (closing || !store.isAvailable()) throw new Error("private writer unavailable"); } }, active.agentId);
                // Final audit N5: only the closed Hub reason, and only while it is clock_skew (the readback text names the clock).
                const readback = listed.exits === "available" && runtimeBridge.status(active.agentId)?.reason === "clock_skew"
                  ? { ...listed, hubReason: "clock_skew" as const } : listed;
                reply(privatePositionSuccess(active, { kind: "list", readback }));
              } catch { reply(privatePositionFailure(active, "state_unavailable")); }
              return;
            }
            if (!service) { reply(privatePositionFailure(active, "exits_unavailable")); return; }
            const recovered = service;
            // Owner item 75: an unmanage check (read-only) or the owner's confirmed unmanage (one ledger write after the same checks).
            // Local only: no RPC read, nothing signed, sent or sold; the spend ledger, the journal and Balchemy are never changed.
            if (active.action === "unmanage_check" || active.action === "unmanage") {
              const work = active.action === "unmanage_check"
                ? recovered.checkUnmanage(active.agentId, active.reservationId).then((check) => privatePositionSuccess(active, { kind: "unmanage_check", check }))
                : recovered.unmanage(active.agentId, active.reservationId).then((result) => privatePositionSuccess(active, { kind: "unmanage", result }));
              void work.then(reply, () => reply(privatePositionFailure(active, "state_unavailable")));
              return;
            }
            // Up to four finalized reads on the owner's RPC: a longer, still bounded deadline.
            clearTimeout(deadline);
            deadline = setTimeout(() => socket.destroy(), PRIVATE_POSITION_PROOF_TIMEOUT_MS);
            deadline.unref(); socket.setTimeout(PRIVATE_POSITION_PROOF_TIMEOUT_MS);
            const operation = new AbortController(); const abort = (): void => operation.abort();
            socket.once("close", abort);
            const work = active.action === "verify"
              ? recovered.verify(active.agentId, active.positionId, operation.signal).then((check) => privatePositionSuccess(active, { kind: "verify", check }))
              : recovered.resolve(active.agentId, { positionId: active.positionId, reservationId: active.reservationId, result: active.result }, operation.signal)
                .then((resolution) => privatePositionSuccess(active, { kind: "resolve", resolution }));
            void work.then(reply, () => reply(privatePositionFailure(active, "state_unavailable"))).finally(() => socket.off("close", abort));
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_exit_rebind") {
          // Owner decision of 21 Nov 2026: preview (read-only) or the owner's typed APPLY of the exit re-bind. Synchronous from the head
          // read to the ledger commit (no await), so no exit pass, buy, settlement or rules confirm of this daemon interleaves.
          const request = parsePrivateExitRebindRequest(raw);
          if (closing) { reply(privateExitRebindFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateExitRebindFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateExitRebindFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateExitRebindFailure(request, "unknown_agent")); return; }
          // A2a gate: apply re-binds open positions' exits (raising); the proof's await comes before the synchronous section below.
          const proof = request.action === "apply" ? request.passphrase : undefined;
          gated({ channel: "private_exit_rebind", action: request.action, agentId: request.agentId, passphrase: proof },
          (code) => reply(privateExitRebindFailure(request, code)), () => {
            const active = proof === undefined ? request : parsePrivateExitRebindRequest(withoutProof(request, "passphrase"));
            let service: PrivateExitRebind | undefined;
            try { service = exitRebind(); } catch { reply(privateExitRebindFailure(active, "state_unavailable")); return; }
            if (!service) { reply(privateExitRebindFailure(active, "exits_unavailable")); return; }
            try {
              if (active.action === "preview") reply(privateExitRebindSuccess(active, { kind: "preview", preview: service.preview(active.agentId) }));
              else {
                const result = service.apply(active.agentId, { operationId: active.operationId, revisionId: active.revisionId, rulesDigest: active.rulesDigest,
                  previewDigest: active.previewDigest });
                // The exit worker values re-bound positions under their new snapshot from its next pass on (it re-reads the ledger).
                reply(privateExitRebindSuccess(active, { kind: "apply", result }));
              }
            } catch (error: unknown) {
              reply(privateExitRebindFailure(active, error instanceof PrivateExitRebindRefused ? error.code : "state_unavailable"));
            }
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_solana_rpc") {
          // A set frame carries the endpoint URL once; replies and failures carry the host or a code only.
          const request = parsePrivateSolanaRpcRequest(raw);
          if (closing) { reply(privateSolanaRpcFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateSolanaRpcFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateSolanaRpcFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateSolanaRpcFailure(request, "unknown_agent")); return; }
          // A2a gate: every set is raising (no order exists between two endpoints). It runs before the config guard and the disarm, so an
          // unproven set changes nothing (it no longer disarms first).
          const proof = request.action === "set" ? request.passphrase : undefined;
          gated({ channel: "private_solana_rpc", action: request.action, agentId: request.agentId, passphrase: proof },
          (code) => reply(privateSolanaRpcFailure(request, code)), (gate) => {
            const active = proof === undefined ? request : parsePrivateSolanaRpcRequest(withoutProof(request, "passphrase"));
            const end = active.action === "set" ? beginConfig(active.agentId) : () => undefined;
            if (active.action === "set") {
              // Owner decision of 17 Nov 2026: an armed agent with an open or unsettled trade keeps its endpoint (positions_open);
              // otherwise an armed agent is disarmed first, as before. Synchronous from the check to the disarm.
              const refusal = privateRpcSetRefusal(readRuntimeState(active.agentId), () => tradeExposure(active.agentId));
              if (refusal) { end(); reply(privateSolanaRpcFailure(active, refusal)); return; }
              if (!disarmForChange(active.agentId)) { end(); reply(privateSolanaRpcFailure(active, "state_unavailable")); return; }
            }
            let response: PrivateSolanaRpcResponse;
            try {
              const settings = solanaRpc();
              // The status also carries the Balchemy-provided connection (closed state, provider names only; never a URL or token).
              if (active.action === "status") response = privateSolanaRpcSuccess(active, { kind: "status", status: settings.status(active.agentId),
                provided: balchemyRpc.status(active.agentId) });
              else {
                const { status } = settings.set(active.agentId, { operationId: active.operationId, expectedRevision: active.expectedRevision, url: active.url });
                response = privateSolanaRpcSuccess(active, { kind: "set", operationId: active.operationId, expectedRevision: active.expectedRevision, status });
              }
            } catch (error: unknown) {
              const code = error instanceof PrivateSolanaRpcSettingsError && PRIVATE_SOLANA_RPC_CHANNEL_ERRORS.includes(error.code as PrivateSolanaRpcChannelError)
                ? error.code as PrivateSolanaRpcChannelError : "state_unavailable";
              response = privateSolanaRpcFailure(active, code);
            } finally { end(); }
            if (gate.gated && active.action === "set" && response.ok) {
              const saved = response;
              void resealAuthority(active.agentId, ["rpc"], gate).finally(() => reply(saved));
            } else reply(response);
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_sizing") {
          const request = parsePrivateSizingRequest(raw);
          if (closing) { reply(privateSizingFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateSizingFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateSizingFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateSizingFailure(request, "unknown_agent")); return; }
          // A2a gate: the first set, a higher amount and ANY slippage change raise (exit sells reuse the entry slippage); a stored
          // revision other than the frame's expected one also counts as raising (its CAS would refuse it anyway).
          const proof = request.action === "update" ? request.passphrase : undefined;
          const next = request.action === "update" ? { amountSol: request.amountSol, slippageBps: request.slippageBps, expectedRevision: request.expectedRevision } : undefined;
          gated({ channel: "private_sizing", action: request.action, agentId: request.agentId, passphrase: proof,
            ...(next ? { raises: async () => {
              const stored = await readSizingPolicy(request.agentId);
              return (stored?.revision ?? 0) !== next.expectedRevision
                || sizingRaise(stored ? { amountSol: stored.amountSol, slippageBps: stored.slippageBps } : null, next);
            } } : {}) },
          (code) => reply(privateSizingFailure(request, code)), (gate) => {
            const active = proof === undefined ? request : parsePrivateSizingRequest(withoutProof(request, "passphrase"));
            // The sizing save awaits the private store: the config guard is held from before the entries hold until it settles.
            const end = active.action === "update" ? beginConfig(active.agentId) : () => undefined;
            const change = active.action === "update" ? changeHolds.begin(active.agentId) : undefined;
            if (change === null) { end(); reply(privateSizingFailure(active, "state_unavailable")); return; }
            const operation = new AbortController(); const abort = (): void => operation.abort();
            socket.once("close", abort);
            let pending: Promise<PrivateSizingResponse>;
            try { pending = brain().handleSizing(active, operation.signal); }
            catch { change?.finish(false); end(); socket.off("close", abort); reply(privateSizingFailure(active, "state_unavailable")); return; }
            void pending.then(async (response) => {
              const saved = response.ok && response.data.kind === "update";
              if (saved) await resealAuthority(active.agentId, ["sizing"], gate);
              reply(settleChange(change, saved, response, (entries) => response.ok && response.data.kind === "update"
                ? privateSizingSuccess(active, { ...response.data, entries }) : response));
            }, () => { change?.finish(false); reply(privateSizingFailure(active, "state_unavailable")); })
              .finally(() => { end(); socket.off("close", abort); });
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_model_budget") {
          // Owner-local daily AI budget: status and limit changes only; never a spend reset or a model call.
          const request = parsePrivateModelBudgetRequest(raw);
          if (closing) { reply(privateModelBudgetFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateModelBudgetFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateModelBudgetFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateModelBudgetFailure(request, "unknown_agent")); return; }
          // A2a gate: a limit above the effective stored one (or against another revision) raises; a captured price raises when it is the
          // first, of another provider or model, or lower (more calls fit under the same budget).
          const proof = request.action === "update" || request.action === "price" ? request.passphrase : undefined;
          const limit = request.action === "update" ? { dailyLimitMicroUsd: request.dailyLimitMicroUsd, expectedRevision: request.expectedRevision } : undefined;
          const quoted = request.action === "price" ? { provider: request.provider, model: request.model, inputMicroUsdPerMillion: request.inputMicroUsdPerMillion,
            outputMicroUsdPerMillion: request.outputMicroUsdPerMillion } : undefined;
          const raises = limit ? async (): Promise<boolean> => {
            const stored = await budgetStatus(request.agentId);
            return stored.policy.revision !== limit.expectedRevision || budgetRaise(stored.policy.dailyLimitMicroUsd, limit.dailyLimitMicroUsd);
          } : quoted ? async (): Promise<boolean> => {
            const stored = (await budgetStatus(request.agentId)).modelPrice;
            return priceRaise(stored ? { provider: stored.provider, model: stored.model, inputMicroUsdPerMillion: stored.inputMicroUsdPerMillion,
              outputMicroUsdPerMillion: stored.outputMicroUsdPerMillion } : null, quoted);
          } : undefined;
          gated({ channel: "private_model_budget", action: request.action, agentId: request.agentId, passphrase: proof, ...(raises ? { raises } : {}) },
          (code) => reply(privateModelBudgetFailure(request, code)), (gate) => {
            const active = proof === undefined ? request : parsePrivateModelBudgetRequest(withoutProof(request, "passphrase"));
            void brain().handleModelBudget(active).then(async (response) => {
              if (response.ok && active.action !== "status") await resealAuthority(active.agentId, active.action === "price" ? ["modelPrice"] : ["budget"], gate);
              reply(response);
            }, () => reply(privateModelBudgetFailure(active, "state_unavailable")));
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_autonomy") {
          const request = parsePrivateAutonomyRequest(raw);
          if (closing) { reply(privateAutonomyFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateAutonomyFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateAutonomyFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateAutonomyFailure(request, "unknown_agent")); return; }
          // A2a gate: a higher daily call limit (or one against another revision) raises.
          const proof = request.action === "update" ? request.passphrase : undefined;
          const next = request.action === "update" ? { dailyCallLimit: request.dailyCallLimit, expectedRevision: request.expectedRevision } : undefined;
          gated({ channel: "private_autonomy", action: request.action, agentId: request.agentId, passphrase: proof,
            ...(next ? { raises: async () => {
              const stored = (await autonomyStatus(request.agentId)).policy;
              return stored.revision !== next.expectedRevision || autonomyRaise(stored.dailyCallLimit, next.dailyCallLimit);
            } } : {}) },
          (code) => reply(privateAutonomyFailure(request, code)), (gate) => {
            const active = proof === undefined ? request : parsePrivateAutonomyRequest(withoutProof(request, "passphrase"));
            const operation = new AbortController(); const abort = (): void => operation.abort();
            socket.once("close", abort);
            void brain().handleAutonomy(active, operation.signal).then(async (response) => {
              if (response.ok && active.action === "update") await resealAuthority(active.agentId, ["autonomy"], gate);
              reply(response);
            }, () => reply(privateAutonomyFailure(active, "state_unavailable"))).finally(() => socket.off("close", abort));
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_signals") {
          const request = parsePrivateSignalRequest(raw);
          if (closing) { reply(privateSignalFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateSignalFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateSignalFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateSignalFailure(request, "unknown_agent")); return; }
          const operation = new AbortController(); const abort = (): void => operation.abort();
          socket.once("close", abort);
          const read = async (): Promise<void> => {
            try {
              const service = brain();
              // S8b readback: each completed buy decision carries its recorded execution outcome (a held store fails the read).
              const buy = (job: { state: string; action?: string }): boolean => job.state === "completed" && job.action === "buy";
              if (request.action === "list") {
                const page = await service.listSignals(request.agentId, request.beforeOrdinal, operation.signal);
                const outcomes = execution().outcomes(request.agentId);
                reply(privateSignalSuccess(request, { kind: "list", page: { ...page, items: page.items.map((item) => {
                  const outcome = buy(item) ? outcomes.get(item.jobId) : undefined; return outcome ? { ...item, executionOutcome: outcome } : item;
                }) } }));
              } else {
                const job = await service.readSignal(request.agentId, request.jobId, operation.signal);
                const outcome = buy({ state: job.state, action: job.result?.decision.action }) ? execution().outcome(request.agentId, job.jobId) : undefined;
                reply(privateSignalSuccess(request, { kind: "read", job, ...(outcome ? { executionOutcome: outcome } : {}) }));
              }
            } catch (error: unknown) {
              const code = error instanceof PrivateBrainStoreError && PRIVATE_SIGNAL_READ_ERRORS.includes(error.code as PrivateSignalReadError)
                ? error.code as PrivateSignalReadError : "state_unavailable";
              reply(privateSignalFailure(request, code));
            } finally { socket.off("close", abort); }
          };
          void read(); return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_intents") {
          const request = parsePrivateIntentRequest(raw);
          if (closing) { reply(privateIntentFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateIntentFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateIntentFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateIntentFailure(request, "unknown_agent")); return; }
          void intents().handle(request).then(reply, () => reply(privateIntentFailure(request, "state_unavailable"))); return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_rules") {
          const request = parsePrivateRuleRequest(raw);
          if (closing) { reply(privateRuleFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateRuleFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateRuleFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateRuleFailure(request, "unknown_agent")); return; }
          if (request.action !== "confirm") { reply(rules().handle(request)); return; }
          // A2a gate: a confirm is classified from the STORED proposal kind (never the frame): only "approval on" is tightening. The
          // proof's await comes before the synchronous section from the config guard to the commit.
          const target = { chain: request.chain, proposalId: request.proposalId };
          gated({ channel: "private_rules", action: request.action, agentId: request.agentId, passphrase: request.passphrase,
            raises: () => ruleConfirmRaise(rules().readProposalKind(request.agentId, target.chain, target.proposalId)) },
          (code) => reply(privateRuleFailure(request, code)), (gate) => {
            const parsed = request.passphrase === undefined ? request : parsePrivateRuleRequest(withoutProof(request, "passphrase"));
            if (parsed.action !== "confirm") { reply(privateRuleFailure(request, "invalid_request")); return; }
            const active = parsed;
            /** Synchronous from the config guard to the commit; undefined: the state could not be read or the hold not placed. */
            const commit = (): { response: PrivateRuleResponse; saved: boolean } | undefined => {
              const end = beginConfig(active.agentId);
              try {
                // Rules of an armed agent: new entries pause until the confirm settles; they resume only if the new revision still
                // passes the entry prerequisites (executable, stop-loss, not shadow mode, no per-trade approval) and caps coverage.
                const change = changeHolds.begin(active.agentId);
                if (!change) return undefined;
                let response: PrivateRuleResponse;
                try { response = rules().handle(active); } catch (error: unknown) { change.finish(false); throw error; }
                const confirmed = response.ok && response.data.kind === "receipt" ? response.data.receipt : null;
                return { saved: confirmed !== null, response: settleChange(change, confirmed !== null, response, (entries) => confirmed
                  ? privateRuleSuccess(active, { kind: "receipt", receipt: confirmed, entries }) : response) };
              } finally { end(); }
            };
            const outcome = commit();
            if (!outcome) { reply(privateRuleFailure(active, "state_unavailable")); return; }
            if (outcome.saved && gate.gated) void resealAuthority(active.agentId, ["rules"], gate).finally(() => reply(outcome.response));
            else reply(outcome.response);
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_brain") {
          const request = parsePrivateBrainRequest(raw);
          if (closing) { reply(privateBrainFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateBrainFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateBrainFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateBrainFailure(request, "unknown_agent")); return; }
          // A2a gate: configure, save and reselect change the model (raising); their proof is `walletPassphrase` (the trading wallet's).
          // `passphrase` stays the model vault's own and is never stripped; model_unlock proves the vault passphrase itself.
          const proof = request.action === "model_configure" || request.action === "model_save" || request.action === "model_reselect"
            ? request.walletPassphrase : undefined;
          gated({ channel: "private_brain", action: request.action, agentId: request.agentId, passphrase: proof },
          (code) => reply(privateBrainFailure(request, code)), (gate) => {
            const active = proof === undefined ? request : parsePrivateBrainRequest(withoutProof(request, "walletPassphrase"));
            const changesModel = active.action === "model_configure" || active.action === "model_save" || active.action === "model_reselect";
            const settle = (response: PrivateBrainResponse): void => {
              if (changesModel && gate.gated && response.ok) void resealAuthority(active.agentId, ["model"], gate).finally(() => reply(response));
              else reply(response);
            };
            try {
              // Private state is initialized only when this local feature is used;
              // ordinary control/status never reads a model key or chat journal.
              const activeBrain = brain();
              if (active.action === "model_save" || active.action === "model_unlock" || active.action === "model_reselect") {
                const operation = new AbortController();
                socket.once("close", () => operation.abort());
                void activeBrain.handleCredential(active, operation.signal).then(settle,
                  () => reply(privateBrainFailure(active, "state_unavailable")));
              } else if (active.action === "chat_create" || active.action === "chat_read" || active.action === "chat_cancel") {
                void activeBrain.handleChat(active).then(reply,
                  () => reply(privateBrainFailure(active, "state_unavailable")));
              } else settle(activeBrain.handle(active));
            } catch { reply(privateBrainFailure(active, "state_unavailable")); }
          });
          return;
        }
        if (typeof raw === "object" && raw !== null && "channel" in raw && raw.channel === "private_owner_pin") {
          // A2a seal step (owner socket only; Hub, the SDK and the backend never reach it). The seal frame carries the trading-wallet
          // passphrase once; it is verified, discarded and never stored, logged or replied.
          const request = parsePrivateOwnerPinRequest(raw);
          if (closing) { reply(privateOwnerPinFailure(request, "closing")); return; }
          if (request.localProfileId !== options.ownerId) { reply(privateOwnerPinFailure(request, "profile_conflict")); return; }
          if (request.instanceId !== instanceId) { reply(privateOwnerPinFailure(request, "instance_conflict")); return; }
          if (!store.agentIds()?.includes(request.agentId)) { reply(privateOwnerPinFailure(request, "unknown_agent")); return; }
          // The status reads every sealed store and the seal one scrypt: the arming deadline either way.
          proofDeadline();
          void ownerPinExchange(request, proofAbort.signal).then(reply, () => reply(privateOwnerPinFailure(request, "state_unavailable")));
          return;
        }
        const request = parseLocalRequest(raw);
        if (closing) { reply(failure(request.id, "closing")); return; }
        if (request.action === "register_agent") {
          reply(request.instanceId !== instanceId ? failure(request.id, "instance_conflict") : registerAgent(request));
          return;
        }
        if (request.action === "daemon_status" || request.action === "daemon_version" || request.action === "agent_list" || request.action === "shutdown") {
          if (request.instanceId !== instanceId) { reply(failure(request.id, "instance_conflict")); return; }
          if (request.action === "shutdown") {
            closing = true;
            socket.once("close", () => { void close(); });
            reply({ version: 1, id: request.id, ok: true, daemon: daemonState() });
            if (socket.destroyed) void close();
          } else if (request.action === "daemon_version") {
            // Read-only: lets a newer CLI tell the owner to restart a runner that still runs older code.
            reply(PACKAGE_VERSION_PATTERN.test(PACKAGE_VERSION) ? { version: 1, id: request.id, ok: true, daemon: { ...daemonState(), packageVersion: PACKAGE_VERSION } }
              : failure(request.id, "state_unavailable"));
          } else if (request.action === "agent_list") {
            const agentIds = store.agentIds();
            reply(agentIds ? { version: 1, id: request.id, ok: true, inventory: { instanceId, agentIds } } : failure(request.id, "state_unavailable"));
          } else {
            reply(store.isAvailable() ? { version: 1, id: request.id, ok: true, daemon: daemonState() } : failure(request.id, "state_unavailable"));
          }
          return;
        }
        if ("agentId" in request) {
          const result = applyControl(request);
          const hub = request.action === "status" && result.ok ? runtimeBridge.status(request.agentId) : undefined;
          let submissionSecurity: { unacknowledgedResignedCopies: number } | undefined;
          if (request.action === "status" && result.ok) {
            // A held journal omits the warning here; the submission hold itself is enforced before any signature.
            try { const copies = submissions().copyHolds(request.agentId); if (copies > 0) submissionSecurity = { unacknowledgedResignedCopies: copies }; } catch { /* Omitted. */ }
          }
          // S8b: the execution summary while armed or while intents are queued/running. M3: also while (exits capability only)
          // a position is held, an exit is pending or a completed buy has no position yet.
          let executionStatus: RunnerExecutionStatus | undefined;
          if (request.action === "status" && result.ok && result.state) {
            let active = result.state.mode === "live_armed";
            try { active ||= execution().active(request.agentId); } catch { /* Shown only for an armed agent then. */ }
            try {
              const summary = active ? undefined : recovery()?.summary(request.agentId);
              if (summary && (summary.held > 0 || summary.pending > 0 || summary.unopened > 0 || summary.entryHold !== null)) active = true;
            } catch { /* The summary is reported unavailable when the status is shown for another reason. */ }
            if (active) executionStatus = executionSummary(request.agentId);
          }
          reply(request.action === "status" && result.ok
            // The lock state is on every status reply, armed or not: a restart always disarms, and the owner must still see it.
            ? { ...result, ...(hub ? { hub } : {}), brainObservation: brainObservation(request.agentId),
              keystoreObservation: keystoreObservation(request.agentId), ...(submissionSecurity ? { submissionSecurity } : {}),
              ...(executionStatus ? { executionStatus } : {}) } : result);
        } else reply(failure(request.id, "invalid_request"));
      } catch { reply(failure(null, "invalid_request")); }
    });
  });

  // Never delete an existing socket: it can belong to another process or an
  // unresolved crash. A deliberate recovery flow must reconcile that state.
  try {
    try {
      fs.lstatSync(socketPath);
      throw new RunnerDaemonError("socket_unavailable");
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => reject(new RunnerDaemonError("socket_unavailable"));
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
  } catch {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    throw new RunnerDaemonError("socket_unavailable");
  }

  // Phase 1 (17 Nov 2026): keep-awake and the exits-only resume, created at startup (below), checked every 30 s and at once after
  // every arm and control. Stopped first on shutdown, so no inhibitor outlives a clean stop.
  let keepAwake: PrivateKeepAwake | undefined;
  let protectionTimer: NodeJS.Timeout | undefined;
  let balchemyRpcTimer: NodeJS.Timeout | undefined;
  let setupTimer: NodeJS.Timeout | undefined;
  const protectionAbort = new AbortController();
  /** Keep-awake only (synchronous, cheap): after an arm, a disarm or any control. */
  const protectionChanged = (): void => { try { if (!closing) keepAwake?.refresh(); } catch { /* The next pass retries. */ } };
  /** The periodic pass: keep-awake, then each exits-only arm. While one waits on an unresolved trade, a reconcile pass runs the releases
   * that need the armed exit gate (F2 for a runner dispute, SF R10 for a stalled buy): no timer of the submission service polls them
   * after a restart. Never throws. */
  const protectionPass = (): void => {
    if (closing) return;
    protectionChanged();
    for (const agentId of store.agentIds() ?? []) {
      let exitsOnly: ReturnType<PrivateArming["resumeExitsOnly"]> = "none";
      try { exitsOnly = armingService?.resumeExitsOnly(agentId) ?? "none"; } catch { exitsOnly = "none"; }
      if (exitsOnly !== "waiting") continue;
      try { void submissions().reconcile(agentId, protectionAbort.signal).catch(() => undefined); } catch { /* The next pass retries. */ }
    }
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    if (protectionTimer) clearInterval(protectionTimer);
    if (balchemyRpcTimer) clearInterval(balchemyRpcTimer);
    if (setupTimer) clearInterval(setupTimer);
    // The Balchemy-provided credentials leave memory with the daemon (never written anywhere).
    try { balchemyRpc.close(); } catch { /* Closed regardless. */ }
    protectionAbort.abort();
    try { keepAwake?.close(); } catch { /* Its own process group ends with the stop signal. */ }
    closePromise = (async () => {
      const listenerClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      // Join receipt commits before closing their writer. Closing authority first
      // prevents any new proof while the signal bridge drains an admitted commit.
      // The setup workers first: no bind, proposal read or ceiling request starts while the stores close beneath them.
      await Promise.all([listenerClosed, autoBind?.close(), ceilingWorker?.close(), controlBridge.close(), runtimeBridge.close(), signalsBridge.close(),
        decisionReports?.close(), privateIntents?.close()]);
      // Execution first: no new build or signature starts while the brain, journal and ledger close beneath it.
      await executionWorker?.close();
      // S5c: no new exit starts while the brain, submissions and position ledger close beneath it.
      await exitWorker?.close();
      await privateBrain?.close();
      decisionOutbox?.close();
      await submissionService?.close();
      executionIntents?.close();
      dcaStore?.close();
      positionLedger?.close();
      submissionJournal?.close();
      spendLedger?.close();
      ownerApprovalStore?.close();
      // A2a: the pin and seal stores close before the keystore they tag with.
      ownerPinStore?.close();
      authoritySealStore?.close();
      await tradingBindings?.close();
      await tradingKeystore?.close();
      solanaRpcSettings?.close();
      launchpadStore?.close();
      privateRules?.close();
      store.close(); resolveClosed();
    })();
    return closePromise;
  };
  const runtimeBridge = new RunnerRuntimeBridge({ directory: store.directory,
    localProfileId: options.ownerId, instanceId, agentIds: store.agentIds() ?? [],
    readBrainObservation: brainObservation,
    readKeystore: keystoreObservation,
    readState: (agentId) => {
      const result = store.control({ version: 1, id: randomUUID(), action: "status", agentId });
      return result.ok ? result.state : undefined;
    },
    onAccepted: (agentId) => { executionWorker?.wake(agentId); },
  });
  const controlBridge = new RunnerControlBridge({ directory: store.directory,
    localProfileId: options.ownerId, instanceId, agentIds: store.agentIds() ?? [],
    readLease: (agentId) => runtimeBridge.activeLease(agentId),
    lookupReceipt: (request) => store.lookupControlReceipt(request),
    control: applyControl,
  });
  const signalsBridge = new RunnerSignalsBridge({ directory: store.directory,
    localProfileId: options.ownerId, instanceId, agentIds: store.agentIds() ?? [],
    readLease: (agentId) => runtimeBridge.activeLease(agentId),
    receive: (agentId, receipt, signal) => brain().receiveSignal(agentId, receipt, signal),
    onAcknowledged: (agentId) => { executionWorker?.wake(agentId); },
  });
  const outboxForReports = reportOutbox();
  const decisionReports = outboxForReports ? new RunnerDecisionReportBridge({ directory: store.directory,
    localProfileId: options.ownerId, instanceId, agentIds: store.agentIds() ?? [], outbox: outboxForReports,
    readLease: (agentId) => runtimeBridge.activeLease(agentId),
  }) : undefined;
  // A listener error poisons availability instead of becoming an uncaught
  // exception or silently reopening a different transport.
  server.on("error", () => { void close(); });
  runtimeBridge.start();
  controlBridge.start();
  signalsBridge.start();
  decisionReports?.start();
  // Restart recovery: orphaned never-signed reservations are released; unfinished attempts poll status while a lease exists.
  try { submissions().recoverOnStart(); } catch { /* Held state keeps every unfinished wallet blocked. */ }
  // Then S8b: interrupted `running` intents are resolved from the journal (never rebuilt) and queues drain.
  try { execution(); } catch { /* A held intent store executes nothing; the next use retries the start. */ }
  // S5c exits, after recovery cleared never-signed pending exits; undefined (nothing constructed) on the exits-off rollback build.
  try { exits(); } catch { /* Retried on the next status read or buy (entry hold); until then every buy is held. */ }
  // Phase 1 keep-awake: needed while any agent is live_armed or holds an open, exit-pending or held position (a restart starts
  // disarmed, so open positions alone keep the computer awake until the owner arms again or they close).
  if (options.keepAwake) keepAwake = new PrivateKeepAwake({ ...options.keepAwake, needed: () => {
    const agentIds = store.agentIds();
    if (!agentIds) throw new Error("state unavailable");
    const ledgerPositions = positions();
    return agentIds.some((agentId) => readRuntimeState(agentId)?.mode === "live_armed"
      || (ledgerPositions?.positions(agentId).some((item) => item.state !== "closed") ?? false));
  } });
  protectionPass();
  protectionTimer = setInterval(protectionPass, PRIVATE_KEEP_AWAKE_POLL_MS);
  protectionTimer.unref();
  // Owner decision of 17 Nov 2026: each agent's Balchemy-provided RPC grant, fetched once its lease exists and refreshed on time.
  if (options.balchemyRpc) {
    balchemyRpcTimer = setInterval(() => { try { if (!closing) balchemyRpc.pass(); } catch { /* The next pass retries. */ } }, BALCHEMY_RPC_PASS_MS);
    balchemyRpcTimer.unref();
  }
  // K2 one-visit setup: the automatic link after pairing and the spend-ceiling worker (each does nothing until it is due).
  if (autoBind && ceilingWorker) {
    const setupWorkers = { autoBind, ceilingWorker };
    setupTimer = setInterval(() => {
      if (closing) return;
      void setupWorkers.autoBind.pass().catch(() => undefined);
      void setupWorkers.ceilingWorker.pass().catch(() => undefined);
    }, SETUP_PASS_MS);
    setupTimer.unref();
  }
  return { socketPath, instanceId, closed, close };
}
