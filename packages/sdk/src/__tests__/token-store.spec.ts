import { TokenStore, type StoredToken } from '../auth/token-store';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

function buildToken(params: {
  token: string;
  expiresInMs: number;
  scope: 'read' | 'trade';
}): StoredToken {
  return {
    token: params.token,
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + params.expiresInMs),
    kid: 'kid-1',
    issuer: 'https://api.balchemy.ai',
    scope: params.scope,
  };
}

describe('TokenStore', () => {
  it('returns current token without refresh when token is not stale', async () => {
    let refreshCalls = 0;
    const refreshFn = async (): Promise<StoredToken> => {
      refreshCalls += 1;
      return buildToken({ token: 'refreshed-token', expiresInMs: 120_000, scope: 'trade' });
    };
    const store = new TokenStore(refreshFn, { refreshBufferSec: 30 });
    store.set(buildToken({ token: 'existing-token', expiresInMs: 120_000, scope: 'trade' }));

    const token = await store.getToken();
    expect(token).toBe('existing-token');
    expect(refreshCalls).toBe(0);
  });

  it('refreshes and stores token when current token is missing', async () => {
    let refreshCalls = 0;
    const refreshFn = async (): Promise<StoredToken> => {
      refreshCalls += 1;
      return buildToken({ token: 'new-token', expiresInMs: 120_000, scope: 'trade' });
    };
    const store = new TokenStore(refreshFn, { refreshBufferSec: 30 });

    const token = await store.getToken();
    expect(token).toBe('new-token');
    expect(refreshCalls).toBe(1);
    expect(store.getCurrent()?.token).toBe('new-token');
  });

  it('refreshes when token is stale under refresh buffer', async () => {
    let refreshCalls = 0;
    const refreshFn = async (): Promise<StoredToken> => {
      refreshCalls += 1;
      return buildToken({ token: 'fresh-token', expiresInMs: 120_000, scope: 'trade' });
    };
    const store = new TokenStore(refreshFn, { refreshBufferSec: 30 });
    store.set(buildToken({ token: 'stale-token', expiresInMs: 5_000, scope: 'trade' }));

    const token = await store.getToken();
    expect(token).toBe('fresh-token');
    expect(refreshCalls).toBe(1);
  });

  it('does not refresh when token lifetime equals refresh buffer exactly', async () => {
    let refreshCalls = 0;
    const refreshFn = async (): Promise<StoredToken> => {
      refreshCalls += 1;
      return buildToken({ token: 'fresh-token', expiresInMs: 120_000, scope: 'trade' });
    };
    const store = new TokenStore(refreshFn, { refreshBufferSec: 30 });
    store.set(buildToken({ token: 'edge-token', expiresInMs: 30_000, scope: 'trade' }));

    const token = await store.getToken();
    expect(token).toBe('edge-token');
    expect(refreshCalls).toBe(0);
  });

  it('deduplicates concurrent refresh calls', async () => {
    let resolveRefresh: (value: StoredToken) => void = () => {
      throw new Error('resolveRefresh was not initialized');
    };
    const refreshPromise = new Promise<StoredToken>((resolve) => {
      resolveRefresh = (value: StoredToken) => {
        resolve(value);
      };
    });

    let refreshCalls = 0;
    const refreshFn = (): Promise<StoredToken> => {
      refreshCalls += 1;
      return refreshPromise;
    };
    const store = new TokenStore(refreshFn, { refreshBufferSec: 30 });

    const first = store.getToken();
    const second = store.getToken();

    expect(refreshCalls).toBe(1);

    resolveRefresh(buildToken({ token: 'shared-token', expiresInMs: 120_000, scope: 'trade' }));

    const firstToken = await first;
    const secondToken = await second;
    expect(firstToken).toBe('shared-token');
    expect(secondToken).toBe('shared-token');
    expect(refreshCalls).toBe(1);
  });

  it('invalidates current token and refreshes on next getToken call', async () => {
    let refreshCalls = 0;
    const refreshFn = async (): Promise<StoredToken> => {
      refreshCalls += 1;
      return buildToken({ token: 'after-invalidate', expiresInMs: 120_000, scope: 'trade' });
    };
    const store = new TokenStore(refreshFn, { refreshBufferSec: 30 });
    store.set(buildToken({ token: 'cached-token', expiresInMs: 120_000, scope: 'trade' }));

    store.invalidate();

    const token = await store.getToken();
    expect(token).toBe('after-invalidate');
    expect(refreshCalls).toBe(1);
  });

  it('keeps previous token when refresh fails', async () => {
    let refreshCalls = 0;
    const refreshFn = async (): Promise<StoredToken> => {
      refreshCalls += 1;
      throw new Error('refresh failed');
    };
    const store = new TokenStore(refreshFn, { refreshBufferSec: 30 });
    const stale = buildToken({ token: 'stale-token', expiresInMs: 5_000, scope: 'trade' });
    store.set(stale);

    let failed = false;
    try {
      await store.getToken();
    } catch (error: unknown) {
      failed = true;
      expect(error instanceof Error ? error.message : '').toBe('refresh failed');
    }

    expect(failed).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(store.getCurrent()).toEqual(stale);
  });

  it('accepts scope downgrade on refresh result', async () => {
    const refreshFn = async (): Promise<StoredToken> =>
      buildToken({ token: 'downgraded-token', expiresInMs: 120_000, scope: 'read' });
    const store = new TokenStore(refreshFn, { refreshBufferSec: 30 });
    store.set(buildToken({ token: 'trade-token', expiresInMs: 5_000, scope: 'trade' }));

    const token = await store.getToken();
    expect(token).toBe('downgraded-token');
    expect(store.getCurrent()?.scope).toBe('read');
  });
});
