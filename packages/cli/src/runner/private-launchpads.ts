/** K4b launchpad signal sources, runner side (owner decision of 19 Nov 2026: Solana launchpads, multi-select and extensible, pump.fun
 * live and the others coming soon; choosing needs no wallet signature). Contract: k4-launchpad-contract.md.
 * - The public catalog is read from the pairing origin and cached for CATALOG_TTL_MS (the route's own public max-age).
 * - The agent's subscription is read and replaced only through the runner-signed route (`get` / `set`, ids strictly ascending; `[]`
 *   unsubscribes). The last answer Balchemy gave is stored per agent with the pairing binding it belongs to, so the cockpit and the
 *   execution checks can read it without a network call.
 * - Execution provenance (launchpadAdmitted): a decision or buy that cites a launchpad signal is allowed ONLY when the stored
 *   subscription belongs to the signal's binding, its revision is the signal's sourceRevision and it lists the launchpad whose catalog
 *   sourceId the signal carries, and that launchpad is `live` in a fresh catalog. Freshness of the signal itself is the shared rule
 *   every source gets (sourceHealthFreshUntil and the 5-minute signal age, private-brain-service.ts guard). Any unknown, stale or
 *   unreadable input holds. Balchemy checks the same subscription server-side (local-agent-execution-provenance.service.ts).
 * Never a key, nonce, proof or signature in a record, reply or log. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalRunnerLaunchpadIds, fetchRunnerLaunchpadCatalog, RunnerLaunchpadSubscriptionsClient, type RunnerLaunchpadCatalog,
  type RunnerLaunchpadSubscriptionsRequest, type RunnerLaunchpadSubscriptionsResponse } from "@balchemyai/agent-sdk";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp } from "./protocol.js";
import { addRunnerAgent } from "./agent-roster.js";
import { signRunnerLaunchpadSubscriptionsProof } from "./pairing-identity.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";

/** The catalog route's public cache (max-age=300). */
export const PRIVATE_LAUNCHPAD_CATALOG_TTL_MS = 300_000;
/** A stored subscription is re-read from Balchemy when older than this before a launchpad decision (a re-pair resets it server-side). */
export const PRIVATE_LAUNCHPAD_SUBSCRIPTION_TTL_MS = 600_000;
const MAX_RECORD_BYTES = 4096;
const HEX = /^[0-9a-f]{64}$/;
const SOURCE_ID = /^src_[0-9a-f]{24}$/;
export const PRIVATE_LAUNCHPAD_ERRORS = ["invalid_request", "unknown_agent", "lease_unavailable", "catalog_unavailable", "launchpad_unknown",
  "launchpad_not_live", "subscription_unavailable", "state_unavailable", "closing"] as const;
export type PrivateLaunchpadErrorCode = typeof PRIVATE_LAUNCHPAD_ERRORS[number];
export class PrivateLaunchpadError extends Error {
  constructor(readonly code: PrivateLaunchpadErrorCode) { super(`Local launchpad sources ${code}`); this.name = "PrivateLaunchpadError"; }
}
function fail(code: PrivateLaunchpadErrorCode = "invalid_request"): never { throw new PrivateLaunchpadError(code); }

/** The last subscription Balchemy answered for this agent, with the pairing binding it belongs to and when it was read. */
export interface PrivateLaunchpadSubscriptionRecord {
  schemaVersion: 1; agentId: string; bindingDigest: string; revision: number; launchpadIds: string[]; updatedAt: string | null; readAt: number;
}
/** Owner view (IPC and CLI): the catalog entries with whether this agent is subscribed, and the stored subscription. */
export interface PrivateLaunchpadEntryView {
  id: string; name: string; status: "live" | "coming_soon"; sourceNote: string; subscribed: boolean;
}
export interface PrivateLaunchpadView { revision: number; launchpads: PrivateLaunchpadEntryView[]; subscribedIds: string[]; updatedAt: string | null }
/** The facts of one delivered signal the provenance check reads. */
export interface PrivateLaunchpadSignalFacts { platform: string; sourceId: string; sourceRevision: number; bindingDigest: string }

