/** K2 one-visit setup, runner side (owner decisions of 19 Nov 2026): on the same Hub page as the pairing, the owner PROPOSES a SOL
 * spend ceiling (per trade and per day, never `none`); this daemon worker reads the proposal with a runner-signed read, opens exactly
 * one `first_enable` challenge per proposal for exactly those caps (basis `fixed`) through `PrivateOwnerApprovals.requestCeiling`,
 * shows its LOCAL check code to the cockpit, and polls the challenge with the existing `poll()`, which verifies the owner's signature
 * itself against the pinned paired wallet before storing anything. A proposal grants nothing; a signed ceiling is a maximum that later
 * lower caps are covered by (`covers()`), so arming within it needs no second browser visit. Nothing here arms, signs a transaction or
 * moves funds.
 *
 * Polling (Balchemy: 30 reads per minute and 2 s per agent on each route) runs only while a setup window is open: up to 30 minutes
 * after a bind this daemon run made (the pairing just finished), or while the cockpit's setup step keeps it alive (`watch`). It stops
 * when the approval is stored, after 30 minutes without a proposal, or on any final refusal (fail closed). One sequential tick per
 * agent every 3 s; at most one request in flight per agent. */
import { performance } from "node:perf_hooks";
import { AgentSdkError, RunnerFirstEnableCeilingClient, validateRunnerCeilingProposal, type RunnerCeilingReadRequest,
  type RunnerCeilingReadResponse } from "@balchemyai/agent-sdk";
import { signRunnerCeilingReadProof, type PairingOwnerApprovalIdentity } from "./pairing-identity.js";
import { addRunnerAgent } from "./agent-roster.js";
import { isId, isRecord } from "./protocol.js";
import { PrivateOwnerApprovalError, privateOwnerApprovalCapsCovered, type PrivateOwnerApprovalBinding, type PrivateOwnerApprovalCeiling,
  type PrivateOwnerApprovalLink, type PrivateOwnerApprovals } from "./private-owner-approvals.js";
import type { PrivateTradingBindingRecord } from "./private-trading-binding.js";
import type { PrivateCeilingRefusal, PrivateCeilingRetryReason, PrivateSetupCeilingView } from "./private-setup-protocol.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";

export const PRIVATE_CEILING_TICK_MS = 3_000;
/** The ceiling read route spaces reads 2 s per agent; a margin covers clock rates. */
export const PRIVATE_CEILING_READ_SPACING_MS = 2_250;
/** How long after its last `watch` the cockpit's setup step counts as open (it watches every 3 s). */
export const PRIVATE_CEILING_WATCH_MS = 10_000;
/** A setup window without any proposal ends after this (and a bind opens one for this long). */
export const PRIVATE_CEILING_WINDOW_MS = 30 * 60_000;
const READ_TIMEOUT_MS = 8_000;
const RATE_LIMIT_PAUSE_MS = 3 * PRIVATE_CEILING_TICK_MS;
const MAX_SERVED = 32;
const UNSUPPORTED = new Set([404, 405, 410, 501]);

export type PrivateCeilingReadErrorCode = "stale" | "unsupported" | "rate_limited" | "network" | "lease" | "mismatch" | "cancelled";
export class PrivateCeilingReadError extends Error {
  constructor(readonly code: PrivateCeilingReadErrorCode) { super(`Spend ceiling read ${code}`); this.name = "PrivateCeilingReadError"; }
}
function readFail(code: PrivateCeilingReadErrorCode): never { throw new PrivateCeilingReadError(code); }

/** The network half: one bounded, lease-fenced runner-signed proposal read. Tests substitute it. */
export interface PrivateCeilingReadTransport {
  read(agentId: string, identity: PairingOwnerApprovalIdentity, request: RunnerCeilingReadRequest, signal: AbortSignal | undefined):
    Promise<Readonly<RunnerCeilingReadResponse>>;
}
export interface PrivateCeilingReadTransportOptions {
  directory: string; localProfileId: string; instanceId: string;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  fetchFn?: typeof fetch;
}
const leaseIdentity = (value: { frontendOrigin: string; agentId: string; bindingDigest: string; runnerPublicKey: string }): string =>
  JSON.stringify([value.frontendOrigin, value.agentId, value.bindingDigest, value.runnerPublicKey]);

