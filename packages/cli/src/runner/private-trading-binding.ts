/** Daemon-owned Hub binding of an agent's local trading wallet (S1b). The runner key signs the SDK's fixed bind nonce
 * and the trading key signs only the SDK's fixed possession message (keystore `signBindingPossession`); the returned
 * public binding is fsynced in this agent's private record. No key, nonce, signature or response body is stored,
 * logged or returned. A binding grants no trading or execution authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { AgentSdkError, RunnerTradingWalletClient, validateRunnerTradingWalletBinding,
  type RunnerTradingWalletBinding } from "@balchemyai/agent-sdk";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { exactKeys, isId, isRecord, isTimestamp } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import { readPairedRunnerDescriptor, signRunnerTradingWalletProof } from "./pairing-identity.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import type { PrivateTradingKeystore } from "./private-trading-keystore.js";
import { parsePrivateTradingBindingRequest, privateTradingBindingFailure, privateTradingBindingSuccess,
  type PrivateTradingBindingError, type PrivateTradingBindingRequest, type PrivateTradingBindingResponse,
  type TradingWalletBindingView } from "./private-trading-binding-protocol.js";
import { addRunnerAgent } from "./agent-roster.js";

const MAX_RECORD_BYTES = 4096;
const MAX_CONFLICT_BYTES = 4096;
/** Backend 409 codes (`LOCAL_AGENT_TRADING_WALLET_CONFLICTS`), reported only after both signatures verified. */
const CONFLICTS: Readonly<Record<string, PrivateTradingBindingError>> = Object.freeze({
  agent_trading_wallet_already_bound: "already_bound", agent_trading_wallet_revoked: "revoked",
  trading_wallet_bound_elsewhere: "bound_elsewhere", trading_wallet_is_identity_wallet: "identity_wallet",
  trading_wallet_is_runner_key: "runner_key" });

export class PrivateTradingBindingServiceError extends Error {
  constructor(readonly code: PrivateTradingBindingError) { super(`Local trading wallet binding ${code}`); this.name = "PrivateTradingBindingServiceError"; }
}
function fail(code: PrivateTradingBindingError): never { throw new PrivateTradingBindingServiceError(code); }

