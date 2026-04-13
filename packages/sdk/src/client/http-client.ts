import { AgentSdkError } from "../errors/agent-sdk-error";
import type { AgentSdkErrorCode } from "../errors/error-codes";
import { withRetry, type RetryOptions } from "../utils/retry";

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
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs;
    this.fetchFn = config.fetchFn ?? fetch;
    this.retryOptions = config.retry ?? { maxAttempts: 3 };
  }

  async get<T>(path: string, headers?: Record<string, string>): Promise<T> {
    return withRetry(
      () => this.request<T>(path, { method: "GET", headers }),
      this.retryOptions
    );
  }

  async post<T>(
    path: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<T> {
    return withRetry(
      () =>
        this.request<T>(path, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      this.retryOptions
    );
  }

  private async request<T>(
    path: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        body: init.body,
        signal: controller.signal,
      });

      const parsed = await this.safeJsonParse(response);
      if (!response.ok) {
        throw this.mapHttpError(response.status, parsed);
      }

      const normalized = this.unwrapCanonicalEnvelope(path, response.status, parsed);

      if (!normalized || typeof normalized !== "object") {
        throw new AgentSdkError({
          code: "invalid_response",
          message: `Unexpected response format from ${path}`,
          status: response.status,
          details: normalized,
        });
      }

      return normalized as T;
    } catch (error: unknown) {
      if (error instanceof AgentSdkError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown network error";
      throw new AgentSdkError({
        code: "network_error",
        message,
        details: error,
      });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private async safeJsonParse(response: Response): Promise<unknown> {
    const text = await response.text();
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
        message: `Request failed for ${path}`,
        details,
      });
    }

    if (!Object.prototype.hasOwnProperty.call(record, "data")) {
      return parsed;
    }

    return record.data;
  }

  private mapHttpError(status: number, details: unknown): AgentSdkError {
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

    return new AgentSdkError({
      code,
      status,
      message: `HTTP ${status}`,
      details,
    });
  }
}
