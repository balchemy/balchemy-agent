/**
 * SseEventStream — lightweight SSE consumer.
 *
 * Parses the text/event-stream protocol and emits typed events via
 * an async iterator or a callback-based subscribe API.
 *
 * Usage (async iterator):
 *   const stream = new SseEventStream(endpoint, apiKey);
 *   for await (const event of stream) {
 *     handleEvent(event);
 *   }
 *
 * Usage (callback):
 *   const unsub = stream.subscribe((event) => { ... }, onError);
 *   // later:
 *   unsub();
 */

import { AgentSdkError } from "../errors/agent-sdk-error";

export type SseEvent = {
  event: string;
  data: unknown;
  id?: string;
};

export type SseStreamOptions = {
  /** Reconnect delay in ms after an unexpected close. 0 = no reconnect. Default: 2000 */
  reconnectDelayMs?: number;
  /** Max reconnect delay cap in ms (for exponential backoff). Default: 30000 */
  maxReconnectDelayMs?: number;
  /** Max reconnect attempts. 0 = unlimited. Default: 0 (unlimited) */
  maxReconnects?: number;
  /** Jitter factor (0-1). Adds randomness to reconnect delay. Default: 0.25 */
  jitterFactor?: number;
  /** Optional fetch override (useful in tests). */
  fetchFn?: typeof fetch;
};

export class SseEventStream implements AsyncIterable<SseEvent> {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly maxReconnects: number;
  private readonly jitterFactor: number;
  private readonly fetchFn: typeof fetch;
  private closed = false;
  private reconnectCount = 0;
  private lastEventId: string | undefined;

  constructor(endpoint: string, apiKey: string, options?: SseStreamOptions) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.reconnectDelayMs = options?.reconnectDelayMs ?? 2000;
    this.maxReconnectDelayMs = options?.maxReconnectDelayMs ?? 30_000;
    this.maxReconnects = options?.maxReconnects ?? 0; // 0 = unlimited
    this.jitterFactor = options?.jitterFactor ?? 0.25;
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Subscribe with a callback. Returns an unsubscribe function.
   */
  subscribe(
    onEvent: (event: SseEvent) => void,
    onError?: (err: unknown) => void
  ): () => void {
    let active = true;

    const run = async (): Promise<void> => {
      try {
        for await (const event of this) {
          if (!active) break;
          onEvent(event);
        }
      } catch (err: unknown) {
        if (active) {
          onError?.(err);
        }
      }
    };

    void run();

    return () => {
      active = false;
      this.close();
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<SseEvent> {
    return this.createIterator();
  }

  private createIterator(): AsyncIterator<SseEvent> {
    const queue: SseEvent[] = [];
    const resolvers: Array<(value: IteratorResult<SseEvent>) => void> = [];
    let done = false;
    let error: unknown = null;

    const push = (event: SseEvent): void => {
      if (resolvers.length > 0) {
        const resolve = resolvers.shift()!;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    const finish = (err?: unknown): void => {
      done = true;
      error = err ?? null;
      for (const resolve of resolvers) {
        if (err) {
          resolve({ value: undefined as unknown as SseEvent, done: true });
        } else {
          resolve({ value: undefined as unknown as SseEvent, done: true });
        }
      }
      resolvers.length = 0;
    };

    // Start consuming in background
    void this.consume(push, finish);

    return {
      next(): Promise<IteratorResult<SseEvent>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (done) {
          if (error) {
            return Promise.reject(error);
          }
          return Promise.resolve({ value: undefined as unknown as SseEvent, done: true });
        }
        return new Promise<IteratorResult<SseEvent>>((resolve) => {
          resolvers.push(resolve);
        });
      },
      return(): Promise<IteratorResult<SseEvent>> {
        finish();
        return Promise.resolve({ value: undefined as unknown as SseEvent, done: true });
      },
    };
  }

  private async consume(
    push: (event: SseEvent) => void,
    finish: (err?: unknown) => void
  ): Promise<void> {
    while (!this.closed) {
      try {
        await this.readStream(push);
        // Clean close from server
        if (this.reconnectDelayMs === 0) break;
        if (this.maxReconnects > 0 && this.reconnectCount >= this.maxReconnects) break;
      } catch (err: unknown) {
        if (this.closed) break;
        if (this.reconnectDelayMs === 0) break;
        if (this.maxReconnects > 0 && this.reconnectCount >= this.maxReconnects) {
          finish(err);
          return;
        }
      }

      if (this.closed) break;
      if (this.reconnectDelayMs === 0) break;
      this.reconnectCount++;

      // Exponential backoff with jitter, capped at maxReconnectDelayMs
      const baseDelay = Math.min(
        this.reconnectDelayMs * Math.pow(2, Math.min(this.reconnectCount - 1, 10)),
        this.maxReconnectDelayMs
      );
      const jitter = baseDelay * this.jitterFactor * (Math.random() * 2 - 1);
      const delay = Math.max(0, baseDelay + jitter);
      await this.sleep(delay);
    }
    finish();
  }

  private async readStream(push: (event: SseEvent) => void): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.lastEventId) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    const response = await this.fetchFn(this.endpoint, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new AgentSdkError({
        code: response.status === 401 || response.status === 403
          ? "provider_auth_error"
          : "execution_error",
        status: response.status,
        message: `SSE stream error: HTTP ${response.status}`,
      });
    }

    if (!response.body) {
      throw new AgentSdkError({
        code: "invalid_response",
        message: "SSE response has no body",
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Current event fields
    let eventType = "message";
    let dataLines: string[] = [];
    let eventId: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, "");

          if (line === "") {
            // Dispatch event
            if (dataLines.length > 0) {
              const rawData = dataLines.join("\n");
              let parsedData: unknown = rawData;
              try {
                parsedData = JSON.parse(rawData) as unknown;
              } catch {
                // keep as string
              }
              push({ event: eventType, data: parsedData, id: eventId });
            }
            // Reset
            eventType = "message";
            dataLines = [];
            eventId = undefined;
            continue;
          }

          if (line.startsWith(":")) {
            // Comment — ignore
            continue;
          }

          const colonIdx = line.indexOf(":");
          let field: string;
          let fieldValue: string;

          if (colonIdx === -1) {
            field = line;
            fieldValue = "";
          } else {
            field = line.slice(0, colonIdx);
            fieldValue = line.slice(colonIdx + 1).replace(/^ /, "");
          }

          switch (field) {
            case "event":
              eventType = fieldValue;
              break;
            case "data":
              dataLines.push(fieldValue);
              break;
            case "id":
              eventId = fieldValue;
              this.lastEventId = fieldValue;
              break;
            case "retry": {
              // Server-sent reconnect hint — ignore for now
              break;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));
  }
}
