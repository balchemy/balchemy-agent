import { WebhookReceiver } from '../agent-loop/webhook-receiver';
import * as crypto from 'node:crypto';

describe('WebhookReceiver', () => {
  const secret = 'test-secret-32-chars-minimum-ok!';

  it('should verify valid HMAC signature', () => {
    const receiver = new WebhookReceiver({ secret, port: 0 });
    const body = JSON.stringify({ type: 'test', trace_id: 'abc' });
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    expect(receiver.verifySignature(body, signature)).toBe(true);
  });

  it('should reject invalid signature', () => {
    const receiver = new WebhookReceiver({ secret, port: 0 });
    expect(receiver.verifySignature('body', 'invalid')).toBe(false);
  });

  it('should deduplicate by trace_id', () => {
    const receiver = new WebhookReceiver({ secret, port: 0 });
    expect(receiver.isDuplicate('trace-1')).toBe(false);
    expect(receiver.isDuplicate('trace-1')).toBe(true);
    expect(receiver.isDuplicate('trace-2')).toBe(false);
  });

  it('should expire dedup entries after TTL', () => {
    const receiver = new WebhookReceiver({ secret, port: 0, dedupTtlMs: 50 });
    expect(receiver.isDuplicate('trace-3')).toBe(false);
    // After TTL, should allow again
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        receiver.cleanup();
        expect(receiver.isDuplicate('trace-3')).toBe(false);
        resolve();
      }, 60);
    });
  });
});
