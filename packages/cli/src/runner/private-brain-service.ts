import { runnerResearchRequestDigest, runnerAssessmentRequestDigest, type RunnerResearchRequest, type RunnerResearchResponse,
  type RunnerAssessmentRequest } from "@balchemyai/agent-sdk";
import * as fs from "node:fs";
import { PrivateBrainModels, PrivateBrainModelError, type PrivateBrainModelConfig } from "./private-brain-models.js";
import { PrivateBrainStore, PrivateBrainStoreError, PRIVATE_BRAIN_SNAPSHOT_FILE, PRIVATE_BRAIN_INITIALIZED_FILE,
  type PrivateBrainStoreOptions } from "./private-brain-store.js";
import { BRAIN_ARCHIVE_PREFIX } from "./private-working-archive.js";
import { parsePrivateBrainRequest, privateBrainSuccess, privateBrainFailure,
  type PrivateBrainRequest, type PrivateBrainResponse, type PrivateBrainErrorCode } from "./private-brain-protocol.js";
import type { PrivateBrainModelState, PrivateBrainVaultState } from "./private-brain-protocol.js";
import { PrivateModelVault, PrivateModelVaultError } from "./private-model-vault.js";
import { runPrivateConversation, PrivateConversationError } from "./private-conversation.js";
import { privateSecretKind } from "./private-secret-guard.js";
import type { PrivateCapProposalInput } from "./private-spend-cap.js";
import type { RunnerAgentState } from "./protocol.js";
import type { LlmAdapter, LlmMessage, RunnerBrainObservation } from "@balchemyai/agent-sdk";
import type { ConversationRuleView, ConversationRuleProposal } from "./private-rule-service.js";
import type { PrivateResearchReceipt } from "./private-research.js";
import { PrivateAssessmentError, type PrivateAssessmentReceipt } from "./private-assessment.js";
import { PrivateWorkingSetStore, PrivateWorkingSetError, type WorkingSetSelector, type WorkingSetSelection } from "./private-working-set.js";
import { projectWorkingContext, renderWorkingContext } from "./private-working-context.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import type { PrivateRuleService } from "./private-rule-service.js";
import { privateSignalJobId, validatePrivateSignalReceipt, privateSignalAssessmentRequest, privateSignalAssessmentNotRequested,
  privateSignalAssessmentFailure, privateSignalAssessmentEvidence, type PrivateSignalReceiptInput, type PrivateSignalJob,
  type PrivateSignalHoldReason, type PrivateSignalResult, type PrivateSignalAssessment, type PrivateAssessmentFailureReason } from "./private-signal-job.js";
import { assetRef } from "./private-research-evidence.js";
import { evaluatePrivateOuterPrefilter, privateBoundReportSymbol, privateOuterSignalDigest, type PrivateOuterSignal } from "./private-outer-decision.js";
import { requestPrivateSignalDecision, privateSignalDecisionMessages, PrivateSignalModelError,
  PRIVATE_SIGNAL_DECISION_MAX_TOKENS } from "./private-signal-decision.js";
import { PrivateModelBudget, PrivateModelBudgetError, privateModelBudgetReply } from "./private-model-budget.js";
import { meterPrivateModelAdapter, privateModelCallEstimate } from "./private-model-budget-meter.js";
import { parsePrivateModelBudgetRequest, privateModelBudgetSuccess, privateModelBudgetFailure, PRIVATE_MODEL_BUDGET_CHANNEL_ERRORS,
  type PrivateModelBudgetRequest, type PrivateModelBudgetResponse, type PrivateModelBudgetChannelError } from "./private-model-budget-protocol.js";
import { PrivateAutonomyError, unpreparedPrivateAutonomyStatus } from "./private-autonomy.js";
import { parsePrivateAutonomyRequest, privateAutonomySuccess, privateAutonomyFailure,
  PRIVATE_AUTONOMY_CHANNEL_ERRORS, type PrivateAutonomyRequest, type PrivateAutonomyResponse,
  type PrivateAutonomyChannelError } from "./private-autonomy-protocol.js";

import { PrivateSizingError } from "./private-sizing.js";
import { parsePrivateSizingRequest, privateSizingSuccess, privateSizingFailure, PRIVATE_SIZING_CHANNEL_ERRORS,
  type PrivateSizingRequest, type PrivateSizingResponse, type PrivateSizingChannelError } from "./private-sizing-protocol.js";
import { buildPrivateSignalPlan, type PrivateSignalPlan } from "./private-signal-plan.js";
import type { PrivateSignalPage } from "./private-signal-protocol.js";
import { addRunnerAgent } from "./agent-roster.js";
import { readPrivateHolderShares, type PrivateHolderShareReader, type PrivateHolderShares } from "./private-holder-share.js";
import { privateTopHolderCounts } from "./private-typed-rules.js";
import { privateDcaEvidence, type PrivateDcaEvidenceResult } from "./private-dca.js";

interface Active { jobId: string; abort: AbortController; kind?: "signal"; started?: boolean }
/** Freshness limits shared with guard() and the prefilter's maximumSignalAgeMs; the assessment never spends the last margin. */
const SIGNAL_MAX_AGE_MS = 300_000;
const ASSESSMENT_MAX_MS = 20_000;
const ASSESSMENT_MARGIN_MS = 2_000;
class SignalHold extends Error {
  constructor(readonly reason: PrivateSignalHoldReason) { super(`Private signal held: ${reason}`); }
}
function allowanceHold(error: unknown): SignalHold {
  if (error instanceof SignalHold) return error;
  // The daily AI budget: a refusal holds the job; its storage problems reuse the existing closed holds.
  if (error instanceof PrivateModelBudgetError)
    return new SignalHold(error.code === "model_budget_exhausted" || error.code === "clock_rollback" ? error.code : "call_allowance_unavailable");
  if (error instanceof PrivateAutonomyError && ["daily_call_limit", "token_cooldown", "legacy_usage_unknown", "clock_rollback"].includes(error.code))
    return new SignalHold(error.code as PrivateSignalHoldReason);
  return new SignalHold("call_allowance_unavailable");
}
export interface PrivateBrainServiceOptions extends PrivateBrainStoreOptions {
  readState(agentId: string): RunnerAgentState | undefined;
  /** Production transport returns the pinned acquisition receipt for local persistence. */
  researchReceipt?(agentId: string, request: RunnerResearchRequest, signal: AbortSignal): Promise<PrivateResearchReceipt>;
  /** Compatibility test seam without durable research context. Not used by the daemon. */
  research?(agentId: string, request: RunnerResearchRequest, signal: AbortSignal): Promise<RunnerResearchResponse>;
  /** Read-only pre-trade evidence for a resolved saved plan. Never changes the plan or authorizes execution. */
  assessmentReceipt?(agentId: string, request: RunnerAssessmentRequest, signal: AbortSignal, timeoutMs?: number): Promise<PrivateAssessmentReceipt>;
  /** Test seam only: production uses the direct provider factory. */
  modelFactory?: (config: PrivateBrainModelConfig) => LlmAdapter;
  readLease?(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  readConfirmedRules?: PrivateRuleService["readConfirmedRevision"];
  /** S8b: called once with each newly completed signal job (the execution queue admits it). A throw never changes the job. */
  onSignalCompleted?(job: PrivateSignalJob): void;
  /** Called once with each signal job that reached a final state (completed, held or failed), after it is durable. Used only
   * for the bounded decision report outbox; a throw is ignored and never changes the job or its admission. */
  onSignalTerminal?(job: PrivateSignalJob): void;
  rules?: {
    read(agentId: string, chain: "solana" | "base"): ConversationRuleView;
    propose(jobId: string, view: ConversationRuleView, exactSource: string): ConversationRuleProposal;
  };
  /** S4: saves an unconfirmed spend cap proposal from the owner's chat (never the ledger; only the CLI confirmation saves caps). */
  spendCaps?: { propose(agentId: string, caps: PrivateCapProposalInput): { proposalId: string } };
  /** Cockpit setup guide: the agent's setup state as compact JSON of closed values and public facts (never a secret). */
  readSetup?(agentId: string, signal: AbortSignal): string | Promise<string>;
  /** K1 entry facts: the agent's ENTRY-class Solana reader (two Balchemy-provided sources must agree) for the top-N holder share of a
   * rule that needs it. Absent or undefined: the share is unknown and such a rule holds. */
  readEntryRpc?(agentId: string): PrivateHolderShareReader | undefined;
  /** K4 launchpad provenance (private-launchpads.ts): `prepare` refreshes a stale catalog or subscription before a launchpad decision
   * (never throws); `admitted` is the synchronous check every guard pass repeats. Absent: every launchpad signal holds. */
  launchpads?: {
    prepare(agentId: string, bindingDigest: string, signal: AbortSignal): Promise<void>;
    admitted(agentId: string, receipt: PrivateSignalReceiptInput): boolean;
  };
}

/** Jobs are acknowledged only after durable creation. Archive and provider work
 * yield independently of socket handlers and the control command queue. */
export class PrivateBrainService {
  private store?: PrivateBrainStore;
  private storeOpen?: Promise<PrivateBrainStore>;
  private readonly storeAbort = new AbortController();
  private readonly chatWork = new Set<Promise<PrivateBrainResponse>>();
  private readonly signalWork = new Set<Promise<void>>();
  private readonly signalReads = new Set<Promise<unknown>>();
  private readonly sizingWork = new Set<Promise<PrivateSizingResponse>>();
  private readonly autonomyWork = new Set<Promise<PrivateAutonomyResponse>>();
  private readonly lastSignalTerminal = new Map<string, RunnerBrainObservation["lastTerminal"]>();
  private readonly signalPending = new Map<string, string[]>();
  private readonly preparing = new Map<string, Active>();
  private readonly models: PrivateBrainModels;
  private readonly pending = new Map<string, string>();
  private readonly active = new Map<string, Active>();
  private readonly inFlight = new Set<Promise<void>>();
  private scheduled = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private vault?: PrivateModelVault;
  private workingSet?: PrivateWorkingSetStore;
  private workingSetOpen?: Promise<PrivateWorkingSetStore>;
  private readonly workingSetAbort = new AbortController();
  private vaultUnavailable = false;
  private budget?: PrivateModelBudget;
  private budgetUnavailable = false;
  private readonly credentialOperations = new Map<string, AbortController>();
  private readonly credentialWork = new Set<Promise<PrivateBrainResponse>>();

