/**
 * AgentOnboardingClient — unit tests
 *
 * Covers:
 *   - onboardWithSiwe: sends correct POST body
 *   - onboardWithIdentity: sends correct POST body with all fields
 *   - requestSiweNonce: calls correct path
 *   - scope field: only included when explicitly set
 */

import { AgentOnboardingClient } from "../auth/onboarding";
import { HttpClient } from "../client/http-client";

// ── helpers ───────────────────────────────────────────────────────────────────

const MOCK_PROVISIONING = {
  success: true,
  bot: { botId: "bot-1", publicId: "pub-1", name: "Agent" },
  mcp: { endpoint: "https://api.balchemy.ai/mcp/pub-1", apiKey: "key-1" },
  base: { chainId: 8453 },
  onboarding: { mode: "walletless", chainId: 8453, registryVerified: true },
  onboardingInstructions: "Follow instructions.",
};

const MOCK_NONCE = { nonce: "abc123", message: "Sign this", expiresAt: "2026-12-31" };

function buildClient() {
  const postMock = jest.fn().mockResolvedValue(MOCK_PROVISIONING);
  const getMock = jest.fn().mockResolvedValue(MOCK_NONCE);
  const httpClient = {
    post: postMock,
    get: getMock,
  } as unknown as HttpClient;
  const onboarding = new AgentOnboardingClient(httpClient);
  return { onboarding, postMock, getMock };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("AgentOnboardingClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── requestSiweNonce ──────────────────────────────────────────────────────
  describe("requestSiweNonce", () => {
    it("posts to /nest/auth/evm/nonce with correct body", async () => {
      const { onboarding, postMock } = buildClient();
      postMock.mockResolvedValue(MOCK_NONCE);
      const result = await onboarding.requestSiweNonce({
        address: "0xabc",
        chainId: 8453,
        domain: "api.balchemy.ai",
        uri: "https://api.balchemy.ai",
      });
      expect(postMock).toHaveBeenCalledWith("/nest/auth/evm/nonce", {
        address: "0xabc",
        chainId: 8453,
        domain: "api.balchemy.ai",
        uri: "https://api.balchemy.ai",
        statement: "Sign in to Balchemy external agent onboarding",
      });
      expect(result).toEqual(MOCK_NONCE);
    });

    it("uses custom statement when provided", async () => {
      const { onboarding, postMock } = buildClient();
      postMock.mockResolvedValue(MOCK_NONCE);
      await onboarding.requestSiweNonce({
        address: "0xabc",
        chainId: 8453,
        domain: "api.balchemy.ai",
        uri: "https://api.balchemy.ai",
        statement: "Custom statement",
      });
      const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(body.statement).toBe("Custom statement");
    });
  });

  // ── onboardWithSiwe ───────────────────────────────────────────────────────
  describe("onboardWithSiwe", () => {
    it("posts to /public/erc8004/onboarding/siwe with message, signature, agentId", async () => {
      const { onboarding, postMock } = buildClient();
      await onboarding.onboardWithSiwe({
        message: "Sign message",
        signature: "0xsig",
        agentId: "agent-001",
      });
      expect(postMock).toHaveBeenCalledWith("/public/erc8004/onboarding/siwe", {
        message: "Sign message",
        signature: "0xsig",
        agentId: "agent-001",
      });
    });

    it("includes scope when explicitly provided", async () => {
      const { onboarding, postMock } = buildClient();
      await onboarding.onboardWithSiwe({
        message: "msg",
        signature: "0xsig",
        agentId: "agent-001",
        scope: "read",
      });
      const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(body.scope).toBe("read");
    });

    it("omits scope when not provided", async () => {
      const { onboarding, postMock } = buildClient();
      await onboarding.onboardWithSiwe({
        message: "msg",
        signature: "0xsig",
        agentId: "agent-001",
      });
      const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
      expect("scope" in body).toBe(false);
    });

    it("returns provisioning result", async () => {
      const { onboarding } = buildClient();
      const result = await onboarding.onboardWithSiwe({
        message: "msg",
        signature: "0xsig",
        agentId: "agent-001",
      });
      expect(result.bot.publicId).toBe("pub-1");
      expect(result.mcp.endpoint).toContain("/mcp/pub-1");
    });
  });

  // ── onboardWithIdentity ───────────────────────────────────────────────────
  describe("onboardWithIdentity", () => {
    it("posts to /public/erc8004/onboarding/identity with all fields", async () => {
      const { onboarding, postMock } = buildClient();
      await onboarding.onboardWithIdentity({
        provider: "localdev",
        identityToken: "token-abc",
        agentId: "agent-001",
        chainId: 8453,
        scope: "trade",
      });
      expect(postMock).toHaveBeenCalledWith("/public/erc8004/onboarding/identity", {
        provider: "localdev",
        identityToken: "token-abc",
        agentId: "agent-001",
        chainId: 8453,
        scope: "trade",
      });
    });

    it("defaults chainId to 8453 when not provided", async () => {
      const { onboarding, postMock } = buildClient();
      await onboarding.onboardWithIdentity({
        provider: "balchemy",
        identityToken: "token",
        agentId: "agent-001",
      });
      const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(body.chainId).toBe(8453);
    });

    it("omits scope when not provided", async () => {
      const { onboarding, postMock } = buildClient();
      await onboarding.onboardWithIdentity({
        provider: "balchemy",
        identityToken: "token",
        agentId: "agent-001",
      });
      const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
      expect("scope" in body).toBe(false);
    });
  });
});
