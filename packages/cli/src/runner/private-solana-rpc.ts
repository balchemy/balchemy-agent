/** Minimal bounded JSON-RPC client for the runner's OWN configured Solana endpoint. Read-only methods
 * plus unsigned simulation; it cannot send. https only (plain http solely for numeric loopback), no
 * URL credentials, redirects refused, response size capped while streaming, one deadline per call and
 * caller cancellation. The endpoint URL often embeds a provider key: it never appears in errors,
 * results or logs; only `redactedSolanaRpcHost` may be displayed. */
import { decodeBase58, isSolanaAddress } from "./solana-base58.js";

export const PRIVATE_SOLANA_RPC_TIMEOUT_MS = 10_000;
export const PRIVATE_SOLANA_RPC_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 2048;
/** Well-known public endpoints: acceptable for shadow observation only (decision 12). */
export const PUBLIC_SOLANA_RPC_HOSTS = ["api.mainnet-beta.solana.com", "api.mainnet.solana.com", "api.devnet.solana.com",
  "api.testnet.solana.com", "solana-api.projectserum.com", "rpc.ankr.com", "solana-rpc.publicnode.com", "solana.public-rpc.com"] as const;

/** `unauthorized` (HTTP 401/403: the provider refused the credential; a Balchemy grant is then refreshed) and `rate_limited`
 * (HTTP 429) are transport failures with their own code; `sources_disagree` is raised only by the dual-source reader
 * (private-solana-rpc-sources.ts) when two answering sources disagree. */
export type PrivateSolanaRpcErrorCode = "endpoint_invalid" | "transport_unavailable" | "timeout" | "cancelled"
  | "response_too_large" | "invalid_response" | "rpc_error" | "request_invalid" | "unauthorized" | "rate_limited" | "sources_disagree";
export class PrivateSolanaRpcError extends Error {
  constructor(readonly code: PrivateSolanaRpcErrorCode) { super(`Local Solana RPC ${code}`); this.name = "PrivateSolanaRpcError"; }
}
function fail(code: PrivateSolanaRpcErrorCode): never { throw new PrivateSolanaRpcError(code); }

export interface PrivateSolanaRpcEndpoint {
  /** Full URL, possibly carrying a provider key. Never display or log it. */
  readonly url: string;
  readonly host: string;
  readonly transport: "https" | "loopback_http";
  readonly class: "owner_configured" | "public_shadow_only";
}
function numericLoopback(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}
/** Closed endpoint policy shared by the settings store, the CLI and this client. */
export function parsePrivateSolanaRpcEndpoint(value: unknown): PrivateSolanaRpcEndpoint {
  if (typeof value !== "string" || value.length < 8 || value.length > MAX_URL_LENGTH || /[\u0000- \u007f-\u009f]/.test(value)) fail("endpoint_invalid");
  let url: URL;
  try { url = new URL(value); } catch { return fail("endpoint_invalid"); }
  const hostname = url.hostname.toLowerCase();
  const transport = url.protocol === "https:" ? "https" : url.protocol === "http:" && numericLoopback(hostname) ? "loopback_http" : undefined;
  if (!transport || url.username || url.password || url.hash || !hostname || hostname.endsWith(".")) fail("endpoint_invalid");
  return Object.freeze({ url: url.href, host: url.host.toLowerCase(), transport,
    class: (PUBLIC_SOLANA_RPC_HOSTS as readonly string[]).includes(hostname) ? "public_shadow_only" as const : "owner_configured" as const });
}
/** The only displayable form of an endpoint: host (and port), never path, query or key. */
export function redactedSolanaRpcHost(value: string): string { return parsePrivateSolanaRpcEndpoint(value).host; }
/** True for exactly the `host` values `parsePrivateSolanaRpcEndpoint` derives (an accepted endpoint's host always passes): the host is
 * round-tripped through the same parser, over https and, for a numeric loopback host, http (a port equal to one scheme's default is
 * dropped by that scheme only). */
export function isPrivateSolanaRpcHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URL_LENGTH || /[/?#@\\]/.test(value)) return false;
  for (const scheme of ["https://", "http://"]) {
    try { if (parsePrivateSolanaRpcEndpoint(`${scheme}${value}/`).host === value) return true; } catch { /* Not this scheme. */ }
  }
  return false;
}

