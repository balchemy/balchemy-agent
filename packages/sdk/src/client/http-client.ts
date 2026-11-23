import { AgentSdkError } from "../errors/agent-sdk-error";
import type { AgentSdkErrorCode } from "../errors/error-codes";
import {
  buildFailureDetails,
  extractFailureMetadata,
  parseRetryAfterSeconds,
} from "../errors/failure-metadata";
import {
  withRetry,
  type RetryOperationPolicy,
  type RetryOptions,
} from "../utils/retry";
import { readBoundedResponseText, ResponseSizeLimitError } from "../utils/redaction";

const MAX_HTTP_RESPONSE_BYTES = 512 * 1024;
const MAX_HTTP_REQUEST_BYTES = 512 * 1024;

export type HttpClientConfig = {
  baseUrl: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  /** Retry options. Set maxAttempts=1 to disable retries. Default: 3 attempts. */
  retry?: RetryOptions;
};

export class HttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly retryOptions: RetryOptions;

  constructor(config: HttpClientConfig) {
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive safe integer");
    }
    const parsedBaseUrl = new URL(config.baseUrl);
    if (
      (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.protocol !== "http:")
      || parsedBaseUrl.username
      || parsedBaseUrl.password
      || parsedBaseUrl.search
      || parsedBaseUrl.hash
    ) {
      throw new Error("baseUrl must not contain credentials, query parameters, or fragments");
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs;
    this.fetchFn = config.fetchFn ?? fetch;
    this.retryOptions = config.retry ?? { maxAttempts: 3 };
  }

  async get<T>(path: string, headers?: Record<string, string>): Promise<T> {
    return withRetry(
      (attempt) => this.request<T>(
        path,
        { method: "GET", headers },
        attempt.remainingDeadlineMs,
      ),
      { kind: "read", operation: this.buildOperationId("get", path) },
      this.retryOptions,
    );
  }

  async post<T>(
    path: string,
    body: Record<string, unknown>,
    operation: RetryOperationPolicy,
    headers?: Record<string, string>,
  ): Promise<T> {
    return withRetry(
      (attempt) =>
        this.request<T>(path, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }, attempt.remainingDeadlineMs),
      operation,
      this.retryOptions,
    );
  }

  private async request<T>(
    path: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
    },
    remainingDeadlineMs: number = this.timeoutMs,
  ): Promise<T> {
    const routeId = this.buildOperationId(init.method.toLowerCase(), path);
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) {
      throw new AgentSdkError({ code: "policy_error", message: "HTTP path is invalid" });
    }
    if (init.body && Buffer.byteLength(init.body, "utf8") > MAX_HTTP_REQUEST_BYTES) {
      throw new AgentSdkError({ code: "policy_error", message: "HTTP request body exceeds the SDK size limit" });
    }
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(this.timeoutMs, remainingDeadlineMs)),
    );

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        body: init.body,
        signal: controller.signal,
        // Signature and identity-token bodies are bound to the configured API.
        // A redirect must not replay them to a different origin or route.
        redirect: "error",
      });

      const parsed = await this.safeJsonParse(response);
      if (!response.ok) {
        throw this.mapHttpError(response, parsed);
      }

      const normalized = this.unwrapCanonicalEnvelope(path, response.status, parsed);

      if (!normalized || typeof normalized !== "object") {
        throw new AgentSdkError({
          code: "invalid_response",
          message: `Unexpected response format for ${routeId}`,
          status: response.status,
          details: buildFailureDetails({
            layer: "http_ingress",
            code: "INVALID_RESPONSE",
            retryable: false,
          }),
        });
      }

      return normalized as T;
    } catch (error: unknown) {
      if (error instanceof AgentSdkError) {
        throw error;
      }
      if (error instanceof ResponseSizeLimitError) {
        throw new AgentSdkError({
          code: "invalid_response",
          message: "HTTP response exceeds the SDK size limit",
          details: buildFailureDetails({
            layer: "http_ingress",
            code: "INVALID_RESPONSE",
            retryable: false,
          }),
        });
      }
      const aborted = error instanceof Error && error.name === "AbortError";
      const message = aborted
        ? `Request timed out for ${routeId}`
        : `Network request failed for ${routeId}`;
      throw new AgentSdkError({
        code: "network_error",
        message,
        details: buildFailureDetails({
          layer: "transport",
          code: aborted ? "CLIENT_TIMEOUT" : "NETWORK_ERROR",
          retryable: true,
        }),
      });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private async safeJsonParse(response: Response): Promise<unknown> {
    const text = await readBoundedResponseText(response, MAX_HTTP_RESPONSE_BYTES);
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private unwrapCanonicalEnvelope(path: string, status: number, parsed: unknown): unknown {
    const routeId = this.buildOperationId("response", path);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return parsed;
    }

    const record = parsed as Record<string, unknown>;
    const hasSuccess = typeof record.success === "boolean";
    if (!hasSuccess) {
      return parsed;
    }

    const success = record.success as boolean;
    if (!success) {
      const details = Object.prototype.hasOwnProperty.call(record, "error")
        ? record.error
        : parsed;
      throw new AgentSdkError({
        code: "execution_error",
        status,
        message: `Request failed for ${routeId}`,
        details: buildFailureDetails(extractFailureMetadata({
          sdkCode: "execution_error",
          status,
          details,
        })),
      });
    }

    if (!Object.prototype.hasOwnProperty.call(record, "data")) {
      return parsed;
    }

    return record.data;
  }

  private mapHttpError(response: Response, details: unknown): AgentSdkError {
    const status = response.status;
    const code: AgentSdkErrorCode =
      status === 401 || status === 403
        ? "provider_auth_error"
        : status === 429
          ? "rate_limit_error"
          : status === 400
            ? "policy_error"
            : status >= 500
              ? "execution_error"
              : "auth_error";
    const parsed = extractFailureMetadata({ sdkCode: code, status, details });
    const retryAfterSeconds = this.readRetryAfterSeconds(response)
      ?? parsed.retryAfterSeconds;

    return new AgentSdkError({
      code,
      status,
      message: `HTTP ${status}`,
      details: buildFailureDetails({
        ...parsed,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      }),
    });
  }

  private readRetryAfterSeconds(response: Response): number | undefined {
    const headers = (response as Response & {
      headers?: { get?: (name: string) => string | null };
    }).headers;
    return typeof headers?.get === "function"
      ? parseRetryAfterSeconds(headers.get("retry-after"))
      : undefined;
  }

  private buildOperationId(method: string, path: string): string {
    const route = path
      .split(/[?#]/, 1)[0]
      .replace(/[^a-zA-Z0-9_.:/-]/g, "_")
      .slice(0, 96);
    return `http:${method}:${route || "/"}`;
  }
}
