import { readBoundedResponseText } from '../../utils/redaction';

type Provider = 'OpenAI' | 'Anthropic';
const MAX_RESPONSE_BYTES = 256 * 1024;

class SafeTransportError extends Error {}

/** One request only. Never forward private prompts or credentials through redirects. */
export async function postLlmJson(
  provider: Provider,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new Error(`${provider} request was cancelled`);
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: (error: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    rejectAbort(new SafeTransportError(`${provider} request ${timedOut ? 'timed out' : 'was cancelled'}`));
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);

  const request = async (): Promise<unknown> => {
    const response = await fetchFn(url, {
      method: 'POST', headers: { ...headers, 'Cache-Control': 'no-store' }, body, signal: controller.signal,
      redirect: 'error', credentials: 'omit',
    });
    if (controller.signal.aborted || !response.ok || response.redirected) {
      // Also release a response returned after cancellation by a custom transport.
      void response.body?.cancel().catch(() => undefined);
      if (controller.signal.aborted) throw new SafeTransportError(`${provider} request ${timedOut ? 'timed out' : 'was cancelled'}`);
      if (response.redirected) throw new SafeTransportError(`${provider} response used a redirect`);
      throw new SafeTransportError(`${provider} request failed with HTTP ${response.status}`);
    }
    const raw = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, controller.signal);
    if (controller.signal.aborted) throw new SafeTransportError(`${provider} request ${timedOut ? 'timed out' : 'was cancelled'}`);
    try { return JSON.parse(raw) as unknown; }
    catch { throw new SafeTransportError(`${provider} returned invalid JSON`); }
  };

  try {
    // A caller-supplied transport must not bypass the timeout by ignoring AbortSignal.
    return await Promise.race([request(), cancelled]);
  } catch (error: unknown) {
    if (error instanceof SafeTransportError) throw error;
    if (controller.signal.aborted) throw new Error(`${provider} request ${timedOut ? 'timed out' : 'was cancelled'}`);
    // Fetch errors/causes may contain a credential-bearing URL or provider payload.
    throw new Error(`${provider} request failed`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
