/** Owner decision of 17 Nov 2026: an owner change to the trading rules (`private_rules` confirm), the spend caps
 * (`private_arming` limits_set) or the buy size (`private_sizing` update) of an ARMED agent never disarms it. While the change is
 * saved only NEW ENTRIES pause (the agent stays live_armed and armed, so stop-loss and take-profit exits keep running); after a
 * confirmed save they resume automatically, but only when
 * - this change path paused them itself (an owner or Hub pause that was already in place is never lifted),
 * - no control moved the state since the hold (the state version is still the hold's: a Hub pause, disarm or stop in between wins),
 * - no other change of the same agent is still being saved, and
 * - every entry prerequisite still holds on the NEW facts (`check`: the confirmed rules are executable with a stop-loss, not shadow
 *   mode and without a per-trade approval requirement, and the stored owner wallet approval still covers the caps; the same checks
 *   arming runs, private-arming.ts `entriesResumeRefusal`).
 * A failed or unknown save keeps entries paused; the marker stays, so the next successful change resumes them.
 *
 * The marker (agentId -> hold version) lives in daemon memory only: every restart lands live_unarmed (state.ts), so no stale
 * marker can outlive it. The local RPC endpoint is not changed under a hold: an armed agent with an open or unsettled trade refuses
 * the change (`positions_open`, privateRpcSetRefusal); otherwise the RPC change still disarms first. */
import type { RunnerAgentState } from "./protocol.js";
import type { RunnerEntriesHold, RunnerEntriesRelease } from "./state.js";

/** Why new entries stayed paused after a saved change (closed set, owner-local IPC only; never sent to Balchemy). */
export const PRIVATE_CHANGE_ENTRIES_REASONS = ["owner_paused", "other_change", "rules_missing", "rules_not_executable", "stop_loss_missing",
  "rules_shadow_mode", "owner_approval_required", "limits_missing", "owner_wallet_approval_missing", "owner_approval_unverifiable",
  "wallet_missing", "wallet_unbound", "wallet_binding_inactive", "state_unavailable",
  // Phase 1 (17 Nov 2026): entries paused by an exits-only arm (private-arming.ts); they resume by themselves once no trade is unresolved.
  "submission_unresolved"] as const;
export type PrivateChangeEntriesReason = typeof PRIVATE_CHANGE_ENTRIES_REASONS[number];
/** Present on a saved change's reply only when the agent was armed when the change began. `resumed`: new entries are on again;
 * `paused`: they stay paused for `reason`; `disarmed`: a disarm or stop arrived while the change was saved. */
export type PrivateChangeEntries = { state: "resumed" } | { state: "paused"; reason: PrivateChangeEntriesReason } | { state: "disarmed" };

function invalid(): never { throw new Error("Invalid private change entries outcome"); }
export function parsePrivateChangeEntries(value: unknown): PrivateChangeEntries {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.state === "resumed" || record.state === "disarmed") {
    if (keys.length !== 1) invalid();
    return record.state === "resumed" ? { state: "resumed" } : { state: "disarmed" };
  }
  if (record.state !== "paused" || keys.length !== 2 || !Object.hasOwn(record, "reason")
    || !(PRIVATE_CHANGE_ENTRIES_REASONS as readonly unknown[]).includes(record.reason)) invalid();
  return { state: "paused", reason: record.reason as PrivateChangeEntriesReason };
}

/** Shown after a change that was refused or whose outcome is unknown (its reply carries no outcome). */
export const PRIVATE_CHANGE_UNSAVED_TEXT = "If this agent is armed, new entries stay paused until a change is saved; stop-loss and take-profit exits keep running.";

const PAUSED_WHY: Readonly<Record<Exclude<PrivateChangeEntriesReason, "owner_paused" | "other_change" | "state_unavailable" | "submission_unresolved">, string>> = Object.freeze({
  rules_missing: "no confirmed Solana rules exist",
  rules_not_executable: "the confirmed rules are not executable (held for review or unsupported)",
  stop_loss_missing: "the confirmed rules have no stop-loss",
  rules_shadow_mode: "the confirmed rules set shadow mode",
  owner_approval_required: "the confirmed rules require your approval before each trade",
  limits_missing: "your spend limits are not set",
  owner_wallet_approval_missing: "your wallet approval does not cover these spend limits",
  owner_approval_unverifiable: "your wallet approval cannot be verified on this computer",
  wallet_missing: "this agent has no trading wallet",
  wallet_unbound: "the trading wallet is not bound in Hub",
  wallet_binding_inactive: "the trading wallet's Hub binding is not active",
});
const RULE_REASONS: readonly PrivateChangeEntriesReason[] = ["rules_missing", "rules_not_executable", "stop_loss_missing", "rules_shadow_mode", "owner_approval_required"];
const APPROVAL_REASONS: readonly PrivateChangeEntriesReason[] = ["limits_missing", "owner_wallet_approval_missing", "owner_approval_unverifiable"];