export type SolanaCommitment = "processed" | "confirmed" | "finalized";
export interface PrivateSolanaAccount { readonly owner: string; readonly lamports: bigint; readonly executable: boolean; readonly data: Uint8Array }
export interface PrivateSolanaRpcOptions {
  endpoint: string; timeoutMs?: number; maxResponseBytes?: number;
  /** Provider credential headers of a Balchemy-provided source (`authorization: Bearer <jwt>` or the provider's token header).
   * Names are lowercase and never one this client owns; values are printable ASCII. Secret: never displayed or logged. */
  headers?: Readonly<Record<string, string>>;
  /** Test seam only; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** Header names this client sets itself or that no provider credential may use. `authorization` is allowed (a bearer JWT). */
const RESERVED_HEADERS: readonly string[] = ["content-type", "accept", "cache-control", "host", "cookie", "content-length", "connection",
  "transfer-encoding", "accept-encoding", "user-agent", "proxy-authorization"];
function credentialHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail("request_invalid");
  const entries = Object.entries(value);
  if (entries.length > 2 || Reflect.ownKeys(value).length !== entries.length) fail("request_invalid");
  for (const [name, text] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || RESERVED_HEADERS.includes(name) || typeof text !== "string" || !/^[\x20-\x7e]{1,4096}$/.test(text)) fail("request_invalid");
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}
function safeInteger(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid_response"); return BigInt(value);
}
/** getTokenLargestAccounts answers at most this many accounts (the RPC's own bound). */
export const PRIVATE_SOLANA_LARGEST_ACCOUNTS_MAX = 20;
const U64_MAX = (1n << 64n) - 1n;
function u64Text(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) fail("invalid_response");
  const amount = BigInt(value); if (amount > U64_MAX) fail("invalid_response"); return amount;
}
function decimals(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 255) fail("invalid_response"); return value;
}
function commitment(value: SolanaCommitment | undefined): SolanaCommitment {
  const chosen = value ?? "confirmed"; if (!["processed", "confirmed", "finalized"].includes(chosen)) fail("request_invalid"); return chosen;
}
function base64Data(value: unknown, maxBytes: number): Uint8Array {
  if (!Array.isArray(value) || value.length !== 2 || value[1] !== "base64" || typeof value[0] !== "string"
    || value[0].length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value[0]) || value[0].length % 4 !== 0) fail("invalid_response");
  return Uint8Array.from(Buffer.from(value[0], "base64"));
}
function account(value: unknown, maxBytes: number): PrivateSolanaAccount | null {
  if (value === null) return null;
  if (!isRecord(value) || !isSolanaAddress(value.owner) || typeof value.executable !== "boolean") fail("invalid_response");
  return Object.freeze({ owner: value.owner, lamports: safeInteger(value.lamports), executable: value.executable, data: base64Data(value.data, maxBytes) });
}

export class PrivateSolanaRpc {
  readonly #endpoint: PrivateSolanaRpcEndpoint;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #fetch: typeof fetch;
  readonly #headers: Readonly<Record<string, string>>;
  #id = 0;

