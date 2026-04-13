import type { LlmAdapter, LlmMessage, LlmResponse } from '../types';

export class OpenAiAdapter implements LlmAdapter {
  private readonly apiKey: string;
  private activeModel: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(apiKey: string, model?: string, timeoutMs?: number, baseUrl?: string) {
    this.apiKey = apiKey;
    this.activeModel = model ?? 'gpt-5.4-mini';
    this.timeoutMs = timeoutMs ?? 10_000;
    this.baseUrl = (baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  setModel(model: string): void {
    this.activeModel = model;
  }

  async chat(messages: LlmMessage[], maxTokens?: number): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.activeModel,
          messages,
          max_completion_tokens: maxTokens ?? 500,
          store: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${text}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage: { prompt_tokens: number; completion_tokens: number };
      };

      return {
        text: data.choices[0]?.message?.content ?? '',
        model: data.model,
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
