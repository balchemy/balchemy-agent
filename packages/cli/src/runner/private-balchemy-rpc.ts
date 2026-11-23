/** Owner decision of 17 Nov 2026: users are never asked for a Solana RPC. Balchemy provides two independent providers and the
 * runner connects to both DIRECTLY (no Balchemy proxy). This module holds each agent's grant (POST rpc-access/{nonce,grant}, the
 * runner proof, SDK RunnerRpcAccessClient) and pins its hosts on the runner's own table, independent of Balchemy.
 *
 * - Fetched only while the agent holds its live runtime lease; held IN MEMORY only (never written, logged or sent anywhere).
 * - Refreshed at or after `refreshAfter`; at once (spaced at least PRIVATE_BALCHEMY_RPC_MIN_SPACING_MS, single flight per agent) after
 *   a provider 401/403. A credential that is refused again after a refresh to the same value backs off instead of looping.
 * - Backoff: 429 the server's Retry-After (at least 10 s); 503 `rpc_access_unavailable` 5 minutes; anything else 5 s doubling to
 *   5 minutes. A failed refresh keeps the current grant; a bearer source past its `expiresAt` is unavailable until a refresh succeeds.
 * - Pinning (pinPrivateBalchemyRpcGrant): each source's provider must be one of PRIVATE_BALCHEMY_RPC_HOSTS and its URL https on one of
 *   that provider's hosts on the default port; the two must be different providers on different registrable domains. A grant that
 *   fails is refused (kept out; the current one, already pinned, stays until it is replaced).
 * - Network (Phase 1 audit L7): a pinned host such as `*.rpcpool.com` also serves other clusters, so before a grant is adopted each
 *   source whose URL this runner has not verified yet answers getGenesisHash, which must be Solana mainnet-beta's
 *   (PRIVATE_SOLANA_MAINNET_GENESIS_HASH). A mismatch refuses the grant (`wrong_network`), also one found later (the held grant is
 *   dropped). A grant is adopted once at least one source verified; a source whose read failed stays unavailable (sourceAvailable)
 *   until a later read verifies it (retried in `pass`, 30 s doubling to 5 minutes), so one provider down at a restart never leaves
 *   exits without the other. No source verified: nothing is adopted and the request is retried with backoff (the current grant stays).
 *   Verified per source URL (not per credential), so a refreshed JWT on the same endpoint is not re-checked.
 * Every status and message names the providers only, never a URL, host path, key, token or header value. */
import { createHash } from "node:crypto";
import { RUNNER_RPC_ACCESS_UNAVAILABLE, type RunnerRpcAccessGrant } from "@balchemyai/agent-sdk";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import { isId } from "./protocol.js";
import { PrivateRpcLagPositives, type PrivateRpcLagTracker } from "./private-solana-rpc-sources.js";
import { addRunnerAgent } from "./agent-roster.js";

/** Solana mainnet-beta's genesis hash (audit L7): the only cluster a Balchemy-provided source may serve. */
export const PRIVATE_SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAX_VERIFIED_URLS = 16;

export const PRIVATE_BALCHEMY_RPC_PROVIDERS = ["alchemy", "helius", "quicknode", "triton", "syndica"] as const;
export type PrivateBalchemyRpcProvider = typeof PRIVATE_BALCHEMY_RPC_PROVIDERS[number];
/** The runner's own pin table (the backend applies the same one, but the runner never relies on it). A leading `*.` is one or more
 * DNS labels before the suffix, with a dot boundary. */
export const PRIVATE_BALCHEMY_RPC_HOSTS: Readonly<Record<PrivateBalchemyRpcProvider, readonly string[]>> = Object.freeze({
  alchemy: Object.freeze(["solana-mainnet.g.alchemy.com"]),
  helius: Object.freeze(["mainnet.helius-rpc.com"]),
  quicknode: Object.freeze(["*.solana-mainnet.quiknode.pro"]),
  triton: Object.freeze(["*.rpcpool.com"]),
  syndica: Object.freeze(["solana-mainnet.api.syndica.io"]),
});
export type PrivateBalchemyRpcHostTable = Readonly<Record<string, readonly string[]>>;
export const PRIVATE_BALCHEMY_RPC_MIN_SPACING_MS = 10_000;
export const PRIVATE_BALCHEMY_RPC_UNCONFIGURED_BACKOFF_MS = 5 * 60_000;
export const PRIVATE_BALCHEMY_RPC_MAX_BACKOFF_MS = 5 * 60_000;
/** A source that failed (timeout, transport, 429) is not queried for this long, so one provider down never makes every read of a
 * preflight wait out its timeout (the blockhash would expire before an exit could go out). */
