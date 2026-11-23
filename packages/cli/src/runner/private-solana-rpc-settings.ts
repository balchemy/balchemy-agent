/** Owner-confirmed, runner-local Solana RPC endpoint per agent, kept in the daemon's private directory.
 * The full URL (often carrying a provider key) is written only to the private 0600 snapshot and is
 * returned only to this daemon's own RPC client; status, IPC replies and errors carry the host alone.
 * A public endpoint is accepted but classed shadow-only (decision 12). Configuration grants no authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp } from "./protocol.js";
import { parsePrivateSolanaRpcEndpoint, type PrivateSolanaRpcEndpoint } from "./private-solana-rpc.js";
import { addRunnerAgent } from "./agent-roster.js";

const MAX_RECORD_BYTES = 4096;
export const PRIVATE_SOLANA_RPC_SETTINGS_ERRORS = ["invalid_request", "revision_conflict", "operation_conflict", "clock_rollback",
  "state_unavailable", "unknown_agent", "closing"] as const;
export type PrivateSolanaRpcSettingsErrorCode = typeof PRIVATE_SOLANA_RPC_SETTINGS_ERRORS[number];
export class PrivateSolanaRpcSettingsError extends Error {
  constructor(readonly code: PrivateSolanaRpcSettingsErrorCode) { super(`Local Solana RPC setting ${code}`); this.name = "PrivateSolanaRpcSettingsError"; }
}
function fail(code: PrivateSolanaRpcSettingsErrorCode): never { throw new PrivateSolanaRpcSettingsError(code); }

export interface PrivateSolanaRpcSetInput { operationId: string; expectedRevision: number; url: string }
/** Display-safe view: host and class only, never the path, query or key. */
export interface PrivateSolanaRpcEndpointStatus {
  revision: number; host: string; transport: PrivateSolanaRpcEndpoint["transport"]; class: PrivateSolanaRpcEndpoint["class"]; updatedAt: number;
}
export interface PrivateSolanaRpcStatus { agentId: string; endpoint: PrivateSolanaRpcEndpointStatus | null }
/** Owner decision of 17 Nov 2026: the class of the RPC an agent executes on. `balchemy_provided`: no owner endpoint of the owner
 * class is set and a pinned Balchemy grant (two providers, private-balchemy-rpc.ts) is held; an owner-configured endpoint keeps its
 * single-source behaviour. */
export type PrivateRpcClass = PrivateSolanaRpcEndpoint["class"] | "balchemy_provided";
/** Daemon-internal (never IPC) view of the RPC an agent executes on, read by arming, the execution gate and intents. A
 * Balchemy-provided view has revision 0 and the display host `balchemy:<provider a>:<provider b>` (provider names only). */
export interface PrivateEffectiveRpcStatus {
  agentId: string;
  endpoint: { readonly class: PrivateRpcClass; readonly host: string; readonly revision: number } | null;
}
/** True for the two classes that may execute (live entries and exits). */
export function privateRpcClassExecutable(value: PrivateRpcClass | null | undefined): boolean {
  return value === "owner_configured" || value === "balchemy_provided";
}
interface RpcRecord { schemaVersion: 1; revision: number; url: string; operationId: string; updatedAt: number }

