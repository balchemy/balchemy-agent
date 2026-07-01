import { BalchemyAgentSdk } from "../src";

const readEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing env: ${key}`);
  }
  return value;
};

async function run(): Promise<void> {
  const sdk = new BalchemyAgentSdk({
    apiBaseUrl: readEnv("BALCHEMY_API_BASE_URL"),
  });

  const onboarding = await sdk.onboardWithSiwe({
    message: readEnv("SIWE_MESSAGE"),
    signature: readEnv("SIWE_SIGNATURE"),
    agentId: readEnv("AGENT_ID"),
  });

  const apiKey = onboarding.mcp.apiKey;
  if (!apiKey) {
    throw new Error("MCP apiKey missing (already provisioned agent may require key rotation)");
  }

  const mcp = sdk.connectMcp({
    endpoint: onboarding.mcp.endpoint,
    apiKey,
  });

  const tools = await mcp.listTools();
  process.stdout.write(JSON.stringify({ toolCount: tools.tools.length }));
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(message);
  process.exit(1);
});