export const PRIVATE_BALCHEMY_RPC_SOURCE_COOLDOWN_MS = 30_000;

/** Closed state of an agent's Balchemy-provided connection (owner-local IPC, setup and cockpit). `ready`: a pinned grant is held;
 * `waiting`: none yet and nothing for the owner to do (no lease yet, first fetch pending, a transient failure); `unavailable`: none
 * can be obtained right now (Balchemy has not configured it, the grant was refused by the pin table, repeated failures). */
export const PRIVATE_BALCHEMY_RPC_STATES = ["ready", "waiting", "unavailable"] as const;
export type PrivateBalchemyRpcState = typeof PRIVATE_BALCHEMY_RPC_STATES[number];
/** `wrong_network` (audit L7): a source of the grant is not Solana mainnet-beta, so the grant was refused. `rpc_source_lag_accepted`
 * (audit M2): recently, one source showed a finalized trade that landed while the other kept answering it has none, and the runner
 * opened that buy's position on the one that showed it (the position-opening read only, after repeated checks; never a sell). */
export const PRIVATE_BALCHEMY_RPC_REASONS = ["lease_unavailable", "grant_pending", "access_unavailable", "rate_limited", "request_failed",
  "grant_refused", "source_unavailable", "rpc_sources_disagree", "wrong_network", "rpc_source_lag_accepted"] as const;
export type PrivateBalchemyRpcReason = typeof PRIVATE_BALCHEMY_RPC_REASONS[number];
export interface PrivateBalchemyRpcStatus {
  state: PrivateBalchemyRpcState;
  /** Both provider names while `ready`, else empty. */
  providers: readonly string[];
  reason: PrivateBalchemyRpcReason | null;
  /** When two answering sources last disagreed (closed reason rpc_sources_disagree), else null. */
  disagreedAt: number | null;
}

/** Closed parse of the status (owner-local IPC): exact keys, closed enums, provider names from the closed set only. */
export function parsePrivateBalchemyRpcStatus(value: unknown): PrivateBalchemyRpcStatus {
  const invalid = (): never => { throw new Error("Invalid Balchemy RPC status"); };
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "disagreedAt,providers,reason,state" || Reflect.ownKeys(record).length !== 4) invalid();
  const { state, providers, reason, disagreedAt } = record;
  if (!(PRIVATE_BALCHEMY_RPC_STATES as readonly unknown[]).includes(state) || !Array.isArray(providers)
    || !providers.every((item) => (PRIVATE_BALCHEMY_RPC_PROVIDERS as readonly unknown[]).includes(item))
    || (state === "ready" ? providers.length !== 2 || providers[0] === providers[1] : providers.length !== 0)
    || (reason !== null && !(PRIVATE_BALCHEMY_RPC_REASONS as readonly unknown[]).includes(reason))
    || (disagreedAt !== null && (typeof disagreedAt !== "number" || !Number.isSafeInteger(disagreedAt) || disagreedAt < 0))) invalid();
  return Object.freeze({ state: state as PrivateBalchemyRpcState, providers: Object.freeze([...(providers as string[])]),
    reason: reason as PrivateBalchemyRpcReason | null, disagreedAt: disagreedAt as number | null });
}

