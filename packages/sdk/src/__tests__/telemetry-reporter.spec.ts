import { TelemetryReporter } from '../agent-loop/telemetry-reporter';

type ReporterHarness = {
  flush(): Promise<void>;
};

describe('TelemetryReporter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('retries failed batches with attempt metadata', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const reporter = new TelemetryReporter('https://api.example.test/telemetry', 'key-1');
    const harness = reporter as unknown as ReporterHarness;

    reporter.reportDecision({ action: 'buy', token: 'BONK', amount: '0.1' });

    await harness.flush();
    expect(reporter.getLastFailureReason()).toBe('network down');
    await harness.flush();
    expect(reporter.getLastFailureReason()).toBe('');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as Record<string, unknown>;
    expect(firstBody.batchId).toBe(secondBody.batchId);
    expect(firstBody.attemptCount).toBe(1);
    expect(secondBody.attemptCount).toBe(2);
    expect(firstBody.sdkVersion).toBe('0.1.15');
    expect(secondBody.events).toEqual(firstBody.events);
  });

  it('keeps the in-memory spool bounded and reports dropped entries', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const reporter = new TelemetryReporter('https://api.example.test/telemetry', 'key-1', 30_000, 2);
    const harness = reporter as unknown as ReporterHarness;

    reporter.reportDecision({ action: 'hold', token: 'A' });
    reporter.reportDecision({ action: 'hold', token: 'B' });
    reporter.reportDecision({ action: 'hold', token: 'C' });

    await harness.flush();

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
      droppedCount: number;
      events: Array<{ token: string }>;
    };
    expect(body.droppedCount).toBe(1);
    expect(body.events.map((event) => event.token)).toEqual(['B', 'C']);
  });

  it('allows SDK and CLI version metadata overrides', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const reporter = new TelemetryReporter(
      'https://api.example.test/telemetry',
      'key-1',
      30_000,
      1_000,
      { sdkVersion: '9.9.9', cliVersion: '8.8.8' },
    );
    const harness = reporter as unknown as ReporterHarness;

    reporter.reportDecision({ action: 'hold' });
    await harness.flush();

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
      sdkVersion: string;
      cliVersion: string;
    };
    expect(body.sdkVersion).toBe('9.9.9');
    expect(body.cliVersion).toBe('8.8.8');
  });
});