  constructor(options: PrivateSolanaRpcOptions) {
    if (!isRecord(options)) fail("request_invalid");
    this.#endpoint = parsePrivateSolanaRpcEndpoint(options.endpoint);
    const timeout = options.timeoutMs ?? PRIVATE_SOLANA_RPC_TIMEOUT_MS; const maxBytes = options.maxResponseBytes ?? PRIVATE_SOLANA_RPC_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024
      || maxBytes > 8 * 1024 * 1024 || (options.fetchFn !== undefined && typeof options.fetchFn !== "function")) fail("request_invalid");
    this.#timeoutMs = timeout; this.#maxBytes = maxBytes; this.#fetch = options.fetchFn ?? fetch;
    this.#headers = credentialHeaders(options.headers);
  }
  /** Display-safe identity of the endpoint. */
  get host(): string { return this.#endpoint.host; }
  get endpointClass(): PrivateSolanaRpcEndpoint["class"] { return this.#endpoint.class; }

  async getAccountInfo(address: string, options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<PrivateSolanaAccount | null> {
    if (!isSolanaAddress(address)) fail("request_invalid");
    const result = await this.#call("getAccountInfo", [address, { encoding: "base64", commitment: commitment(options.commitment) }], signal);
    if (!isRecord(result) || !("value" in result)) fail("invalid_response");
    return account(result.value, this.#maxBytes);
  }
  /** One atomic read at one slot (lookup tables plus the mint). */
  async getMultipleAccounts(addresses: readonly string[], options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<(PrivateSolanaAccount | null)[]> {
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 100 || !addresses.every(isSolanaAddress)) fail("request_invalid");
    const result = await this.#call("getMultipleAccounts", [[...addresses], { encoding: "base64", commitment: commitment(options.commitment) }], signal);
    if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== addresses.length) fail("invalid_response");
    return result.value.map((value: unknown) => account(value, this.#maxBytes));
  }
  async getLatestBlockhash(options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<{ blockhash: string; lastValidBlockHeight: bigint; contextSlot: bigint }> {
    const result = await this.#call("getLatestBlockhash", [{ commitment: commitment(options.commitment) }], signal);
    if (!isRecord(result) || !isRecord(result.context) || !isRecord(result.value) || !isSolanaAddress(result.value.blockhash)) fail("invalid_response");
    return Object.freeze({ blockhash: result.value.blockhash, lastValidBlockHeight: safeInteger(result.value.lastValidBlockHeight), contextSlot: safeInteger(result.context.slot) });
  }
  async isBlockhashValid(blockhash: string, options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<{ valid: boolean; contextSlot: bigint }> {
    if (!isSolanaAddress(blockhash)) fail("request_invalid");
    const result = await this.#call("isBlockhashValid", [blockhash, { commitment: commitment(options.commitment) }], signal);
    if (!isRecord(result) || !isRecord(result.context) || typeof result.value !== "boolean") fail("invalid_response");
    return Object.freeze({ valid: result.value, contextSlot: safeInteger(result.context.slot) });
  }
  async getBlockHeight(options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<bigint> {
    return safeInteger(await this.#call("getBlockHeight", [{ commitment: commitment(options.commitment) }], signal));
  }
  /** The cluster's genesis hash, base58 of 32 bytes (audit L7: a Balchemy-provided source must serve Solana mainnet-beta). */
  async getGenesisHash(signal?: AbortSignal): Promise<string> {
    const result = await this.#call("getGenesisHash", [], signal);
    if (typeof result !== "string" || decodeBase58(result, 32) === undefined) fail("invalid_response");
    return result;
  }
  /** Rent-exempt minimum in lamports for an account of `dataLength` bytes, as this node's bank computes it (the buy
   * simulation's created-account rent evidence; the evaluator bounds it). */
  async getMinimumBalanceForRentExemption(dataLength: number, options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<bigint> {
    if (!Number.isSafeInteger(dataLength) || dataLength < 0 || dataLength > 10 * 1024 * 1024) fail("request_invalid");
    return safeInteger(await this.#call("getMinimumBalanceForRentExemption", [dataLength, { commitment: commitment(options.commitment) }], signal));
  }
  /** The slot and the block height of ONE bank at `commitment` (one response, so both describe the same view). */
  async getEpochInfo(options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<{ absoluteSlot: bigint; blockHeight: bigint }> {
    const result = await this.#call("getEpochInfo", [{ commitment: commitment(options.commitment) }], signal);
    if (!isRecord(result)) fail("invalid_response");
    return Object.freeze({ absoluteSlot: safeInteger(result.absoluteSlot), blockHeight: safeInteger(result.blockHeight) });
  }
  /** Statuses of 1..8 exact signatures in ONE response (one backend's view at `contextSlot`); null where that node knows none.
   * `searchTransactionHistory` extends the search past the recent status cache into the node's ledger history. */
  async getSignatureStatuses(signatures: readonly string[], options: { searchTransactionHistory?: boolean } = {}, signal?: AbortSignal): Promise<{
    contextSlot: bigint; statuses: ReadonlyArray<{ slot: bigint; failed: boolean; confirmationStatus: "processed" | "confirmed" | "finalized" | null } | null>;
  }> {
    if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > 8 || !signatures.every((item) => typeof item === "string" && decodeBase58(item, 64) !== undefined)
      || (options.searchTransactionHistory !== undefined && typeof options.searchTransactionHistory !== "boolean")) fail("request_invalid");
    const result = await this.#call("getSignatureStatuses", [[...signatures], { searchTransactionHistory: options.searchTransactionHistory === true }], signal);
    if (!isRecord(result) || !isRecord(result.context) || !Array.isArray(result.value) || result.value.length !== signatures.length) fail("invalid_response");
    const contextSlot = safeInteger(result.context.slot);
    const statuses = result.value.map((value: unknown) => {
      if (value === null) return null;
      if (!isRecord(value) || !("err" in value)) fail("invalid_response");
      const status = value.confirmationStatus ?? null;
      if (status !== null && status !== "processed" && status !== "confirmed" && status !== "finalized") fail("invalid_response");
      return Object.freeze({ slot: safeInteger(value.slot), failed: value.err !== null, confirmationStatus: status as "processed" | "confirmed" | "finalized" | null });
    });
    return Object.freeze({ contextSlot, statuses: Object.freeze(statuses) });
  }
  /** Every token account `owner` holds under exactly one token program (`programId`), base64 data, in ONE response at
   * `commitment` (one backend's view at `contextSlot`). Strict: each entry is a non-executable account owned by `programId`
   * with a unique address; anything else is invalid_response. The wallet-balance settlement parses the data itself. */
  async getTokenAccountsByOwner(owner: string, programId: string, options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<{
    contextSlot: bigint; accounts: ReadonlyArray<{ readonly address: string; readonly data: Uint8Array }>;
  }> {
    if (!isSolanaAddress(owner) || !isSolanaAddress(programId)) fail("request_invalid");
    const result = await this.#call("getTokenAccountsByOwner", [owner, { programId }, { encoding: "base64", commitment: commitment(options.commitment) }], signal);
    if (!isRecord(result) || !isRecord(result.context) || !Array.isArray(result.value)) fail("invalid_response");
    const contextSlot = safeInteger(result.context.slot);
    const seen = new Set<string>();
    const accounts = result.value.map((entry: unknown) => {
      if (!isRecord(entry) || !isSolanaAddress(entry.pubkey) || seen.has(entry.pubkey)) fail("invalid_response");
      seen.add(entry.pubkey);
      const parsed = account(entry.account, this.#maxBytes);
      if (!parsed || parsed.owner !== programId || parsed.executable) fail("invalid_response");
      return Object.freeze({ address: entry.pubkey, data: parsed.data });
    });
    return Object.freeze({ contextSlot, accounts: Object.freeze(accounts) });
  }
  /** The mint's total supply in base units (u64 text) and its decimals, at `commitment` (one node's view at `contextSlot`). Read only
   * for the K1 entry filter top_holders_pct (private-holder-share.ts). */
  async getTokenSupply(mint: string, options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<{
    contextSlot: bigint; amount: bigint; decimals: number;
  }> {
    if (!isSolanaAddress(mint)) fail("request_invalid");
    const result = await this.#call("getTokenSupply", [mint, { commitment: commitment(options.commitment) }], signal);
    if (!isRecord(result) || !isRecord(result.context) || !isRecord(result.value)) fail("invalid_response");
    return Object.freeze({ contextSlot: safeInteger(result.context.slot), amount: u64Text(result.value.amount), decimals: decimals(result.value.decimals) });
  }
  /** The mint's largest TOKEN ACCOUNTS (at most 20, the node's own bound), largest first, base-unit amounts (u64 text). Token accounts,
   * not owners: one owner may hold several, and pool, bonding-curve and exchange accounts are included. Read only for the K1 entry
   * filter top_holders_pct. */
  async getTokenLargestAccounts(mint: string, options: { commitment?: SolanaCommitment } = {}, signal?: AbortSignal): Promise<{
    contextSlot: bigint; accounts: ReadonlyArray<{ readonly address: string; readonly amount: bigint }>;
  }> {
    if (!isSolanaAddress(mint)) fail("request_invalid");
    const result = await this.#call("getTokenLargestAccounts", [mint, { commitment: commitment(options.commitment) }], signal);
    if (!isRecord(result) || !isRecord(result.context) || !Array.isArray(result.value) || result.value.length > PRIVATE_SOLANA_LARGEST_ACCOUNTS_MAX) fail("invalid_response");
    const seen = new Set<string>(); let previous: bigint | undefined;
    const accounts = result.value.map((entry: unknown) => {
      if (!isRecord(entry) || !isSolanaAddress(entry.address) || seen.has(entry.address)) fail("invalid_response");
      seen.add(entry.address);
      const amount = u64Text(entry.amount);
      // Largest first: a node that answers out of order is not trusted for a top-N sum.
      if (previous !== undefined && amount > previous) fail("invalid_response");
      previous = amount;
      return Object.freeze({ address: entry.address, amount });
    });
    return Object.freeze({ contextSlot: safeInteger(result.context.slot), accounts: Object.freeze(accounts) });
  }
  /** Unsigned simulation of exact wire bytes: no signature check, the build's own blockhash, and the
   * post-state of `accounts` in base64. Returns the raw `value` for the pure evaluator. */
  async simulateTransaction(wireTransaction: Uint8Array, accounts: readonly string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!(wireTransaction instanceof Uint8Array) || wireTransaction.length < 1 || wireTransaction.length > 1232
      || !Array.isArray(accounts) || accounts.length > 8 || !accounts.every(isSolanaAddress)) fail("request_invalid");
    const result = await this.#call("simulateTransaction", [Buffer.from(wireTransaction).toString("base64"), { encoding: "base64",
      sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", innerInstructions: true,
      accounts: { encoding: "base64", addresses: [...accounts] } }], signal);
    if (!isRecord(result) || !isRecord(result.context) || !isRecord(result.value)) fail("invalid_response");
    safeInteger(result.context.slot);
    return result.value;
  }
  /** One transaction by its exact signature (json encoding, v0 supported) at `finalized` (default) or `confirmed`
   * commitment; null when the node has none at that commitment. Returns the raw result for the pure fact extractors in
   * private-position-facts.ts (one shape for buys and sells); it proves nothing by itself. `acceptLagPositive` is read only by the
   * dual-source reader (private-solana-rpc-sources.ts, audit M2 (b)); a single endpoint ignores it. */
  async getTransaction(signature: string, options: { commitment?: "confirmed" | "finalized"; acceptLagPositive?: boolean } = {},
    signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const chosen = options.commitment ?? "finalized";
    if (decodeBase58(signature, 64) === undefined || (chosen !== "confirmed" && chosen !== "finalized")) fail("request_invalid");
    const result = await this.#call("getTransaction", [signature, { encoding: "json", commitment: chosen, maxSupportedTransactionVersion: 0 }], signal);
    if (result === null) return null;
    if (!isRecord(result)) fail("invalid_response");
    return result;
  }

  async #call(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) fail("cancelled");
    const id = ++this.#id; const controller = new AbortController(); let timedOut = false;
    const abort = (): void => controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs); timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        const send = this.#fetch;
        response = await send(this.#endpoint.url, { method: "POST", redirect: "error", signal: controller.signal,
          headers: { ...this.#headers, "content-type": "application/json", accept: "application/json", "cache-control": "no-store" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      } catch { return fail(signal?.aborted ? "cancelled" : timedOut ? "timeout" : "transport_unavailable"); }
      if (response.status !== 200 || response.redirected || response.type === "opaqueredirect") {
        await response.body?.cancel().catch(() => undefined);
        fail(response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 429 ? "rate_limited" : "transport_unavailable");
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > this.#maxBytes) { await response.body?.cancel().catch(() => undefined); fail("response_too_large"); }
      const body = await this.#read(response, () => (signal?.aborted ? "cancelled" : timedOut ? "timeout" : "transport_unavailable"));
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { return fail("invalid_response"); }
      if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== id) fail("invalid_response");
      // Provider error text is never surfaced.
      if ("error" in parsed) fail("rpc_error");
      if (!("result" in parsed)) fail("invalid_response");
      return parsed.result;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
  }
  async #read(response: Response, interrupted: () => PrivateSolanaRpcErrorCode): Promise<Uint8Array> {
    if (!response.body) fail("invalid_response");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read().catch(() => undefined);
        if (!next) fail(interrupted());
        if (next.done) break;
        length += next.value.byteLength;
        if (length > this.#maxBytes) { await reader.cancel().catch(() => undefined); fail("response_too_large"); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, length);
  }
}
