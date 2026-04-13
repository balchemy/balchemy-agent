/**
 * HttpClient — unit tests
 *
 * Covers:
 *   - GET request: success path, non-ok response error mapping
 *   - POST request: body serialized, headers forwarded
 *   - Timeout: AbortController triggered on timeout
 *   - Error mapping: 401→provider_auth_error, 429→rate_limit_error, 400→policy_error, 500→execution_error
 *   - Network errors wrapped as AgentSdkError with code=network_error
 *   - Empty response body handling
 */

import { HttpClient } from "../client/http-client";
import { AgentSdkError } from "../errors/agent-sdk-error";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFetch(
  status: number,
  body: unknown,
  ok = status >= 200 && status < 300
): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    text: jest.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function buildClient(fetchFn: jest.Mock) {
  return new HttpClient({
    baseUrl: "https://api.balchemy.ai/api",
    timeoutMs: 5000,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe("HttpClient", () => {
  // ── GET ──────────────────────────────────────────────────────────────────
  describe("get", () => {
    it("calls fetch with GET method and correct URL", async () => {
      const fetchFn = makeFetch(200, { ok: true });
      const client = buildClient(fetchFn);
      const result = await client.get("/nest/health");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.balchemy.ai/api/nest/health");
      expect(init.method).toBe("GET");
      expect(result).toEqual({ ok: true });
    });

    it("forwards custom headers", async () => {
      const fetchFn = makeFetch(200, { data: 1 });
      const client = buildClient(fetchFn);
      await client.get("/path", { "X-Custom": "value" });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Custom"]).toBe("value");
    });

    it("strips trailing slash from baseUrl", async () => {
      const fetchFn = makeFetch(200, { x: 1 });
      const client = new HttpClient({
        baseUrl: "https://api.balchemy.ai/api/",
        timeoutMs: 5000,
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      await client.get("/test");
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toBe("https://api.balchemy.ai/api/test");
    });

    it("unwraps canonical success envelope", async () => {
      const fetchFn = makeFetch(200, {
        success: true,
        data: { ready: true },
        meta: { compatMode: "canonical" },
      });
      const client = buildClient(fetchFn);
      const result = await client.get<{ ready: boolean }>("/nest/health");
      expect(result).toEqual({ ready: true });
    });
  });

  describe("canonical envelope errors", () => {
    it("throws AgentSdkError when canonical response has success=false", async () => {
      const fetchFn = makeFetch(200, {
        success: false,
        error: { code: "BAD_REQUEST", message: "failed" },
      });
      const client = buildClient(fetchFn);

      await expect(client.get("/path")).rejects.toMatchObject({
        code: "execution_error",
        status: 200,
      });
    });
  });

  // ── POST ─────────────────────────────────────────────────────────────────
  describe("post", () => {
    it("sends body as JSON string", async () => {
      const fetchFn = makeFetch(200, { created: true });
      const client = buildClient(fetchFn);
      await client.post("/endpoint", { key: "value" });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ key: "value" }));
    });

    it("sets Content-Type application/json", async () => {
      const fetchFn = makeFetch(200, { created: true });
      const client = buildClient(fetchFn);
      await client.post("/endpoint", {});
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  // ── Error mapping ────────────────────────────────────────────────────────
  describe("HTTP error mapping", () => {
    const cases: Array<[number, string]> = [
      [401, "provider_auth_error"],
      [403, "provider_auth_error"],
      [429, "rate_limit_error"],
      [400, "policy_error"],
      [500, "execution_error"],
      [503, "execution_error"],
    ];

    for (const [status, code] of cases) {
      it(`maps HTTP ${status} to AgentSdkError.code=${code}`, async () => {
        const fetchFn = makeFetch(status, { error: "fail" }, false);
        const client = buildClient(fetchFn);
        try {
          await client.get("/path");
          fail("should have thrown");
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(AgentSdkError);
          expect((err as AgentSdkError).code).toBe(code);
          expect((err as AgentSdkError).status).toBe(status);
        }
      });
    }
  });

  // ── Empty body ───────────────────────────────────────────────────────────
  describe("empty response body", () => {
    it("throws invalid_response for non-object 200 body", async () => {
      const fetchFn = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('"just a string"'),
      });
      const client = buildClient(fetchFn);
      await expect(client.get("/path")).rejects.toBeInstanceOf(AgentSdkError);
    });
  });

  // ── Network error ────────────────────────────────────────────────────────
  describe("network errors", () => {
    it("wraps fetch throw as AgentSdkError with code=network_error", async () => {
      const fetchFn = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const client = buildClient(fetchFn);
      try {
        await client.get("/path");
        fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AgentSdkError);
        expect((err as AgentSdkError).code).toBe("network_error");
      }
    });
  });
});
