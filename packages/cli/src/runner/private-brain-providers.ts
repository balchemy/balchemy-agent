/** The closed set of model providers the local runner can use with the owner's API key, and the fixed endpoint of each.
 * A provider name always maps to exactly one endpoint in this table: no URL is ever accepted from IPC, a saved record or
 * the owner. Saved records of 0.6.0 (`openai` and `anthropic`, IDs without `/`) stay valid unchanged. */
import { isLlmModelId, type LocalLlmAdapterConfig } from "@balchemyai/agent-sdk";

export const PRIVATE_BRAIN_PROVIDERS = ["openai", "anthropic", "openrouter"] as const;
export type PrivateBrainProvider = typeof PRIVATE_BRAIN_PROVIDERS[number];

export function isPrivateBrainProvider(value: unknown): value is PrivateBrainProvider {
  return typeof value === "string" && (PRIVATE_BRAIN_PROVIDERS as readonly string[]).includes(value);
}
/** 1-160 characters; letters, digits, `.`, `_`, `:` and `-`, optionally in `/`-separated segments (`vendor/model`). */
export function isPrivateBrainModelId(value: unknown): value is string { return isLlmModelId(value); }

/** OpenRouter speaks the OpenAI chat-completions protocol at its own fixed host. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const PRIVATE_BRAIN_PROVIDER_LABELS: Readonly<Record<PrivateBrainProvider, string>> = Object.freeze({
  openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter",
});

/** The SDK adapter configuration for one provider: the endpoint comes only from this table. */
export function privateBrainAdapterConfig(config: { provider: PrivateBrainProvider; model: string; apiKey: string }): LocalLlmAdapterConfig {
  switch (config.provider) {
    case "openai": return { provider: "openai", model: config.model, apiKey: config.apiKey };
    case "anthropic": return { provider: "anthropic", model: config.model, apiKey: config.apiKey };
    case "openrouter": return { provider: "openai", baseUrl: OPENROUTER_BASE_URL, model: config.model, apiKey: config.apiKey };
  }
}
