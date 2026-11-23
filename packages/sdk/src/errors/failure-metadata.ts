import type { AgentSdkErrorCode } from "./error-codes";

export type FailureLayer =
  | "transport"
  | "http_ingress"
  | "mcp_ingress"
  | "mcp_scope"
  | "research_budget"
  | "provider"
  | "policy"
  | "unknown";

export type FailureMetadata = {
  layer: FailureLayer;
  code: string;
  source?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  degraded?: boolean;
  dataAvailable?: boolean;
};

const MACHINE_CODE_RE = /^[A-Z][A-Z0-9_]{1,95}$/;
const SOURCE_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFailureLayer(value: unknown): FailureLayer | undefined {
  switch (value) {
    case "transport":
    case "http_ingress":
    case "mcp_ingress":
    case "mcp_scope":
    case "research_budget":
    case "provider":
    case "policy":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}

function asMachineCode(value: unknown): string | undefined {
  return typeof value === "string" && MACHINE_CODE_RE.test(value)
    ? value
    : undefined;
}

function asSource(value: unknown): string | undefined {
  return typeof value === "string" && SOURCE_RE.test(value)
    ? value
    : undefined;
}

function asRetryAfterSeconds(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return asRetryAfterSeconds(Number(value));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(value));
}

function candidateRecords(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  const records = [value];
  for (const key of ["error", "data", "details"] as const) {
    const nested = value[key];
    if (isRecord(nested)) {
      records.push(nested);
      if (isRecord(nested.error)) {
        records.push(nested.error);
      }
    }
  }
  return records;
}

function firstValue<T>(
  records: Record<string, unknown>[],
  keys: readonly string[],
  normalize: (value: unknown) => T | undefined,
): T | undefined {
  for (const record of records) {
    for (const key of keys) {
      const normalized = normalize(record[key]);
      if (normalized !== undefined) {
        return normalized;
      }
    }
  }
  return undefined;
}

function fallbackLayer(code: AgentSdkErrorCode, status?: number): FailureLayer {
  if (code === "network_error") {
    return "transport";
  }
  if (code === "provider_auth_error") {
    return "provider";
  }
  if (code === "policy_error") {
    return "policy";
  }
  if (status !== undefined) {
    return "http_ingress";
  }
  return "unknown";
}

function fallbackMachineCode(code: AgentSdkErrorCode, status?: number): string {
  if (status === 429 || code === "rate_limit_error") {
    return "HTTP_INGRESS_RATE_LIMITED";
  }
  if (status === 401) {
    return "HTTP_UNAUTHORIZED";
  }
  if (status === 403) {
    return "HTTP_FORBIDDEN";
  }
  if (status !== undefined && status >= 500) {
    return "HTTP_UPSTREAM_ERROR";
  }
  switch (code) {
    case "network_error":
      return "NETWORK_ERROR";
    case "policy_error":
      return "POLICY_REJECTED";
    case "provider_auth_error":
      return "PROVIDER_UNAUTHORIZED";
    case "invalid_response":
      return "INVALID_RESPONSE";
    case "execution_error":
      return "EXECUTION_ERROR";
    case "auth_error":
      return "AUTH_ERROR";
    case "unknown_error":
      return "UNKNOWN_ERROR";
  }
}

function fallbackRetryable(code: AgentSdkErrorCode, status?: number): boolean {
  if (status === 401 || status === 403 || status === 400) {
    return false;
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  return code === "network_error" || code === "rate_limit_error";
}

export function extractFailureMetadata(params: {
  sdkCode: AgentSdkErrorCode;
  status?: number;
  details?: unknown;
}): FailureMetadata {
  const records = candidateRecords(params.details);
  const retryAfterSeconds = firstValue(
    records,
    ["retryAfterSeconds", "retry_after_seconds", "retryAfter", "retry-after"],
    asRetryAfterSeconds,
  );
  const explicitRetryable = firstValue(
    records,
    ["retryable"],
    (value) => typeof value === "boolean" ? value : undefined,
  );
  const degraded = firstValue(
    records,
    ["degraded"],
    (value) => typeof value === "boolean" ? value : undefined,
  );
  const dataAvailable = firstValue(
    records,
    ["dataAvailable", "data_available"],
    (value) => typeof value === "boolean" ? value : undefined,
  );
  const source = firstValue(records, ["source", "provider"], asSource);

  return {
    layer: firstValue(records, ["layer"], asFailureLayer)
      ?? fallbackLayer(params.sdkCode, params.status),
    code: firstValue(records, ["code", "reasonCode", "reason_code"], asMachineCode)
      ?? fallbackMachineCode(params.sdkCode, params.status),
    ...(source ? { source } : {}),
    retryable:
      fallbackRetryable(params.sdkCode, params.status)
      && explicitRetryable !== false,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(degraded !== undefined ? { degraded } : {}),
    ...(dataAvailable !== undefined ? { dataAvailable } : {}),
  };
}

export function parseRetryAfterSeconds(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const delta = asRetryAfterSeconds(trimmed);
  if (delta !== undefined) {
    return delta;
  }
  const atMs = Date.parse(trimmed);
  if (!Number.isFinite(atMs) || atMs <= nowMs) {
    return undefined;
  }
  return asRetryAfterSeconds((atMs - nowMs) / 1000);
}

export function buildFailureDetails(
  metadata: FailureMetadata,
): Record<string, unknown> {
  return {
    layer: metadata.layer,
    code: metadata.code,
    ...(metadata.source ? { source: metadata.source } : {}),
    retryable: metadata.retryable,
    ...(metadata.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: metadata.retryAfterSeconds }
      : {}),
    ...(metadata.degraded !== undefined ? { degraded: metadata.degraded } : {}),
    ...(metadata.dataAvailable !== undefined
      ? { dataAvailable: metadata.dataAvailable }
      : {}),
  };
}
