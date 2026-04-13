import type { LlmAdapter, LlmMessage, LlmResponse } from '../types';

export class AnthropicAdapter implements LlmAdapter {
  private readonly apiKey: string;
  private activeModel: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model?: string, timeoutMs?: number) {
    this.apiKey = apiKey;
    this.activeModel = model ?? 'claude-haiku-4-5-20251001';
    this.timeoutMs = timeoutMs ?? 10_000;
  }

  setModel(model: string): void {
    this.activeModel = model;
  }

  async chat(messages: LlmMessage[], maxTokens?: number): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Separate system message from conversation
    const systemMsg = messages.find(m => m.role === 'system');
    const conversationMsgs = messages.filter(m => m.role !== 'system');

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.activeModel,
          max_tokens: maxTokens ?? 500,
          ...(systemMsg ? { system: systemMsg.content } : {}),
          messages: conversationMsgs.map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${text}`);
      }

      const data = await response.json() as {
        content: Array<{ type: string; text: string }>;
        model: string;
        usage: { input_tokens: number; output_tokens: number };
      };

      const textContent = data.content.find(c => c.type === 'text');

      return {
        text: textContent?.text ?? '',
        model: data.model,
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