/** Owner text of a saved change's entries outcome; nothing when the agent was not armed (no outcome). */
export function privateChangeEntriesLines(entries: PrivateChangeEntries | undefined, agentId: string): string[] {
  if (!entries) return [];
  if (entries.state === "resumed") return ["New entries were paused while this change was saved and are on again. Stop-loss and take-profit exits kept running."];
  if (entries.state === "disarmed") return [`The agent was disarmed or stopped while this change was saved. Nothing trades until you arm it again: balchemy runner arm ${agentId}.`];
  const reason = entries.reason;
  // Turning entries back on after they stayed paused: either a change that fixes the reason (resumes by itself) or disarm and
  // re-arm, which stops exits in between. Hub "Resume shadow" also disarms.
  const rearm = `or disarm and re-arm (exits stop while disarmed): balchemy runner disarm ${agentId}, then balchemy runner arm ${agentId}.`;
  if (reason === "owner_paused") return [`New entries stay paused because they were paused in Hub or the CLI. Exits keep running. To turn entries on again without disarming: /resume in the cockpit (balchemy; typed RESUME ${agentId}). Or disarm and re-arm (exits stop while disarmed): balchemy runner disarm ${agentId}, then balchemy runner arm ${agentId}.`];
  if (reason === "other_change") return ["New entries stay paused while another change to this agent is still being saved; they turn on again when it is saved. Exits keep running."];
  if (reason === "submission_unresolved") return [`New entries stay paused: this agent is armed for exits only while a trade from before is unresolved (see balchemy runner trades ${agentId}). Exits keep running. Entries turn on again by themselves once no unresolved trade remains; check: balchemy runner status ${agentId}`];
  if (reason === "state_unavailable") return [`New entries stay paused: the runner could not confirm the new setup. Exits keep running. Check balchemy runner status ${agentId}, then save the change again, ${rearm}`];
  const why = PAUSED_WHY[reason];
  const fix = RULE_REASONS.includes(reason) ? `Confirm rules that fix this and entries turn on again by themselves, ${rearm}`
    : APPROVAL_REASONS.includes(reason) ? `Set limits your wallet approval covers and entries turn on again by themselves, ${rearm} Arming shows the Hub approval link.`
      : `Check balchemy runner wallet ${agentId} status, ${rearm}`;
  return [`New entries stay paused: ${why}. Exits keep running. ${fix}`];
}

export interface PrivateChangeHoldsOptions {
  readState(agentId: string): RunnerAgentState | undefined;
  hold(agentId: string): RunnerEntriesHold;
  release(agentId: string, expectedVersion: number): RunnerEntriesRelease;
  /** Every entry prerequisite a resume needs, on the current facts; null when entries may resume. Synchronous, so nothing runs
   * between it and `release`. A throw or an unknown code keeps entries paused (`state_unavailable`). */
  check(agentId: string): string | null;
  /** After each transition (the daemon reports it with the next heartbeat at once). */
  onChanged?(agentId: string): void;
  /** Phase 1: true while the agent's entries are paused by an exits-only arm (private-arming.ts exitsOnlyHeld), so a change made
   * meanwhile reports `submission_unresolved` instead of an owner pause. Never lifted here either way. */
  exitsOnly?(agentId: string): boolean;
}
/** One change in flight. `finish(saved)` returns the outcome to attach to the saved reply, or undefined when the agent was not
 * armed when the change began (the reply carries nothing). Idempotent: a second call returns the first outcome. Never throws. */
export interface PrivateChangeHold { finish(saved: boolean): PrivateChangeEntries | undefined }

interface Marker { version: number; holders: number }

