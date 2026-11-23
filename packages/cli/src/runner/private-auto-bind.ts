/** K2 one-visit setup (owner decision of 19 Nov 2026): the runner links the agent's trading wallet to Balchemy by itself once the
 * pairing receipt is saved, a live runtime lease exists and the wallet is unlocked in this daemon run; no typed `BIND <agent>`. It
 * runs the existing runner-signed bind (`PrivateTradingBindings.bind`: runner-key proof plus the trading key's fixed possession
 * message; no transaction, no funds), which keeps every refusal: the pairing (identity) wallet, identity wallets, runner keys, a wallet
 * bound elsewhere, a second wallet and a revoked agent. A bind grants no trading authority.
 *
 * Retries: a missing lease or wallet is waited for (nothing is sent); a transient failure (lease moved, Balchemy unreachable or busy,
 * an unknown outcome, which an exact re-bind of the same wallet resolves) retries after 2, 4, 8 then every 15 s; every other refusal
 * is final for this daemon run and shown, with `balchemy runner wallet <agent> bind` as the manual fallback. */
import { performance } from "node:perf_hooks";
import { addRunnerAgent } from "./agent-roster.js";
import { isId } from "./protocol.js";
import { PrivateTradingBindingServiceError } from "./private-trading-binding.js";
import type { PrivateTradingBindingError, TradingWalletBindingView } from "./private-trading-binding-protocol.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import type { PrivateSetupLinkView } from "./private-setup-protocol.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";

export const PRIVATE_AUTO_BIND_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000] as const;
const RETRYABLE: ReadonlySet<PrivateTradingBindingError> = new Set<PrivateTradingBindingError>(["lease_unavailable", "wallet_locked",
  "server_unavailable", "rate_limited", "busy", "outcome_unknown", "closing"]);

export interface PrivateAutoBindOptions {
  agentIds: readonly string[];
  /** The pairing receipt is adopted (`readPairingAdoption`). */
  readPaired(agentId: string): boolean;
  readWallet(agentId: string): TradingWalletStatus;
  readBinding(agentId: string): TradingWalletBindingView;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  /** The existing daemon bind (`PrivateTradingBindings.bind`). */
  bind(agentId: string, signal: AbortSignal): Promise<TradingWalletBindingView>;
  /** A bind this run made succeeded (the ceiling worker opens its setup window). */
  onBound?(agentId: string): void;
  monotonicNow?(): number;
}
interface AgentState { inFlight?: Promise<void>; nextAt: number; failures: number; retrying?: PrivateTradingBindingError; refused?: PrivateTradingBindingError }

export class PrivateAutoBind {
  readonly #options: PrivateAutoBindOptions;
  readonly #agentIds: string[];
  readonly #state = new Map<string, AgentState>();
  readonly #abort = new AbortController();
  #closed = false;

  constructor(options: PrivateAutoBindOptions) {
    if (!Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.readPaired !== "function"
      || typeof options.readWallet !== "function" || typeof options.readBinding !== "function" || typeof options.readLease !== "function"
      || typeof options.bind !== "function") throw new Error("Invalid auto-bind options");
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Public facts only. A read that fails is `unavailable`, never "unbound". */
  status(agentId: string): PrivateSetupLinkView {
    const state = this.#agent(agentId);
    if (!state) return { state: "unavailable" };
    let paired: boolean; let wallet: TradingWalletStatus; let binding: TradingWalletBindingView;
    try { paired = this.#options.readPaired(agentId); wallet = this.#options.readWallet(agentId); binding = this.#options.readBinding(agentId); }
    catch { return { state: "unavailable" }; }
    if (binding.state === "bound") return { state: "linked", address: binding.address, walletBindingId: binding.walletBindingId };
    if (binding.state === "revoked") return { state: "refused", reason: "revoked" };
    if (binding.state === "held") return { state: "refused", reason: "state_unavailable" };
    if (!paired) return { state: "unpaired" };
    if (wallet.state === "absent") return { state: "no_wallet" };
    if (wallet.state === "held") return { state: "refused", reason: "wallet_held" };
    if (state.refused) return { state: "refused", reason: state.refused };
    if (state.inFlight) return { state: "linking" };
    if (wallet.state === "locked") return { state: "locked" };
    if (state.retrying) return { state: "retrying", reason: state.retrying };
    if (!this.#leased(agentId)) return { state: "waiting_lease" };
    return { state: "linking" };
  }

  /** One scheduling pass (the daemon calls it every second): binds each paired, unbound agent whose wallet is unlocked and whose lease
   * is live, at most one bind per agent at a time and never before its back-off ends. Resolves when the binds it started end. */
  pass(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const started: Promise<void>[] = [];
    const now = this.#mono();
    for (const agentId of this.#agentIds) {
      const state = this.#agent(agentId);
      if (!state || state.inFlight || state.refused || state.nextAt > now) continue;
      try {
        if (!this.#options.readPaired(agentId) || this.#options.readBinding(agentId).state !== "unbound"
          || this.#options.readWallet(agentId).state !== "unlocked" || !this.#leased(agentId)) continue;
      } catch { continue; }
      const work = this.#bind(agentId, state).finally(() => { state.inFlight = undefined; });
      state.inFlight = work; started.push(work);
    }
    return Promise.all(started).then(() => undefined);
  }
  async close(): Promise<void> {
    this.#closed = true; this.#abort.abort();
    await Promise.allSettled([...this.#state.values()].map((state) => state.inFlight));
  }

  async #bind(agentId: string, state: AgentState): Promise<void> {
    try {
      const view = await this.#options.bind(agentId, this.#abort.signal);
      if (view.state !== "bound") throw new PrivateTradingBindingServiceError("state_unavailable");
      state.failures = 0; state.retrying = undefined;
      try { this.#options.onBound?.(agentId); } catch { /* The cockpit's watch opens the ceiling window as well. */ }
    } catch (error: unknown) {
      if (this.#closed) return;
      const code: PrivateTradingBindingError = error instanceof PrivateTradingBindingServiceError ? error.code : "state_unavailable";
      if (!RETRYABLE.has(code)) { state.refused = code; state.retrying = undefined; return; }
      state.retrying = code;
      state.nextAt = this.#mono() + PRIVATE_AUTO_BIND_BACKOFF_MS[Math.min(state.failures, PRIVATE_AUTO_BIND_BACKOFF_MS.length - 1)]!;
      state.failures += 1;
    }
  }
  #leased(agentId: string): boolean {
    const lease = this.#options.readLease(agentId);
    return !!lease && Number.isSafeInteger(lease.epoch) && lease.epoch >= 1 && lease.remainingMs > 0;
  }
  #agent(agentId: string): AgentState | undefined {
    if (this.#closed || !this.#agentIds.includes(agentId)) return undefined;
    let state = this.#state.get(agentId);
    if (!state) { state = { nextAt: 0, failures: 0 }; this.#state.set(agentId, state); }
    return state;
  }
  #mono(): number { return (this.#options.monotonicNow ?? (() => performance.now()))(); }
}
