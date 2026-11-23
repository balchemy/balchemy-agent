/** Owner decision of 17 Nov 2026: Balchemy provides two independent Solana RPC providers and the runner reads both DIRECTLY. This
 * module is the dual-source reader the daemon's single RPC factory hands to every reader of a Balchemy-provided agent. It never
 * sends anything: read methods and unsigned simulation only, like PrivateSolanaRpc.
 *
 * Policy, by the class the daemon gives each read site (`readClass`):
 * - `entry` (buy preflight, buy resend height, the cap quote): BOTH sources must answer and agree; one unavailable or any
 *   disagreement refuses the step (new entries wait).
 * - `exit` (sell preflight and simulation, a sell's finalized transaction, and the buy's finalized transaction that OPENS a position
 *   and gives it its stop-loss: PRIVATE_POSITION_OPENING_READ_CLASS): when both answer they must agree, otherwise the step
 *   stops and the disagreement is reported; when exactly one answers (the other unavailable, NOT disagreeing) the step proceeds on
 *   that one, but only for a POSITIVE result (`acceptOne`): a finalized transaction that landed without error, a valid blockhash, an
 *   account read, a height, a rent minimum. A negative one (absent, failed, expired) frees units for another sell, so it needs both.
 * - `display` (wallet balance shown to the owner): the first source that answers.
 * Negative proofs (a sell or buy that did NOT land, an expiry, a balance settlement) never merge single reads: they run WHOLE on each
 * source (`readers`, private-position-balance.ts) and hold unless both prove.
 *
 * Agreement per method (`combine`):
 * - account reads (getAccountInfo, getMultipleAccounts): identical owner, executable flag and data bytes at every index (and the
 *   lamports for getAccountInfo, which also serves the cap quote); null on both is agreement; null on one is lag (wait, no warning);
 * - getBlockHeight and getEpochInfo: within PRIVATE_RPC_SOURCE_HEIGHT_TOLERANCE blocks; getBlockHeight answers the higher height by
 *   default (signing freshness wants it) or the lower one (`height: "min"`, the resend check that closes a relay), getEpochInfo the
 *   lower height and the higher slot (an expiry is harder to prove);
 * - isBlockhashValid: the same `valid` on both (a split is lag; the lower context slot is answered);
 * - getMinimumBalanceForRentExemption: equal lamports;
 * - simulateTransaction: each source's raw value is handed to the same evaluator (simulateTransactionEach; the preflight requires
 *   every one to pass, private-solana-swap-preflight.ts), never compared byte for byte;
 * - getTransaction: null on both, or the same canonical facts the fact extractors read (slot, signatures, message, meta err/fee/
 *   balances/token balances/loaded addresses/inner instructions; key order and `stackHeight` ignored); present on one only is lag;
 * - getSignatureStatuses and getTokenAccountsByOwner (negative proofs; both always required): the same entries; the lower context
 *   slot and the lower confirmation status are answered.
 * - getTokenSupply and getTokenLargestAccounts (K1 entry filter top_holders_pct, `entry` class only): the same supply and decimals,
 *   and the same accounts with the same amounts in the same order; any difference is lag (a fresh launch trades between two slots),
 *   which holds the entry without the agent-wide disagreement report. Different decimals are a disagreement (they never change).
 * A disagreement is re-read once after PRIVATE_RPC_SOURCE_RECHECK_MS before it is raised (`sources_disagree`, reported through
 * `onDisagree`). Phase 1 audit M2: a lag answer (one source null or a different valid/blockhash, the other present) is re-read once
 * the same way before it refuses (`transport_unavailable`); the lag and the disagreement share that one re-read. One exception after
 * the re-read: an EXIT-class finalized getTransaction that opts in (`acceptLagPositive`, the position-opening read only; never the sell
 * settlement) where one source shows the transaction landed with err null and the other answers null is accepted after PRIVATE_RPC_LAG_ACCEPT_PASSES consecutive such passes (spaced, same source, same facts; counted per agent by
 * `lagPositives`, PrivateRpcLagPositives, because the daemon builds a new reader per read) and reported (closed reason
 * rpc_source_lag_accepted, no URL). A negative (failed, absent) is never accepted this way, nor any other method.
 * URLs, tokens and headers never appear in an error or a report: only the closed codes and the provider names. */