export type PrivateLaunchpadQuery = (agentId: string, lease: Readonly<RunnerRuntimeActiveLease>, request: RunnerLaunchpadSubscriptionsRequest,
  signal?: AbortSignal) => Promise<RunnerLaunchpadSubscriptionsResponse>;
export interface PrivateLaunchpadsOptions {
  directory: string; localProfileId: string; instanceId: string; agentIds: readonly string[];
  assertAvailable(): void;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  /** Test seams; production uses the SDK clients and the adopted identity signer. */
  fetchCatalog?(frontendOrigin: string, signal?: AbortSignal): Promise<RunnerLaunchpadCatalog>;
  query?: PrivateLaunchpadQuery;
  now?(): number;
}
export function privateLaunchpadFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `launchpads-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}
function decodeRecord(value: unknown): PrivateLaunchpadSubscriptionRecord {
  if (!isRecord(value) || Object.keys(value).length !== 7 || value.schemaVersion !== 1 || !isId(value.agentId)
    || typeof value.bindingDigest !== "string" || !HEX.test(value.bindingDigest)
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.launchpadIds) || (value.updatedAt !== null && (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))))
    || !isTimestamp(value.readAt) || (value.revision === 0) !== (value.updatedAt === null)) fail("state_unavailable");
  let ids: string[];
  try { ids = canonicalRunnerLaunchpadIds(value.launchpadIds as string[]); } catch { return fail("state_unavailable"); }
  if (JSON.stringify(ids) !== JSON.stringify(value.launchpadIds)) fail("state_unavailable");
  return { schemaVersion: 1, agentId: value.agentId, bindingDigest: value.bindingDigest, revision: value.revision, launchpadIds: ids,
    updatedAt: value.updatedAt as string | null, readAt: value.readAt };
}

/** Pure: may a decision or buy cite this launchpad signal? (subscribed at the signal's revision under its binding, live, fresh catalog) */
export function privateLaunchpadAdmitted(signal: PrivateLaunchpadSignalFacts, record: PrivateLaunchpadSubscriptionRecord | undefined,
  catalog: { catalog: RunnerLaunchpadCatalog; readAt: number } | undefined, nowMs: number): boolean {
  if (signal.platform !== "launchpad") return false;
  if (!record || !catalog || !Number.isFinite(nowMs) || nowMs < catalog.readAt || nowMs - catalog.readAt >= PRIVATE_LAUNCHPAD_CATALOG_TTL_MS) return false;
  if (record.bindingDigest !== signal.bindingDigest || record.revision < 1 || record.revision !== signal.sourceRevision) return false;
  const entry = catalog.catalog.launchpads.find((item) => item.sourceId === signal.sourceId);
  return Boolean(entry && SOURCE_ID.test(entry.sourceId) && entry.status === "live" && record.launchpadIds.includes(entry.id));
}

type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<PrivateLaunchpadSubscriptionRecord> };

export class PrivateLaunchpads {
  readonly #options: PrivateLaunchpadsOptions;
  readonly #agentIds: string[];
  readonly #directory: string;
  readonly #slots = new Map<string, Slot>();
  readonly #catalogs = new Map<string, { catalog: RunnerLaunchpadCatalog; readAt: number }>();
  readonly #now: () => number;
  #closed = false;

  constructor(options: PrivateLaunchpadsOptions) {
    if (!isRecord(options) || typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !isId(options.localProfileId)
      || !isId(options.instanceId) || !Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id))
      || typeof options.assertAvailable !== "function" || typeof options.readLease !== "function") fail();
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds };
    this.#directory = path.resolve(options.directory); this.#now = options.now ?? Date.now;
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Idempotent. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }
  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") slot.storage.close();
    this.#slots.clear();
  }

  /** The catalog of the agent's pairing origin: the cached copy while fresh, else one bounded read. */
  async catalog(agentId: string, signal?: AbortSignal): Promise<RunnerLaunchpadCatalog> {
    const lease = this.#lease(agentId);
    const cached = this.#catalogs.get(lease.frontendOrigin); const now = this.#now();
    if (cached && now >= cached.readAt && now - cached.readAt < PRIVATE_LAUNCHPAD_CATALOG_TTL_MS) return cached.catalog;
    let catalog: RunnerLaunchpadCatalog;
    try { catalog = await (this.#options.fetchCatalog ?? ((origin, abort) => fetchRunnerLaunchpadCatalog({ frontendOrigin: origin }, abort)))(lease.frontendOrigin, signal); }
    catch { return fail("catalog_unavailable"); }
    this.#catalogs.set(lease.frontendOrigin, { catalog, readAt: this.#now() });
    return catalog;
  }
  /** The stored subscription, or undefined (never subscribed through this runner, or not read yet). Read-only; creates no file. */
  subscription(agentId: string): PrivateLaunchpadSubscriptionRecord | undefined {
    this.#known(agentId);
    const slot = this.#slot(agentId, false);
    if (!slot) return undefined;
    try { return slot.storage.read(); } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
  }
  /** Reads the agent's subscription from Balchemy (runner-signed `get`) and stores it. */
  async refresh(agentId: string, signal?: AbortSignal): Promise<PrivateLaunchpadSubscriptionRecord> {
    return this.#exchange(agentId, { kind: "get" }, signal);
  }
  /** Replaces the whole subscription (sorted, unique; only live catalog ids; `[]` unsubscribes) and stores Balchemy's answer. */
  async set(agentId: string, ids: readonly string[], signal?: AbortSignal): Promise<PrivateLaunchpadSubscriptionRecord> {
    let launchpadIds: string[];
    try { launchpadIds = canonicalRunnerLaunchpadIds(ids); } catch { return fail("invalid_request"); }
    const catalog = await this.catalog(agentId, signal);
    for (const id of launchpadIds) {
      const entry = catalog.launchpads.find((item) => item.id === id);
      if (!entry) fail("launchpad_unknown");
      if (entry.status !== "live") fail("launchpad_not_live");
    }
    return this.#exchange(agentId, { kind: "set", launchpadIds }, signal);
  }
  /** Owner view: the fresh catalog and the current subscription (one `get`). */
  async view(agentId: string, signal?: AbortSignal): Promise<PrivateLaunchpadView> {
    const catalog = await this.catalog(agentId, signal);
    return privateLaunchpadView(catalog, await this.refresh(agentId, signal));
  }
  /** Before a launchpad decision: refresh a missing, foreign-binding or old subscription and a stale catalog. Never throws; a failed
   * refresh leaves `admitted` false. */
  async prepare(agentId: string, bindingDigest: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.catalog(agentId, signal);
      let record: PrivateLaunchpadSubscriptionRecord | undefined;
      try { record = this.subscription(agentId); } catch { record = undefined; }
      const now = this.#now();
      if (!record || record.bindingDigest !== bindingDigest || now < record.readAt || now - record.readAt >= PRIVATE_LAUNCHPAD_SUBSCRIPTION_TTL_MS)
        await this.refresh(agentId, signal);
    } catch { /* Held by `admitted`. */ }
  }
  /** Synchronous provenance check from the stored subscription and the cached catalog (see privateLaunchpadAdmitted). */
  admitted(agentId: string, frontendOrigin: string, signal: PrivateLaunchpadSignalFacts): boolean {
    try { return privateLaunchpadAdmitted(signal, this.subscription(agentId), this.#catalogs.get(frontendOrigin), this.#now()); }
    catch { return false; }
  }

  async #exchange(agentId: string, request: RunnerLaunchpadSubscriptionsRequest, signal?: AbortSignal): Promise<PrivateLaunchpadSubscriptionRecord> {
    const lease = this.#lease(agentId);
    const query: PrivateLaunchpadQuery = this.#options.query ?? ((id, current, input, abort) => new RunnerLaunchpadSubscriptionsClient({
      frontendOrigin: current.frontendOrigin, agentId: current.agentId, bindingDigest: current.bindingDigest, runnerPublicKey: current.runnerPublicKey,
      instanceId: current.instanceId, apiBaseUrl: `${current.frontendOrigin}/api`,
      signer: (nonce, expected) => {
        const live = this.#options.readLease(id);
        if (!live || live.bindingDigest !== current.bindingDigest || live.epoch !== expected.epoch) throw new Error("lease changed");
        return signRunnerLaunchpadSubscriptionsProof({ directory: this.#options.directory, localProfileId: this.#options.localProfileId, agentId: id },
          { instanceId: current.instanceId, epoch: expected.epoch, request: expected.request, nonce });
      } }).query(input, current.epoch, abort));
    let response: RunnerLaunchpadSubscriptionsResponse;
    try { response = await query(agentId, lease, request, signal); }
    catch (error: unknown) {
      // The SDK reports a refused launchpad as LAUNCHPAD_UNKNOWN / LAUNCHPAD_NOT_LIVE.
      const code = isRecord(error) && typeof error.machineCode === "string" ? error.machineCode.toLowerCase() : "";
      return fail(code === "launchpad_unknown" || code === "launchpad_not_live" ? code : "subscription_unavailable");
    }
    const current = this.#options.readLease(agentId);
    if (response.agentId !== lease.agentId || response.bindingDigest !== lease.bindingDigest || response.instanceId !== lease.instanceId
      || !current || current.bindingDigest !== lease.bindingDigest) fail("subscription_unavailable");
    const record: PrivateLaunchpadSubscriptionRecord = { schemaVersion: 1, agentId, bindingDigest: response.bindingDigest,
      revision: response.subscription.revision, launchpadIds: [...response.subscription.launchpadIds], updatedAt: response.subscription.updatedAt,
      readAt: this.#now() };
    this.#write(agentId, decodeRecord(record));
    return record;
  }
  #lease(agentId: string): Readonly<RunnerRuntimeActiveLease> {
    this.#known(agentId);
    const lease = this.#options.readLease(agentId);
    if (!lease || lease.instanceId !== this.#options.instanceId || !(lease.remainingMs > 0)) fail("lease_unavailable");
    return lease;
  }
  #known(agentId: string): void {
    if (this.#closed) fail("closing");
    if (!isId(agentId) || !this.#agentIds.includes(agentId)) fail("unknown_agent");
  }
  #write(agentId: string, record: PrivateLaunchpadSubscriptionRecord): void {
    const slot = this.#slot(agentId, true, record);
    if (!slot) fail("state_unavailable");
    try { slot.storage.commit(record); } catch { this.#slots.set(agentId, { kind: "held" }); fail("state_unavailable"); }
  }
  /** Opens the agent's record; without `create`, a record that does not exist yet stays absent (no file is created). */
  #slot(agentId: string, create: boolean, initial?: PrivateLaunchpadSubscriptionRecord): Extract<Slot, { kind: "open" }> | undefined {
    const current = this.#slots.get(agentId);
    if (current?.kind === "held") fail("state_unavailable");
    if (current) return current;
    const files = privateLaunchpadFiles(agentId);
    const present = [files.markerFile, files.snapshotFile].some((name) => {
      try { fs.lstatSync(path.join(this.#directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    });
    if (!present && !create) return undefined;
    try {
      const storage = new OwnedJsonSnapshot<PrivateLaunchpadSubscriptionRecord>({ directory: this.#directory, ...files,
        marker: { schemaVersion: 1, localProfileId: this.#options.localProfileId, agentId, kind: "launchpad_subscription" },
        maximumBytes: MAX_RECORD_BYTES, initial: initial ?? { schemaVersion: 1, agentId, bindingDigest: "0".repeat(64), revision: 0, launchpadIds: [],
          updatedAt: null, readAt: 0 }, assertAvailable: this.#options.assertAvailable, decode: decodeRecord });
      const slot = { kind: "open" as const, storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
  }
}

export function privateLaunchpadView(catalog: RunnerLaunchpadCatalog, record: PrivateLaunchpadSubscriptionRecord): PrivateLaunchpadView {
  return { revision: record.revision, subscribedIds: [...record.launchpadIds], updatedAt: record.updatedAt,
    launchpads: catalog.launchpads.map((item) => ({ id: item.id, name: item.name, status: item.status, sourceNote: item.sourceNote,
      subscribed: record.launchpadIds.includes(item.id) })) };
}
