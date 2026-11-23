/** S8a single local execution choke point. Every runner path that could build, sign or relay a swap asks this gate first,
 * and again after every asynchronous boundary; the backend runs its own arming gate independently at every build and
 * submit (the runner-signed live_armed heartbeat mirror, owner controls and halts), so neither side trusts the other.
 *
 * Steps:
 * - `entry_build` (a new BUY build): live_armed, armed, idle, entries enabled, the plan's runtime revision is the current
 *   one, the plan's confirmed rules still carry a stop-loss, and no owner approval requirement applies.
 * - `entry_sign` (the one keystore signature of a validated BUY): live_armed, armed, idle, entries enabled, and the same
 *   runtime revision the build ran under (a disarm, stop, pause or re-arm in between refuses).
 * - Both entry steps also re-read live owner facts (S8a review, defence in depth beside the change path: since the owner
 *   decision of 17 Nov 2026 a change to rules, sizing or caps of an armed agent pauses its entries while it is saved and resumes
 *   them only when the new facts still pass the entry prerequisites, private-change-entries.ts; an RPC change disarms first or is
 *   refused while a trade is open): the confirmed rules head is still the plan's revision and not shadowMode, and the agent's
 *   RPC is still the owner's own endpoint or the two Balchemy-provided sources (never the public shadow-only class, never none).
 * - `relay` (relaying already-signed, journaled bytes, including identical recovery resends): live_armed, armed, idle.
 *   Pausing entries never blocks it; disarm or stop does (no execution at all, exits included). Status reconciliation is
 *   never gated: it only reads server truth.
 * - `exit_build` / `exit_sign` (S5c: the sell of an open position): live_armed, armed, idle and the exits capability.
 *   An entries pause never blocks an exit (owner decision: pause stops new entries, exits continue); disarm, stop or a
 *   non-idle runtime does (no execution at all). The exit follows its position's stored exit snapshot (fixed when the buy
 *   opened it), so the live rules head is not consulted: a rules change while armed pauses entries only and never alters the
 *   stop-loss of an open position; the agent's RPC must still be the owner's own endpoint or Balchemy-provided, and `exit_sign` requires the runtime
 *   revision the exit build ran under (a change hold or release in between refuses that one signature; the next pass rebuilds).
 *   Owner decision of 23 Nov 2026: an unreadable rule store therefore never stops an exit (privateExecutionLiveFacts reads its fields
 *   null, which only the entry steps refuse, `rules_unavailable`); a failed read of the facts as a whole (`undefined`) still refuses.
 *
 * Exits (S5) ship in this build: the single capability flag PRIVATE_EXIT_EXECUTION_AVAILABLE is true, so automatic
 * stop-loss/take-profit sells can protect an autonomous buy. A build with the flag false (the exits-off rollback build)
 * refuses `exits_unavailable` at every new-buy step here and at the arming precheck, and its sells are refused. The
 * `capabilities` argument is a test-only seam: production callers never pass it, and nothing (no env var, file or IPC) can
 * set it at runtime.
 *
 * PRIVATE_SIGNAL_PLAN_UNAVAILABLE_GATES stays the plan's immutable record (a plan never claims execution). Of that list
 * this gate now enforces `live_permission` (live_armed + entries) and `approval` (refused while any applies: the approval
 * flow is not built). Enforced elsewhere on the same path: `spending_ceiling` (local ledger caps, mirrored server-side),
 * `pretrade` (fresh allow assessment), `global_fee` and `slippage_policy` (server fee policy inside the runner's fee-wallet
 * allow-list and 150 bps ceiling, private-fee-policy.ts; validator min-out bound),
 * `signer`, `submission` and `reconciliation` (S4 journal and relay). The plan gates `price`, `balance`, `positions` and
 * `trade_rate` have no dedicated local gate; what bounds them on this path: `price` the fresh pretrade allow and the validated
 * min-out; `balance` the pre-signature simulation; `positions` PRIVATE_POSITIONS_MAX_ACTIVE (64) and the entry hold;
 * `trade_rate` one buy start per wallet per PRIVATE_EXECUTION_RATE_MS (30 s, wall clock) and the autonomy daily call limit
 * (200 by default, at most 2000) with its 10 min token cooldown (private-autonomy.ts). With both spend caps `none`, spend is
 * bounded only by these. */