export interface PrivateBalchemyRpcSource {
  readonly id: "a" | "b";
  readonly provider: PrivateBalchemyRpcProvider;
  /** Full URL (may carry a provider key). Never display or log it. */
  readonly url: string;
  /** Credential headers for PrivateSolanaRpc (empty for `none`). Never display or log them. */
  readonly headers: Readonly<Record<string, string>>;
  /** A bearer credential's expiry, else null (none and header credentials carry no expiry in the grant). */
  readonly expiresAtMs: number | null;
  /** Identity of this credential (SHA-256 of URL and headers), to tell a rotated credential from the same one. Never displayed. */
  readonly fingerprint: string;
}
export interface PrivateBalchemyRpcGrant {
  readonly issuedAtMs: number;
  readonly refreshAfterMs: number;
  readonly sources: readonly [PrivateBalchemyRpcSource, PrivateBalchemyRpcSource];
}

/** True when `hostname` is one of `provider`'s pinned hosts in `table`. */
export function privateBalchemyRpcHostPinned(provider: string, hostname: string, table: PrivateBalchemyRpcHostTable = PRIVATE_BALCHEMY_RPC_HOSTS): boolean {
  const patterns = Object.prototype.hasOwnProperty.call(table, provider) ? table[provider] : undefined;
  if (!patterns) return false;
  const host = hostname.toLowerCase();
  return patterns.some((pattern) => {
    if (!pattern.startsWith("*.")) return host === pattern;
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host.slice(0, host.length - suffix.length));
  });
}
/** The registrable domain as the last two DNS labels (every pinned provider host's: alchemy.com, helius-rpc.com, quiknode.pro, ...).
 * Independent of the table, so two pinned hosts on one domain are still refused. */
export function privateRegistrableDomain(hostname: string): string { return hostname.toLowerCase().split(".").slice(-2).join("."); }

/** The runner's own pin of a parsed grant (SDK validateRunnerRpcAccessGrant already enforced its exact shape). Null when refused. */
export function pinPrivateBalchemyRpcGrant(grant: RunnerRpcAccessGrant, table: PrivateBalchemyRpcHostTable = PRIVATE_BALCHEMY_RPC_HOSTS): PrivateBalchemyRpcGrant | null {
  try {
    const issuedAtMs = Date.parse(grant.issuedAt); const refreshAfterMs = Date.parse(grant.refreshAfter);
    if (grant.version !== 1 || !Number.isFinite(issuedAtMs) || !Number.isFinite(refreshAfterMs) || refreshAfterMs <= issuedAtMs
      || !Array.isArray(grant.sources) || grant.sources.length !== 2) return null;
    const sources = grant.sources.map((source, index) => {
      const id = index === 0 ? "a" as const : "b" as const;
      if (source.id !== id || !(PRIVATE_BALCHEMY_RPC_PROVIDERS as readonly string[]).includes(source.provider)) return null;
      let url: URL; try { url = new URL(source.url); } catch { return null; }
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port !== ""
        || !privateBalchemyRpcHostPinned(source.provider, url.hostname, table)) return null;
      const auth = source.auth;
      const headers: Record<string, string> = auth.kind === "bearer" ? { authorization: `Bearer ${auth.token}` }
        : auth.kind === "header" ? { [auth.name]: auth.value } : {};
      const expiresAtMs = auth.kind === "bearer" ? Date.parse(auth.expiresAt) : null;
      if (expiresAtMs !== null && !Number.isFinite(expiresAtMs)) return null;
      const fingerprint = createHash("sha256").update(JSON.stringify([source.url, Object.entries(headers)]), "utf8").digest("hex");
      return Object.freeze({ id, provider: source.provider as PrivateBalchemyRpcProvider, url: source.url, headers: Object.freeze(headers), expiresAtMs, fingerprint });
    });
    const [a, b] = sources;
    if (!a || !b || a.provider === b.provider
      || privateRegistrableDomain(new URL(a.url).hostname) === privateRegistrableDomain(new URL(b.url).hostname)) return null;
    return Object.freeze({ issuedAtMs, refreshAfterMs, sources: Object.freeze([a, b]) as unknown as readonly [PrivateBalchemyRpcSource, PrivateBalchemyRpcSource] });
  } catch { return null; }
}

