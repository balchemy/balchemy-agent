import fs from "node:fs";
import path from "node:path";
import { BalchemyMcpClient } from "../mcp/mcp-client";

describe("public SDK boundary", () => {
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