  private readonly options: PrivateBrainServiceOptions;
  private readonly agentList: string[];

  constructor(options: PrivateBrainServiceOptions) {
    this.agentList = [...options.agentIds]; this.options = { ...options, agentIds: this.agentList };
    // Every configured adapter, including an injected test factory's, is metered by the daily AI budget.
    this.models = new PrivateBrainModels(options.agentIds, (agent) => this.cancelAgent(agent), options.modelFactory,
      (agentId, selected, adapter) => meterPrivateModelAdapter(adapter, { agentId, ...selected }, () => this.getBudget()));
  }

  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Its model starts locked; the job journal,
   * vault, working set and AI budget opened so far learn the id (one opening now learns it when it resolves); every other agent's
   * model, key, jobs and budget are untouched. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void {
    if (!addRunnerAgent(this.agentList, agentId)) return;
    this.models.addAgent(agentId);
    this.store?.addAgent(agentId); this.vault?.addAgent(agentId); this.workingSet?.addAgent(agentId); this.budget?.addAgent(agentId);
  }

  /** Enum-only current-instance projection. No journal/vault initialization or history scan. */
  observeBrain(rules: RunnerBrainObservation["rules"], agentId: string): RunnerBrainObservation {
    if (this.closed || !this.options.agentIds.includes(agentId)) throw new PrivateBrainStoreError("state_unavailable");
    this.options.assertAvailable();
    const active = this.active.get(agentId);
    const signal = active?.kind === "signal" && !active.abort.signal.aborted ? active : undefined;
    return Object.freeze({ version: 1, model: this.models.state(agentId).state, rules,
      activity: signal ? signal.started ? "running" : "pending" : this.signalPending.get(agentId)?.length ? "pending" : "idle",
      lastTerminal: this.lastSignalTerminal.get(agentId) ?? "none" });
  }
  private observedTerminal(job: PrivateSignalJob): void {
    if (job.state !== "received" && job.state !== "running") {
      this.lastSignalTerminal.set(job.agentId, job.state);
      try { this.options.onSignalTerminal?.(job); } catch { /* A report is never part of the decision. */ }
    }
  }

  /** Owner-local exact reference lookup; never calls a model or a provider. */
  async readIntentEvidence(agentId: string, refId: string, nowMs: number, signal: AbortSignal): Promise<{
    selection: WorkingSetSelection; assertCurrent(): void;
  }> {
    const guard = (): void => {
      if (this.closed || signal.aborted) throw new PrivateBrainStoreError("state_unavailable");
      this.options.assertAvailable();
      if (!this.options.agentIds.includes(agentId)) throw new PrivateBrainStoreError("unknown_agent");
    };
    guard(); const store = await this.getWorkingSet(); guard();
    const checkpoint = store.captureCheckpointGuard();
    const selection = await store.selectAsync({ localAgentId: agentId, conversationId: "main" }, { kind: "refId", refId }, nowMs, { signal, guard });
    const assertCurrent = (): void => { guard(); checkpoint(); };
    assertCurrent(); return { selection, assertCurrent };
  }

  /** The never-buy symbol of a completed decision at the build choke point: the symbol its own bound reports carry
   * (privateBoundReportSymbol over the asset's current working-set selection, conversation "main"); null when unknown. */
  async entrySymbol(agentId: string, refId: string, bindings: Parameters<typeof privateBoundReportSymbol>[2], signal?: AbortSignal): Promise<string | null> {
    const guard = (): void => {
      if (this.closed || signal?.aborted) throw new PrivateBrainStoreError("state_unavailable");
      this.options.assertAvailable();
      if (!this.options.agentIds.includes(agentId)) throw new PrivateBrainStoreError("unknown_agent");
    };
    guard(); const store = await this.getWorkingSet(); guard();
    const queryScope = { localAgentId: agentId, conversationId: "main" };
    const selection = await store.selectAsync(queryScope, { kind: "refId", refId }, Date.now(), { ...(signal ? { signal } : {}), guard });
    guard();
    return privateBoundReportSymbol(selection, { localProfileId: this.options.localProfileId, agentId, conversationId: "main" }, bindings, Date.now());
  }

  /** K1b DCA: fresh usable research of exactly `mint` for one add. The working set's (conversation "main") when every report stays
   * fresh long enough (privateDcaEvidence), else one research query (candidate report with onchain data, under the active lease)
   * appended to the working set and read again. Never calls a model; a failure is a throw or a closed reason. */
  async dcaEvidence(agentId: string, mint: string, signal: AbortSignal): Promise<PrivateDcaEvidenceResult> {
    const guard = (): void => {
      if (this.closed || signal.aborted) throw new PrivateBrainStoreError("state_unavailable");
      this.options.assertAvailable();
      if (!this.options.agentIds.includes(agentId)) throw new PrivateBrainStoreError("unknown_agent");
    };
    guard();
    const asset = assetRef("solana", mint);
    const queryScope = { localAgentId: agentId, conversationId: "main" };
    const scope = { localProfileId: this.options.localProfileId, ...queryScope };
    const store = await this.getWorkingSet(); guard();
    const read = async (): Promise<PrivateDcaEvidenceResult> => {
      const selection = await store.selectAsync(queryScope, { kind: "refId", refId: asset.refId }, Date.now(), { signal, guard });
      guard(); return privateDcaEvidence(selection, scope, mint, Date.now());
    };
    const first = await read();
    if (first.ok || first.reason === "evidence_mismatch" || !this.options.researchReceipt) return first;
    const lease = this.options.readLease?.(agentId);
    if (!lease || lease.instanceId !== this.options.instanceId || !Number.isFinite(lease.remainingMs) || lease.remainingMs <= 0) return first;
    const request: RunnerResearchRequest = { kind: "candidate_report", chain: "solana", assetId: mint, includeX: false, includeOnchain: true };
    const requestDigest = runnerResearchRequestDigest(request);
    const research = await this.options.researchReceipt(agentId, request, signal); guard();
    const target = research.expectedTarget;
    if (target.frontendOrigin !== lease.frontendOrigin || target.agentId !== lease.agentId || target.bindingDigest !== lease.bindingDigest
      || target.instanceId !== lease.instanceId || target.epoch !== lease.epoch || target.runnerPublicKey !== lease.runnerPublicKey
      || runnerResearchRequestDigest(target.request) !== requestDigest || research.response.requestDigest !== requestDigest) return { ok: false, reason: "evidence_mismatch" };
    await store.appendAsync({ ...queryScope, jobId: `dca:${requestDigest.slice(0, 32)}:${Date.now()}`, requestId: requestDigest, receipt: research }, guard, signal);
    guard();
    return read();
  }

