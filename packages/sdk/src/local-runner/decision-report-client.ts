import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText } from "../utils/redaction";
import type { RunnerRuntimeTarget } from "./runtime-client";
import { base64, cancelledFor, exactWith, HEX, invalidFor, matches, pinTarget, positive, proofHttpClient, proofNonceMessage,
  sha256, signWithin, solanaAddress, targetPart, TARGET_KEYS, timestampWith, validateProofNonce, waitFor, type ExactFn,
  type RunnerProofNonce } from "./runner-proof-transport";

export type RunnerDecisionReportTarget = RunnerRuntimeTarget;
export const RUNNER_DECISION_ACTIONS = ["buy", "sell", "hold", "skip"] as const;
export type RunnerDecisionAction = typeof RUNNER_DECISION_ACTIONS[number];
/** Closed hold reasons, identical to the backend list. `other` stands for a runner reason this list does not name yet. */
export const RUNNER_DECISION_HOLD_REASONS = [
  "scope_mismatch", "runtime_changed", "runtime_disallowed", "signal_future", "signal_stale",
  "rules_changed", "rules_missing", "rules_held", "rules_invalid", "evidence_unresolved", "evidence_missing",
  "evidence_held", "evidence_mismatch", "entry_facts_missing", "entry_signals_missing", "entry_rule_failed",
  "strategy_facts_missing", "model_locked", "source_stale", "lease_unavailable", "admission_unavailable",
  "daily_call_limit", "token_cooldown", "legacy_usage_unknown", "clock_rollback", "call_allowance_unavailable", "sizing_policy_changed",
  "provider_unavailable", "research_unavailable", "invalid_result", "other",
] as const;
export type RunnerDecisionHoldReason = typeof RUNNER_DECISION_HOLD_REASONS[number];
/** The whole report (owner decision of 11 Nov 2026): no rationale, amount, prompt or credential field exists.
 * holdReason is non-null only with `hold`. */
export interface RunnerDecisionReport {
  version: 1; eventId: string; assetId: string; action: RunnerDecisionAction; holdReason: RunnerDecisionHoldReason | null; decidedAt: string;
}
export type RunnerDecisionReportExpectedTarget = RunnerDecisionReportTarget & { epoch: number; report: RunnerDecisionReport };
export type RunnerDecisionReportNonce = RunnerProofNonce<"balchemy.local-agent.decision-report.v1">;
export interface RunnerDecisionReportReceipt { version: 1; requestDigest: string; agentId: string; eventId: string; receivedAt: string }
/** Runner key: sign only runnerDecisionReportNonceMessage after independently checking this context. Base64, 64 bytes. */
export type RunnerDecisionReportSigner = (nonce: Readonly<RunnerDecisionReportNonce>, expected: RunnerDecisionReportExpectedTarget) => string | Promise<string>;
export interface RunnerDecisionReportClientConfig extends RunnerDecisionReportTarget {
  apiBaseUrl: string; signer: RunnerDecisionReportSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/decision-reports";
const PURPOSE = "balchemy.local-agent.decision-report.v1" as const;
const REQUEST_PURPOSE = "balchemy.local-agent.decision-report.request.v1";
const REPORT_KEYS = ["version", "eventId", "assetId", "action", "holdReason", "decidedAt"] as const;
const EVENT_ID = /^lsi_[0-9a-f]{64}$/;
const MAX_PAYLOAD_BYTES = 2048;
/** A 409 body is read only to find its bounded reason; anything larger is not a reason this client knows. */
const MAX_CONFLICT_BYTES = 8192;
/** The backend accepts a decidedAt up to 60 s ahead of its clock (LOCAL_AGENT_DECISION_REPORT_SKEW_MS); the receipt time is
 * informational, so a runner clock that far behind the server must not turn a stored report into a failed send. */
export const RUNNER_DECISION_REPORT_RECEIPT_SKEW_MS = 60_000;
/** `details.reason` of a 409 (the backend's global error filter keeps only generic codes). A report conflict is permanent: a
 * different report is already recorded for this eventId and is never overwritten. A lease conflict is transient. Surfaced as
 * AgentSdkError.machineCode with status 409; a 409 without a known reason keeps the generic machine code. */
export const RUNNER_DECISION_REPORT_CONFLICT = "DECISION_REPORT_CONFLICT";
export const RUNNER_DECISION_REPORT_LEASE_CONFLICT = "DECISION_REPORT_LEASE_CONFLICT";
const CONFLICT_REASONS: readonly string[] = [RUNNER_DECISION_REPORT_CONFLICT, RUNNER_DECISION_REPORT_LEASE_CONFLICT];
const invalid: () => never = invalidFor("decision report");
const cancelled = cancelledFor("decision report");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);