import type { PRIVATE_SIGNAL_PLAN_UNAVAILABLE_GATES } from "./private-signal-plan.js";
import { isId, parseAgentState, type RunnerAgentState } from "./protocol.js";

export const PRIVATE_EXECUTION_GATE_ENFORCES = ["live_permission", "approval"] as const satisfies readonly typeof PRIVATE_SIGNAL_PLAN_UNAVAILABLE_GATES[number][];
export const PRIVATE_EXECUTION_GATE_REFUSALS = ["runtime_unavailable", "runtime_stopped", "runtime_not_armed", "entries_paused",
  "runtime_changed", "rules_unavailable", "stop_loss_missing", "owner_approval_required", "rules_changed", "rules_shadow_mode",
  "rpc_not_owner_configured", "exits_unavailable"] as const;
/** True since S5: automatic stop-loss/take-profit exits execute. Only the exits-off rollback build sets it false. */
export const PRIVATE_EXIT_EXECUTION_AVAILABLE = true;
export interface PrivateExecutionCapabilities {
  readonly exits: boolean;
  /** Test-only: one synthetic fee wallet that replaces the runner's fee-wallet allow-list (private-fee-policy.ts). Absent
   * (production): the compile-time BALCHEMY_SOLANA_FEE_WALLETS. The fee ceiling is never injectable. */
  readonly feeWallet?: string;
}
/** The production capabilities. Tests inject their own through constructor/option seams only. */
export const PRIVATE_EXECUTION_CAPABILITIES: PrivateExecutionCapabilities = Object.freeze({ exits: PRIVATE_EXIT_EXECUTION_AVAILABLE });
export type PrivateExecutionGateRefusal = typeof PRIVATE_EXECUTION_GATE_REFUSALS[number];
export type PrivateExecutionGateStep = "entry_build" | "entry_sign" | "relay" | "exit_build" | "exit_sign";
/** Plan facts for `entry_build`, copied from a resolved plan (risks + exit snapshot); null when the plan has none. */
export interface PrivateExecutionGatePlan {
  runtimeVersion: number;
  /** The confirmed rule revision the plan was resolved under (null when the plan has none). */
  ruleRevisionId: string | null;
  risks: { confirmBeforeTrade: boolean; requireApprovalAboveUsd: number | null; requireApprovalForNewTokens: boolean } | null;
  exit: { stopLossBps: number } | null;
}
/** Owner facts read live at each entry step; `undefined` (a failed read) refuses. */
export interface PrivateExecutionLiveFacts {
  /** Current confirmed Solana rules head; shadowMode from its execution policy (null when not executable). */
  ruleRevisionId: string | null; rulesShadowMode: boolean | null;
  /** Class of the RPC the agent executes on, null when none: the owner's own endpoint, a public shadow-only one, or (owner decision
   * of 17 Nov 2026) the two Balchemy-provided sources. */
  rpcClass: "owner_configured" | "public_shadow_only" | "balchemy_provided" | null;
}
/** The live owner facts from their two separate reads (the daemon's one reader of them). `assertAvailable` is the daemon's guard (its private
 * store is closing or unavailable) and runs first: its throw propagates, so the facts read fails as a whole and every caller then passes
 * `undefined`, which refuses every step. Owner decision of 23 Nov 2026: an unreadable rule store (it fails closed until a restart, for
 * example after a same-user edit of its file while armed) is not a failed read of every fact. Its two fields read null (no executable
 * confirmed rules), so every entry step (a new buy, its signature, a DCA add) still refuses `rules_unavailable`, while exits, which follow
 * their position's bound exit snapshot and need only the RPC class, keep running. Only the rules read is tolerated: a failed RPC read still
 * throws. Besides exit_build/exit_sign, the same facts also let these RPC-class-only reconciliation checks run while the rule store is
 * unreadable: the owner close-out proof (private-submission.ts), the F2/stall releases, the proof that a buy did not land (`#buyReadable`),
 * and the exit worker's balance settlement and position opening (private-exit-worker.ts). None of them signs or relays. */