  handle(input: PrivateBrainRequest): PrivateBrainResponse {
    const request = parsePrivateBrainRequest(input);
    try {
      if (this.closed) return privateBrainFailure(request, "closing");
      if (request.localProfileId !== this.options.localProfileId) return privateBrainFailure(request, "profile_conflict");
      if (request.instanceId !== this.options.instanceId) return privateBrainFailure(request, "instance_conflict");
      if (!this.options.agentIds.includes(request.agentId)) return privateBrainFailure(request, "unknown_agent");
      switch (request.action) {
        case "model_status": return this.modelResponse(request, this.models.state(request.agentId));
        case "model_configure": return this.modelResponse(request, this.models.configure(request.agentId, request.expectedRevision,
          { provider: request.provider, model: request.model, apiKey: request.apiKey }));
        case "model_lock": return this.modelResponse(request, this.models.lock(request.agentId, request.expectedRevision));
        case "model_save": case "model_unlock": case "model_reselect": return privateBrainFailure(request, "invalid_request");
        case "chat_read": case "chat_cancel": case "chat_create": return privateBrainFailure(request, "invalid_request");
      }
    } catch (error: unknown) { return privateBrainFailure(request, this.error(error)); }
  }

  /** Historical lookup is asynchronous. No socket disconnect resubmits a job;
   * callers recover uncertain acknowledgements using the same read-only ID. */
  handleChat(input: PrivateBrainRequest): Promise<PrivateBrainResponse> {
    const request = Object.freeze({ ...parsePrivateBrainRequest(input) });
    if (this.chatWork.size >= 16) return Promise.resolve(privateBrainFailure(request, "busy"));
    const work = this.chat(request);
    this.chatWork.add(work);
    void work.then(() => this.chatWork.delete(work), () => this.chatWork.delete(work));
    return work;
  }

  /** The transport may ACK only after this resolves. Model work is independent
   * of transport lifetime; an exact receipt replay never enqueues it again. */
  receiveSignal(agentId: string, input: PrivateSignalReceiptInput, signal?: AbortSignal): Promise<void> {
    if (this.signalWork.size >= 16) return Promise.reject(new PrivateBrainStoreError("busy"));
    let receipt: PrivateSignalReceiptInput;
    try { receipt = validatePrivateSignalReceipt(input); }
    catch { return Promise.reject(new PrivateBrainStoreError("invalid_request")); }
    const work = this.receive(agentId, receipt, signal);
    this.signalWork.add(work);
    void work.then(() => this.signalWork.delete(work), () => this.signalWork.delete(work));
    return work;
  }

  /** Private local readback; never sent to server heartbeat or analytics. */
  readSignal(agentId: string, jobId: string, signal?: AbortSignal): Promise<PrivateSignalJob> {
    return this.readSignals(agentId, signal, async (store, operation) => {
      if (this.preparing.get(agentId)?.jobId === jobId) throw new PrivateBrainStoreError("busy");
      try { return await store.readSignalAsync(agentId, jobId, operation); }
      catch (error: unknown) {
        if (error instanceof PrivateBrainStoreError && error.code === "job_not_found"
          && this.preparing.get(agentId)?.jobId === jobId) throw new PrivateBrainStoreError("busy");
        throw error;
      }
    });
  }

  listSignals(agentId: string, beforeOrdinal?: number, signal?: AbortSignal): Promise<PrivateSignalPage> {
    return this.readSignals(agentId, signal, (store, operation) => store.listSignalsAsync(agentId, beforeOrdinal, operation));
  }

  /** Allowance changes require the exact local owner transport binding. They
   * never configure a model, reset usage, or dispatch autonomous work. */
  handleAutonomy(input: PrivateAutonomyRequest, signal?: AbortSignal): Promise<PrivateAutonomyResponse> {
    const request = parsePrivateAutonomyRequest(input);
    if (this.autonomyWork.size >= 16) return Promise.resolve(privateAutonomyFailure(request, "busy"));
    const work = this.autonomy(request, signal);
    this.autonomyWork.add(work);
    void work.then(() => this.autonomyWork.delete(work), () => this.autonomyWork.delete(work));
    return work;
  }

  private async autonomy(request: PrivateAutonomyRequest, signal?: AbortSignal): Promise<PrivateAutonomyResponse> {
    try {
      if (request.localProfileId !== this.options.localProfileId) return privateAutonomyFailure(request, "profile_conflict");
      if (request.instanceId !== this.options.instanceId) return privateAutonomyFailure(request, "instance_conflict");
      if (!this.options.agentIds.includes(request.agentId)) return privateAutonomyFailure(request, "unknown_agent");
      const operation = { signal: signal ?? this.storeAbort.signal, guard: (): void => {
        if (this.closed) throw new PrivateBrainStoreError("closing");
        if (signal?.aborted) throw new PrivateBrainStoreError("cancelled");
        this.options.assertAvailable();
      } };
      operation.guard();
      if (request.action === "status" && !this.storeOpen) {
        const names = fs.readdirSync(this.options.directory);
        if (!names.some((name) => name === PRIVATE_BRAIN_SNAPSHOT_FILE || name === PRIVATE_BRAIN_INITIALIZED_FILE || name.startsWith(BRAIN_ARCHIVE_PREFIX))) {
          operation.guard();
          return privateAutonomySuccess(request, { kind: "status", status: unpreparedPrivateAutonomyStatus(request.agentId, Date.now()) });
        }
      }
      const store = await this.openStore(); operation.guard();
      if (request.action === "status")
        return privateAutonomySuccess(request, { kind: "status", status: store.autonomyStatus(request.agentId, Date.now()) });
      const status = store.setAutonomyPolicy(request.agentId, { operationId: request.operationId,
        expectedRevision: request.expectedRevision, dailyCallLimit: request.dailyCallLimit }, Date.now(), operation);
      return privateAutonomySuccess(request, { kind: "update", operationId: request.operationId,
        expectedRevision: request.expectedRevision, status });
    } catch (error: unknown) {
      const code = error instanceof PrivateBrainStoreError || error instanceof PrivateAutonomyError ? error.code : "state_unavailable";
      return privateAutonomyFailure(request, PRIVATE_AUTONOMY_CHANNEL_ERRORS.includes(code as PrivateAutonomyChannelError)
        ? code as PrivateAutonomyChannelError : "state_unavailable");
    }
  }

  /** Owner-local daily AI budget: status and limit changes only. Never resets spend, calls a model or arms execution. */
  handleModelBudget(input: PrivateModelBudgetRequest): Promise<PrivateModelBudgetResponse> {
    const request = parsePrivateModelBudgetRequest(input);
    try {
      if (this.closed) return Promise.resolve(privateModelBudgetFailure(request, "closing"));
      if (request.localProfileId !== this.options.localProfileId) return Promise.resolve(privateModelBudgetFailure(request, "profile_conflict"));
      if (request.instanceId !== this.options.instanceId) return Promise.resolve(privateModelBudgetFailure(request, "instance_conflict"));
      if (!this.options.agentIds.includes(request.agentId)) return Promise.resolve(privateModelBudgetFailure(request, "unknown_agent"));
      const budget = this.getBudget();
      if (request.action === "status") return Promise.resolve(privateModelBudgetSuccess(request, { kind: "status", status: budget.status(request.agentId) }));
      if (request.action === "price") return Promise.resolve(privateModelBudgetSuccess(request, { kind: "status", status: budget.setModelPrice(request.agentId,
        { provider: request.provider, model: request.model, inputMicroUsdPerMillion: request.inputMicroUsdPerMillion, outputMicroUsdPerMillion: request.outputMicroUsdPerMillion }) }));
      const { status } = budget.setPolicy(request.agentId, { operationId: request.operationId,
        expectedRevision: request.expectedRevision, dailyLimitMicroUsd: request.dailyLimitMicroUsd });
      return Promise.resolve(privateModelBudgetSuccess(request, { kind: "update", operationId: request.operationId,
        expectedRevision: request.expectedRevision, status }));
    } catch (error: unknown) {
      const code = error instanceof PrivateModelBudgetError ? error.code : "state_unavailable";
      return Promise.resolve(privateModelBudgetFailure(request, PRIVATE_MODEL_BUDGET_CHANNEL_ERRORS.includes(code as PrivateModelBudgetChannelError)
        ? code as PrivateModelBudgetChannelError : "state_unavailable"));
    }
  }

  /** Read-only budget admission of one decision call, before the call allowance is debited; holds the job otherwise. */
  private checkModelBudget(agentId: string, messages: readonly LlmMessage[]): void {
    const state = this.models.state(agentId);
    if (state.state !== "ready") throw new SignalHold("model_locked");
    const budget = this.getBudget();
    // The same price the metered call reserves at (a captured OpenRouter catalog price for exactly this model, else the table).
    const check = budget.check(agentId, privateModelCallEstimate(state.provider, state.model, messages, PRIVATE_SIGNAL_DECISION_MAX_TOKENS,
      budget.modelPrice(agentId, state.provider, state.model)));
    if (!check.allowed) throw new SignalHold(check.reason);
  }