/** What a failed grant request was, from the SDK error's public fields only (status, machine code, Retry-After). */
export interface PrivateBalchemyRpcFailure { status?: number; code?: string; retryAfterSeconds?: number; refused?: boolean; wrongNetwork?: boolean }
export interface PrivateBalchemyRpcAccessOptions {
  agentIds: readonly string[];
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  /** One signed grant request (SDK RunnerRpcAccessClient.grant under the runner key); throws the SDK error. */
  fetchGrant(agentId: string, lease: Readonly<RunnerRuntimeActiveLease>, signal: AbortSignal): Promise<RunnerRpcAccessGrant>;
  /** Audit L7: one getGenesisHash read on this source (the daemon: PrivateSolanaRpc over the source's URL and headers); throws when
   * the read fails. Read once per new source URL, before the grant is adopted. */
  readGenesisHash(source: PrivateBalchemyRpcSource, signal: AbortSignal): Promise<string>;
  now?(): number;
  /** Test seam; production uses PRIVATE_BALCHEMY_RPC_HOSTS. */
  hosts?: PrivateBalchemyRpcHostTable;
}
interface Entry {
  grant: PrivateBalchemyRpcGrant | null;
  inflight: boolean;
  nextAttemptAt: number;
  lastAttemptAt: number;
  failures: number;
  reason: PrivateBalchemyRpcReason | null;
  unavailable: boolean;
  refreshNow: boolean;
  disagreedAt: number | null;
  /** Per source: down until (cooldown) and the fingerprint last refused with 401/403. */
  downUntil: { a: number; b: number };
  refused: { a: string | null; b: string | null };
  refusedStreak: { a: number; b: number };
  /** Audit L7: SHA-256 of each source URL whose genesis hash was read as mainnet-beta (memory only, bounded); whether each source of
   * the held grant is verified (an unverified one is unavailable); the background re-read of an unverified source. */
  verifiedUrls: Set<string>;
  verifiedSource: { a: boolean; b: boolean };
  verifying: boolean;
  verifyNextAt: number;
  verifyFailures: number;
  /** Audit M2: lag passes of exit-class finalized positives, and when one was last accepted on one source. */
  lag: PrivateRpcLagPositives;
  lagAcceptedAt: number | null;
}
const urlDigest = (url: string): string => createHash("sha256").update(url, "utf8").digest("hex");
function failureOf(error: unknown): PrivateBalchemyRpcFailure {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  return { ...(typeof record.status === "number" ? { status: record.status } : {}), ...(typeof record.machineCode === "string" ? { code: record.machineCode } : {}),
    ...(typeof record.retryAfterSeconds === "number" && Number.isFinite(record.retryAfterSeconds) ? { retryAfterSeconds: record.retryAfterSeconds } : {}) };
}