export function privateExecutionLiveFacts(assertAvailable: () => void,
  readRules: () => Pick<PrivateExecutionLiveFacts, "ruleRevisionId" | "rulesShadowMode">,
  readRpcClass: () => PrivateExecutionLiveFacts["rpcClass"]): PrivateExecutionLiveFacts {
  assertAvailable();
  let rules: Pick<PrivateExecutionLiveFacts, "ruleRevisionId" | "rulesShadowMode">;
  try { const read = readRules(); rules = { ruleRevisionId: read.ruleRevisionId, rulesShadowMode: read.rulesShadowMode }; }
  catch { rules = { ruleRevisionId: null, rulesShadowMode: null }; }
  return { ...rules, rpcClass: readRpcClass() };
}
export type PrivateExecutionGateInput =
  | { step: "entry_build"; agentId: string; plan: PrivateExecutionGatePlan; facts: PrivateExecutionLiveFacts | undefined }
  | { step: "entry_sign"; agentId: string; runtimeVersion: number; ruleRevisionId: string | null; facts: PrivateExecutionLiveFacts | undefined }
  | { step: "relay"; agentId: string }
  | { step: "exit_build"; agentId: string; facts: PrivateExecutionLiveFacts | undefined }
  | { step: "exit_sign"; agentId: string; runtimeVersion: number; facts: PrivateExecutionLiveFacts | undefined };
function liveFacts(facts: PrivateExecutionLiveFacts | undefined, ruleRevisionId: string | null): PrivateExecutionGateRefusal | null {
  if (!facts) return "rules_unavailable";
  if (facts.rpcClass !== "owner_configured" && facts.rpcClass !== "balchemy_provided") return "rpc_not_owner_configured";
  if (facts.rulesShadowMode === null) return "rules_unavailable";
  if (facts.rulesShadowMode) return "rules_shadow_mode";
  return ruleRevisionId !== null && facts.ruleRevisionId === ruleRevisionId ? null : "rules_changed";
}

/** True while any owner approval requirement in the confirmed rules applies. */
export function privateApprovalRequired(risks: PrivateExecutionGatePlan["risks"]): boolean {
  return !risks || risks.confirmBeforeTrade !== false || risks.requireApprovalAboveUsd !== null || risks.requireApprovalForNewTokens !== false;
}

/** Null only when the step may proceed now. Never throws: an unreadable or foreign state is `runtime_unavailable`. */
export function privateExecutionGate(state: RunnerAgentState | undefined, input: PrivateExecutionGateInput,
  capabilities: PrivateExecutionCapabilities = PRIVATE_EXECUTION_CAPABILITIES): PrivateExecutionGateRefusal | null {
  let current: RunnerAgentState;
  try { if (!state || !isId(input.agentId)) return "runtime_unavailable"; current = parseAgentState(state); }
  catch { return "runtime_unavailable"; }
  if (current.agentId !== input.agentId) return "runtime_unavailable";
  if (current.lifecycle !== "idle") return "runtime_stopped";
  if (current.mode !== "live_armed" || current.armed !== true) return "runtime_not_armed";
  if (input.step === "relay") return null;
  if (input.step === "exit_build" || input.step === "exit_sign") {
    // An entries pause never blocks an exit; disarm, stop and a non-idle runtime were refused above.
    if (capabilities.exits !== true) return "exits_unavailable";
    if (input.step === "exit_sign" && current.version !== input.runtimeVersion) return "runtime_changed";
    // The rules fields are not consulted (an unreadable rule store reads them null and the exit continues); a failed facts read refuses.
    // On exits `rules_unavailable` here therefore means the facts read failed as a whole (the private store is closing or unavailable, or
    // the RPC settings read failed), not the rule store.
    if (!input.facts) return "rules_unavailable";
    return input.facts.rpcClass === "owner_configured" || input.facts.rpcClass === "balchemy_provided" ? null : "rpc_not_owner_configured";
  }
  if (current.entries !== "enabled") return "entries_paused";
  if (capabilities.exits !== true) return "exits_unavailable";
  if (input.step === "entry_sign") return current.version === input.runtimeVersion ? liveFacts(input.facts, input.ruleRevisionId) : "runtime_changed";
  const plan = input.plan;
  if (current.version !== plan.runtimeVersion) return "runtime_changed";
  if (!plan.risks || !plan.exit) return "rules_unavailable";
  if (!Number.isSafeInteger(plan.exit.stopLossBps) || plan.exit.stopLossBps <= 0) return "stop_loss_missing";
  if (privateApprovalRequired(plan.risks)) return "owner_approval_required";
  return liveFacts(input.facts, plan.ruleRevisionId);
}