  /** Explicit owner setup amount; never initializes a model or arms execution. */
  handleSizing(input: PrivateSizingRequest, signal?: AbortSignal): Promise<PrivateSizingResponse> {
    const request = parsePrivateSizingRequest(input);
    if (this.sizingWork.size >= 16) return Promise.resolve(privateSizingFailure(request, "busy"));
    const work = this.sizing(request, signal); this.sizingWork.add(work);
    void work.then(() => this.sizingWork.delete(work), () => this.sizingWork.delete(work));
    return work;
  }

  private async sizing(request: PrivateSizingRequest, signal?: AbortSignal): Promise<PrivateSizingResponse> {
    try {
      if (request.localProfileId !== this.options.localProfileId) return privateSizingFailure(request, "profile_conflict");
      if (request.instanceId !== this.options.instanceId) return privateSizingFailure(request, "instance_conflict");
      if (!this.options.agentIds.includes(request.agentId)) return privateSizingFailure(request, "unknown_agent");
      const operation = { signal: signal ?? this.storeAbort.signal, guard: (): void => {
        if (this.closed) throw new PrivateBrainStoreError("closing");
        if (signal?.aborted) throw new PrivateBrainStoreError("cancelled");
        this.options.assertAvailable();
      } };
      const currentRevision = (): `brr_${string}` | null => {
        operation.guard();
        if (!this.options.readConfirmedRules) throw new PrivateSizingError("state_unavailable");
        return this.options.readConfirmedRules(request.agentId, "solana").head.revisionId;
      };
      const ruleRevision = currentRevision();
      if (request.action === "status" && !this.storeOpen) {
        const names = fs.readdirSync(this.options.directory);
        if (!names.some((name) => name === PRIVATE_BRAIN_SNAPSHOT_FILE || name === PRIVATE_BRAIN_INITIALIZED_FILE || name.startsWith(BRAIN_ARCHIVE_PREFIX))) {
          operation.guard();
          return privateSizingSuccess(request, { kind: "status", status: {
            agentId: request.agentId, currentRuleRevisionId: ruleRevision, policy: null } });
        }
      }
      const store = await this.openStore(); operation.guard();
      const currentRuleRevisionId = currentRevision();
      if (request.action === "status") return privateSizingSuccess(request, { kind: "status", status: {
        agentId: request.agentId, currentRuleRevisionId, policy: store.sizingPolicy(request.agentId) } });
      const policyInput = { operationId: request.operationId, expectedRevision: request.expectedRevision,
        expectedRuleRevisionId: request.expectedRuleRevisionId, amountSol: request.amountSol, slippageBps: request.slippageBps };
      const recovered = store.sizingPolicyChange(request.agentId, policyInput);
      if (recovered) return privateSizingSuccess(request, { kind: "update", operationId: request.operationId, expectedRevision: request.expectedRevision,
        status: { agentId: request.agentId, currentRuleRevisionId, policy: recovered } });
      if (request.expectedRuleRevisionId !== currentRuleRevisionId) return privateSizingFailure(request, "rule_revision_conflict");
      const policy = store.setSizingPolicy(request.agentId, policyInput, Date.now(), { ...operation, guard: (): void => {
          operation.guard();
          if (currentRevision() !== request.expectedRuleRevisionId) throw new PrivateSizingError("rule_revision_conflict");
        } });
      return privateSizingSuccess(request, { kind: "update", operationId: request.operationId, expectedRevision: request.expectedRevision,
        status: { agentId: request.agentId, currentRuleRevisionId, policy } });
    } catch (error: unknown) {
      const code = error instanceof PrivateBrainStoreError || error instanceof PrivateSizingError ? error.code : "state_unavailable";
      return privateSizingFailure(request, PRIVATE_SIZING_CHANNEL_ERRORS.includes(code as PrivateSizingChannelError)
        ? code as PrivateSizingChannelError : "state_unavailable");
    }
  }

  private readSignals<T>(agentId: string, signal: AbortSignal | undefined,
    read: (store: PrivateBrainStore, operation: { signal: AbortSignal; guard(): void }) => Promise<T>): Promise<T> {
    if (this.signalReads.size >= 16) return Promise.reject(new PrivateBrainStoreError("busy"));
    const operation = { signal: signal ?? this.storeAbort.signal, guard: (): void => {
      if (this.closed) throw new PrivateBrainStoreError("closing");
      if (signal?.aborted) throw new PrivateBrainStoreError("cancelled");
      if (!this.options.agentIds.includes(agentId)) throw new PrivateBrainStoreError("unknown_agent");
      this.options.assertAvailable();
    } };
    const work = (async (): Promise<T> => {
      operation.guard(); const store = await this.openStore(); operation.guard();
      const result = await read(store, operation); operation.guard(); return result;
    })();
    this.signalReads.add(work);
    void work.then(() => this.signalReads.delete(work), () => this.signalReads.delete(work));
    return work;
  }

  private async receive(agentId: string, input: PrivateSignalReceiptInput, signal?: AbortSignal): Promise<void> {
    const jobId = privateSignalJobId(input);
    if (agentId !== input.agentId || input.localProfileId !== this.options.localProfileId
      || !this.options.agentIds.includes(agentId)) throw new PrivateBrainStoreError("invalid_request");
    if (this.preparing.has(agentId)) throw new PrivateBrainStoreError("busy");
    const preparing: Active = { jobId, abort: new AbortController(), kind: "signal" };
    this.preparing.set(agentId, preparing);
    const abort = (): void => preparing.abort.abort();
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const guard = (): void => {
      if (this.closed || preparing.abort.signal.aborted || this.preparing.get(agentId) !== preparing)
        throw new PrivateBrainStoreError("cancelled");
      this.options.assertAvailable(); this.assertSignalLease(input);
    };
    try {
      guard(); const store = await this.openStore(); guard();
      // Resolve exact durable replay before applying new-work queue capacity.
      let replay = false;
      try { await store.readSignalAsync(agentId, jobId, { signal: preparing.abort.signal, guard }); replay = true; }
      catch (error: unknown) { if (!(error instanceof PrivateBrainStoreError) || error.code !== "job_not_found") throw error; }
      const createGuard = (): void => {
        guard();
        if (!replay && (this.signalPending.get(agentId)?.length ?? 0) >= 16) throw new PrivateBrainStoreError("busy");
      };
      const result = await store.recordSignalAsync(input, { signal: preparing.abort.signal, guard: createGuard });
      try { guard(); }
      catch (error: unknown) {
        if (result.created) {
          try { this.observedTerminal(store.holdSignal(agentId, result.job.jobId, result.job.generation,
            error instanceof SignalHold ? error.reason : "runtime_changed")); }
          catch { /* A stop or failed writer may already have invalidated this receipt. */ }
        }
        throw error;
      }
      if (result.created) {
        const queue = this.signalPending.get(agentId) ?? [];
        queue.push(result.job.jobId); this.signalPending.set(agentId, queue); this.schedule();
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.preparing.get(agentId) === preparing) this.preparing.delete(agentId);
    }
  }

