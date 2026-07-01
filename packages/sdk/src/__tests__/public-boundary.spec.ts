import fs from "node:fs";
import path from "node:path";
import * as publicSdk from "../index";
import { BalchemyMcpClient } from "../mcp/mcp-client";
import type { McpCallToolResponse } from "../types";

describe("public SDK boundary", () => {
  it("exposes the recovery root import surface", async () => {
    expect(publicSdk.BalchemyClient).toBe(publicSdk.BalchemyAgentSdk);
    expect(typeof publicSdk.agentReadinessReport).toBe("function");
    expect(typeof publicSdk.agentContextSnapshot).toBe("function");
    expect(typeof publicSdk.agentMarketBrief).toBe("function");
    expect(typeof publicSdk.agentCandidateReport).toBe("function");
    expect(typeof publicSdk.agentRiskReport).toBe("function");

    const response: McpCallToolResponse = { content: [] };
    const client = {
      agentReadinessReport: jest.fn().mockResolvedValue(response),
      agentContextSnapshot: jest.fn().mockResolvedValue(response),
      agentMarketBrief: jest.fn().mockResolvedValue(response),
      agentCandidateReport: jest.fn().mockResolvedValue(response),
      agentRiskReport: jest.fn().mockResolvedValue(response),
    } as unknown as BalchemyMcpClient;

    await expect(publicSdk.agentReadinessReport(client)).resolves.toBe(response);
    await expect(publicSdk.agentContextSnapshot(client)).resolves.toBe(response);
    await expect(publicSdk.agentMarketBrief(client, { query: "SOL" })).resolves.toBe(response);
    await expect(publicSdk.agentCandidateReport(client, { query: "SOL" })).resolves.toBe(response);
    await expect(publicSdk.agentRiskReport(client, { query: "SOL" })).resolves.toBe(response);
  });

  it("does not expose typed privileged trade helper methods", () => {
    const client = new BalchemyMcpClient({
      endpoint: "https://api.balchemy.ai/mcp/pub-test-1",
      apiKey: "balc_test_key_123456",
      fetchFn: jest.fn() as unknown as typeof fetch,
    }) as unknown as Record<string, unknown>;

    expect(client.tradeCommand).toBeUndefined();
    expect(client.agentExecute).toBeUndefined();
    expect(client.evmSwap).toBeUndefined();
    expect(client.solanaSwap).toBeUndefined();
  });

  it("keeps public README on the canonical MCP and revoke-proof contract", () => {
    const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");

    expect(readme).toContain("POST /mcp/{publicId}");
    expect(readme).not.toContain("POST /api/mcp/{publicId}");
    expect(readme).toContain("Bearer identity proof");
    expect(readme).not.toContain("details: err.details");
  });
});