export class PrivateChangeHolds {
  readonly #options: PrivateChangeHoldsOptions;
  readonly #markers = new Map<string, Marker>();
  constructor(options: PrivateChangeHoldsOptions) { this.#options = options; }

  /** Before the change applies (the caller holds the config guard from here until finish). Null refuses the change: the state is
   * unreadable or an armed agent's entries could not be paused. */
  begin(agentId: string): PrivateChangeHold | null {
    const state = this.#read(agentId);
    if (!state) return null;
    if (state.mode !== "live_armed") { this.#markers.delete(agentId); return this.#done(undefined); }
    if (state.entries === "paused") {
      const marker = this.#markers.get(agentId);
      // Paused by an earlier change of this path and untouched since (same version): this change shares that hold.
      if (marker && marker.version === state.version) { marker.holders += 1; return this.#held(agentId, marker); }
      // Paused by the owner (Hub or CLI), or by a change whose hold an owner control has since replaced: never lifted here.
      this.#markers.delete(agentId);
      // Phase 1: paused by an exits-only arm (it resumes by itself once no trade is unresolved): also never lifted here.
      let exitsOnly = false;
      try { exitsOnly = this.#options.exitsOnly?.(agentId) === true; } catch { exitsOnly = false; }
      return this.#done({ state: "paused", reason: exitsOnly ? "submission_unresolved" : "owner_paused" });
    }
    let result: RunnerEntriesHold;
    try { result = this.#options.hold(agentId); } catch { return null; }
    if (result.kind === "refused") return null;
    if (result.kind === "not_armed") { this.#markers.delete(agentId); return this.#done(undefined); }
    if (result.kind === "already_paused") { this.#markers.delete(agentId); return this.#done({ state: "paused", reason: "owner_paused" }); }
    const marker: Marker = { version: result.state.version, holders: 1 };
    this.#markers.set(agentId, marker);
    this.#changed(agentId);
    return this.#held(agentId, marker);
  }

  /** Test and status seam: the hold version this path owns for the agent, if any. */
  heldVersion(agentId: string): number | undefined { return this.#markers.get(agentId)?.version; }

  #done(outcome: PrivateChangeEntries | undefined): PrivateChangeHold {
    return { finish: () => outcome };
  }

  #held(agentId: string, marker: Marker): PrivateChangeHold {
    let finished = false; let outcome: PrivateChangeEntries | undefined;
    return { finish: (saved: boolean) => {
      if (finished) return outcome;
      finished = true;
      try { outcome = this.#finish(agentId, marker, saved); } catch { outcome = { state: "paused", reason: "state_unavailable" }; }
      return outcome;
    } };
  }

  #finish(agentId: string, marker: Marker, saved: boolean): PrivateChangeEntries {
    marker.holders = Math.max(0, marker.holders - 1);
    const owned = this.#markers.get(agentId) === marker;
    const current = this.#read(agentId);
    if (!current) return { state: "paused", reason: "state_unavailable" };
    if (current.mode !== "live_armed") { if (owned) this.#markers.delete(agentId); return { state: "disarmed" }; }
    // Not saved (refused or unknown): entries stay paused and the marker stays, so the next saved change can resume them.
    if (!saved) return { state: "paused", reason: "state_unavailable" };
    if (!owned || current.version !== marker.version || current.entries !== "paused") {
      if (owned) this.#markers.delete(agentId);
      return current.entries === "enabled" ? { state: "resumed" } : { state: "paused", reason: "owner_paused" };
    }
    if (marker.holders > 0) return { state: "paused", reason: "other_change" };
    let refusal: string | null;
    try { refusal = this.#options.check(agentId); } catch { refusal = "state_unavailable"; }
    // A failed prerequisite keeps the marker: a later saved change that fixes it resumes entries without a disarm.
    if (refusal !== null) {
      return { state: "paused", reason: (PRIVATE_CHANGE_ENTRIES_REASONS as readonly string[]).includes(refusal) && refusal !== "owner_paused"
        && refusal !== "other_change" && refusal !== "submission_unresolved" ? refusal as PrivateChangeEntriesReason : "state_unavailable" };
    }
    let released: RunnerEntriesRelease;
    try { released = this.#options.release(agentId, marker.version); } catch { return { state: "paused", reason: "state_unavailable" }; }
    if (released.kind === "refused") return { state: "paused", reason: "state_unavailable" };
    this.#markers.delete(agentId);
    if (released.kind === "released") { this.#changed(agentId); return { state: "resumed" }; }
    if (released.kind === "not_armed") return { state: "disarmed" };
    return released.state.entries === "enabled" ? { state: "resumed" } : { state: "paused", reason: "owner_paused" };
  }

  #read(agentId: string): RunnerAgentState | undefined {
    try { return this.#options.readState(agentId); } catch { return undefined; }
  }

  #changed(agentId: string): void {
    try { this.#options.onChanged?.(agentId); } catch { /* The heartbeat interval reports it. */ }
  }
}

/** RPC `set` of an armed agent (decided separately from the hold above): refused while any position is open, pending an exit,
 * held or not opened yet, or any trade is unfinished, because a different endpoint (a public shadow-only one, or another network)
 * can leave a position without its stop-loss; an unreadable ledger or journal refuses too. Not armed: null (the change proceeds as
 * before: the daemon still disarms an armed agent first). An unreadable state is `state_unavailable`. */
export function privateRpcSetRefusal(state: RunnerAgentState | undefined, readExposure: () => number): "positions_open" | "state_unavailable" | null {
  if (!state) return "state_unavailable";
  if (state.mode !== "live_armed") return null;
  let exposure: number;
  try { exposure = readExposure(); } catch { return "positions_open"; }
  return Number.isSafeInteger(exposure) && exposure === 0 ? null : "positions_open";
}
