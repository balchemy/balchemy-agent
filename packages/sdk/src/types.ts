export type AgentOnboardingMode = "siwe" | "walletless" | "legacy";
export type AgentScope = "read" | "trade" | "manage";

export type ProvisionedBot = {
  botId: string;
  publicId: string;
  name: string;
};

export type ProvisionedMcp = {
  endpoint: string;
  apiKey?: string;
  keyPrefix?: string;
  keyId?: string;
};

export type ProvisionedBaseWallet = {
  chainId: number;
  custodialWallet?: {
    address: string;
    walletId?: string;
    chainId?: number;
  };
};

export type IdentityAccess = {
  token: string;
  tokenType: "Bearer";
  expiresIn: number;
  expiresAt: string;
  kid: string;
  issuer: string;
  /** Scope granted at onboarding. "manage" is never issued at onboarding time. */
  scope: "read" | "trade";
};

export type OnboardingResponse = {
  /**
   * Legacy flag from canonical API envelopes.
   * SDK unwraps `{ success, data }`, so this is typically undefined.
   */
  success?: boolean;
  bot: ProvisionedBot;
  mcp: ProvisionedMcp;
  base: ProvisionedBaseWallet;
  onboardingInstructions?: string;
  onboarding?: {
    mode: AgentOnboardingMode;
    chainId: number;
    registryVerified: boolean;
    identityProvider?: string;
  };
  identityAccess?: IdentityAccess;
};

export type SiweNonceResponse = {
  message: string;
  nonce?: string;
  issuedAt?: string;
  expiresAt?: string;
};

export type OnboardWithSiweInput = {
  message: string;
  signature: string;
  agentId: string;
  /** Optional existing bot binding target (owned bot id). */
  botId?: string;
  /** Requested MCP key scope. Defaults to "trade" if omitted. */
  scope?: "read" | "trade";
};

export type OnboardWithIdentityInput = {
  provider: string;
  identityToken: string;
  agentId: string;
  /** Optional existing bot binding target (owned bot id). */
  botId?: string;
  chainId?: number;
  /** Requested MCP key scope. Defaults to "trade" if omitted. */
  scope?: "read" | "trade";
};

export type RequestSiweNonceInput = {
  address: string;
  chainId: number;
  domain: string;
  uri: string;
  statement?: string;
};

export type RevokeIdentityTokenInput = {
  jti: string;
  ttlSeconds?: number;
};

export type IdentityTokenRevokeStatusInput = {
  jti: string;
};

export type IdentityTokenRevokeResponse = {
  revoked: boolean;
  jti: string;
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpListToolsResponse = {
  tools: McpTool[];
};

export type McpTextContent = {
  type: "text";
  text: string;
};

export type McpCallToolResponse = {
  content: McpTextContent[];
  isError?: boolean;
};

/** Structured response from agent mode LLM calls */
export type AgentResponse = {
  answer: string;
  confidence: number;
  sources?: string[];
  tool_calls?: Array<{
    tool_name: string;
    result: unknown;
    success: boolean;
  }>;
  follow_up_suggestions?: string[];
};

/** x-balchemy extension fields present in MCP tools/list entries */
export type McpToolExtensions = {
  'x-balchemy-category'?: string;
  'x-balchemy-data-contract'?: string;
  'x-balchemy-requires-scope'?: string;
  'x-balchemy-rate-limit'?: string;
};

/** Extended MCP tool with balchemy metadata from the tools/list response */
export type McpToolWithMetadata = McpTool & {
  extensions?: McpToolExtensions;
};

export type AgentSdkConfig = {
  /**
   * Base URL for the Balchemy API, including the `/api` path segment.
   *
   * The SDK appends endpoint paths (e.g. `/public/erc8004/onboarding/identity`)
   * directly to this value, so it must NOT have a trailing slash.
   *
   * @example
   * // Local development
   * apiBaseUrl: "http://localhost:3000/api"
   *
   * @example
   * // Production
   * apiBaseUrl: "https://api.balchemy.ai/api"
   */
  apiBaseUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};
