import type { LlmAdapter, LlmMessage, LlmResponse, LlmRequestOptions } from '../types';
import { postLlmJson } from './transport';
import { isLlmModelId } from './model-id';

const MAX_RESPONSE_TEXT_CHARS = 64 * 1024;
const MAX_REQUEST_TEXT_CHARS = 256 * 1024;
const MAX_MESSAGES = 100;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseOpenAiResponse(value: unknown): LlmResponse {
  const record = asRecord(value);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const usage = asRecord(record?.usage);
  const text = message?.content;
  const model = record?.model;
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  if (
    choices.length !== 1
    || choice?.finish_reason !== 'stop'
    || message?.role !== 'assistant'
    || (message.refusal !== null && message.refusal !== undefined)
    || (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0))
    || (message.function_call !== undefined && message.function_call !== null)
    || typeof text !== 'string'
    || text.length === 0
    || text.length > MAX_RESPONSE_TEXT_CHARS
    || typeof model !== 'string'
    || model.length === 0
    || model.length > 160
    || !Number.isSafeInteger(inputTokens)
    || (inputTokens as number) < 0
    || !Number.isSafeInteger(outputTokens)
    || (outputTokens as number) < 0
  ) {
    throw new Error('OpenAI returned an invalid response envelope');
  }
  // OpenRouter (same protocol) reports its own charge as `usage.cost`. It is optional and never fails the response;
  // a BYOK charge may differ from the upstream bill, so it is not surfaced.
  const cost = usage?.cost;
  const costUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= 1_000_000 && usage?.is_byok !== true
    ? cost : undefined;
  return { text, model, inputTokens: inputTokens as number, outputTokens: outputTokens as number,
    ...(costUsd === undefined ? {} : { costUsd }) };
}

export class OpenAiAdapter implements LlmAdapter {
  private readonly apiKey: string;
  private activeModel: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(apiKey: string, model?: string, timeoutMs?: number, baseUrl?: string, fetchFn?: typeof fetch) {
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4_096) {
      throw new Error('OpenAI API key is invalid');
    }
    this.apiKey = apiKey;
    this.activeModel = model ?? 'gpt-5.4-mini';
    this.timeoutMs = timeoutMs ?? 10_000;
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error('OpenAI timeout is invalid');
    }
    let parsedBaseUrl: URL;
    try { parsedBaseUrl = new URL(baseUrl ?? OPENAI_BASE_URL); }
    catch { throw new Error('OpenAI base URL is invalid'); }
    const loopback = parsedBaseUrl.hostname === '127.0.0.1' || parsedBaseUrl.hostname === '[::1]';
    if (
      (parsedBaseUrl.protocol !== 'https:' && !(parsedBaseUrl.protocol === 'http:' && loopback))
      || parsedBaseUrl.username
      || parsedBaseUrl.password
      || parsedBaseUrl.search
      || parsedBaseUrl.hash
    ) {
      throw new Error('OpenAI base URL is invalid');
    }
    this.baseUrl = parsedBaseUrl.toString().replace(/\/+$/, '');
    this.setModel(this.activeModel);
  }

  setModel(model: string): void {
    if (!isLlmModelId(model)) {
      throw new Error('OpenAI model name is invalid');
    }
    this.activeModel = model;
  }

  async chat(messages: LlmMessage[], maxTokens?: number, options?: LlmRequestOptions): Promise<LlmResponse> {
    if (
      !Array.isArray(messages)
      || messages.length === 0
      || messages.length > MAX_MESSAGES
      || messages.some((message) => (
        !message || (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant')
        || typeof message.content !== 'string'
        || message.content.length === 0
      ))
      || messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8'), 0) > MAX_REQUEST_TEXT_CHARS
    ) {
      throw new Error('OpenAI messages exceed the SDK request limits');
    }
    const tokenLimit = maxTokens ?? 500;
    if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0 || tokenLimit > 16_384) {
      throw new Error('OpenAI maxTokens is invalid');
    }
    if (this.baseUrl === OPENAI_BASE_URL && !this.apiKey.startsWith('sk-')) {
      throw new Error(
        'OpenAI ChatGPT subscription login is not a Platform API key. Use an API key from platform.openai.com/api-keys for the local runner.',
      );
    }

    return parseOpenAiResponse(await postLlmJson('OpenAI', `${this.baseUrl}/chat/completions`, {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    }, JSON.stringify({
      model: this.activeModel,
      messages: messages.map(({ role, content }) => ({ role, content })),
      max_completion_tokens: tokenLimit,
      store: false,
      // Opt-in JSON mode, official OpenAI endpoint only: OpenAI-protocol providers that reject the field never receive it.
      ...(options?.jsonObject === true && this.baseUrl === OPENAI_BASE_URL ? { response_format: { type: 'json_object' } } : {}),
    }), this.timeoutMs, this.fetchFn, options?.signal));
  }
}
