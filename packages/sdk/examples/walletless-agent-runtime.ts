import { BalchemyAgentSdk } from "../src";

const readEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing env: ${key}`);
  }
  return value;
};

async function run(): Promise<void> {
  // BALCHEMY_API_BASE_URL must include the /api path prefix and must NOT have a trailing slash.
  // Example: "http://localhost:3000/api" (local) or "https://api.balchemy.ai/api" (prod)
  const sdk = new BalchemyAgentSdk({
    apiBaseUrl: readEnv("BALCHEMY_API_BASE_URL"),
  });

  const onboarding = await sdk.onboardWithIdentity({
    provider: readEnv("AGENT_PROVIDER"),
    identityToken: readEnv("AGENT_IDENTITY_TOKEN"),
    agentId: readEnv("AGENT_ID"),
    chainId: 8453,
  });

  const apiKey = onboarding.mcp.apiKey;
  if (!apiKey) {
    throw new Error("MCP apiKey missing (already provisioned agent may require key rotation)");
  }

  const mcp = sdk.connectMcp({
    endpoint: onboarding.mcp.endpoint,
    apiKey,
  });

  const status = await mcp.callTool("trading_evm_status", {});
  process.stdout.write(JSON.stringify(status));
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(message);
  process.exit(1);
});