import { PrivateSolanaRpcError, type PrivateSolanaAccount, type PrivateSolanaRpc, type PrivateSolanaRpcErrorCode } from "./private-solana-rpc.js";

/** Every read method of PrivateSolanaRpc (structural: PrivateSolanaRpc itself has private fields). */
export type PrivateSolanaReader = Pick<PrivateSolanaRpc, "getAccountInfo" | "getMultipleAccounts" | "getLatestBlockhash" | "isBlockhashValid"
  | "getBlockHeight" | "getMinimumBalanceForRentExemption" | "getEpochInfo" | "getSignatureStatuses" | "getTokenAccountsByOwner"
  | "simulateTransaction" | "getTransaction" | "getTokenSupply" | "getTokenLargestAccounts">;
export type PrivateRpcReadClass = "entry" | "exit" | "display";
/** Main-session fund-safety decision (18 Nov 2026): the finalized buy transaction that opens a position is an exit-class POSITIVE
 * read. Requiring both sources would leave a filled buy without its stop-loss while one provider is down; a false single-source
 * "landed" is harmless (the later sell simulation fails without the tokens). One source showing it landed with err null opens the
 * position; two that disagree open nothing (rpc_sources_disagree); a lone "not found" concludes nothing (wait). Audit M2: one source
 * showing it landed with err null while the other keeps answering null opens it after PRIVATE_RPC_LAG_ACCEPT_PASSES consecutive
 * passes (rpc_source_lag_accepted; the read opts in with `acceptLagPositive`), so a lagging provider cannot keep a filled buy without
 * its stop-loss. A sell's settlement never does: it stays held until both agree or the other is unreachable. */
export const PRIVATE_POSITION_OPENING_READ_CLASS: PrivateRpcReadClass = "exit";
export type PrivateRpcSourceId = "a" | "b";
/** Two answering sources' block heights may be this many blocks apart and still agree (about 12 s; the signing slack). */
export const PRIVATE_RPC_SOURCE_HEIGHT_TOLERANCE = 30n;
export const PRIVATE_RPC_SOURCE_RECHECK_MS = 500;
/** Audit M2: consecutive lag passes (one source landed with err null, the other null, after the re-read) before an exit-class finalized
 * positive is accepted on the source that shows it, and the least time between two counted passes (several readers may ask for the
 * same signature within one settlement pass; those count once). */
export const PRIVATE_RPC_LAG_ACCEPT_PASSES = 3;
export const PRIVATE_RPC_LAG_ACCEPT_SPACING_MS = 2_000;
const LAG_ACCEPT_MAX_KEYS = 64;
/** The per-agent memory of lag passes (structural, so a test can count across reader instances). */
export interface PrivateRpcLagTracker {
  /** One lag pass for `key` (a transaction signature) whose present side is `witness` (source id and canonical facts). True when this
   * pass is the PRIVATE_RPC_LAG_ACCEPT_PASSES-th consecutive one: the positive is accepted (the entry is cleared and reported). */
  observe(key: string, witness: string): boolean;
  /** Any other outcome for `key` (agreement, both null, a disagreement, a failed source, a negative): the count restarts. */
  clear(key: string): void;
}
/** Audit M2: the daemon's per-agent lag-pass memory (private-balchemy-rpc.ts holds one per agent). In memory only, bounded; a restart
 * starts every count again (it waits longer, never less). A different witness (another source or other facts) restarts the count. */
