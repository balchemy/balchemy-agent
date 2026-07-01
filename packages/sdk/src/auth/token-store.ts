/**
 * TokenStore — in-memory token lifecycle manager.
 *
 * Holds the current identityAccess token and refreshes it automatically
 * before expiry. The refresh callback is provided by the consumer
 * (typically AgentOnboardingClient.onboardWithIdentity / onboardWithSiwe).
 *
 * Token is considered stale when less than `refreshBufferSec` seconds remain.
 * Default buffer: 30 seconds.
 */

export type StoredToken = {
  token: string;
  tokenType: "Bearer";
  expiresAt: Date;
  kid: string;
  issuer: string;
  scope: "read" | "trade";
};

export type TokenRefreshFn = () => Promise<StoredToken>;

export type TokenStoreOptions = {
  /** Seconds before expiry to proactively refresh. Default: 30 */
  refreshBufferSec?: number;
};

export class TokenStore {
  private current: StoredToken | null = null;
  private refreshing: Promise<StoredToken> | null = null;
  private readonly refreshBufferMs: number;

  constructor(
    private readonly refreshFn: TokenRefreshFn,
    options?: TokenStoreOptions
  ) {
    this.refreshBufferMs = (options?.refreshBufferSec ?? 30) * 1000;
  }

  /**
   * Returns the current valid token, refreshing if necessary.
   * Concurrent calls during an in-flight refresh share the same Promise.
   */
  async getToken(): Promise<string> {
    if (this.current && !this.isStale(this.current)) {
      return this.current.token;
    }
    return (await this.ensureRefresh()).token;
  }

  /** Returns the full stored token object (or null if never set). */
  getCurrent(): StoredToken | null {
    return this.current;
  }

  /** Forcefully sets the current token (e.g. from an onboarding response). */
  set(token: StoredToken): void {
    this.current = token;
  }

  /** Invalidates the current token, forcing the next call to refresh. */
  invalidate(): void {
    this.current = null;
  }

  // ── private ──────────────────────────────────────────────────────────────

  private isStale(token: StoredToken): boolean {
    return token.expiresAt.getTime() - Date.now() < this.refreshBufferMs;
  }

  private ensureRefresh(): Promise<StoredToken> {
    if (this.refreshing) {
      return this.refreshing;
    }
    this.refreshing = this.refreshFn()
      .then((token) => {
        this.current = token;
        this.refreshing = null;
        return token;
      })
      .catch((err: unknown) => {
        this.refreshing = null;
        throw err;
      });
    return this.refreshing;
  }
}