export class PrivateBalchemyRpcAccess {
  readonly #options: PrivateBalchemyRpcAccessOptions;
  readonly #agentIds: string[];
  readonly #entries = new Map<string, Entry>();
  readonly #abort = new AbortController();
  #closed = false;
  constructor(options: PrivateBalchemyRpcAccessOptions) {
    if (!Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.readLease !== "function"
      || typeof options.fetchGrant !== "function" || typeof options.readGenesisHash !== "function") throw new Error("Invalid Balchemy RPC access options");
    this.#agentIds = [...options.agentIds];
    this.#options = { ...options, agentIds: this.#agentIds };
    for (const agentId of options.agentIds) this.#entries.set(agentId, this.#newEntry());
  }
  /** One agent's empty entry (no grant: fetched once its lease exists). */
  #newEntry(): Entry {
    const entry: Entry = { grant: null, inflight: false, nextAttemptAt: 0, lastAttemptAt: Number.NEGATIVE_INFINITY, failures: 0, reason: null,
      unavailable: false, refreshNow: false, disagreedAt: null, downUntil: { a: 0, b: 0 }, refused: { a: null, b: null }, refusedStreak: { a: 0, b: 0 },
      verifiedUrls: new Set(), verifiedSource: { a: false, b: false }, verifying: false, verifyNextAt: 0, verifyFailures: 0, lag: new PrivateRpcLagPositives({ now: () => this.#now(), onAccepted: () => { entry.lagAcceptedAt = this.#now(); } }),
      lagAcceptedAt: null };
    return entry;
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon gets the same empty entry the constructor
   * gives every agent; every other agent's grant, cooldowns and lag memory are untouched. Idempotent; throws (changing nothing) on an
   * invalid id or past 64 agents. */
  addAgent(agentId: string): void { if (addRunnerAgent(this.#agentIds, agentId)) this.#entries.set(agentId, this.#newEntry()); }
  #now(): number { return (this.#options.now ?? Date.now)(); }

  /** The pinned grant held for this agent (it may carry an expired bearer source: see sourceAvailable), else undefined. */
  grant(agentId: string): PrivateBalchemyRpcGrant | undefined { return this.#entries.get(agentId)?.grant ?? undefined; }
  /** False while the source's credential expired or the source is inside its failure cooldown. */
  sourceAvailable(agentId: string, source: "a" | "b"): boolean {
    const entry = this.#entries.get(agentId); const grant = entry?.grant;
    if (!entry || !grant) return false;
    const now = this.#now(); const held = grant.sources[source === "a" ? 0 : 1];
    return entry.verifiedSource[source] && (held.expiresAtMs === null || held.expiresAtMs > now) && entry.downUntil[source] <= now;
  }
  /** A source read failed with a closed code (never a value). 401/403 asks for a refresh; transport failures start the cooldown. */
  reportFailure(agentId: string, source: "a" | "b", code: string): void {
    const entry = this.#entries.get(agentId); const grant = entry?.grant;
    if (!entry || !grant || this.#closed) return;
    const now = this.#now();
    if (code === "unauthorized") {
      const fingerprint = grant.sources[source === "a" ? 0 : 1].fingerprint;
      // The same credential refused again after a refresh: back off (doubling) instead of looping on a dead credential.
      entry.refusedStreak[source] = entry.refused[source] === fingerprint ? entry.refusedStreak[source] + 1 : 1;
      entry.refused[source] = fingerprint;
      entry.downUntil[source] = now + Math.min(PRIVATE_BALCHEMY_RPC_MAX_BACKOFF_MS, PRIVATE_BALCHEMY_RPC_SOURCE_COOLDOWN_MS * 2 ** (entry.refusedStreak[source] - 1));
      if (entry.refusedStreak[source] === 1) { entry.refreshNow = true; entry.nextAttemptAt = Math.max(now, entry.lastAttemptAt + PRIVATE_BALCHEMY_RPC_MIN_SPACING_MS); }
      return;
    }
    if (code === "timeout" || code === "transport_unavailable" || code === "rate_limited" || code === "response_too_large" || code === "invalid_response"
      || code === "rpc_error") entry.downUntil[source] = Math.max(entry.downUntil[source], now + PRIVATE_BALCHEMY_RPC_SOURCE_COOLDOWN_MS);
  }
  /** Two answering sources disagreed (closed reason; logged nowhere with a value). */
  reportDisagreement(agentId: string): void { const entry = this.#entries.get(agentId); if (entry) entry.disagreedAt = this.#now(); }
  /** Audit M2: this agent's lag-pass memory for the dual-source readers (an accepted positive is reported in `status`). */
  lagPositives(agentId: string): PrivateRpcLagTracker | undefined { return this.#entries.get(agentId)?.lag; }

  status(agentId: string): PrivateBalchemyRpcStatus {
    const entry = this.#entries.get(agentId);
    if (!entry) return Object.freeze({ state: "unavailable", providers: Object.freeze([]), reason: "request_failed", disagreedAt: null });
    const disagreedAt = entry.disagreedAt;
    if (entry.grant) {
      const now = this.#now();
      const down = !this.sourceAvailable(agentId, "a") || !this.sourceAvailable(agentId, "b");
      const recent = (at: number | null): boolean => at !== null && now - at < 10 * 60_000;
      return Object.freeze({ state: "ready", providers: Object.freeze(entry.grant.sources.map((source) => source.provider)),
        reason: recent(disagreedAt) ? "rpc_sources_disagree" : recent(entry.lagAcceptedAt) ? "rpc_source_lag_accepted" : down ? "source_unavailable" : null,
        disagreedAt });
    }
    if (entry.unavailable) return Object.freeze({ state: "unavailable", providers: Object.freeze([]), reason: entry.reason ?? "request_failed", disagreedAt });
    const lease = this.#options.readLease(agentId);
    return Object.freeze({ state: "waiting", providers: Object.freeze([]), reason: !lease ? "lease_unavailable" : entry.reason ?? "grant_pending", disagreedAt });
  }

  /** One pass: start a grant request for each agent that needs one and may make one now (lease held, spacing and backoff passed,
   * none in flight). Never throws; never awaits the requests (each settles on its own). */
  pass(): void {
    if (this.#closed) return;
    const now = this.#now();
    for (const [agentId, entry] of this.#entries) {
      // Audit L7: a held grant's unverified source is re-read (never while a grant request or another re-read is in flight).
      if (entry.grant && !entry.inflight && !entry.verifying && (!entry.verifiedSource.a || !entry.verifiedSource.b) && now >= entry.verifyNextAt) {
        void this.#reverify(entry, entry.grant);
      }
      const due = !entry.grant || entry.refreshNow || now >= entry.grant.refreshAfterMs;
      if (!due || entry.inflight || entry.verifying || now < entry.nextAttemptAt || now < entry.lastAttemptAt + PRIVATE_BALCHEMY_RPC_MIN_SPACING_MS) continue;
      let lease: Readonly<RunnerRuntimeActiveLease> | undefined;
      try { lease = this.#options.readLease(agentId); } catch { lease = undefined; }
      if (!lease) continue;
      void this.#request(agentId, entry, lease);
    }
  }
  async #request(agentId: string, entry: Entry, lease: Readonly<RunnerRuntimeActiveLease>): Promise<void> {
    entry.inflight = true; entry.lastAttemptAt = this.#now(); entry.refreshNow = false;
    try {
      let received: RunnerRpcAccessGrant;
      try { received = await this.#options.fetchGrant(agentId, lease, this.#abort.signal); }
      catch (error: unknown) { if (!this.#closed) this.#failed(entry, failureOf(error)); return; }
      if (this.#closed) return;
      const pinned = pinPrivateBalchemyRpcGrant(received, this.#options.hosts);
      if (!pinned) { this.#failed(entry, { refused: true }); return; }
      // Audit L7: a source is used only once it answered Solana mainnet-beta's genesis hash; any other cluster refuses the grant.
      let network: "verified" | "mismatch" | "unverified";
      try { network = await this.#verifyNetwork(entry, pinned); } catch { if (!this.#closed) this.#failed(entry, {}); return; }
      if (this.#closed) return;
      if (network === "mismatch") { this.#failed(entry, { refused: true, wrongNetwork: true }); return; }
      const verified = { a: entry.verifiedUrls.has(urlDigest(pinned.sources[0].url)), b: entry.verifiedUrls.has(urlDigest(pinned.sources[1].url)) };
      // No source verified: nothing is adopted (never an unverified grant); one verified: adopted, the other stays unavailable.
      if (!verified.a && !verified.b) { this.#failed(entry, {}); return; }
      const previous = entry.grant;
      entry.grant = pinned; entry.failures = 0; entry.reason = null; entry.unavailable = false; entry.nextAttemptAt = 0;
      entry.verifiedSource = verified;
      if (network === "unverified") this.#verifyLater(entry); else entry.verifyFailures = 0;
      // A rotated credential lifts its 401 cooldown; the same one keeps it (reportFailure backs off).
      for (const [index, id] of (["a", "b"] as const).entries()) {
        const source = pinned.sources[index]!;
        if (previous?.sources[index]?.fingerprint !== source.fingerprint && entry.refused[id] !== source.fingerprint) { entry.downUntil[id] = 0; entry.refusedStreak[id] = 0; }
      }
    } finally { entry.inflight = false; }
  }
  /** Audit L7: one getGenesisHash per source URL not verified yet, both in parallel. `mismatch` when any answered another cluster;
   * `unverified` when a read failed (that source stays unavailable); each matching URL is remembered either way. */
  async #verifyNetwork(entry: Entry, grant: PrivateBalchemyRpcGrant): Promise<"verified" | "mismatch" | "unverified"> {
    const pending = grant.sources.filter((source) => !entry.verifiedUrls.has(urlDigest(source.url)));
    if (pending.length === 0) return "verified";
    // A reader that throws synchronously (for example a header over the runner's cap) is one failed source, never a daemon crash.
    const results = await Promise.allSettled(pending.map((source) => Promise.resolve().then(() => this.#options.readGenesisHash(source, this.#abort.signal))));
    let outcome: "verified" | "mismatch" | "unverified" = "verified";
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") { if (outcome === "verified") outcome = "unverified"; continue; }
      if (result.value !== PRIVATE_SOLANA_MAINNET_GENESIS_HASH) { outcome = "mismatch"; continue; }
      if (entry.verifiedUrls.size >= MAX_VERIFIED_URLS) entry.verifiedUrls.clear();
      entry.verifiedUrls.add(urlDigest(pending[index]!.url));
    }
    return outcome;
  }
  /** Audit L7: the background re-read of a held grant's unverified source. A mismatch drops the whole grant (`wrong_network`); a
   * result for a grant that was replaced meanwhile is discarded. */
  async #reverify(entry: Entry, grant: PrivateBalchemyRpcGrant): Promise<void> {
    entry.verifying = true;
    try {
      let network: "verified" | "mismatch" | "unverified";
      try { network = await this.#verifyNetwork(entry, grant); } catch { network = "unverified"; }
      if (this.#closed || entry.grant !== grant) return;
      if (network === "mismatch") { entry.grant = null; this.#failed(entry, { refused: true, wrongNetwork: true }); return; }
      entry.verifiedSource = { a: entry.verifiedUrls.has(urlDigest(grant.sources[0].url)), b: entry.verifiedUrls.has(urlDigest(grant.sources[1].url)) };
      if (network === "unverified") this.#verifyLater(entry); else entry.verifyFailures = 0;
    } catch { this.#verifyLater(entry); }
    finally { entry.verifying = false; }
  }
  #verifyLater(entry: Entry): void {
    entry.verifyFailures += 1;
    entry.verifyNextAt = this.#now() + Math.min(PRIVATE_BALCHEMY_RPC_MAX_BACKOFF_MS, PRIVATE_BALCHEMY_RPC_SOURCE_COOLDOWN_MS * 2 ** Math.min(entry.verifyFailures - 1, 10));
  }
  #failed(entry: Entry, failure: PrivateBalchemyRpcFailure): void {
    const now = this.#now();
    entry.failures += 1;
    const doubling = Math.min(PRIVATE_BALCHEMY_RPC_MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(entry.failures - 1, 10));
    if (failure.refused) {
      entry.reason = failure.wrongNetwork ? "wrong_network" : "grant_refused"; entry.unavailable = true;
      entry.nextAttemptAt = now + PRIVATE_BALCHEMY_RPC_UNCONFIGURED_BACKOFF_MS; return;
    }
    if (failure.status === 503 && failure.code === RUNNER_RPC_ACCESS_UNAVAILABLE) {
      entry.reason = "access_unavailable"; entry.unavailable = true; entry.nextAttemptAt = now + PRIVATE_BALCHEMY_RPC_UNCONFIGURED_BACKOFF_MS; return;
    }
    if (failure.status === 429) {
      entry.reason = "rate_limited"; entry.unavailable = entry.failures >= 3;
      entry.nextAttemptAt = now + Math.max(PRIVATE_BALCHEMY_RPC_MIN_SPACING_MS, (failure.retryAfterSeconds ?? 0) * 1000); return;
    }
    entry.reason = "request_failed"; entry.unavailable = entry.failures >= 3; entry.nextAttemptAt = now + doubling;
  }
  close(): void { this.#closed = true; this.#abort.abort(); for (const entry of this.#entries.values()) entry.grant = null; }
}
