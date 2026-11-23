export type LlmProvider = 'anthropic' | 'openai' | 'custom';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The charge in USD the provider itself reported for this call (OpenRouter `usage.cost`), when present.
   * Absent when the provider reports none, or when the call ran on the caller's own provider key (BYOK). */
  costUsd?: number;
}

export interface LlmAdapter {
  chat(messages: LlmMessage[], maxTokens?: number, options?: LlmRequestOptions): Promise<LlmResponse>;
  /** Override the active model for the next call(s). */
  setModel(model: string): void;
}

export interface LlmRequestOptions {
  /** Stops waiting and aborts transport; it does not prove cancellation at the provider. */
  signal?: AbortSignal;
  /**
   * Opt-in request for one JSON object as the reply. It is a hint, not a guarantee: the OpenAI adapter sends
   * `response_format: { type: 'json_object' }` only to the official OpenAI endpoint (https://api.openai.com/v1);
   * other OpenAI-protocol endpoints (OpenRouter, self-hosted) and the Anthropic adapter ignore it. The caller still
   * validates the text, and its messages must mention JSON (OpenAI refuses JSON mode otherwise).
   */
  jsonObject?: boolean;
}

export interface LlmTokenPricing {
  /** USD per one million input tokens. */
  input: number;
  /** USD per one million output tokens. */
  output: number;
}