/** The production transport: the current lease must be this pairing's and must not change between the first check, the signature
 * and the answer (the same fence as the owner-approval transport). The SDK validates the answer against the pinned request. */
export function privateCeilingReadTransport(options: PrivateCeilingReadTransportOptions): PrivateCeilingReadTransport {
  return {
    async read(agentId, identity, request, signal) {
      const initial = options.readLease(agentId);
      if (!initial || initial.instanceId !== options.instanceId || !Number.isSafeInteger(initial.epoch) || initial.epoch < 1
        || !(initial.remainingMs > 0) || leaseIdentity(initial) !== leaseIdentity(identity)) readFail("lease");
      const pinned = JSON.stringify([leaseIdentity(initial), initial.instanceId, initial.epoch]);
      const held = (): boolean => {
        const lease = options.readLease(agentId);
        return !!lease && JSON.stringify([leaseIdentity(lease), lease.instanceId, lease.epoch]) === pinned && lease.remainingMs > 0;
      };
      let signerFailed = false;
      const scope = { directory: options.directory, localProfileId: options.localProfileId, agentId };
      try {
        const client = new RunnerFirstEnableCeilingClient({ frontendOrigin: initial.frontendOrigin, agentId: initial.agentId,
          bindingDigest: initial.bindingDigest, runnerPublicKey: initial.runnerPublicKey, instanceId: initial.instanceId,
          apiBaseUrl: `${initial.frontendOrigin}/api`, timeoutMs: Math.max(1, Math.min(Math.floor(initial.remainingMs), READ_TIMEOUT_MS)),
          ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
          readSigner: (nonce, expected) => {
            try {
              if (signal?.aborted || !held()) throw new Error("lease changed");
              return signRunnerCeilingReadProof(scope, { instanceId: options.instanceId, epoch: expected.epoch, request: expected.request, nonce });
            } catch (error: unknown) { signerFailed = true; throw error; }
          } });
        const response = await client.readProposal(request, initial.epoch, signal);
        if (!held()) readFail("lease");
        return response;
      } catch (error: unknown) {
        if (signal?.aborted) readFail("cancelled");
        if (error instanceof PrivateCeilingReadError) throw error;
        if (signerFailed || !held()) readFail("lease");
        const status = error instanceof AgentSdkError ? error.status : undefined;
        if (status === 409) readFail("stale");
        if (status !== undefined && UNSUPPORTED.has(status)) readFail("unsupported");
        if (status === 429 || (error instanceof AgentSdkError && error.code === "rate_limit_error")) readFail("rate_limited");
        // A validated-but-unexpected answer (another request digest, a proposal out of bounds) is a mismatch, never a proposal.
        if (error instanceof AgentSdkError && error.code === "invalid_response") readFail("mismatch");
        return readFail("network");
      }
    },
  };
}

export type PrivateCeilingApprovals = Pick<PrivateOwnerApprovals, "requestCeiling" | "ceilingRequest" | "poll" | "record">;
export interface PrivateCeilingWorkerOptions {
  agentIds: readonly string[];
  /** The authority identity: in the daemon the sealed owner pin (`PrivateOwnerPins.identity`, A2a), which throws `owner_pin_missing` or
   * `wallet_locked` (both read as not ready) or another pin refusal; undefined until adopted. */
  readIdentity(agentId: string): PairingOwnerApprovalIdentity | undefined;
  /** The agent's local binding record (`PrivateTradingBindings.record`); only an `active` one is used. */
  readBinding(agentId: string): PrivateTradingBindingRecord | undefined;
  /** The daemon's owner-approval store (lazy). */
  approvals(): PrivateCeilingApprovals;
  transport: PrivateCeilingReadTransport;
  now?(): number;
  monotonicNow?(): number;
}
interface Challenge { proposalId: string; ceiling: PrivateOwnerApprovalCeiling; link: PrivateOwnerApprovalLink }
interface AgentState {
  /** Monotonic times: a bind's window, the cockpit's keep-alive, the last proposal seen, the next tick, the last proposal read. */
  bindUntil: number; watchUntil: number; lastProposalAt: number; nextAt: number; lastRead: number;
  inFlight?: Promise<void>;
  served: string[];
  challenge?: Challenge;
  expired?: PrivateOwnerApprovalCeiling;
  /** Final for this window (cleared when a new window opens). */
  stopped?: PrivateCeilingRefusal;
  /** Ends only the current proposal (`too_many_open`, `request_failed`) or a transient read failure. */
  notice?: { kind: "refused"; reason: PrivateCeilingRefusal } | { kind: "retrying"; reason: PrivateCeilingRetryReason };
  requesting?: PrivateOwnerApprovalCeiling;
  /** The approval for the served ceiling is stored: nothing more to poll until a new bind. */
  done: boolean;
}
type Ready = { identity: PairingOwnerApprovalIdentity; binding: PrivateOwnerApprovalBinding } | { view: PrivateSetupCeilingView };