/** Persisted verbatim. `active` keeps the exact SDK-validated public binding and the bind's lease coordinates. */
export type PrivateTradingBindingRecord = {
  schemaVersion: 1; localProfileId: string; agentId: string; state: "active"; frontendOrigin: string; instanceId: string; epoch: number;
  binding: RunnerTradingWalletBinding; recordedAt: number;
} | {
  schemaVersion: 1; localProfileId: string; agentId: string; state: "revoked"; frontendOrigin: string; serverAgentId: string;
  walletAddress: string; walletBindingId: string | null; observedAt: number;
};
export function tradingBindingFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  // Never a `trading-wallet-` prefix: that namespace is the keystore's closed envelope directory scan.
  const stem = `wallet-binding-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}
function originOf(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("origin");
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("origin");
  return value;
}
/** Historical reopen: the SDK's closed binding check (format + walletBindingDigest), with no current-time freshness. */
export function parsePrivateTradingBindingRecord(value: unknown, scope: { localProfileId: string; agentId: string }): PrivateTradingBindingRecord | null {
  if (value === null) return null;
  if (!isRecord(value) || value.schemaVersion !== 1 || value.localProfileId !== scope.localProfileId || value.agentId !== scope.agentId) throw new Error("record");
  if (value.state === "active") {
    if (!exactKeys(value, ["schemaVersion", "localProfileId", "agentId", "state", "frontendOrigin", "instanceId", "epoch", "binding", "recordedAt"])
      || !isRecord(value.binding) || !isTimestamp(value.recordedAt) || typeof value.instanceId !== "string"
      || typeof value.epoch !== "number") throw new Error("record");
    const b = value.binding;
    const binding = validateRunnerTradingWalletBinding(b, { frontendOrigin: originOf(value.frontendOrigin), agentId: String(b.agentId),
      bindingDigest: String(b.bindingDigest), runnerPublicKey: String(b.runnerPublicKey), instanceId: value.instanceId, epoch: value.epoch,
      request: { version: 1, chain: "solana", walletAddress: String(b.walletAddress) } }, Number.MAX_SAFE_INTEGER);
    return Object.freeze({ schemaVersion: 1, localProfileId: scope.localProfileId, agentId: scope.agentId, state: "active",
      frontendOrigin: value.frontendOrigin as string, instanceId: value.instanceId, epoch: value.epoch, binding: { ...binding }, recordedAt: value.recordedAt });
  }
  if (value.state === "revoked") {
    if (!exactKeys(value, ["schemaVersion", "localProfileId", "agentId", "state", "frontendOrigin", "serverAgentId", "walletAddress", "walletBindingId", "observedAt"])
      || typeof value.serverAgentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.serverAgentId)
      || !isSolanaAddress(value.walletAddress) || !isTimestamp(value.observedAt)
      || (value.walletBindingId !== null && (typeof value.walletBindingId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.walletBindingId)))) throw new Error("record");
    return Object.freeze({ schemaVersion: 1, localProfileId: scope.localProfileId, agentId: scope.agentId, state: "revoked",
      frontendOrigin: originOf(value.frontendOrigin), serverAgentId: value.serverAgentId, walletAddress: value.walletAddress,
      walletBindingId: value.walletBindingId as string | null, observedAt: value.observedAt });
  }
  throw new Error("record");
}
export function tradingBindingView(record: PrivateTradingBindingRecord | null | undefined): TradingWalletBindingView {
  if (!record) return { state: "unbound" };
  return record.state === "active" ? { state: "bound", walletBindingId: record.binding.walletBindingId, address: record.binding.walletAddress,
    boundAt: record.binding.boundAt } : { state: "revoked", address: record.walletAddress, walletBindingId: record.walletBindingId,
    observedAt: new Date(record.observedAt).toISOString() };
}

/** Reads the backend's fixed 409 code from a bounded clone of the response; anything else is unknown. */
async function conflictCode(response: Response): Promise<PrivateTradingBindingError | undefined> {
  try {
    const reader = response.body?.getReader(); if (!reader) return undefined;
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > MAX_CONFLICT_BYTES) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    const message = isRecord(parsed) ? (isRecord(parsed.error) ? parsed.error.message : parsed.message) : undefined;
    return typeof message === "string" && Object.hasOwn(CONFLICTS, message) ? CONFLICTS[message] : undefined;
  } catch { return undefined; }
}

export interface PrivateTradingBindingOptions {
  directory: string; localProfileId: string; instanceId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this store never creates a second lock. */
  assertAvailable(): void;
  keystore: Pick<PrivateTradingKeystore, "status" | "signBindingPossession">;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  readPairingWallet(agentId: string): { chain: "solana" | "base"; address: string } | undefined;
  fetchFn?: typeof fetch;
  now?(): number;
}
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<PrivateTradingBindingRecord | null> };

export class PrivateTradingBindings {
  readonly #options: PrivateTradingBindingOptions;
  readonly #agentIds: string[];
  readonly #slots = new Map<string, Slot>();
  readonly #active = new Set<string>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #closed = false;

  constructor(options: PrivateTradingBindingOptions) {
    if (!isRecord(options) || typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !isId(options.localProfileId)
      || !isId(options.instanceId) || !Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id))
      || typeof options.assertAvailable !== "function" || typeof options.readLease !== "function"
      || typeof options.readPairingWallet !== "function" || !options.keystore) fail("invalid_request");
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, directory: path.resolve(options.directory), agentIds: this.#agentIds };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Public view only; a never-bound agent's status creates no file. */
  status(agentId: string): TradingWalletBindingView {
    const slot = this.#slot(agentId, false);
    if (!slot) return { state: "unbound" };
    if (slot.kind === "held") return { state: "held" };
    try { return tradingBindingView(slot.storage.read()); } catch { this.#slots.set(agentId, { kind: "held" }); return { state: "held" }; }
  }
  /** The exact local record for the execution build path; throws when held or unreadable. */
  record(agentId: string): PrivateTradingBindingRecord | undefined {
    const slot = this.#slot(agentId, false);
    if (!slot) return undefined;
    if (slot.kind === "held") return fail("state_unavailable");
    try { return slot.storage.read() ?? undefined; } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
  }

  bind(agentId: string, signal?: AbortSignal): Promise<TradingWalletBindingView> {
    const work = this.#binding(agentId, signal);
    this.#work.add(work);
    void work.then(() => this.#work.delete(work), () => this.#work.delete(work));
    return work;
  }

  async handle(input: PrivateTradingBindingRequest, signal?: AbortSignal): Promise<PrivateTradingBindingResponse> {
    const request = parsePrivateTradingBindingRequest(input);
    try {
      if (request.localProfileId !== this.#options.localProfileId) return privateTradingBindingFailure(request, "profile_conflict");
      if (request.instanceId !== this.#options.instanceId) return privateTradingBindingFailure(request, "instance_conflict");
      if (!this.#options.agentIds.includes(request.agentId)) return privateTradingBindingFailure(request, "unknown_agent");
      const binding = request.action === "status" ? this.status(request.agentId) : await this.bind(request.agentId, signal);
      return privateTradingBindingSuccess(request, binding);
    } catch (error: unknown) {
      return privateTradingBindingFailure(request, error instanceof PrivateTradingBindingServiceError ? error.code
        : request.action === "bind" ? "outcome_unknown" : "state_unavailable");
    }
  }

  close(): Promise<void> {
    this.#closed = true; this.#abort.abort();
    return Promise.allSettled([...this.#work]).then(() => {
      for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Preserve files. */ } }
      this.#slots.clear();
    });
  }

  async #binding(agentId: string, signal?: AbortSignal): Promise<TradingWalletBindingView> {
    this.#available(); this.#agent(agentId);
    if (this.#active.has(agentId)) fail("busy");
    this.#active.add(agentId);
    try {
      const identity = { directory: this.#options.directory, localProfileId: this.#options.localProfileId, agentId };
      let paired: ReturnType<typeof readPairedRunnerDescriptor>;
      try { paired = readPairedRunnerDescriptor(identity); } catch { return fail("state_unavailable"); }
      if (!paired) fail("not_paired");
      const lease = this.#options.readLease(agentId);
      if (!lease || lease.instanceId !== this.#options.instanceId || lease.frontendOrigin !== paired.frontendOrigin
        || lease.agentId !== paired.agentId || lease.bindingDigest !== paired.bindingDigest || lease.runnerPublicKey !== paired.runnerPublicKey
        || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1 || !(lease.remainingMs > 0)) fail("lease_unavailable");
      const pinned = JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest, lease.runnerPublicKey, lease.instanceId, lease.epoch]);
      let wallet: ReturnType<PrivateTradingBindingOptions["keystore"]["status"]>;
      try { wallet = this.#options.keystore.status(agentId); } catch { return fail("state_unavailable"); }
      if (wallet.state === "absent") fail("wallet_missing");
      if (wallet.state === "held") fail("wallet_held");
      if (wallet.state !== "unlocked") fail("wallet_locked");
      const address = wallet.address;
      let pairingWallet: ReturnType<PrivateTradingBindingOptions["readPairingWallet"]>;
      try { pairingWallet = this.#options.readPairingWallet(agentId); } catch { return fail("state_unavailable"); }
      if (pairingWallet?.chain === "solana" && pairingWallet.address === address) fail("pairing_wallet");
      const current = this.record(agentId);
      if (current?.state === "revoked") fail("revoked");
      if (current?.state === "active") {
        const b = current.binding;
        // The exact same local binding is already recorded; nothing is re-sent.
        if (b.walletAddress === address && b.agentId === lease.agentId && b.bindingDigest === lease.bindingDigest
          && b.runnerPublicKey === lease.runnerPublicKey && current.frontendOrigin === lease.frontendOrigin) return tradingBindingView(current);
        fail("already_bound");
      }
      const fence = (): void => {
        const now = this.#options.readLease(agentId);
        if (this.#closed || signal?.aborted || !now || now.remainingMs <= 0
          || JSON.stringify([now.frontendOrigin, now.agentId, now.bindingDigest, now.runnerPublicKey, now.instanceId, now.epoch]) !== pinned) fail("lease_unavailable");
        this.#available();
      };
      // Callback observations live on one holder so control-flow narrowing never hides a later write.
      const seen: { conflict?: PrivateTradingBindingError; signerFailure?: PrivateTradingBindingError; signed: boolean } = { signed: false };
      const transport = this.#options.fetchFn ?? fetch;
      const fetchFn: typeof fetch = async (url, init) => {
        const response = await transport(url, init);
        if (response.status === 409 && String(url).endsWith("/trading-wallet/bind")) seen.conflict = await conflictCode(response.clone());
        return response;
      };
      const failSigner = (error: unknown): never => {
        seen.signerFailure = error instanceof PrivateTradingBindingServiceError ? error.code
          : isRecord(error) && error.code === "wallet_locked" ? "wallet_locked"
            : isRecord(error) && (error.code === "trading_wallet" || error.code === "pairing_wallet") ? "pairing_wallet" : "state_unavailable";
        throw error;
      };
      let client: RunnerTradingWalletClient;
      try {
        client = new RunnerTradingWalletClient({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId, bindingDigest: lease.bindingDigest,
          runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, apiBaseUrl: `${lease.frontendOrigin}/api`, timeoutMs: 20_000, fetchFn,
          signer: (nonce, expected) => {
            try { fence(); return signRunnerTradingWalletProof(identity, { instanceId: lease.instanceId, epoch: expected.epoch, request: expected.request, nonce }); }
            catch (error: unknown) { return failSigner(error); }
          },
          walletSigner: (nonce, expected) => {
            try { fence(); const signature = this.#options.keystore.signBindingPossession(agentId, nonce, expected); seen.signed = true; return signature; }
            catch (error: unknown) { return failSigner(error); }
          } });
      } catch { return fail("state_unavailable"); }
      const scope = new AbortController(); const abort = (): void => scope.abort();
      signal?.addEventListener("abort", abort, { once: true }); this.#abort.signal.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || this.#abort.signal.aborted) scope.abort();
      let response: Awaited<ReturnType<RunnerTradingWalletClient["bind"]>>;
      try { response = await client.bind({ version: 1, chain: "solana", walletAddress: address }, lease.epoch, scope.signal); }
      catch (error: unknown) {
        if (seen.signerFailure) fail(seen.signerFailure);
        if (seen.conflict) {
          if (seen.conflict === "revoked") this.#persistRevoked(agentId, lease, address);
          fail(seen.conflict);
        }
        const status = error instanceof AgentSdkError ? error.status : undefined;
        if (status === 409) fail("conflict");
        if (status === 401 || status === 403) fail("proof_rejected");
        if (status === 429) fail("rate_limited");
        if (status === 400) fail("server_rejected");
        // Before both proofs exist the bind request was never sent.
        return fail(seen.signed ? "outcome_unknown" : "server_unavailable");
      } finally { signal?.removeEventListener("abort", abort); this.#abort.signal.removeEventListener("abort", abort); }
      const binding = response.binding;
      const record: PrivateTradingBindingRecord = { schemaVersion: 1, localProfileId: this.#options.localProfileId, agentId, state: "active",
        frontendOrigin: lease.frontendOrigin, instanceId: lease.instanceId, epoch: lease.epoch, binding: { ...binding }, recordedAt: this.#now() };
      try { this.#write(agentId, record); } catch { return fail("write_outcome_unknown"); }
      return tradingBindingView(record);
    } finally { this.#active.delete(agentId); }
  }
  /** Best effort: a revocation is terminal server-side; a failed local write leaves the prior record unchanged. */
  #persistRevoked(agentId: string, lease: Readonly<RunnerRuntimeActiveLease>, address: string): void {
    try {
      const current = this.record(agentId);
      this.#write(agentId, { schemaVersion: 1, localProfileId: this.#options.localProfileId, agentId, state: "revoked",
        frontendOrigin: lease.frontendOrigin, serverAgentId: lease.agentId, walletAddress: address,
        walletBindingId: current?.state === "active" && current.binding.walletAddress === address ? current.binding.walletBindingId : null,
        observedAt: this.#now() });
    } catch { /* The refusal is still reported. */ }
  }
  #write(agentId: string, record: PrivateTradingBindingRecord): void {
    const slot = this.#slot(agentId, true);
    if (!slot || slot.kind !== "open") fail("state_unavailable");
    try { slot.storage.commit(parsePrivateTradingBindingRecord(structuredClone(record), { localProfileId: this.#options.localProfileId, agentId })); }
    catch { this.#slots.set(agentId, { kind: "held" }); throw new PrivateTradingBindingServiceError("write_outcome_unknown"); }
  }
  /** Lazily opens one agent's record; with `create`, an absent record is initialized as unbound first. */
  #slot(agentId: string, create: boolean): Slot | undefined {
    this.#available(); this.#agent(agentId);
    const current = this.#slots.get(agentId);
    if (current) return current;
    const files = tradingBindingFiles(agentId);
    const exists = (name: string): boolean => {
      try { fs.lstatSync(path.join(this.#options.directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    };
    try { if (!create && !exists(files.markerFile) && !exists(files.snapshotFile)) return undefined; }
    catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
    try {
      const scope = { localProfileId: this.#options.localProfileId, agentId };
      const storage = new OwnedJsonSnapshot<PrivateTradingBindingRecord | null>({ directory: this.#options.directory, ...files,
        marker: { schemaVersion: 1, localProfileId: scope.localProfileId, agentId, kind: "trading_wallet_binding" }, maximumBytes: MAX_RECORD_BYTES,
        initial: null, assertAvailable: this.#options.assertAvailable, decode: (value) => parsePrivateTradingBindingRecord(value, scope) });
      const slot: Slot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
  }
  #now(): number {
    const value = (this.#options.now ?? Date.now)();
    if (!isTimestamp(value)) fail("state_unavailable");
    return value;
  }
  #agent(agentId: string): void { if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent"); }
  #available(): void {
    if (this.#closed) fail("closing");
    try { this.#options.assertAvailable(); } catch { fail("state_unavailable"); }
  }
}