/** Closed validation of one report; anything outside the six bounded fields is refused before it can be sent. */
export function validateRunnerDecisionReport(value: unknown): Readonly<RunnerDecisionReport> {
  exact(value, REPORT_KEYS);
  if (value.version !== 1 || !matches(value.eventId, EVENT_ID) || !solanaAddress(value.assetId)
    || !RUNNER_DECISION_ACTIONS.includes(value.action as RunnerDecisionAction)) invalid();
  if (value.holdReason !== null && (value.action !== "hold"
    || !RUNNER_DECISION_HOLD_REASONS.includes(value.holdReason as RunnerDecisionHoldReason))) invalid();
  timestamp(value.decidedAt);
  return Object.freeze({ version: 1, eventId: value.eventId as string, assetId: value.assetId as string, action: value.action as RunnerDecisionAction,
    holdReason: value.holdReason as RunnerDecisionHoldReason | null, decidedAt: value.decidedAt as string });
}
export function runnerDecisionReportRequestDigest(value: RunnerDecisionReport): string {
  const report = validateRunnerDecisionReport(value);
  return sha256([REQUEST_PURPOSE, ...REPORT_KEYS.map((key) => report[key])]);
}
function expected(value: RunnerDecisionReportExpectedTarget): RunnerDecisionReportExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "report"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch, report: validateRunnerDecisionReport(value.report) });
}
export function validateRunnerDecisionReportNonce(value: unknown, expectedTarget: RunnerDecisionReportExpectedTarget, now = Date.now()): RunnerDecisionReportNonce {
  const pinned = expected(expectedTarget);
  return validateProofNonce(value, pinned, PURPOSE, "decision-reports/submit", runnerDecisionReportRequestDigest(pinned.report), now, invalid);
}
export function runnerDecisionReportNonceMessage(value: RunnerDecisionReportNonce, expectedTarget: RunnerDecisionReportExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerDecisionReportNonce(value, expectedTarget, now));
}
export function validateRunnerDecisionReportReceipt(value: unknown, expectedTarget: RunnerDecisionReportExpectedTarget, now = Date.now()): RunnerDecisionReportReceipt {
  const pinned = expected(expectedTarget);
  exact(value, ["version", "requestDigest", "agentId", "eventId", "receivedAt"]);
  if (!Number.isFinite(now) || value.version !== 1 || !matches(value.requestDigest, HEX)
    || value.requestDigest !== runnerDecisionReportRequestDigest(pinned.report) || value.agentId !== pinned.agentId
    || value.eventId !== pinned.report.eventId || timestamp(value.receivedAt) > now + RUNNER_DECISION_REPORT_RECEIPT_SKEW_MS) invalid();
  return Object.freeze({ ...value }) as unknown as RunnerDecisionReportReceipt;
}
/** The closed conflict reason of a 409 body (canonical `error.details.reason` or legacy `details.reason`), else undefined. */
function conflictReason(text: string): string | undefined {
  let body: unknown; try { body = JSON.parse(text) as unknown; } catch { return undefined; }
  const reason = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value)
    ? ((value as { details?: unknown }).details as { reason?: unknown } | null | undefined)?.reason : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const found = reason((body as { error?: unknown }).error) ?? reason(body);
  return typeof found === "string" && CONFLICT_REASONS.includes(found) ? found : undefined;
}

/** Public runner route only (POST /api/nest/local-agents/decision-reports/{nonce,submit}); credential-free, redirect-refusing. */
export class RunnerDecisionReportClient {
  private readonly pinned: RunnerDecisionReportTarget;
  private readonly signer: RunnerDecisionReportSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerDecisionReportClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.timeoutMs = config.timeoutMs ?? 20_000; this.transport = config.fetchFn ?? fetch;
  }
  /** One signed attempt. An identical resubmission answers the original receipt; a different report for the event is a 409
   * whose machineCode is RUNNER_DECISION_REPORT_CONFLICT (permanent); a lease conflict is RUNNER_DECISION_REPORT_LEASE_CONFLICT. */
  async submit(input: RunnerDecisionReport, epoch: number, callerSignal?: AbortSignal): Promise<RunnerDecisionReportReceipt> {
    const operation = expected({ ...this.pinned, epoch, report: input });
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    // Only a 409 body is inspected, for its closed reason; the bytes are handed on unchanged.
    let conflict: string | undefined;
    const transport: typeof fetch = async (url, init) => {
      const response = await this.transport(url, init);
      if (response.status !== 409) return response;
      const text = await readBoundedResponseText(response, MAX_CONFLICT_BYTES, init?.signal ?? undefined);
      conflict = conflictReason(text);
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerDecisionReportRequestDigest(operation.report) },
      { kind: "side_effecting", operation: "local-agent:decision-report-nonce" }), scope.signal, cancelled);
      const nonce = validateRunnerDecisionReportNonce(data, operation);
      const signature = await signWithin(() => this.signer(nonce, operation), nonce.expiresAt, scope.signal, invalid, cancelled);
      validateRunnerDecisionReportNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/submit`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch,
        report: operation.report }, { kind: "side_effecting", operation: "local-agent:decision-report-submit" }), scope.signal, cancelled);
      return validateRunnerDecisionReportReceipt(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError && error.status === 409 && conflict !== undefined) {
        throw new AgentSdkError({ code: error.code, status: 409, message: error.message,
          details: { layer: "http_ingress", code: conflict, retryable: conflict !== RUNNER_DECISION_REPORT_CONFLICT } });
      }
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
