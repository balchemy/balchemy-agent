/**
 * TelemetryReporter
 *
 * Reports SDK-side agent activity (LLM calls, decisions, model routing) to
 * the Balchemy server for ClickHouse analytics.
 *
 * Design principles:
 * - All sends are fire-and-forget — errors are silently swallowed.
 * - Events are batched; the flush runs every flushIntervalMs (default 30 s).
 * - A final flush is triggered synchronously on stop().
 */

export type TelemetryEntryType = 'llm_call' | 'decision' | 'model_route';

export interface LlmCallData {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
}

export interface DecisionData {
  action: string;
  token?: string;
  amount?: string;
  confidence?: number;
  reasoning?: string;
}

export interface ModelRouteData {
  eventType: string;
  score: number;
  selectedModel: string;
  tier: 'cheap' | 'full';
}

export type TelemetryEntry =
  | ({ type: 'llm_call'; timestamp: number } & LlmCallData)
  | ({ type: 'decision'; timestamp: number } & DecisionData)
  | ({ type: 'model_route'; timestamp: number } & ModelRouteData);

export class TelemetryReporter {
  private readonly buffer: TelemetryEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** Full URL: e.g. https://api.balchemy.ai/api/agent-telemetry/abc123 */
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly flushIntervalMs: number = 30_000,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Allow the process to exit even if this timer is still active
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Best-effort final flush — do not await; caller should not block on telemetry
    void this.flush();
  }

  reportLlmCall(data: LlmCallData): void {
    this.buffer.push({ type: 'llm_call', timestamp: Date.now(), ...data });
  }

  reportDecision(data: DecisionData): void {
    this.buffer.push({ type: 'decision', timestamp: Date.now(), ...data });
  }

  reportModelRoute(data: ModelRouteData): void {
    this.buffer.push({ type: 'model_route', timestamp: Date.now(), ...data });
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    // Drain atomically — if fetch throws, events are lost (intentional: telemetry
    // must never block the agent loop or accumulate indefinitely on a dead server).
    const batch = this.buffer.splice(0);
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      // Fire-and-forget — telemetry failures must not propagate to the agent loop
    }
  }
}
