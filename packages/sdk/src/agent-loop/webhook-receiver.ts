import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AgentEvent } from './types';

export interface WebhookReceiverConfig {
  secret: string;
  port: number;
  dedupTtlMs?: number;
}

export class WebhookReceiver {
  private readonly secret: string;
  private readonly port: number;
  private readonly dedupTtlMs: number;
  private readonly seen = new Map<string, number>();
  private server: http.Server | null = null;
  private onEvent: ((event: AgentEvent) => void) | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: WebhookReceiverConfig) {
    this.secret = config.secret;
    this.port = config.port;
    this.dedupTtlMs = config.dedupTtlMs ?? 300_000; // 5 minutes
  }

  verifySignature(body: string, signature: string): boolean {
    const expected = crypto
      .createHmac('sha256', this.secret)
      .update(body)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature, 'hex')
      );
    } catch {
      return false;
    }
  }

  isDuplicate(traceId: string): boolean {
    if (this.seen.has(traceId)) return true;
    this.seen.set(traceId, Date.now());
    return false;
  }

  cleanup(): void {
    const cutoff = Date.now() - this.dedupTtlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  async start(handler: (event: AgentEvent) => void): Promise<void> {
    if (this.port === 0) return;
    this.onEvent = handler;

    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/webhook') {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const signature = req.headers['x-balchemy-signature'] as string;
        if (!signature || !this.verifySignature(body, signature)) {
          res.writeHead(401);
          res.end('Invalid signature');
          return;
        }

        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          const traceId = parsed.trace_id as string;

          if (traceId && this.isDuplicate(traceId)) {
            res.writeHead(200);
            res.end('Duplicate');
            return;
          }

          const event: AgentEvent = {
            id: traceId,
            type: (parsed.type as string) ?? 'unknown',
            data: parsed,
            timestamp: Date.now(),
            source: 'webhook',
          };

          this.onEvent?.(event);
          res.writeHead(200);
          res.end('OK');
        } catch {
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
    });

    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