export class PrivateRpcLagPositives implements PrivateRpcLagTracker {
  readonly #entries = new Map<string, { witness: string; count: number; lastAt: number }>();
  readonly #now: () => number;
  readonly #onAccepted: (() => void) | undefined;
  constructor(options: { now?: () => number; onAccepted?: () => void } = {}) {
    this.#now = options.now ?? Date.now; this.#onAccepted = options.onAccepted;
  }
  observe(key: string, witness: string): boolean {
    const now = this.#now(); const prior = this.#entries.get(key);
    const entry = !prior || prior.witness !== witness ? { witness, count: 1, lastAt: now }
      : now - prior.lastAt >= PRIVATE_RPC_LAG_ACCEPT_SPACING_MS ? { witness, count: prior.count + 1, lastAt: now } : prior;
    this.#entries.delete(key); this.#entries.set(key, entry);
    while (this.#entries.size > LAG_ACCEPT_MAX_KEYS) { const oldest = this.#entries.keys().next().value; if (oldest === undefined) break; this.#entries.delete(oldest); }
    if (entry.count < PRIVATE_RPC_LAG_ACCEPT_PASSES) return false;
    this.#entries.delete(key);
    try { this.#onAccepted?.(); } catch { /* Reporting never changes the read. */ }
    return true;
  }
  clear(key: string): void { this.#entries.delete(key); }
}
export interface PrivateDualSolanaSource {
  readonly id: PrivateRpcSourceId;
  readonly provider: string;
  readonly rpc: PrivateSolanaReader;
  /** False while this source is known down (a recent failure inside its cooldown, an expired credential): it is not queried. */
  available(): boolean;
}
export interface PrivateDualSolanaRpcOptions {
  readonly sources: readonly [PrivateDualSolanaSource, PrivateDualSolanaSource];
  readonly readClass: PrivateRpcReadClass;
  readonly height?: "max" | "min";
  /** A source read failed (closed code only); the daemon marks the source down or refreshes the grant on `unauthorized`. */
  onFailure?(source: PrivateRpcSourceId, code: PrivateSolanaRpcErrorCode): void;
  /** Two answering sources disagreed twice (closed reason rpc_sources_disagree; never a value or a URL). */
  onDisagree?(readClass: PrivateRpcReadClass): void;
  /** Audit M2: the agent's lag-pass memory; without it a lag answer is never accepted (it refuses, as for every other method). */
  lagPositives?: PrivateRpcLagTracker;
  recheckMs?: number;
}

const LAG = Symbol("lag");
const DISAGREE = Symbol("disagree");
type Combined<T> = T | typeof LAG | typeof DISAGREE;
type Answer<T> = { ok: true; value: T } | { ok: false; code: PrivateSolanaRpcErrorCode };
/** Audit M2: how a lasting lag of one read may count toward acceptance (getTransaction only): the present side as a witness, or
 * undefined when it is not a positive. */
type LagPositive<T> = { key: string; accept(x: T, y: T): { witness: string; value: T } | undefined };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail(code: PrivateSolanaRpcErrorCode): never { throw new PrivateSolanaRpcError(code); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return Buffer.from(left).equals(Buffer.from(right)); }
function accountsAgree(left: PrivateSolanaAccount | null, right: PrivateSolanaAccount | null, lamports: boolean): Combined<true> {
  if (left === null && right === null) return true;
  if (left === null || right === null) return LAG;
  return left.owner === right.owner && left.executable === right.executable && sameBytes(left.data, right.data)
    && (!lamports || left.lamports === right.lamports) ? true : DISAGREE;
}
/** Sorted-key JSON of a value, without `stackHeight` (an optional field providers serve differently). Never displayed. */
export function privateCanonicalJson(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (!isRecord(item)) return item;
    return Object.fromEntries(Object.keys(item).filter((key) => key !== "stackHeight").sort().map((key) => [key, walk(item[key])]));
  };
  return JSON.stringify(walk(value));
}
/** The facts of a finalized transaction the fact extractors read (private-position-facts.ts), canonical. */
export function privateTransactionFacts(value: Record<string, unknown>): string {
  const transaction = isRecord(value.transaction) ? value.transaction : {};
  const message = isRecord(transaction.message) ? transaction.message : {};
  const meta = isRecord(value.meta) ? value.meta : {};
  const pick = (record: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
  return privateCanonicalJson({ slot: value.slot, signatures: transaction.signatures,
    message: pick(message, ["accountKeys", "addressTableLookups", "header", "instructions", "recentBlockhash"]),
    meta: pick(meta, ["err", "fee", "preBalances", "postBalances", "preTokenBalances", "postTokenBalances", "loadedAddresses", "innerInstructions"]) });
}
/** A finalized transaction that landed without error: the only getTransaction result an exit accepts from one source. */
export function privateTransactionLanded(value: unknown): boolean {
  return isRecord(value) && isRecord(value.transaction) && isRecord(value.meta) && "err" in value.meta && value.meta.err === null;
}
const STATUS_RANK = { processed: 0, confirmed: 1, finalized: 2 } as const;
type Status = { slot: bigint; failed: boolean; confirmationStatus: "processed" | "confirmed" | "finalized" | null };
function lowerStatus(left: Status["confirmationStatus"], right: Status["confirmationStatus"]): Status["confirmationStatus"] {
  if (left === null || right === null) return null;
  return STATUS_RANK[left] <= STATUS_RANK[right] ? left : right;
}
const min = (left: bigint, right: bigint): bigint => (left < right ? left : right);
const max = (left: bigint, right: bigint): bigint => (left > right ? left : right);
const apart = (left: bigint, right: bigint): bigint => (left > right ? left - right : right - left);

export class PrivateDualSolanaRpc implements PrivateSolanaReader {
  readonly #options: PrivateDualSolanaRpcOptions;
  constructor(options: PrivateDualSolanaRpcOptions) {
    if (!isRecord(options) || !Array.isArray(options.sources) || options.sources.length !== 2 || options.sources[0].id !== "a"
      || options.sources[1].id !== "b" || !["entry", "exit", "display"].includes(options.readClass)
      || (options.height !== undefined && options.height !== "max" && options.height !== "min")) fail("request_invalid");
    this.#options = options;
  }
  get readClass(): PrivateRpcReadClass { return this.#options.readClass; }
  /** Display-safe identity: the two provider names, never a host, path or key. */
  get host(): string { return `balchemy:${this.#options.sources[0].provider}:${this.#options.sources[1].provider}`; }
  /** Each source on its own, for proofs that must hold whole on BOTH (private-position-balance.ts). A source that is known down
   * answers `transport_unavailable` at once. */
  get readers(): readonly [PrivateSolanaReader, PrivateSolanaReader] {
    return [this.#single(this.#options.sources[0]), this.#single(this.#options.sources[1])];
  }
  /** A whole-proof run on each source contradicted the other (private-position-balance.ts): reported like a read disagreement. */
  disagree(): void { try { this.#options.onDisagree?.(this.#options.readClass); } catch { /* Reporting never changes the refusal. */ } }

  getAccountInfo(...args: Parameters<PrivateSolanaReader["getAccountInfo"]>): ReturnType<PrivateSolanaReader["getAccountInfo"]> {
    return this.#read((rpc, signal) => rpc.getAccountInfo(args[0], args[1], signal), (x, y) => {
      const agreed = accountsAgree(x, y, true); return agreed === true ? x : agreed;
    }, (value) => value !== null, args[2]);
  }
  getMultipleAccounts(...args: Parameters<PrivateSolanaReader["getMultipleAccounts"]>): ReturnType<PrivateSolanaReader["getMultipleAccounts"]> {
    return this.#read((rpc, signal) => rpc.getMultipleAccounts(args[0], args[1], signal), (x, y) => {
      if (x.length !== y.length) return DISAGREE;
      const each = x.map((item, index) => accountsAgree(item, y[index] ?? null, false));
      return each.includes(DISAGREE) ? DISAGREE : each.includes(LAG) ? LAG : x;
    }, () => true, args[2]);
  }
  getLatestBlockhash(...args: Parameters<PrivateSolanaReader["getLatestBlockhash"]>): ReturnType<PrivateSolanaReader["getLatestBlockhash"]> {
    return this.#read((rpc, signal) => rpc.getLatestBlockhash(args[0], signal), (x, y) => (x.blockhash === y.blockhash
      && x.lastValidBlockHeight === y.lastValidBlockHeight ? x : LAG), () => true, args[1]);
  }
  isBlockhashValid(...args: Parameters<PrivateSolanaReader["isBlockhashValid"]>): ReturnType<PrivateSolanaReader["isBlockhashValid"]> {
    return this.#read((rpc, signal) => rpc.isBlockhashValid(args[0], args[1], signal), (x, y) => (x.valid === y.valid
      ? Object.freeze({ valid: x.valid, contextSlot: min(x.contextSlot, y.contextSlot) }) : LAG), (value) => value.valid === true, args[2]);
  }
  getBlockHeight(...args: Parameters<PrivateSolanaReader["getBlockHeight"]>): ReturnType<PrivateSolanaReader["getBlockHeight"]> {
    const pick = this.#options.height === "min" ? min : max;
    return this.#read((rpc, signal) => rpc.getBlockHeight(args[0], signal), (x, y) => (apart(x, y) <= PRIVATE_RPC_SOURCE_HEIGHT_TOLERANCE
      ? pick(x, y) : DISAGREE), () => true, args[1]);
  }
  getMinimumBalanceForRentExemption(...args: Parameters<PrivateSolanaReader["getMinimumBalanceForRentExemption"]>): ReturnType<PrivateSolanaReader["getMinimumBalanceForRentExemption"]> {
    return this.#read((rpc, signal) => rpc.getMinimumBalanceForRentExemption(args[0], args[1], signal), (x, y) => (x === y ? x : DISAGREE),
      () => true, args[2]);
  }
  /** Negative-proof read: both sources always. */
  getEpochInfo(...args: Parameters<PrivateSolanaReader["getEpochInfo"]>): ReturnType<PrivateSolanaReader["getEpochInfo"]> {
    return this.#read((rpc, signal) => rpc.getEpochInfo(args[0], signal), (x, y) => (apart(x.blockHeight, y.blockHeight) <= PRIVATE_RPC_SOURCE_HEIGHT_TOLERANCE
      ? Object.freeze({ absoluteSlot: max(x.absoluteSlot, y.absoluteSlot), blockHeight: min(x.blockHeight, y.blockHeight) }) : DISAGREE),
    () => false, args[1]);
  }
  /** Negative-proof read: both sources always. */
  getSignatureStatuses(...args: Parameters<PrivateSolanaReader["getSignatureStatuses"]>): ReturnType<PrivateSolanaReader["getSignatureStatuses"]> {
    return this.#read((rpc, signal) => rpc.getSignatureStatuses(args[0], args[1], signal), (x, y) => {
      if (x.statuses.length !== y.statuses.length) return DISAGREE;
      let lag = false; let disagree = false;
      const statuses = x.statuses.map((left, index) => {
        const right = y.statuses[index] ?? null;
        if (left === null && right === null) return null;
        if (left === null || right === null) { lag = true; return null; }
        if (left.slot !== right.slot || left.failed !== right.failed) { disagree = true; return null; }
        return Object.freeze({ slot: left.slot, failed: left.failed, confirmationStatus: lowerStatus(left.confirmationStatus, right.confirmationStatus) });
      });
      return disagree ? DISAGREE : lag ? LAG : Object.freeze({ contextSlot: min(x.contextSlot, y.contextSlot), statuses: Object.freeze(statuses) });
    }, () => false, args[2]);
  }
  /** Negative-proof read: both sources always. */
  getTokenAccountsByOwner(...args: Parameters<PrivateSolanaReader["getTokenAccountsByOwner"]>): ReturnType<PrivateSolanaReader["getTokenAccountsByOwner"]> {
    return this.#read((rpc, signal) => rpc.getTokenAccountsByOwner(args[0], args[1], args[2], signal), (x, y) => {
      if (x.accounts.length !== y.accounts.length) return LAG;
      const right = new Map(y.accounts.map((item) => [item.address, item.data]));
      return x.accounts.every((item) => { const other = right.get(item.address); return other !== undefined && sameBytes(item.data, other); })
        ? Object.freeze({ contextSlot: min(x.contextSlot, y.contextSlot), accounts: x.accounts }) : LAG;
    }, () => false, args[3]);
  }
  /** K1 entry facts: both sources must answer the same supply (a difference is lag; decimals never change). */
  getTokenSupply(...args: Parameters<PrivateSolanaReader["getTokenSupply"]>): ReturnType<PrivateSolanaReader["getTokenSupply"]> {
    return this.#read((rpc, signal) => rpc.getTokenSupply(args[0], args[1], signal), (x, y) => (x.decimals !== y.decimals ? DISAGREE
      : x.amount === y.amount ? Object.freeze({ contextSlot: min(x.contextSlot, y.contextSlot), amount: x.amount, decimals: x.decimals }) : LAG),
    () => false, args[2]);
  }
  /** K1 entry facts: both sources must answer the same largest accounts and amounts in the same order (a difference is lag). */
  getTokenLargestAccounts(...args: Parameters<PrivateSolanaReader["getTokenLargestAccounts"]>): ReturnType<PrivateSolanaReader["getTokenLargestAccounts"]> {
    return this.#read((rpc, signal) => rpc.getTokenLargestAccounts(args[0], args[1], signal), (x, y) => (x.accounts.length === y.accounts.length
      && x.accounts.every((item, index) => item.address === y.accounts[index]?.address && item.amount === y.accounts[index]?.amount)
      ? Object.freeze({ contextSlot: min(x.contextSlot, y.contextSlot), accounts: x.accounts }) : LAG), () => false, args[2]);
  }
  /** The first source's raw value under the same availability rules; the preflight uses simulateTransactionEach instead. */
  async simulateTransaction(...args: Parameters<PrivateSolanaReader["simulateTransaction"]>): ReturnType<PrivateSolanaReader["simulateTransaction"]> {
    const each = await this.simulateTransactionEach(...args);
    return each[0]!;
  }
  /** Each available source's raw simulation value, for the SAME evaluator: both for `entry`; one or both for `exit`; the first for
   * `display`. Never compared byte for byte (slots, logs and compute units differ legitimately). */
  async simulateTransactionEach(...args: Parameters<PrivateSolanaReader["simulateTransaction"]>): Promise<Record<string, unknown>[]> {
    const [wire, accounts, signal] = args;
    const answers = await this.#ask((rpc, read) => rpc.simulateTransaction(wire, accounts, read), signal);
    const values = answers.filter((item): item is { ok: true; value: Record<string, unknown> } => item.ok).map((item) => item.value);
    if (this.#options.readClass === "display") return values.length > 0 ? [values[0]!] : this.#none(answers, signal);
    if (values.length === 2) return values;
    if (values.length === 1 && this.#options.readClass === "exit") return values;
    return this.#none(answers, signal);
  }
  getTransaction(...args: Parameters<PrivateSolanaReader["getTransaction"]>): ReturnType<PrivateSolanaReader["getTransaction"]> {
    // Audit M2: only an exit-class FINALIZED read that opts in (`acceptLagPositive`: the position-opening read only, main-session
    // decision of 18 Nov 2026) may accept a lasting lag, and only for a landed transaction (never a negative). The sell settlement
    // never opts in: a false "sold" would close a position that still holds tokens, while waiting is harmless.
    const finalized = (args[1]?.commitment ?? "finalized") === "finalized";
    const lag: LagPositive<Record<string, unknown> | null> | undefined = finalized && args[1]?.acceptLagPositive === true
      && this.#options.readClass === "exit" ? { key: args[0],
      accept: (x, y) => {
        const present: Record<string, unknown> | null = x !== null && y === null ? x : x === null && y !== null ? y : null;
        const id = x !== null ? "a" : "b";
        return present !== null && privateTransactionLanded(present) ? { witness: `${id}:${privateTransactionFacts(present)}`, value: present } : undefined;
      } } : undefined;
    const commitment = args[1]?.commitment;
    return this.#read((rpc, signal) => rpc.getTransaction(args[0], commitment ? { commitment } : {}, signal), (x, y) => {
      if (x === null && y === null) return null;
      if (x === null || y === null) return LAG;
      return privateTransactionFacts(x) === privateTransactionFacts(y) ? x : DISAGREE;
    }, privateTransactionLanded, args[2], lag);
  }

  #single(source: PrivateDualSolanaSource): PrivateSolanaReader {
    const guard = <A extends unknown[], R>(call: (...input: A) => Promise<R>) => async (...input: A): Promise<R> => {
      if (!source.available()) fail("transport_unavailable");
      try { return await call(...input); } catch (error: unknown) { this.#failed(source.id, error); throw error; }
    };
    const rpc = source.rpc;
    return Object.freeze({
      getAccountInfo: guard(rpc.getAccountInfo.bind(rpc)), getMultipleAccounts: guard(rpc.getMultipleAccounts.bind(rpc)),
      getLatestBlockhash: guard(rpc.getLatestBlockhash.bind(rpc)), isBlockhashValid: guard(rpc.isBlockhashValid.bind(rpc)),
      getBlockHeight: guard(rpc.getBlockHeight.bind(rpc)), getMinimumBalanceForRentExemption: guard(rpc.getMinimumBalanceForRentExemption.bind(rpc)),
      getEpochInfo: guard(rpc.getEpochInfo.bind(rpc)), getSignatureStatuses: guard(rpc.getSignatureStatuses.bind(rpc)),
      getTokenAccountsByOwner: guard(rpc.getTokenAccountsByOwner.bind(rpc)), simulateTransaction: guard(rpc.simulateTransaction.bind(rpc)),
      getTransaction: guard(rpc.getTransaction.bind(rpc)), getTokenSupply: guard(rpc.getTokenSupply.bind(rpc)),
      getTokenLargestAccounts: guard(rpc.getTokenLargestAccounts.bind(rpc)),
    });
  }
  #failed(source: PrivateRpcSourceId, error: unknown): void {
    const code = error instanceof PrivateSolanaRpcError ? error.code : "invalid_response";
    if (code === "cancelled" || code === "request_invalid") return;
    try { this.#options.onFailure?.(source, code); } catch { /* Reporting never changes the read. */ }
  }
  /** Both sources in parallel (a known-down source is not queried). Throws only `cancelled` when the caller aborted. */
  async #ask<T>(read: (rpc: PrivateSolanaReader, signal: AbortSignal | undefined) => Promise<T>, signal?: AbortSignal): Promise<[Answer<T>, Answer<T>]> {
    if (signal?.aborted) fail("cancelled");
    const one = async (source: PrivateDualSolanaSource): Promise<Answer<T>> => {
      let up: boolean; try { up = source.available(); } catch { up = false; }
      if (!up) return { ok: false, code: "transport_unavailable" };
      try { return { ok: true, value: await read(source.rpc, signal) }; }
      catch (error: unknown) {
        this.#failed(source.id, error);
        return { ok: false, code: error instanceof PrivateSolanaRpcError ? error.code : "invalid_response" };
      }
    };
    const answers = await Promise.all([one(this.#options.sources[0]), one(this.#options.sources[1])]);
    if (signal?.aborted) fail("cancelled");
    return answers;
  }
  #none(answers: readonly Answer<unknown>[], signal?: AbortSignal): never {
    if (signal?.aborted) fail("cancelled");
    const codes = answers.flatMap((item) => (item.ok ? [] : [item.code]));
    // A provider that refused the credential is reported as such only when no source answered at all.
    return fail(codes.length === 2 && codes.every((code) => code === "unauthorized") ? "unauthorized"
      : codes.length === 2 && codes.every((code) => code === "timeout") ? "timeout" : "transport_unavailable");
  }
  async #read<T>(read: (rpc: PrivateSolanaReader, signal: AbortSignal | undefined) => Promise<T>, combine: (x: T, y: T) => Combined<T>,
    acceptOne: (value: T) => boolean, signal?: AbortSignal, lag?: LagPositive<T>): Promise<T> {
    const readClass = this.#options.readClass;
    let answers = await this.#ask(read, signal);
    if (readClass === "display") {
      const first = answers.find((item): item is { ok: true; value: T } => item.ok);
      return first ? first.value : this.#none(answers, signal);
    }
    const tracker = this.#options.lagPositives;
    const restart = (): void => { if (lag && tracker) { try { tracker.clear(lag.key); } catch { /* Memory only. */ } } };
    for (let attempt = 0; ; attempt += 1) {
      const [x, y] = answers;
      if (x.ok && y.ok) {
        const combined = combine(x.value, y.value);
        if (combined !== LAG && combined !== DISAGREE) { restart(); return combined; }
        if (attempt > 0) {
          if (combined === DISAGREE) {
            restart();
            try { this.#options.onDisagree?.(readClass); } catch { /* Reporting never changes the refusal. */ }
            fail("sources_disagree");
          }
          // Audit M2 (b): a lag that outlasted the re-read. Only an exit-class finalized landed positive may count toward acceptance.
          const positive = lag && tracker ? lag.accept(x.value, y.value) : undefined;
          if (!positive || !lag || !tracker) { restart(); fail("transport_unavailable"); }
          let accepted = false;
          try { accepted = tracker.observe(lag.key, positive.witness); } catch { accepted = false; }
          if (accepted) return positive.value;
          fail("transport_unavailable");
        }
        // One bounded re-read, shared by a disagreement and a lag (audit M2 (a), (c)): two providers a slot apart is neither.
        // An awaited re-read delay keeps the event loop alive (never unref'd), so the caller always gets its answer.
        await new Promise<void>((resolve) => { setTimeout(resolve, this.#options.recheckMs ?? PRIVATE_RPC_SOURCE_RECHECK_MS); });
        answers = await this.#ask(read, signal);
        continue;
      }
      restart();
      const single = x.ok ? x : y.ok ? y : undefined;
      // Exactly one answered (the other unavailable, not disagreeing): an exit proceeds on a positive result only.
      if (single && readClass === "exit" && acceptOne(single.value)) return single.value;
      return this.#none(answers, signal);
    }
  }
}

export function isPrivateDualSolanaRpc(value: unknown): value is PrivateDualSolanaRpc { return value instanceof PrivateDualSolanaRpc; }
