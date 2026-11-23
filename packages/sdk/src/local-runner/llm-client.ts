import { OpenAiAdapter } from '../agent-loop/llm-adapters/openai';
import { AnthropicAdapter } from '../agent-loop/llm-adapters/anthropic';
import type { LlmAdapter } from '../agent-loop/types';
import { isLlmModelId } from '../agent-loop/llm-adapters/model-id';

interface LocalLlmConfig {
  /** Supplied by the user's process; never sent to a Balchemy endpoint. */
  apiKey: string;
  /** Explicit selection. This factory never selects a provider/model fallback. */
  model: string;
  timeoutMs?: number;
  /** Explicit caller-owned transport. It receives private prompts and credentials. */
  fetchFn?: typeof fetch;
}

export type LocalLlmAdapterConfig = LocalLlmConfig & (
  | { provider: 'openai'; baseUrl?: string }
  | { provider: 'anthropic' }
);

/** Local provider calls only; no server agent, private memory or execution authority. */
export function createLocalLlmAdapter(config: LocalLlmAdapterConfig): LlmAdapter {
  if (!config || !isLlmModelId(config.model)) {
    throw new Error('An explicit valid local LLM model is required');
  }
  if (config.fetchFn !== undefined && typeof config.fetchFn !== 'function') {
    throw new Error('Local LLM transport is invalid');
  }
  switch (config.provider) {
    case 'openai':
      return new OpenAiAdapter(config.apiKey, config.model, config.timeoutMs, config.baseUrl, config.fetchFn);
    case 'anthropic':
      return new AnthropicAdapter(config.apiKey, config.model, config.timeoutMs, config.fetchFn);
    default:
      throw new Error('Local LLM provider is unsupported');
  }
}