function revision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("invalid_request");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail("invalid_request");
}
export function parsePrivateSolanaRpcSetInput(value: unknown): PrivateSolanaRpcSetInput {
  exact(value, ["operationId", "expectedRevision", "url"]);
  if (!isId(value.operationId) || !revision(value.expectedRevision) || !Number.isSafeInteger(value.expectedRevision + 1)) fail("invalid_request");
  try { parsePrivateSolanaRpcEndpoint(value.url); } catch { fail("invalid_request"); }
  return Object.freeze({ operationId: value.operationId, expectedRevision: value.expectedRevision, url: value.url as string });
}
export function parsePrivateSolanaRpcStatus(value: unknown, agentId: string): PrivateSolanaRpcStatus {
  exact(value, ["agentId", "endpoint"]);
  if (value.agentId !== agentId || !isId(agentId)) fail("invalid_request");
  if (value.endpoint === null) return Object.freeze({ agentId, endpoint: null });
  exact(value.endpoint, ["revision", "host", "transport", "class", "updatedAt"]);
  const e = value.endpoint;
  if (!revision(e.revision) || e.revision < 1 || typeof e.host !== "string" || e.host.length < 1 || e.host.length > 300
    || !/^[a-z0-9.:[\]-]+$/.test(e.host) || !["https", "loopback_http"].includes(String(e.transport))
    || !["owner_configured", "public_shadow_only"].includes(String(e.class)) || !isTimestamp(e.updatedAt)) fail("invalid_request");
  return Object.freeze({ agentId, endpoint: Object.freeze({ revision: e.revision, host: e.host, updatedAt: e.updatedAt,
    transport: e.transport as PrivateSolanaRpcEndpointStatus["transport"], class: e.class as PrivateSolanaRpcEndpointStatus["class"] }) });
}
function decodeRecord(value: unknown): RpcRecord {
  exact(value, ["schemaVersion", "revision", "url", "operationId", "updatedAt"]);
  if (value.schemaVersion !== 1 || !revision(value.revision) || value.revision < 1 || !isId(value.operationId) || !isTimestamp(value.updatedAt)) fail("state_unavailable");
  try { parsePrivateSolanaRpcEndpoint(value.url); } catch { fail("state_unavailable"); }
  return { schemaVersion: 1, revision: value.revision, url: value.url as string, operationId: value.operationId, updatedAt: value.updatedAt };
}
function view(agentId: string, record: RpcRecord | undefined): PrivateSolanaRpcStatus {
  if (!record) return Object.freeze({ agentId, endpoint: null });
  const endpoint = parsePrivateSolanaRpcEndpoint(record.url);
  return parsePrivateSolanaRpcStatus({ agentId, endpoint: { revision: record.revision, host: endpoint.host, transport: endpoint.transport,
    class: endpoint.class, updatedAt: record.updatedAt } }, agentId);
}
export function privateSolanaRpcFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `solana-rpc-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}

export interface PrivateSolanaRpcSettingsOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this store never creates a second lock. */
  assertAvailable(): void;
  now?(): number;
}
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<RpcRecord> };

export class PrivateSolanaRpcSettings {
  readonly #options: PrivateSolanaRpcSettingsOptions;
  readonly #agentIds: string[];
  readonly #directory: string;
  readonly #slots = new Map<string, Slot>();
  #closed = false;

  constructor(options: PrivateSolanaRpcSettingsOptions) {
    if (!isRecord(options) || !isId(options.localProfileId) || !Array.isArray(options.agentIds) || options.agentIds.length < 1
      || options.agentIds.length > 64 || options.agentIds.some((id) => !isId(id)) || new Set(options.agentIds).size !== options.agentIds.length
      || typeof options.assertAvailable !== "function" || typeof options.directory !== "string" || !path.isAbsolute(options.directory)
      || (options.now !== undefined && typeof options.now !== "function")) fail("invalid_request");
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds };
    this.#directory = path.resolve(options.directory);
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Read-only: an agent without a saved endpoint creates no file. */
  status(agentId: string): PrivateSolanaRpcStatus { this.#available(agentId); return view(agentId, this.#read(agentId)); }

  /** Daemon-internal: the full endpoint for this agent's own RPC client. Never crosses IPC. */
  endpoint(agentId: string): PrivateSolanaRpcEndpoint | null {
    this.#available(agentId); const record = this.#read(agentId); return record ? parsePrivateSolanaRpcEndpoint(record.url) : null;
  }

  /** Compare-and-set by revision; an identical replay of the last operation is acknowledged without a write. */
  set(agentId: string, input: unknown): { status: PrivateSolanaRpcStatus; replayed: boolean } {
    this.#available(agentId);
    const request = parsePrivateSolanaRpcSetInput(input);
    const current = this.#read(agentId);
    if (current?.operationId === request.operationId) {
      if (current.revision !== request.expectedRevision + 1 || current.url !== parsePrivateSolanaRpcEndpoint(request.url).url) fail("operation_conflict");
      return { status: view(agentId, current), replayed: true };
    }
    if ((current?.revision ?? 0) !== request.expectedRevision) fail("revision_conflict");
    const now = (this.#options.now ?? Date.now)();
    if (!isTimestamp(now)) fail("state_unavailable");
    if (current && now < current.updatedAt) fail("clock_rollback");
    const next: RpcRecord = { schemaVersion: 1, revision: request.expectedRevision + 1, url: parsePrivateSolanaRpcEndpoint(request.url).url,
      operationId: request.operationId, updatedAt: now };
    const slot = this.#slots.get(agentId);
    try {
      if (slot?.kind === "open") slot.storage.commit(next);
      else this.#open(agentId, next);
    } catch { this.#hold(agentId); fail("state_unavailable"); }
    const written = this.#read(agentId);
    if (!written || written.operationId !== next.operationId || written.revision !== next.revision) fail("state_unavailable");
    return { status: view(agentId, written), replayed: false };
  }

  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Closed regardless. */ } }
    this.#slots.clear();
  }

  #available(agentId: string): void {
    if (this.#closed) fail("closing");
    if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent");
    try { this.#options.assertAvailable(); } catch { fail("state_unavailable"); }
  }
  #read(agentId: string): RpcRecord | undefined {
    let slot = this.#slots.get(agentId);
    if (!slot) {
      const files = privateSolanaRpcFiles(agentId);
      let present: boolean;
      try {
        const exists = (name: string): boolean => {
          try { fs.lstatSync(path.join(this.#directory, name)); return true; }
          catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
        };
        present = exists(files.markerFile) || exists(files.snapshotFile);
      } catch { return fail("state_unavailable"); }
      if (!present) return undefined;
      slot = this.#open(agentId);
    }
    if (slot.kind === "held") fail("state_unavailable");
    try { return slot.storage.read(); } catch { this.#hold(agentId); return fail("state_unavailable"); }
  }
  /** With `initial`, an absent record is created (marker + fsync, then snapshot + fsync + rename). */
  #open(agentId: string, initial?: RpcRecord): Slot {
    let storage: OwnedJsonSnapshot<RpcRecord> | undefined;
    try {
      storage = new OwnedJsonSnapshot<RpcRecord>({ directory: this.#directory, ...privateSolanaRpcFiles(agentId),
        marker: { schemaVersion: 1, localProfileId: this.#options.localProfileId, agentId, kind: "solana_rpc" }, maximumBytes: MAX_RECORD_BYTES,
        // An existing record is decoded from disk; `initial` is used only when nothing exists yet.
        initial: initial ?? { schemaVersion: 1, revision: 0, url: "", operationId: "", updatedAt: 0 },
        assertAvailable: this.#options.assertAvailable, decode: decodeRecord });
      const slot: Slot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch {
      try { storage?.close(); } catch { /* Preserve files; no detail leaves this boundary. */ }
      return this.#hold(agentId);
    }
  }
  #hold(agentId: string): Slot {
    const current = this.#slots.get(agentId);
    if (current?.kind === "open") { try { current.storage.close(); } catch { /* Held regardless. */ } }
    const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held;
  }
}
