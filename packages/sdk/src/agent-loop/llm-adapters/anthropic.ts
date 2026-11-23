import type { LlmAdapter, LlmMessage, LlmResponse, LlmRequestOptions } from '../types';
import { postLlmJson } from './transport';
import { isLlmModelId } from './model-id';

const MAX_RESPONSE_TEXT_CHARS = 64 * 1024;
const MAX_REQUEST_TEXT_CHARS = 256 * 1024;
const MAX_MESSAGES = 100;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseAnthropicResponse(value: unknown): LlmResponse {
  const record = asRecord(value);
  const content = Array.isArray(record?.content) ? record.content : [];
  const blocks = content.map(asRecord);
  const usage = asRecord(record?.usage);
  const text = blocks.map((block) => typeof block?.text === 'string' ? block.text : '').join('');
  const model = record?.model;
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  if (
    record?.type !== 'message'
    || record.role !== 'assistant'
    || record.stop_reason !== 'end_turn'
    || asRecord(record.stop_details)?.type === 'refusal'
    || blocks.length === 0
    || blocks.some((block) => block?.type !== 'text' || typeof block.text !== 'string')
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
    throw new Error('Anthropic returned an invalid response envelope');
  }
  return { text, model, inputTokens: inputTokens as number, outputTokens: outputTokens as number };
}

export class AnthropicAdapter implements LlmAdapter {
  private readonly apiKey: string;
  private activeModel: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(apiKey: string, model?: string, timeoutMs?: number, fetchFn?: typeof fetch) {
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4_096) {
      throw new Error('Anthropic API key is invalid');
    }
    this.apiKey = apiKey;
    this.activeModel = model ?? 'claude-haiku-4-5-20251001';
    this.timeoutMs = timeoutMs ?? 10_000;
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error('Anthropic timeout is invalid');
    }
    this.setModel(this.activeModel);
  }

  setModel(model: string): void {
    if (!isLlmModelId(model)) {
      throw new Error('Anthropic model name is invalid');
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
      || messages.filter((message) => message.role === 'system').length > 1
      || messages.every((message) => message.role === 'system')
    ) {
      throw new Error('Anthropic messages exceed the SDK request limits');
    }
    const tokenLimit = maxTokens ?? 500;
    if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0 || tokenLimit > 16_384) {
      throw new Error('Anthropic maxTokens is invalid');
    }
    // Separate system message from conversation
    const systemMsg = messages.find(m => m.role === 'system');
    const conversationMsgs = messages.filter(m => m.role !== 'system');

    return parseAnthropicResponse(await postLlmJson('Anthropic', 'https://api.anthropic.com/v1/messages', {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }, JSON.stringify({
      model: this.activeModel,
      max_tokens: tokenLimit,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: conversationMsgs.map(m => ({
        role: m.role,
        content: m.content,
      })),
    }), this.timeoutMs, this.fetchFn, options?.signal));
  }
}