  private async chat(request: PrivateBrainRequest): Promise<PrivateBrainResponse> {
    let preparing: Active | undefined;
    try {
      if (this.closed) return privateBrainFailure(request, "closing");
      if (request.localProfileId !== this.options.localProfileId) return privateBrainFailure(request, "profile_conflict");
      if (request.instanceId !== this.options.instanceId) return privateBrainFailure(request, "instance_conflict");
      if (!this.options.agentIds.includes(request.agentId)) return privateBrainFailure(request, "unknown_agent");
      if (request.action !== "chat_create" && request.action !== "chat_read" && request.action !== "chat_cancel")
        return privateBrainFailure(request, "invalid_request");
      const preparingId = [...this.preparing.entries()].find(([, value]) => value.jobId === request.jobId);
      if (request.action === "chat_create") {
        if (preparingId) return privateBrainFailure(request, preparingId[0] === request.agentId ? "busy" : "job_conflict");
        if (this.preparing.has(request.agentId)) return privateBrainFailure(request, "busy");
        preparing = { jobId: request.jobId, abort: new AbortController() };
        this.preparing.set(request.agentId, preparing);
      } else if (preparingId) {
        if (preparingId[0] !== request.agentId) return privateBrainFailure(request, "job_not_found");
        if (request.action === "chat_read") return privateBrainFailure(request, "busy");
        preparingId[1].abort.abort();
      }
      if (request.action === "chat_cancel") {
        if (this.pending.get(request.agentId) === request.jobId) this.pending.delete(request.agentId);
        const active = this.active.get(request.agentId);
        if (active?.jobId === request.jobId) active.abort.abort();
      }
      const guard = (): void => {
        if (this.closed) throw new PrivateBrainStoreError("closing");
        this.options.assertAvailable();
        if (preparing && (preparing.abort.signal.aborted || this.preparing.get(request.agentId) !== preparing))
          throw new PrivateBrainStoreError("cancelled");
      };
      guard(); const store = await this.openStore(); guard();
      const operation = { signal: preparing?.abort.signal ?? this.storeAbort.signal, guard };
      if (request.action === "chat_read") return privateBrainSuccess(request, { job: await store.readAsync(request.agentId, request.jobId, operation) });
      if (request.action === "chat_cancel") return privateBrainSuccess(request, { job: await store.cancelAsync(request.agentId, request.jobId, operation) });
      if (request.action !== "chat_create") return privateBrainFailure(request, "invalid_request");
      // A secret pasted into chat never reaches the model or the job journal; the cockpit refuses it first and explains.
      if (privateSecretKind(request.text)) return privateBrainFailure(request, "invalid_request");
      // Resolve durable replay before consulting current model or busy state.
      // Passing revision zero cannot create anything when this ID is absent.
      try { return privateBrainSuccess(request, { job: await store.createAsync(request, 0, operation) }); }
      catch (error: unknown) { if (!(error instanceof PrivateBrainStoreError) || error.code !== "model_locked") throw error; }
      guard();
      if (this.pending.has(request.agentId) || this.active.has(request.agentId)
        || this.signalPending.has(request.agentId)) return privateBrainFailure(request, "busy");
      const state = this.options.readState(request.agentId);
      if (!state || state.lifecycle !== "idle") return privateBrainFailure(request, "cancelled");
      const model = this.models.current(request.agentId);
      const createGuard = (): void => {
        guard();
        const current = this.options.readState(request.agentId);
        if (!current || current.version !== state.version || current.lifecycle !== "idle"
          || this.models.current(request.agentId).revision !== model.revision
          || this.pending.has(request.agentId) || this.active.has(request.agentId)
          || this.signalPending.has(request.agentId)) throw new PrivateBrainStoreError("cancelled");
      };
      const job = await store.createAsync(request, model.revision, { ...operation, guard: createGuard });
      createGuard();
      const currentJob = store.read(request.agentId, request.jobId);
      if (currentJob.state !== "queued" || currentJob.generation !== job.generation) throw new PrivateBrainStoreError("cancelled");
      // No await between final post-commit checks and enqueue. Cancellation
      // during archive traversal is also fenced before the durable commit.
      this.pending.set(request.agentId, request.jobId); this.schedule();
      return privateBrainSuccess(request, { job });
    } catch (error: unknown) { return privateBrainFailure(request, this.error(error)); }
    finally { if (preparing && this.preparing.get(request.agentId) === preparing) this.preparing.delete(request.agentId); }
  }

