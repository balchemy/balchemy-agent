/** Immutable descriptive previews under the existing daemon writer. No execution adapter. */
import { OwnedJsonSnapshot, OwnedJsonSnapshotError } from "./owned-json-snapshot.js";
import { exactKeys, isRecord, type RunnerAgentState } from "./protocol.js";
import { buildPrivateSolanaIntentPreview, parsePrivateSolanaIntentPreview, PrivateSolanaPreviewError,
  type PrivateSolanaIntentPreview } from "./private-solana-intent-preview.js";
import { parsePrivateIntentRequest, privateIntentFailure, privateIntentSuccess,
  type PrivateIntentRequest, type PrivateIntentResponse } from "./private-intent-protocol.js";
import type { PrivateRuleService } from "./private-rule-service.js";
import type { WorkingSetSelection } from "./private-working-set.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_INTENT_FILE = "private-intent-previews.json";
export const PRIVATE_INTENT_MARKER = "private-intent-previews.initialized";
const MAX_PREVIEWS = 128;
interface Snapshot { schemaVersion: 1; localProfileId: string; previews: PrivateSolanaIntentPreview[] }
interface Options {
  directory: string; localProfileId: string; instanceId: string; agentIds: readonly string[];
  assertAvailable(): void;
  readRuntime(agentId: string): RunnerAgentState | undefined;
  readRules(agentId: string): ReturnType<PrivateRuleService["readConfirmedRevision"]>;
  readEvidence(agentId: string, refId: string, nowMs: number, signal: AbortSignal): Promise<{
    selection: WorkingSetSelection; assertCurrent(): void;
  }>;
}
function sameRequest(a: PrivateSolanaIntentPreview["request"], b: PrivateSolanaIntentPreview["request"]): boolean {
  return a.intentId === b.intentId && a.expectedRuntimeVersion === b.expectedRuntimeVersion && a.expectedRevisionId === b.expectedRevisionId
    && a.refId === b.refId && a.amountSol === b.amountSol && a.slippageBps === b.slippageBps;
}
export class PrivateIntentService {
  private storage?: OwnedJsonSnapshot<Snapshot>;
  private closed = false;
  private unavailable = false;
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<PrivateIntentResponse>>();
  private preparing?: { intentId: string; agentId: string };
  private closePromise?: Promise<void>;
  private readonly options: Options;
  private readonly agentList: string[];
  constructor(options: Options) { this.agentList = [...options.agentIds]; this.options = { ...options, agentIds: this.agentList }; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.agentList, agentId); }
  handle(input: PrivateIntentRequest): Promise<PrivateIntentResponse> {
    const request = parsePrivateIntentRequest(input);
    const work = this.perform(request);
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  private async perform(request: PrivateIntentRequest): Promise<PrivateIntentResponse> {
    let admitted = false;
    try {
      if (this.closed) return privateIntentFailure(request, "closing");
      if (request.localProfileId !== this.options.localProfileId) return privateIntentFailure(request, "profile_conflict");
      if (request.instanceId !== this.options.instanceId) return privateIntentFailure(request, "instance_conflict");
      if (!this.options.agentIds.includes(request.agentId)) return privateIntentFailure(request, "unknown_agent");
      this.options.assertAvailable();
      const storage = this.getStorage(); const snapshot = storage.read();
      const intentId = request.action === "preview" ? request.request.intentId : request.intentId;
      const previous = snapshot.previews.find((item) => item.request.intentId === intentId);
      if (previous && (previous.scope.agentId !== request.agentId || (request.action === "preview" && !sameRequest(previous.request, request.request))))
        return privateIntentFailure(request, "intent_conflict");
      // A lost ACK resolves to the original immutable result, even after restart,
      // rule changes or a pause. It is never silently recomputed or submitted.
      if (!previous && request.action === "read" && this.preparing?.intentId === intentId)
        return privateIntentFailure(request, this.preparing.agentId === request.agentId ? "busy" : "intent_conflict");
      if (previous || request.action === "read") return privateIntentSuccess(request, previous ?? null);
      // One detached history scan at a time for this owner profile. Socket
      // disconnects cannot create an unbounded queue; historical reads stay open.
      if (this.preparing) return privateIntentFailure(request, "busy");
      this.preparing = { intentId, agentId: request.agentId }; admitted = true;
      if (snapshot.previews.length >= MAX_PREVIEWS) return privateIntentFailure(request, "journal_full");
      const beforeRuntime = this.options.readRuntime(request.agentId);
      if (!beforeRuntime) return privateIntentFailure(request, "state_unavailable");
      if (beforeRuntime.version !== request.request.expectedRuntimeVersion) return privateIntentFailure(request, "runtime_conflict");
      if (this.options.readRules(request.agentId).head.revisionId !== request.request.expectedRevisionId)
        return privateIntentFailure(request, "revision_conflict");
      const evidence = await this.options.readEvidence(request.agentId, request.request.refId, Date.now(), this.abort.signal);
      if (this.closed) return privateIntentFailure(request, "closing");
      this.options.assertAvailable(); evidence.assertCurrent();
      // Async history yields to controls and other previews. Resolve duplicates
      // again and append to the current journal, never overwrite another result.
      const current = storage.read(); const concurrent = current.previews.find((item) => item.request.intentId === intentId);
      if (concurrent) return concurrent.scope.agentId === request.agentId && sameRequest(concurrent.request, request.request)
        ? privateIntentSuccess(request, concurrent) : privateIntentFailure(request, "intent_conflict");
      if (current.previews.length >= MAX_PREVIEWS) return privateIntentFailure(request, "journal_full");
      const runtime = this.options.readRuntime(request.agentId);
      if (!runtime) return privateIntentFailure(request, "state_unavailable");
      const nowMs = Date.now();
      const preview = buildPrivateSolanaIntentPreview({
        scope: { localProfileId: request.localProfileId, agentId: request.agentId, instanceId: request.instanceId },
        request: request.request, runtime, rules: this.options.readRules(request.agentId),
        selection: evidence.selection, nowMs,
      });
      // Validate the response envelope before committing, never ACK an
      // untransportable result. Final capability checks/build/commit have no await.
      const response = privateIntentSuccess(request, preview);
      this.options.assertAvailable(); evidence.assertCurrent();
      storage.commit({ ...current, previews: [...current.previews, preview] });
      return response;
    } catch (error: unknown) {
      return privateIntentFailure(request, error instanceof PrivateSolanaPreviewError ? error.code
        : error instanceof OwnedJsonSnapshotError && error.code === "snapshot_too_large" ? "journal_full" : "state_unavailable");
    } finally { if (admitted) this.preparing = undefined; }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.abort.abort();
    this.closePromise = Promise.allSettled([...this.pending]).then(() => this.storage?.close());
    return this.closePromise;
  }
  private getStorage(): OwnedJsonSnapshot<Snapshot> {
    if (this.unavailable) throw new Error("Private intents unavailable");
    if (!this.storage) {
      try {
        this.storage = new OwnedJsonSnapshot({ directory: this.options.directory, snapshotFile: PRIVATE_INTENT_FILE,
          markerFile: PRIVATE_INTENT_MARKER, marker: { schemaVersion: 1, localProfileId: this.options.localProfileId },
          initial: { schemaVersion: 1, localProfileId: this.options.localProfileId, previews: [] }, maximumBytes: 2 * 1024 * 1024,
          assertAvailable: () => this.options.assertAvailable(), decode: (value) => {
            if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId", "previews"]) || value.schemaVersion !== 1
              || value.localProfileId !== this.options.localProfileId || !Array.isArray(value.previews) || value.previews.length > MAX_PREVIEWS)
              throw new Error("Invalid private intent state");
            const previews = value.previews.map(parsePrivateSolanaIntentPreview);
            if (previews.some((item) => item.scope.localProfileId !== this.options.localProfileId || !this.options.agentIds.includes(item.scope.agentId))
              || new Set(previews.map((item) => item.request.intentId)).size !== previews.length) throw new Error("Invalid private intent scope");
            return { schemaVersion: 1, localProfileId: this.options.localProfileId, previews };
          } });
      } catch { this.unavailable = true; throw new Error("Private intents unavailable"); }
    }
    return this.storage;
  }
}
