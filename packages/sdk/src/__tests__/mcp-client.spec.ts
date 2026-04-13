/**
 * BalchemyMcpClient — unit tests
 *
 * Covers:
 *   - listTools: success path, JSON-RPC result parsing
 *   - callTool: sends correct JSON-RPC body, returns result
 *   - ping: returns true for valid listTools response
 *   - SSE payload extraction: data: lines parsed correctly
 *   - JSON-RPC error response: AgentSdkError thrown with code=execution_error
 *   - Network error: wrapped as AgentSdkError with code=network_error
 *   - Empty response body: AgentSdkError with code=invalid_response
 */

import { BalchemyMcpClient, connectMcp } from "../mcp/mcp-client";
import { AgentSdkError } from "../errors/agent-sdk-error";
import type { RetryOptions } from "../utils/retry";

// ── helpers ───────────────────────────────────────────────────────────────────

const ENDPOINT = "https://api.balchemy.ai/mcp/pub-test-1";
const API_KEY = "bAlc-test-key-1234";
const RETRY_NO_DELAY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 0,
  maxDelayMs: 1,
  jitter: false,
  sleepFn: async (): Promise<void> => undefined,
};

function makeFetchSuccess(result: unknown): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result })
    ),
  });
}

function makeFetchError(errorMsg: string, code = -32601): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message: errorMsg } })
    ),
  });
}

function buildClient(
  fetchFn: jest.Mock,
  retry: RetryOptions = RETRY_NO_DELAY
) {
  return new BalchemyMcpClient({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    timeoutMs: 5000,
    fetchFn: fetchFn as unknown as typeof fetch,
    retry,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe("BalchemyMcpClient", () => {
  // ── listTools ─────────────────────────────────────────────────────────────
  describe("listTools", () => {
    it("calls the MCP endpoint with tools/list method", async () => {
      const fetchFn = makeFetchSuccess({ tools: [{ name: "ask_bot" }] });
      const client = buildClient(fetchFn);
      const result = await client.listTools();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(ENDPOINT);
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.method).toBe("tools/list");
      expect(body.jsonrpc).toBe("2.0");
      expect(result.tools).toEqual([{ name: "ask_bot" }]);
    });

    it("sends Authorization: Bearer header", async () => {
      const fetchFn = makeFetchSuccess({ tools: [] });
      const client = buildClient(fetchFn);
      await client.listTools();
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });
  });

  // ── callTool ──────────────────────────────────────────────────────────────
  describe("callTool", () => {
    it("sends tools/call with name and arguments", async () => {
      const fetchFn = makeFetchSuccess({ content: [{ type: "text", text: "result" }] });
      const client = buildClient(fetchFn);
      const result = await client.callTool("ask_bot", { message: "hello" });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.method).toBe("tools/call");
      const params = body.params as Record<string, unknown>;
      expect(params.name).toBe("ask_bot");
      expect(params.arguments).toEqual({ message: "hello" });
      expect(result.content[0].text).toBe("result");
    });
  });

  // ── convenience methods ──────────────────────────────────────────────────
  describe("convenience methods", () => {
    it("agentExecute calls agent_execute tool", async () => {
      const fetchFn = makeFetchSuccess({ content: [{ type: "text", text: "ok" }] });
      const client = buildClient(fetchFn);
      await client.agentExecute({ instruction: "test" });

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      expect(body.params.name).toBe("agent_execute");
      expect(body.params.arguments).toEqual({ instruction: "test" });
    });

    it("requestSeed throws deterministic disabled error", async () => {
      const fetchFn = makeFetchSuccess({ content: [] });
      const client = buildClient(fetchFn);

      await expect(client.requestSeed()).rejects.toMatchObject({
        code: "execution_error",
      });
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  // ── ping ──────────────────────────────────────────────────────────────────
  describe("ping", () => {
    it("returns true when listTools returns an array", async () => {
      const fetchFn = makeFetchSuccess({ tools: [] });
      const client = buildClient(fetchFn);
      const ok = await client.ping();
      expect(ok).toBe(true);
    });
  });

  // ── SSE payload extraction ────────────────────────────────────────────────
  describe("SSE payload extraction", () => {
    it("extracts data: lines from SSE response", async () => {
      const jsonRpcResult = { tools: [{ name: "ask_bot" }] };
      const ssePayload = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: jsonRpcResult })}\n\n`;
      const fetchFn = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue(ssePayload),
      });
      const client = buildClient(fetchFn);
      const result = await client.listTools();
      expect(result.tools).toEqual([{ name: "ask_bot" }]);
    });
  });

  // ── JSON-RPC error response ───────────────────────────────────────────────
  describe("JSON-RPC error response", () => {
    it("throws AgentSdkError with code=execution_error", async () => {
      const fetchFn = makeFetchError("Unknown tool: foo");
      const client = buildClient(fetchFn);
      await expect(client.callTool("foo", {})).rejects.toBeInstanceOf(AgentSdkError);
      try {
        await client.callTool("foo", {});
      } catch (err: unknown) {
        expect((err as AgentSdkError).code).toBe("execution_error");
        expect((err as AgentSdkError).message).toBe("Unknown tool: foo");
      }
    });
  });

  describe("retry behavior by method/error", () => {
    it("does not retry tools/call execution_error by default", async () => {
      const fetchFn = makeFetchError("execution failed");
      const client = buildClient(fetchFn, {
        ...RETRY_NO_DELAY,
        maxAttempts: 3,
      });

      await expect(client.callTool("ask_bot", { message: "hello" })).rejects.toBeInstanceOf(
        AgentSdkError
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("retries listTools execution_error with default policy", async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32601, message: "temporary failure" },
            })
          ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32601, message: "temporary failure" },
            })
          ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
          ),
        });

      const client = buildClient(fetchFn);
      const result = await client.listTools();

      expect(result.tools).toEqual([]);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it("retries tools/call network_error with default policy", async () => {
      const fetchFn = jest
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: "ok" }] },
            })
          ),
        });

      const client = buildClient(fetchFn);
      const result = await client.callTool("ask_bot", { message: "hello" });

      expect(result.content[0].text).toBe("ok");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("allows custom shouldRetry override for tools/call execution_error", async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32601, message: "temporary execution error" },
            })
          ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: "ok" }] },
            })
          ),
        });

      const client = buildClient(fetchFn, {
        ...RETRY_NO_DELAY,
        maxAttempts: 2,
        shouldRetry: (): boolean => true,
      });

      const result = await client.callTool("ask_bot", { message: "hello" });

      expect(result.content[0].text).toBe("ok");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  // ── Network error ─────────────────────────────────────────────────────────
  describe("network errors", () => {
    it("wraps network failure as AgentSdkError with code=network_error", async () => {
      const fetchFn = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const client = buildClient(fetchFn);
      try {
        await client.listTools();
        fail("should have thrown");
      } catch (err: unknown) {
        expect((err as AgentSdkError).code).toBe("network_error");
      }
    });
  });

  // ── Empty response body ───────────────────────────────────────────────────
  describe("empty response body", () => {
    it("throws AgentSdkError with code=invalid_response", async () => {
      const fetchFn = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue(""),
      });
      const client = buildClient(fetchFn);
      await expect(client.listTools()).rejects.toBeInstanceOf(AgentSdkError);
    });
  });

  // ── connectMcp factory ────────────────────────────────────────────────────
  describe("connectMcp factory", () => {
    it("returns a BalchemyMcpClient instance", () => {
      const client = connectMcp({ endpoint: ENDPOINT, apiKey: API_KEY });
      expect(client).toBeInstanceOf(BalchemyMcpClient);
    });
  });
});