  cancelAgent(agentId: string): void {
    const active = this.active.get(agentId);
    const signalId = this.signalPending.get(agentId)?.[0] ?? (active?.kind === "signal" ? active.jobId : undefined);
    this.credentialOperations.get(agentId)?.abort();
    this.preparing.get(agentId)?.abort.abort();
    this.pending.delete(agentId);
    this.signalPending.delete(agentId);
    this.active.get(agentId)?.abort.abort();
    // Invalidate the durable generation even if the transport ignores abort.
    this.store?.cancelAgent(agentId);
    if (signalId && this.store) {
      try { this.observedTerminal(this.store.readSignal(agentId, signalId)); } catch { /* Observation cannot change cancellation semantics. */ }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.storeAbort.abort();
    for (const preparing of this.preparing.values()) preparing.abort.abort();
    this.workingSetAbort.abort();
    for (const operation of this.credentialOperations.values()) operation.abort();
    for (const active of this.active.values()) active.abort.abort();
    this.pending.clear();
    this.signalPending.clear();
    this.models.close();
    for (const agent of this.options.agentIds) {
      try { this.store?.cancelAgent(agent); } catch { /* Corrupt storage stays unavailable. */ }
    }
    this.closePromise = Promise.allSettled([...this.inFlight, ...this.credentialWork, ...this.chatWork, ...this.signalWork, ...this.signalReads, ...this.autonomyWork, ...this.sizingWork,
      ...(this.storeOpen ? [this.storeOpen] : []), ...(this.workingSetOpen ? [this.workingSetOpen] : [])]).then(() => {
      this.vault?.close(); this.workingSet?.close(); this.store?.close(); this.budget?.close();
    });
    return this.closePromise;
  }

  /** The two password-derived credential operations never hold
   * the control queue; observed disconnect, lock, stop, replacement and shutdown fence
   * both the durable write and the later in-memory selection. */
  handleCredential(input: PrivateBrainRequest, signal?: AbortSignal): Promise<PrivateBrainResponse> {
    const request = Object.freeze({ ...parsePrivateBrainRequest(input) });
    const work = this.credential(request, signal);
    this.credentialWork.add(work);
    void work.then(() => this.credentialWork.delete(work), () => this.credentialWork.delete(work));
    return work;
  }

  private async credential(request: PrivateBrainRequest, signal?: AbortSignal): Promise<PrivateBrainResponse> {
    let operation: AbortController | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (this.closed) return privateBrainFailure(request, "closing");
      if (request.localProfileId !== this.options.localProfileId) return privateBrainFailure(request, "profile_conflict");
      if (request.instanceId !== this.options.instanceId) return privateBrainFailure(request, "instance_conflict");
      if (!this.options.agentIds.includes(request.agentId)) return privateBrainFailure(request, "unknown_agent");
      if (request.action !== "model_save" && request.action !== "model_unlock" && request.action !== "model_reselect") return privateBrainFailure(request, "invalid_request");
      if (this.credentialOperations.has(request.agentId)) return privateBrainFailure(request, "busy");
      if (this.models.state(request.agentId).revision !== request.expectedRevision) return privateBrainFailure(request, "revision_conflict");
      operation = new AbortController();
      this.credentialOperations.set(request.agentId, operation);
      onAbort = () => operation?.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) operation.abort();
      const guard = (): void => {
        if (this.closed) throw new PrivateBrainModelError("closing");
        if (operation?.signal.aborted || this.credentialOperations.get(request.agentId) !== operation) throw new PrivateModelVaultError("cancelled");
        this.options.assertAvailable();
        if (this.models.state(request.agentId).revision !== request.expectedRevision) throw new PrivateBrainModelError("revision_conflict");
      };
      guard();
      const vault = this.getVault();
      let selected: PrivateBrainModelConfig;
      if (request.action === "model_save") {
        selected = { provider: request.provider, model: request.model, apiKey: request.apiKey };
        await vault.save(request.agentId, request.expectedVaultRevision, selected, request.passphrase, operation.signal, guard);
      } else if (request.action === "model_reselect") {
        selected = await vault.reselect(request.agentId, request.expectedVaultRevision, request.model, request.passphrase, operation.signal, guard);
      } else {
        selected = await vault.unlock(request.agentId, request.expectedVaultRevision, request.passphrase, operation.signal, guard);
      }
      guard();
      const saved = vault.state(request.agentId);
      if (!saved.saved) throw new PrivateModelVaultError("vault_missing");
      // The selector's invalidation cancels older assistant jobs. This completed
      // credential operation is no longer pending and must not cancel itself.
      this.credentialOperations.delete(request.agentId);
      return this.modelResponse(request, this.models.configure(request.agentId, request.expectedRevision, selected,
        { source: "vault", vaultRevision: saved.revision }));
    } catch (error: unknown) { return privateBrainFailure(request, this.error(error)); }
    finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (operation && this.credentialOperations.get(request.agentId) === operation) this.credentialOperations.delete(request.agentId);
    }
  }

  private getStore(): PrivateBrainStore {
    // Active jobs are in the bounded current window. They never scan archives.
    if (!this.store) throw new PrivateBrainStoreError("state_unavailable");
    return this.store;
  }
  private openStore(): Promise<PrivateBrainStore> {
    if (this.closed) return Promise.reject(new PrivateBrainStoreError("closing"));
    // A single lifecycle-owned open validates committed history before restart
    // recovery. Status/model-only clients do not initialize the chat journal.
    this.storeOpen ??= PrivateBrainStore.open(this.options, { signal: this.storeAbort.signal }).then((store) => {
      if (this.closed) { store.close(); throw new PrivateBrainStoreError("closing"); }
      // An agent added while this open was in flight (the open copied the list before its first await).
      for (const agentId of this.agentList) store.addAgent(agentId);
      this.store = store; return store;
    });
    return this.storeOpen;
  }

  private getVault(): PrivateModelVault {
    if (this.vaultUnavailable) throw new PrivateModelVaultError("state_unavailable");
    if (!this.vault) {
      try { this.vault = new PrivateModelVault(this.options); }
      catch { this.vaultUnavailable = true; throw new PrivateModelVaultError("state_unavailable"); }
    }
    return this.vault;
  }
  private getBudget(): PrivateModelBudget {
    if (this.closed) throw new PrivateModelBudgetError("closing");
    if (this.budgetUnavailable) throw new PrivateModelBudgetError("state_unavailable");
    if (!this.budget) {
      try { this.budget = new PrivateModelBudget(this.options); }
      catch { this.budgetUnavailable = true; throw new PrivateModelBudgetError("state_unavailable"); }
    }
    return this.budget;
  }
  private getWorkingSet(): Promise<PrivateWorkingSetStore> {
    if (this.closed) return Promise.reject(new PrivateBrainStoreError("state_unavailable"));
    this.workingSetOpen ??= PrivateWorkingSetStore.open(this.options, { signal: this.workingSetAbort.signal }).then((store) => {
      if (this.closed) { store.close(); throw new PrivateBrainStoreError("state_unavailable"); }
      // An agent added while this open was in flight (the open copied the list before its first await).
      for (const agentId of this.agentList) store.addAgent(agentId);
      this.workingSet = store; return store;
    });
    return this.workingSetOpen;
  }
  private modelResponse(request: PrivateBrainRequest, model: PrivateBrainModelState): PrivateBrainResponse {
    let vault: PrivateBrainVaultState;
    try { vault = this.getVault().state(request.agentId); }
    catch { vault = { saved: "unavailable" }; }
    return privateBrainSuccess(request, { model, vault });
  }

  private schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closed) return;
      for (const agentId of new Set([...this.pending.keys(), ...this.signalPending.keys()])) {
        if (this.active.size >= 4) break;
        if (this.active.has(agentId)) continue;
        const chatId = this.pending.get(agentId);
        const signalQueue = this.signalPending.get(agentId);
        const jobId = chatId ?? signalQueue?.shift();
        if (!jobId) continue;
        if (chatId) this.pending.delete(agentId);
        else if (!signalQueue?.length) this.signalPending.delete(agentId);
        else { this.signalPending.delete(agentId); this.signalPending.set(agentId, signalQueue); }
        const active: Active = { jobId, abort: new AbortController(), ...(!chatId ? { kind: "signal" as const } : {}) };
        this.active.set(agentId, active);
        const work = (active.kind === "signal" ? this.runSignal(agentId, active) : this.run(agentId, active)).finally(() => {
          const queued = this.signalPending.get(agentId);
          if (queued) { this.signalPending.delete(agentId); this.signalPending.set(agentId, queued); }
          this.active.delete(agentId); this.inFlight.delete(work); this.schedule();
        });
        this.inFlight.add(work);
      }
    });
  }

  private assertSignalLease(receipt: PrivateSignalReceiptInput): Readonly<RunnerRuntimeActiveLease> {
    const lease = this.options.readLease?.(receipt.agentId);
    if (!lease || lease.frontendOrigin !== receipt.frontendOrigin || lease.agentId !== receipt.serverAgentId
      || lease.bindingDigest !== receipt.bindingDigest || lease.instanceId !== receipt.instanceId
      || lease.instanceId !== this.options.instanceId || lease.epoch !== receipt.epoch
      || !Number.isFinite(lease.remainingMs) || lease.remainingMs <= 0) throw new SignalHold("lease_unavailable");
    return lease;
  }

  private async runSignal(agentId: string, active: Active): Promise<void> {
    let generation: number | undefined;
    try {
      const store = this.getStore(); const received = store.readSignal(agentId, active.jobId);
      generation = received.generation;
      if (received.state !== "received") return;
      const receipt = received.receipt;
      this.assertSignalLease(receipt);
      // K4: a launchpad launch is a public observation; it is decided only for a subscribed, live launchpad (held otherwise).
      const launchpad = receipt.signal.platform === "launchpad";
      if (launchpad) {
        if (!this.options.launchpads) throw new SignalHold("launchpad_unavailable");
        await this.options.launchpads.prepare(agentId, receipt.bindingDigest, active.abort.signal);
        if (this.closed || active.abort.signal.aborted) return;
        if (!this.options.launchpads.admitted(agentId, receipt)) throw new SignalHold("launchpad_unavailable");
      }
      const runtime = this.options.readState(agentId);
      if (!runtime || runtime.lifecycle !== "idle" || runtime.mode === "paused") throw new SignalHold("runtime_disallowed");
      if (this.models.state(agentId).state !== "ready") throw new SignalHold("model_locked");
      if (!this.options.readConfirmedRules) throw new SignalHold("rules_missing");
      const rules = this.options.readConfirmedRules(agentId, receipt.signal.chain);
      if (!rules.revision || !rules.head.revisionId) throw new SignalHold("rules_missing");
      if (rules.head.state !== "compiled") throw new SignalHold("rules_held");
      const model = this.models.current(agentId);
      const sizingPolicy = store.sizingPolicy(agentId);
      const conversationId = "main";
      let phase: "received" | "running" = "received";
      const guard = (): void => {
        if (this.closed || active.abort.signal.aborted || this.active.get(agentId) !== active)
          throw new PrivateBrainStoreError("cancelled");
        this.options.assertAvailable();
        const currentJob = store.readSignal(agentId, active.jobId);
        if (currentJob.state !== phase || currentJob.generation !== generation
          || this.models.current(agentId).revision !== model.revision) throw new PrivateBrainStoreError("cancelled");
        const currentRuntime = this.options.readState(agentId);
        if (!currentRuntime || currentRuntime.version !== runtime.version || currentRuntime.lifecycle !== "idle"
          || currentRuntime.mode !== runtime.mode) throw new SignalHold("runtime_changed");
        this.assertSignalLease(receipt);
        if (this.options.readConfirmedRules!(agentId, receipt.signal.chain).head.revisionId !== rules.head.revisionId)
          throw new SignalHold("rules_changed");
        if ((store.sizingPolicy(agentId)?.digest ?? null) !== (sizingPolicy?.digest ?? null)) throw new SignalHold("sizing_policy_changed");
        const now = Date.now();
        if (now >= Date.parse(receipt.signal.sourceHealthFreshUntil)) throw new SignalHold("source_stale");
        const age = now - Date.parse(receipt.signal.observedAt);
        if (age < 0) throw new SignalHold("signal_future");
        if (age >= SIGNAL_MAX_AGE_MS) throw new SignalHold("signal_stale");
        if (launchpad && !this.options.launchpads?.admitted(agentId, receipt)) throw new SignalHold("launchpad_unavailable");
      };
      guard();
      // The first autonomous use may validate historical reservations. Neither
      // readback nor configuring a model initializes or resets this accounting.
      try {
        await store.prepareAutonomyAsync(agentId, Date.now(), { signal: active.abort.signal, guard });
        guard();
        const allowance = store.checkSignalAllowance(agentId, active.jobId, Date.now());
        if (!allowance.allowed) throw new SignalHold(allowance.reason);
        // Not even one decision's output fits today's AI budget: hold before any research fetch or call debit.
        this.checkModelBudget(agentId, []);
      } catch (error: unknown) { throw allowanceHold(error); }
      guard();
      const started = store.startSignal(agentId, active.jobId, generation, { modelRevision: model.revision,
        runtimeVersion: runtime.version, ruleRevisionId: rules.head.revisionId, conversationId,
        planVersion: 1, sizingPolicyDigest: sizingPolicy?.digest ?? null });
      generation = started.generation; phase = "running"; active.started = true;
      guard();
      const request: RunnerResearchRequest = { kind: "candidate_report", chain: receipt.signal.chain,
        assetId: receipt.signal.assetId, includeX: false, includeOnchain: true };
      if (!this.options.researchReceipt) throw new PrivateConversationError("research_unavailable");
      const requestDigest = runnerResearchRequestDigest(request);
      const queryScope = { localAgentId: agentId, conversationId };
      const working = await this.getWorkingSet(); guard();
      let research: PrivateResearchReceipt;
      try { research = await this.options.researchReceipt(agentId, request, active.abort.signal); }
      catch {
        guard();
        await working.appendFailureAsync({ ...queryScope, jobId: active.jobId, requestId: requestDigest,
          request, failedAt: new Date().toISOString(), reason: "transport_unavailable" }, guard, active.abort.signal);
        throw new PrivateConversationError("research_unavailable");
      }
      guard();
      const lease = this.assertSignalLease(receipt);
      const target = research.expectedTarget;
      if (target.frontendOrigin !== receipt.frontendOrigin || target.agentId !== receipt.serverAgentId
        || target.bindingDigest !== receipt.bindingDigest || target.instanceId !== receipt.instanceId
        || target.epoch !== receipt.epoch || target.runnerPublicKey !== lease.runnerPublicKey
        || runnerResearchRequestDigest(target.request) !== requestDigest || research.response.requestDigest !== requestDigest) {
        await working.appendFailureAsync({ ...queryScope, jobId: active.jobId, requestId: requestDigest,
          request, failedAt: new Date().toISOString(), reason: "invalid_response" }, guard, active.abort.signal);
        throw new PrivateConversationError("research_unavailable");
      }
      try { await working.appendAsync({ ...queryScope, jobId: active.jobId, requestId: requestDigest, receipt: research }, guard, active.abort.signal); }
      catch (error: unknown) {
        if (error instanceof PrivateWorkingSetError && error.code === "invalid_evidence") {
          guard();
          await working.appendFailureAsync({ ...queryScope, jobId: active.jobId, requestId: requestDigest,
            request, failedAt: new Date().toISOString(), reason: "invalid_response" }, guard, active.abort.signal);
        }
        throw error;
      }
      guard();
      const asset = assetRef(receipt.signal.chain, receipt.signal.assetId);
      const scope = { localProfileId: this.options.localProfileId, agentId, conversationId };
      const content = { signalId: receipt.signal.eventId, chain: asset.chain, assetId: asset.assetId, refId: asset.refId,
        observedAt: receipt.signal.observedAt, source: { platform: receipt.signal.platform, sourceId: receipt.signal.sourceId } };
      const observation: PrivateOuterSignal = { ...content, digest: privateOuterSignalDigest(scope, content) };
      const select = async (): Promise<WorkingSetSelection> => {
        guard(); const checkpoint = working.captureCheckpointGuard();
        const selection = await working.selectAsync(queryScope, { kind: "refId", refId: asset.refId }, Date.now(),
          { signal: active.abort.signal, guard });
        guard(); checkpoint(); return selection;
      };
      // K1: the top-N holder shares a typed rule needs, read once (both sources in agreement) and reused by every evaluation below.
      const holderCounts = privateTopHolderCounts(rules.revision.rules);
      let holderShares: PrivateHolderShares | undefined;
      if (holderCounts.length) {
        let reader: PrivateHolderShareReader | undefined;
        try { reader = this.options.readEntryRpc?.(agentId); } catch { reader = undefined; }
        holderShares = await readPrivateHolderShares(reader, asset.assetId, holderCounts, active.abort.signal);
        guard();
      }
      const prefilter = (selection: WorkingSetSelection) => evaluatePrivateOuterPrefilter({ scope, signal: observation,
        runtime: this.options.readState(agentId)!, expectedRuntimeVersion: runtime.version,
        rules: this.options.readConfirmedRules!(agentId, asset.chain), expectedRevisionId: rules.head.revisionId,
        selection, nowMs: Date.now(), maximumSignalAgeMs: SIGNAL_MAX_AGE_MS, ...(holderShares ? { holderShares } : {}) });
      const selection = await select(); const admission = prefilter(selection);
      if (admission.state !== "passed") throw new SignalHold(admission.reasons[0] ?? "evidence_held");
      guard();
      const contextCheckpoint = working.captureCheckpointGuard();
      const view = await working.readAsync(queryScope, Date.now(), { focusRefIds: [asset.refId] }, { signal: active.abort.signal, guard });
      guard(); contextCheckpoint();
      const context = projectWorkingContext({ scope: { localProfileId: scope.localProfileId, ...queryScope },
        view, selection, nowMs: Date.now() });
      const beforeModel = prefilter(selection);
      if (context.selection?.kind !== "resolved" || beforeModel.state !== "passed")
        throw new SignalHold(beforeModel.state === "held" ? beforeModel.reasons[0] ?? "evidence_held" : "evidence_held");
      // An oversized context keeps its existing failure in the call itself; only the budget is checked here.
      let decisionMessages: LlmMessage[] | undefined;
      try { decisionMessages = privateSignalDecisionMessages({ observation, revision: rules.revision, context }); }
      catch { decisionMessages = undefined; }
      // Durable debit precedes the actual provider invocation. An ambiguous
      // write, cancellation or failed call cannot refund it or trigger replay.
      try {
        guard();
        const allowance = store.checkSignalAllowance(agentId, active.jobId, Date.now());
        if (!allowance.allowed) throw new SignalHold(allowance.reason);
        // The exact decision estimate must fit today's AI budget before the call allowance is debited.
        if (decisionMessages) this.checkModelBudget(agentId, decisionMessages);
        const reserved = store.reserveSignalCall(agentId, active.jobId, generation,
          { policyRevision: allowance.policyRevision, admission: beforeModel.binding, nowMs: Date.now() },
          { signal: active.abort.signal, guard });
        if (!reserved.created) throw new SignalHold("call_allowance_unavailable");
        generation = reserved.job.generation;
      } catch (error: unknown) { throw allowanceHold(error); }
      guard();
      let decision: Awaited<ReturnType<typeof requestPrivateSignalDecision>>;
      // The metered adapter refuses without a provider call when the budget changed since the check above.
      try { decision = await requestPrivateSignalDecision({ adapter: model.adapter, signal: active.abort.signal,
        observation, revision: rules.revision, context }); }
      catch (error: unknown) { throw error instanceof PrivateModelBudgetError ? allowanceHold(error) : error; }
      guard();
      const current = prefilter(await select());
      if (current.state !== "passed") throw new SignalHold(current.reasons[0] ?? "evidence_held");
      if (JSON.stringify(current.binding) !== JSON.stringify(admission.binding)) throw new SignalHold("evidence_mismatch");
      guard();
      const plan = buildPrivateSignalPlan({ receipt, start: started.start!, decision, admission: current.binding,
        jobId: active.jobId, runtime, rules, policy: sizingPolicy, nowMs: Date.now() });
      guard();
      const assessment = plan.state === "resolved" && this.options.assessmentReceipt
        ? await this.assessSignalPlan(agentId, receipt, plan, guard, active.abort.signal) : undefined;
      guard();
      const result: PrivateSignalResult = { decision, admission: current.binding, plan };
      // Only the bounded record may degrade: the full projection, then an explicit failure, then none.
      const attempts: (PrivateSignalAssessment | undefined)[] = assessment === undefined ? [undefined]
        : assessment.outcome === "complete" || assessment.outcome === "unavailable"
          ? [assessment, privateSignalAssessmentFailure(plan, "record_unrepresentable", new Date().toISOString()), undefined] : [assessment, undefined];
      for (const [index, attempt] of attempts.entries()) {
        try {
          guard();
          const completed = store.completeSignal(agentId, active.jobId, generation, attempt ? { ...result, assessment: attempt } : result);
          this.observedTerminal(completed);
          try { this.options.onSignalCompleted?.(completed); } catch { /* The completed record stands; a lost admission is never retried, so it never executes. */ }
          break;
        } catch (error: unknown) {
          // A codec size rejection happens before commit; any other failure keeps existing semantics.
          if (index === attempts.length - 1 || !(error instanceof PrivateBrainStoreError) || error.code !== "invalid_result") throw error;
        }
      }
    } catch (error: unknown) {
      if (this.closed || active.abort.signal.aborted || generation === undefined) return;
      try {
        if (error instanceof SignalHold) this.observedTerminal(this.getStore().holdSignal(agentId, active.jobId, generation, error.reason));
        else if (this.getStore().readSignal(agentId, active.jobId).state === "received")
          this.observedTerminal(this.getStore().holdSignal(agentId, active.jobId, generation, "admission_unavailable"));
        else this.observedTerminal(this.getStore().failSignal(agentId, active.jobId, generation,
          error instanceof PrivateSignalModelError ? error.code
            : error instanceof PrivateConversationError || error instanceof PrivateWorkingSetError ? "research_unavailable" : "invalid_result"));
      } catch { /* Changed, cancelled or corrupt state cannot accept a late decision. */ }
    }
  }

  /** One fresh read for exactly this plan. Assessment problems are recorded, never promoted to a job
   * failure; the job guard and signal lease still drop late results under existing semantics. */
  private async assessSignalPlan(agentId: string, receipt: PrivateSignalReceiptInput, plan: PrivateSignalPlan,
    guard: () => void, signal: AbortSignal): Promise<PrivateSignalAssessment> {
    const derived = privateSignalAssessmentRequest(plan);
    if ("reason" in derived) return privateSignalAssessmentNotRequested(plan, derived.reason);
    const failed = (reason: PrivateAssessmentFailureReason): PrivateSignalAssessment =>
      privateSignalAssessmentFailure(plan, reason, new Date().toISOString());
    guard();
    // Same clock and fields as guard(): the read may not consume the source-health or signal freshness window the commit still needs.
    const at = Date.now();
    const budget = Math.min(ASSESSMENT_MAX_MS, Date.parse(receipt.signal.sourceHealthFreshUntil) - at - ASSESSMENT_MARGIN_MS,
      Date.parse(receipt.signal.observedAt) + SIGNAL_MAX_AGE_MS - at - ASSESSMENT_MARGIN_MS);
    if (!(budget >= ASSESSMENT_MARGIN_MS)) return failed("deadline_insufficient");
    // The bound is also enforced here: a transport seam that ignores the timeout argument still cannot outlive it.
    const bounded = new AbortController(); const relay = (): void => bounded.abort();
    if (signal.aborted) relay(); else signal.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(relay, Math.floor(budget)); timer.unref();
    let assessed: PrivateAssessmentReceipt;
    try { assessed = await this.options.assessmentReceipt!(agentId, structuredClone(derived.request), bounded.signal, Math.floor(budget)); }
    catch (error: unknown) {
      guard();
      return failed(error instanceof PrivateAssessmentError && error.code === "invalid_response" ? "invalid_response" : "transport_unavailable");
    }
    finally { clearTimeout(timer); signal.removeEventListener("abort", relay); }
    guard();
    const lease = this.assertSignalLease(receipt);
    try {
      const target = assessed.expectedTarget; const response = assessed.response;
      if (target.frontendOrigin !== receipt.frontendOrigin || target.agentId !== receipt.serverAgentId
        || target.bindingDigest !== receipt.bindingDigest || target.instanceId !== receipt.instanceId
        || target.epoch !== receipt.epoch || target.runnerPublicKey !== lease.runnerPublicKey
        || runnerAssessmentRequestDigest(target.request) !== derived.requestDigest || response.requestDigest !== derived.requestDigest
        || response.agentId !== receipt.serverAgentId || response.bindingDigest !== receipt.bindingDigest
        || response.instanceId !== receipt.instanceId || response.epoch !== receipt.epoch) return failed("invalid_response");
      return privateSignalAssessmentEvidence(plan, response, assessed.receivedAt);
    } catch { return failed("invalid_response"); }
  }

  private async run(agentId: string, active: Active): Promise<void> {
    let generation: number | undefined;
    try {
      const model = this.models.current(agentId);
      const work = this.getStore().start(agentId, active.jobId);
      generation = work.job.generation;
      if (model.revision !== work.job.modelRevision) { this.getStore().cancel(agentId, active.jobId); return; }
      const guard = (signal: AbortSignal): void => this.assertJobCurrent(agentId, active, model.revision, work.job.generation, signal);
      // The current CLI exposes one private conversation per local agent. This
      // stable ID survives daemon instances without mixing agents or profiles.
      const scope = { localProfileId: this.options.localProfileId, localAgentId: agentId, conversationId: "main" };
      const queryScope = { localAgentId: agentId, conversationId: scope.conversationId };
      const history = await this.getStore().historyAsync(agentId, 8, { signal: active.abort.signal, guard: () => guard(active.abort.signal) });
      guard(active.abort.signal);
      let reply: string;
      try { reply = await runPrivateConversation({ text: work.text, history,
        adapter: model.adapter, signal: active.abort.signal,
        research: async (request, signal) => {
          guard(signal);
          if (!this.options.researchReceipt) {
            if (!this.options.research) throw new PrivateConversationError("research_unavailable");
            return this.options.research(agentId, request, signal);
          }
          const expectedDigest = runnerResearchRequestDigest(request);
          const recordedRequest = structuredClone(request);
          const recordFailure = async (reason: "transport_unavailable" | "invalid_response"): Promise<void> => {
            guard(signal);
            const store = await this.getWorkingSet(); guard(signal);
            await store.appendFailureAsync({ ...queryScope, jobId: active.jobId, requestId: expectedDigest,
              request: recordedRequest, failedAt: new Date().toISOString(), reason }, () => guard(signal), signal);
          };
          let receipt: PrivateResearchReceipt;
          try { receipt = await this.options.researchReceipt(agentId, structuredClone(recordedRequest), signal); }
          catch { await recordFailure("transport_unavailable"); throw new PrivateConversationError("research_unavailable"); }
          guard(signal);
          if (receipt.response.requestDigest !== expectedDigest
            || runnerResearchRequestDigest(receipt.expectedTarget.request) !== expectedDigest) {
            await recordFailure("invalid_response"); throw new PrivateConversationError("research_unavailable");
          }
          try {
            const store = await this.getWorkingSet(); guard(signal);
            await store.appendAsync({ ...queryScope, jobId: active.jobId, requestId: expectedDigest, receipt }, () => guard(signal), signal);
          }
          catch (error: unknown) {
            if (error instanceof PrivateWorkingSetError && error.code === "invalid_evidence") await recordFailure("invalid_response");
            throw error;
          }
          return receipt.response;
        },
        ...(this.options.researchReceipt ? { context: {
          read: async (signal: AbortSignal) => {
            guard(signal); const store = await this.getWorkingSet(); guard(signal);
            const checkpoint = store.captureCheckpointGuard();
            const view = await store.readAsync(queryScope, Date.now(), {}, { signal, guard: () => guard(signal) });
            guard(signal); checkpoint();
            return renderWorkingContext({ scope, view, nowMs: Date.now() });
          },
          select: async (selector: WorkingSetSelector, signal: AbortSignal) => {
            guard(signal); const store = await this.getWorkingSet(); guard(signal);
            const checkpoint = store.captureCheckpointGuard();
            const selection = await store.selectAsync(queryScope, selector, Date.now(), { signal, guard: () => guard(signal) });
            const view = await store.readAsync(queryScope, Date.now(), selector.kind === "refId" ? { focusRefIds: [selector.refId] } : {},
              { signal, guard: () => guard(signal) });
            guard(signal); checkpoint();
            const projected = projectWorkingContext({ scope, view, selection, nowMs: Date.now() });
            const currentSelection: WorkingSetSelection = projected.selection?.kind === "unresolved"
              ? { ...projected.selection, executionAuthority: "not_authorized_by_report" } : selection;
            return { selection: currentSelection, context: JSON.stringify(projected) };
          },
        } } : {}),
        ...(this.options.readSetup ? { setup: {
          read: async (signal: AbortSignal) => {
            this.assertJobCurrent(agentId, active, model.revision, work.job.generation, signal);
            return this.options.readSetup!(agentId, signal);
          },
        } } : {}),
        ...(this.options.spendCaps ? { spendCaps: { agentId,
          propose: (caps: PrivateCapProposalInput, signal: AbortSignal) => {
            this.assertJobCurrent(agentId, active, model.revision, work.job.generation, signal);
            return this.options.spendCaps!.propose(agentId, caps);
          },
        } } : {}),
        ...(this.options.rules ? { rules: { agentId,
          read: (chain: "solana" | "base", signal: AbortSignal) => {
            this.assertJobCurrent(agentId, active, model.revision, work.job.generation, signal);
            return this.options.rules!.read(agentId, chain);
          },
          propose: (view: ConversationRuleView, source: string, signal: AbortSignal) => {
            this.assertJobCurrent(agentId, active, model.revision, work.job.generation, signal);
            return this.options.rules!.propose(active.jobId, view, source);
          },
        } } : {}),
      }); } catch (error: unknown) {
        // The daily AI budget refused a model call before the provider was reached: the owner gets a short answer.
        if (!(error instanceof PrivateModelBudgetError) || (error.code !== "model_budget_exhausted" && error.code !== "clock_rollback")) throw error;
        reply = privateModelBudgetReply(agentId, error);
      }
      if (this.closed || active.abort.signal.aborted || this.models.current(agentId).revision !== model.revision) return;
      this.getStore().complete(agentId, active.jobId, generation, reply);
    } catch (error: unknown) {
      if (this.closed || active.abort.signal.aborted || generation === undefined) return;
      try { this.getStore().fail(agentId, active.jobId, generation,
        error instanceof PrivateConversationError ? error.code
          : error instanceof PrivateWorkingSetError ? "research_unavailable"
            : error instanceof PrivateModelBudgetError ? "provider_unavailable" : "invalid_result"); }
      catch { /* A cancelled, changed or corrupt journal cannot accept late output. */ }
    }
  }

  private assertJobCurrent(agentId: string, active: Active, revision: number, generation: number, signal: AbortSignal): void {
    if (this.closed || signal.aborted || active.abort.signal.aborted || this.active.get(agentId) !== active
      || this.models.current(agentId).revision !== revision) throw new PrivateBrainStoreError("cancelled");
    this.options.assertAvailable();
    const job = this.getStore().read(agentId, active.jobId);
    if (job.state !== "running" || job.generation !== generation) throw new PrivateBrainStoreError("cancelled");
  }

  private error(error: unknown): PrivateBrainErrorCode {
    return error instanceof PrivateBrainStoreError || error instanceof PrivateBrainModelError || error instanceof PrivateModelVaultError ? error.code : "state_unavailable";
  }
}