export class PrivateCeilingWorker {
  readonly #options: PrivateCeilingWorkerOptions;
  readonly #agentIds: string[];
  readonly #state = new Map<string, AgentState>();
  readonly #abort = new AbortController();
  #closed = false;

  constructor(options: PrivateCeilingWorkerOptions) {
    if (!Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.readIdentity !== "function"
      || typeof options.readBinding !== "function" || typeof options.approvals !== "function" || !options.transport) throw new Error("Invalid ceiling worker options");
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** A bind this daemon run made (the pairing just finished): a 30-minute setup window opens. */
  opened(agentId: string): void {
    const state = this.#agent(agentId); if (!state) return;
    const now = this.#mono();
    state.bindUntil = now + PRIVATE_CEILING_WINDOW_MS; state.lastProposalAt = now; state.stopped = undefined; state.notice = undefined; state.done = false;
  }
  /** The cockpit's setup step is open (keep-alive). A step opened after a gap starts a fresh window. */
  watch(agentId: string): void {
    const state = this.#agent(agentId); if (!state) return;
    const now = this.#mono();
    if (!this.#active(state, now)) { state.lastProposalAt = now; state.stopped = undefined; state.notice = undefined; }
    state.watchUntil = now + PRIVATE_CEILING_WATCH_MS;
  }

  /** Public facts only (never a nonce or signature). A stored approval for the current binding is `approved`; reads that fail are a
   * refusal, never "missing". */
  status(agentId: string): PrivateSetupCeilingView {
    const state = this.#agent(agentId);
    if (!state) return { state: "refused", reason: "state_unavailable" };
    const ready = this.#ready(agentId);
    if ("view" in ready) return ready.view;
    if (state.stopped) return { state: "refused", reason: state.stopped };
    const now = this.#now();
    const challenge = state.challenge;
    if (challenge && Date.parse(challenge.link.expiresAt) > now) {
      return { state: "challenge", challengeId: challenge.link.challengeId, checkCode: challenge.link.checkCode, expiresAt: challenge.link.expiresAt,
        ...challenge.ceiling };
    }
    let record: ReturnType<PrivateCeilingApprovals["record"]>;
    try { record = this.#options.approvals().record(agentId, ready.binding); } catch { return { state: "refused", reason: "state_unavailable" }; }
    if (record) {
      return { state: "approved", perTradeLamports: record.caps.perTrade.kind === "lamports" ? record.caps.perTrade.lamports : null,
        dailyLamports: record.caps.daily.kind === "lamports" ? record.caps.daily.lamports : null };
    }
    if (!this.#active(state, this.#mono())) return { state: "idle" };
    if (state.requesting) return { state: "requesting", ...state.requesting };
    if (state.notice?.kind === "refused") return { state: "refused", reason: state.notice.reason };
    if (challenge || state.expired) return { state: "expired", ...(challenge ? challenge.ceiling : state.expired!) };
    if (state.notice?.kind === "retrying") return { state: "retrying", reason: state.notice.reason };
    return { state: "waiting" };
  }

  /** One scheduling pass (the daemon calls it every second): starts a tick for each agent whose window is open, whose previous tick
   * ended and whose next time came. Resolves when the ticks it started end. Never throws. */
  pass(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const started: Promise<void>[] = [];
    const now = this.#mono();
    for (const agentId of this.#agentIds) {
      const state = this.#agent(agentId);
      if (!state || state.inFlight || state.done || state.stopped || state.nextAt > now || !this.#active(state, now)) continue;
      const work = this.#tick(agentId, state).catch(() => undefined).finally(() => {
        state.inFlight = undefined; state.nextAt = Math.max(state.nextAt, this.#mono() + PRIVATE_CEILING_TICK_MS);
      });
      state.inFlight = work; started.push(work);
    }
    return Promise.all(started).then(() => undefined);
  }
  async close(): Promise<void> {
    this.#closed = true; this.#abort.abort();
    await Promise.allSettled([...this.#state.values()].map((state) => state.inFlight));
  }

  async #tick(agentId: string, state: AgentState): Promise<void> {
    const ready = this.#ready(agentId);
    if ("view" in ready) { if (ready.view.state === "refused") state.stopped = ready.view.reason; return; }
    const { identity, binding } = ready;
    const signal = this.#abort.signal;
    // 1. The open challenge, if any: the existing poll verifies and stores the owner's evidence itself.
    const challenge = state.challenge;
    if (challenge) {
      try {
        const answer = await this.#options.approvals().poll(agentId, challenge.link.challengeId, signal);
        if (answer === "approved") { state.challenge = undefined; state.expired = undefined; state.notice = undefined; state.done = true; state.bindUntil = 0; return; }
        if (answer === "expired") { state.challenge = undefined; state.expired = challenge.ceiling; }
      } catch (error: unknown) {
        if (this.#closed) return;
        const code = error instanceof PrivateOwnerApprovalError ? error.code : "state_unavailable";
        if (code === "approval_superseded") { state.challenge = undefined; state.done = true; return; }
        if (code === "approval_mismatch") { state.stopped = "mismatch"; return; }
        if (code === "owner_approval_unverifiable") { state.stopped = "unverifiable"; return; }
        if (code === "state_unavailable") { state.stopped = "state_unavailable"; return; }
        // lease_unavailable, approval_unavailable, cancelled: the next tick polls again.
      }
    }
    // 2. The owner's current proposal.
    const now = this.#mono();
    if (!state.challenge && now - state.lastProposalAt > PRIVATE_CEILING_WINDOW_MS) { state.stopped = "timed_out"; return; }
    if (now - state.lastRead < PRIVATE_CEILING_READ_SPACING_MS) return;
    let response: Readonly<RunnerCeilingReadResponse>;
    try { response = await this.#options.transport.read(agentId, identity, { version: 1, ...binding }, signal); }
    catch (error: unknown) {
      if (this.#closed) return;
      const code = error instanceof PrivateCeilingReadError ? error.code : "network";
      if (code === "stale" || code === "unsupported" || code === "mismatch") { state.stopped = code; return; }
      if (code === "rate_limited") state.nextAt = this.#mono() + RATE_LIMIT_PAUSE_MS;
      if (code !== "cancelled") state.notice = { kind: "retrying", reason: code === "rate_limited" ? "rate_limited" : code === "lease" ? "lease" : "network" };
      return;
    } finally { state.lastRead = this.#mono(); }
    if (state.notice?.kind === "retrying") state.notice = undefined;
    if (response.state === "none") return;
    let proposal: ReturnType<typeof validateRunnerCeilingProposal>;
    try { proposal = validateRunnerCeilingProposal(response.proposal, this.#now()); } catch { state.stopped = "mismatch"; return; }
    state.lastProposalAt = this.#mono();
    if (state.served.includes(proposal.proposalId)) return;
    // Served from here on: at most one challenge per proposal, and a refused create is never retried for the same id.
    state.served = [...state.served, proposal.proposalId].slice(-MAX_SERVED);
    state.notice = undefined;
    const ceiling: PrivateOwnerApprovalCeiling = { perTradeLamports: proposal.perTradeLamports, dailyLamports: proposal.dailyLamports };
    const approvals = this.#options.approvals();
    try {
      // Already covered by a stored approval (for example after a restart): nothing to sign.
      const record = approvals.record(agentId, binding);
      if (record && privateOwnerApprovalCapsCovered(record.caps, { perTrade: { kind: "lamports", lamports: ceiling.perTradeLamports },
        daily: { kind: "lamports", lamports: ceiling.dailyLamports } })) { state.challenge = undefined; state.expired = undefined; state.done = true; return; }
      // A challenge this runner already opened for this proposal (a restart): resume it instead of opening a second one.
      const resumed = approvals.ceilingRequest(agentId, binding, ceiling, Date.parse(proposal.createdAt));
      if (resumed) { state.challenge = { proposalId: proposal.proposalId, ceiling, link: resumed }; state.expired = undefined; return; }
    } catch (error: unknown) {
      state.stopped = error instanceof PrivateOwnerApprovalError && error.code === "approval_mismatch" ? "mismatch" : "state_unavailable"; return;
    }
    state.requesting = ceiling;
    try {
      const link = await approvals.requestCeiling(agentId, binding, ceiling, signal);
      state.challenge = { proposalId: proposal.proposalId, ceiling, link }; state.expired = undefined;
    } catch (error: unknown) {
      if (this.#closed) return;
      const failure = error instanceof PrivateOwnerApprovalError ? error : undefined;
      if (failure?.code === "cancelled") { state.served = state.served.filter((id) => id !== proposal.proposalId); return; }
      if (failure?.status === 409) { state.stopped = "stale"; return; }
      if (failure?.code === "approval_mismatch") { state.stopped = "mismatch"; return; }
      if (failure?.code === "owner_approval_unverifiable") { state.stopped = "unverifiable"; return; }
      if (!failure || failure.code === "state_unavailable") { state.stopped = "state_unavailable"; return; }
      state.notice = { kind: "refused", reason: failure.status === 429 ? "too_many_open" : "request_failed" };
    } finally { state.requesting = undefined; }
  }

  /** The pinned identity and the ACTIVE binding of this same pairing, or the view that says why not (checked locally, before any
   * network call: a Base pairing is unverifiable, a binding of another pairing is stale). */
  #ready(agentId: string): Ready {
    let identity: PairingOwnerApprovalIdentity | undefined;
    let record: PrivateTradingBindingRecord | undefined;
    try { identity = this.#options.readIdentity(agentId); record = identity ? this.#options.readBinding(agentId) : undefined; }
    catch (error: unknown) {
      // A2a (plan section B4): the daemon reads the authority identity from the sealed owner pin. No pin yet, or a locked wallet (the pin
      // verifies only while unlocked), is not ready: autoBind starts this worker by itself, before the owner's seal step.
      const code = isRecord(error) ? error.code : undefined;
      if (code === "owner_pin_missing" || code === "wallet_locked") return { view: { state: "not_ready" } };
      return { view: { state: "refused", reason: "state_unavailable" } };
    }
    if (!identity) return { view: { state: "not_ready" } };
    if (identity.pairedWallet.chain !== "solana") return { view: { state: "refused", reason: "unverifiable" } };
    if (!record || record.state !== "active") return { view: { state: "not_ready" } };
    const b = record.binding;
    if (b.agentId !== identity.agentId || b.bindingDigest !== identity.bindingDigest || b.runnerPublicKey !== identity.runnerPublicKey
      || record.frontendOrigin !== identity.frontendOrigin) return { view: { state: "refused", reason: "stale" } };
    return { identity, binding: { walletBindingId: b.walletBindingId, tradingWalletAddress: b.walletAddress } };
  }
  #active(state: AgentState, now: number): boolean { return state.bindUntil > now || state.watchUntil > now; }
  #agent(agentId: string): AgentState | undefined {
    if (this.#closed || !this.#agentIds.includes(agentId)) return undefined;
    let state = this.#state.get(agentId);
    if (!state) {
      state = { bindUntil: 0, watchUntil: 0, lastProposalAt: this.#mono(), nextAt: 0, lastRead: -Infinity, served: [], done: false };
      this.#state.set(agentId, state);
    }
    return state;
  }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #mono(): number { return (this.#options.monotonicNow ?? (() => performance.now()))(); }
}
