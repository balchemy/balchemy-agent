/** Owner decision of 21 Nov 2026: after the owner confirms changed rules, the cockpit asks whether the new exit rules (stop-loss,
 * take-profit ladder, trailing stop) also apply to the agent's open positions. The default is no: every position keeps the exit snapshot
 * it was opened with (private-positions.ts). On yes (a separate typed APPLY <agent>) this service re-binds the exit snapshot of each
 * eligible open position to the agent's CURRENT confirmed head, through one durable ledger commit (PrivatePositionLedger.rebindExits).
 *
 * - `preview` (read-only): the confirmed head's revision id, rules digest and exit snapshot, and per non-closed position its current
 *   snapshot and whether it would be re-bound or skipped (PRIVATE_EXIT_REBIND_SKIPS), bound by `previewDigest`.
 * - `apply`: recomputes the preview synchronously and refuses `rules_changed` when the head (revision or rules digest) is not the one the
 *   owner saw, and `preview_changed` when any position, snapshot or skip moved since; then one commit re-binds every eligible position
 *   (each re-checked inside the commit). Nothing awaits between the recomputation and the commit, so no exit pass, buy or settlement of
 *   this daemon interleaves. A replay of the same operation (a lost reply, a restart) answers from the ledger without writing again.
 * Skipped, never transformed: a position that is held or has a sell in flight, a mint with an unfinished buy or sell in the journal or an
 * unsettled DCA add, a take-profit ladder already started on other levels, or an armed trailing stop whose pair changes. While any signal
 * buy is being prepared (its mint is not known before its journal attempt), the whole apply refuses `buy_preparing`.
 *
 * DCA (decision): an add record binds the exit snapshot of the head at its creation (private-dca-store.ts, digest-bound), so FUTURE lots
 * of a campaign always follow the newest confirmed revision whatever the owner answers here; EXISTING lots are positions like any other
 * and follow this yes or no. An add in flight is never edited: its mint is skipped (`buy_in_flight`) and its lot opens with the exits it
 * was planned with. Local only: nothing is signed, sent or sold, and Balchemy never evaluates a trigger (rules stay local). */
import { createHash } from "node:crypto";
import { isPrivateSubmissionTerminal, type PrivateSubmissionAttempt } from "./private-submission-journal.js";
import { privateDcaAddUnsettled, type PrivateDcaAdd } from "./private-dca-store.js";
import type { PrivateExecutionIntent } from "./private-execution-intents.js";
import { privateExitSnapshotValid, type PrivateExitSnapshot } from "./private-exit-triggers.js";
import { privateExitRebindRefusal, privateExitSnapshotKey, PrivatePositionError, type PrivateExitRebindSkip, type PrivatePosition,
  type PrivatePositionLedger } from "./private-positions.js";

export const PRIVATE_EXIT_REBIND_ERRORS = ["rules_missing", "rules_not_executable", "rules_changed", "preview_changed", "buy_preparing",
  "clock_rollback", "state_unavailable"] as const;
export type PrivateExitRebindError = typeof PRIVATE_EXIT_REBIND_ERRORS[number];
export class PrivateExitRebindRefused extends Error {
  constructor(readonly code: PrivateExitRebindError) { super(`Exit re-bind ${code}`); this.name = "PrivateExitRebindRefused"; }
}
function refuse(code: PrivateExitRebindError): never { throw new PrivateExitRebindRefused(code); }

/** The confirmed head's exit binding: null when no compiled, executable revision exists. */
export interface PrivateExitRebindRules { revisionId: string; rulesDigest: string; exit: PrivateExitSnapshot }
/** One non-closed position: `current` indexes the preview's distinct `snapshots`; `skip` null means it would be re-bound. */
export interface PrivateExitRebindItem { positionId: string; tokenMint: string; current: number; skip: PrivateExitRebindSkip | null }
export interface PrivateExitRebindPreview {
  revisionId: string; rulesDigest: string; next: PrivateExitSnapshot; snapshots: PrivateExitSnapshot[]; items: PrivateExitRebindItem[];
  previewDigest: string;
}
export interface PrivateExitRebindApply { operationId: string; revisionId: string; rulesDigest: string; previewDigest: string }
export type PrivateExitRebindResultItem = { positionId: string; outcome: "rebound" } | { positionId: string; outcome: "skipped"; reason: PrivateExitRebindSkip };
export interface PrivateExitRebindResult { operationId: string; revisionId: string; rulesDigest: string; replayed: boolean; items: PrivateExitRebindResultItem[] }

export interface PrivateExitRebindOptions {
  positions: Pick<PrivatePositionLedger, "positions" | "rebindExits">;
  /** The agent's confirmed head as an exit binding (the same derivation arming and the DCA worker use); null when none is executable. */
  readRules(agentId: string): PrivateExitRebindRules | null;
  readAttempts(agentId: string): readonly PrivateSubmissionAttempt[];
  /** Execution intents (a `running` one is a buy being prepared). */
  readIntents(agentId: string): readonly PrivateExecutionIntent[];
  /** DCA add records; absent when this build does not declare dca.v1 (no adds exist then). */
  readDcaAdds?(agentId: string): readonly PrivateDcaAdd[];
  now?(): number;
}

/** The preview digest: the head and every disposition the owner reads, never a moving price fact (trailing marks are not part of it). */
export function privateExitRebindDigest(agentId: string, preview: Omit<PrivateExitRebindPreview, "previewDigest">): string {
  return createHash("sha256").update(JSON.stringify(["balchemy.local-agent.exit-rebind-preview.v1", agentId, preview.revisionId, preview.rulesDigest,
    privateExitSnapshotKey(preview.next), preview.snapshots.map(privateExitSnapshotKey),
    preview.items.map((item) => [item.positionId, item.tokenMint, item.current, item.skip])]), "utf8").digest("hex");
}

