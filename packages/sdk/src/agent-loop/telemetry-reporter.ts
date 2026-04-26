/**
 * TelemetryReporter
 *
 * Reports SDK-side agent activity (LLM calls, decisions, model routing) to
 * the Balchemy server for ClickHouse analytics.
 *
 * Design principles:
 * - Sends are fire-and-forget from the agent loop, but failed batches are retried
 *   from a bounded in-memory spool.
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

interface TelemetryBatch {
  batchId: string;
  events: TelemetryEntry[];
  attemptCount: number;
  droppedCount: number;
}

export interface TelemetryReporterMetadata {
  sdkVersion?: string;
  cliVersion?: string;
}

const DEFAULT_MAX_BUFFERED_ENTRIES = 1_000;
const MAX_EVENTS_PER_BATCH = 200;
const BALCHEMY_AGENT_SDK_VERSION = '0.1.15';

export class TelemetryReporter {
  private readonly buffer: TelemetryEntry[] = [];
  private readonly retryQueue: TelemetryBatch[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private droppedSinceLastBatch = 0;
  private batchSequence = 0;
  private lastFailureReason = '';

  constructor(
    /** Full URL: e.g. https://api.balchemy.ai/api/agent-telemetry/abc123 */
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly flushIntervalMs: number = 30_000,
    private readonly maxBufferedEntries: number = DEFAULT_MAX_BUFFERED_ENTRIES,
    private readonly metadata: TelemetryReporterMetadata = {},
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
    this.enqueue({ type: 'llm_call', timestamp: Date.now(), ...data });
  }

  reportDecision(data: DecisionData): void {
    this.enqueue({ type: 'decision', timestamp: Date.now(), ...data });
  }

  reportModelRoute(data: ModelRouteData): void {
    this.enqueue({ type: 'model_route', timestamp: Date.now(), ...data });
  }

  getLastFailureReason(): string {
    return this.lastFailureReason;
  }

  private async flush(): Promise<void> {
    const batch = this.nextBatch();
    if (!batch) return;

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          batchId: batch.batchId,
          attemptCount: batch.attemptCount,
          droppedCount: batch.droppedCount,
          sdkVersion: this.metadata.sdkVersion ?? BALCHEMY_AGENT_SDK_VERSION,
          cliVersion: this.metadata.cliVersion,
          events: batch.events,
        }),
      });
      if (!response.ok) {
        throw new Error(`telemetry ingest failed: ${response.status}`);
      }
      if (this.retryQueue[0]?.batchId === batch.batchId) {
        this.retryQueue.shift();
      }
      this.lastFailureReason = '';
    } catch (error: unknown) {
      this.lastFailureReason = error instanceof Error ? error.message : String(error);
      batch.attemptCount++;
      if (!this.retryQueue.some((item) => item.batchId === batch.batchId)) {
        this.retryQueue.unshift(batch);
      }
      this.trimToCapacity();
    }
  }

  private enqueue(entry: TelemetryEntry): void {
    this.buffer.push(entry);
    this.trimToCapacity();
  }

  private nextBatch(): TelemetryBatch | null {
    const retryBatch = this.retryQueue[0];
    if (retryBatch) {
      return retryBatch;
    }
    if (this.buffer.length === 0) {
      return null;
    }

    const events = this.buffer.splice(0, MAX_EVENTS_PER_BATCH);
    const batch: TelemetryBatch = {
      batchId: `sdk-${Date.now()}-${++this.batchSequence}`,
      events,
      attemptCount: 1,
      droppedCount: this.droppedSinceLastBatch,
    };
    this.droppedSinceLastBatch = 0;
    return batch;
  }

  private trimToCapacity(): void {
    while (this.pendingEntryCount() > this.maxBufferedEntries) {
      const droppedFromBuffer = this.buffer.shift();
      if (droppedFromBuffer) {
        this.droppedSinceLastBatch++;
        continue;
      }

      const oldestRetry = this.retryQueue[this.retryQueue.length - 1];
      const droppedFromRetry = oldestRetry?.events.shift();
      if (droppedFromRetry) {
        this.droppedSinceLastBatch++;
        if (oldestRetry.events.length === 0) {
          this.retryQueue.pop();
        }
        continue;
      }

      return;
    }
  }

  private pendingEntryCount(): number {
    return this.retryQueue.reduce(
      (count, batch) => count + batch.events.length,
      this.buffer.length,
    );
  }
}