export class PrivateExitRebind {
  readonly #options: PrivateExitRebindOptions;
  constructor(options: PrivateExitRebindOptions) { this.#options = options; }

  preview(agentId: string): PrivateExitRebindPreview {
    return this.#plan(agentId).preview;
  }

  apply(agentId: string, request: PrivateExitRebindApply): PrivateExitRebindResult {
    const o = this.#options;
    // A replay of an operation that already committed answers from the ledger (one snapshot per agent: all or nothing was written).
    const positions = this.#read(() => o.positions.positions(agentId));
    const replay = positions.filter((item) => item.rebound?.operationId === request.operationId);
    if (replay.length > 0) {
      if (replay.some((item) => item.rebound?.revisionId !== request.revisionId || item.rebound?.rulesDigest !== request.rulesDigest)) refuse("preview_changed");
      return { operationId: request.operationId, revisionId: request.revisionId, rulesDigest: request.rulesDigest, replayed: true,
        items: replay.map((item) => ({ positionId: item.positionId, outcome: "rebound" as const })) };
    }
    const { preview, rules } = this.#plan(agentId);
    if (preview.revisionId !== request.revisionId || preview.rulesDigest !== request.rulesDigest) refuse("rules_changed");
    if (preview.previewDigest !== request.previewDigest) refuse("preview_changed");
    const eligible = preview.items.filter((item) => item.skip === null);
    const skipped: PrivateExitRebindResultItem[] = preview.items.filter((item) => item.skip !== null)
      .map((item) => ({ positionId: item.positionId, outcome: "skipped" as const, reason: item.skip as PrivateExitRebindSkip }));
    if (eligible.length === 0) return { operationId: request.operationId, revisionId: rules.revisionId, rulesDigest: rules.rulesDigest, replayed: false, items: skipped };
    let outcomes: ReturnType<PrivatePositionLedger["rebindExits"]>;
    try {
      outcomes = o.positions.rebindExits(agentId, { operationId: request.operationId, revisionId: rules.revisionId, rulesDigest: rules.rulesDigest,
        exit: rules.exit, positions: eligible.map((item) => ({ positionId: item.positionId, expectedExit: preview.snapshots[item.current]! })) }, this.#now());
    } catch (error: unknown) {
      return refuse(error instanceof PrivatePositionError && error.code === "clock_rollback" ? "clock_rollback" : "state_unavailable");
    }
    const applied: PrivateExitRebindResultItem[] = outcomes.map((item) => item.outcome === "rebound" ? { positionId: item.positionId, outcome: "rebound" as const }
      : { positionId: item.positionId, outcome: "skipped" as const, reason: item.reason });
    return { operationId: request.operationId, revisionId: rules.revisionId, rulesDigest: rules.rulesDigest, replayed: false, items: [...applied, ...skipped] };
  }

  #now(): number { return (this.#options.now ?? Date.now)(); }
  #read<T>(reader: () => T): T { try { return reader(); } catch { return refuse("state_unavailable"); } }

  /** Synchronous: the head, every non-closed position and the mint-level in-flight facts read in one step. */
  #plan(agentId: string): { preview: PrivateExitRebindPreview; rules: PrivateExitRebindRules } {
    const o = this.#options;
    const rules = this.#read(() => o.readRules(agentId));
    if (!rules) refuse("rules_missing");
    if (!privateExitSnapshotValid(rules.exit) || !(rules.exit.stopLossBps > 0)) refuse("rules_not_executable");
    const positions = this.#read(() => o.positions.positions(agentId)).filter((item) => item.state !== "closed");
    const attempts = this.#read(() => o.readAttempts(agentId));
    const intents = this.#read(() => o.readIntents(agentId));
    const adds = this.#read(() => o.readDcaAdds?.(agentId) ?? []);
    if (intents.some((item) => item.state === "running")) refuse("buy_preparing");
    const open = attempts.filter((item) => !isPrivateSubmissionTerminal(item.state));
    const selling = new Set<string>([...open.filter((item) => item.swap.direction === "sell").map((item) => item.swap.inputMint),
      ...positions.filter((item) => item.pendingExit !== null || item.state === "held").map((item) => item.tokenMint)]);
    const buying = new Set<string>([...open.filter((item) => item.swap.direction === "buy").map((item) => item.swap.outputMint),
      ...adds.filter(privateDcaAddUnsettled).map((item) => item.mint)]);
    const snapshots: PrivateExitSnapshot[] = []; const keys: string[] = [];
    const items = positions.map((position: PrivatePosition): PrivateExitRebindItem => {
      const key = privateExitSnapshotKey(position.exit);
      let current = keys.indexOf(key);
      if (current < 0) { current = keys.length; keys.push(key); snapshots.push(JSON.parse(key) as PrivateExitSnapshot); }
      // The position's own state first (held, a sell in flight, already current, ladder, trailing), then its mint's in-flight trades.
      const own = privateExitRebindRefusal(position, rules.exit);
      const skip = own ?? (selling.has(position.tokenMint) ? "sell_in_flight" : buying.has(position.tokenMint) ? "buy_in_flight" : null);
      return { positionId: position.positionId, tokenMint: position.tokenMint, current, skip };
    });
    const base = { revisionId: rules.revisionId, rulesDigest: rules.rulesDigest, next: JSON.parse(privateExitSnapshotKey(rules.exit)) as PrivateExitSnapshot, snapshots, items };
    return { preview: { ...base, previewDigest: privateExitRebindDigest(agentId, base) }, rules };
  }
}
