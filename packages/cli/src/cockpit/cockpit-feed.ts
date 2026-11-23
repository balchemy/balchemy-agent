/** The agent narrates its work in the cockpit chat: each new decision, each trade state change and each exit sale becomes one plain
 * English line. The lines are built by code from the runner's own read-only journals (never model text), so a token name or a signal
 * cannot write into them; asset IDs are shortened, launchpad names come only from the runner's catalog readback, and only closed
 * state words are shown. Reading changes nothing.
 * K5b: a held decision names its reason in plain words. The signal summary carries closed reason codes only, not the measured values
 * (such as a holder share against the limit), so the values themselves are not shown. An exit sale names its trigger (seen while the
 * exit was pending) and its realized result in SOL.
 * A1: every line carries its record mark (KOKPIT-SPEC §3), chosen from the closed state and reason codes, never from text:
 * `check` a routine check that bought nothing, `submit` sent with the outcome not known yet, `done` a confirmed buy or sale only,
 * `held` held, paused or waiting for the owner, `failed` failed or blocked, `unknown` an outcome being reconciled or not known.
 * "Submitted" is never `done`. No line names a CLI command. */
import type { PrivateSignalSummary } from "../runner/private-signal-protocol.js";
import type { PrivateSubmissionState, PrivateSubmissionView } from "../runner/private-submission-journal.js";
import type { CockpitRecordMark } from "../tui/cockpit/theme.js";
import type { PrivatePositionView } from "../runner/private-position-protocol.js";
import { privateLamportsToSol } from "../runner/private-spend-cap.js";
import type { CockpitFeedLine } from "../tui/cockpit/CockpitScreen.js";
import { formatSignedSol, type CockpitCounters } from "./cockpit-panel.js";

function short(value: string): string { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? `${value.slice(0, 4)}…${value.slice(-4)}` : "(token)"; }
function word(value: string | null | undefined): string { return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value.replace(/_/g, " ") : "unknown"; }

/** Plain words for the closed hold and failure codes; any other closed code is shown as its words. */
const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  entry_rule_failed: "it failed one of your entry rules", entry_facts_missing: "facts your entry rules need were missing",
  entry_signals_missing: "your rules need more signals", strategy_facts_missing: "facts your strategy needs were missing",
  rules_missing: "no confirmed rules", rules_held: "your rules are held for review", rules_invalid: "your rules are invalid", rules_changed: "your rules changed",
  runtime_disallowed: "the agent may not trade right now", runtime_changed: "the agent's mode changed", signal_stale: "the signal was too old",
  signal_future: "the signal time was in the future", evidence_missing: "no research evidence", evidence_unresolved: "the research did not finish",
  evidence_held: "the research is held", evidence_mismatch: "the research did not match the signal", model_locked: "the AI model is locked",
  model_budget_exhausted: "today's AI budget is used up", daily_call_limit: "today's AI call limit is reached", token_cooldown: "this token was checked recently",
  launchpad_unavailable: "that launchpad is not selected or not live", source_stale: "the source is out of date", sizing_policy_changed: "the buy size changed",
});
/** Holds that are a routine "no buy" for this token (its own facts or rules); every other hold is the owner's or the agent's state. */
const ROUTINE_HOLDS: ReadonlySet<string> = new Set(["entry_rule_failed", "entry_facts_missing", "entry_signals_missing", "token_cooldown",
  "signal_stale", "signal_future"]);
function reasonText(reason: string | null | undefined): string {
  return typeof reason === "string" && Object.hasOwn(REASON_TEXT, reason) ? REASON_TEXT[reason]! : word(reason);
}
/** A launchpad name from the runner's catalog readback (letters, digits, spaces, dots and hyphens only), else a generic word. */
function sourceText(item: PrivateSignalSummary, names?: ReadonlyMap<string, string>): string {
  if (item.platform === "telegram") return "Telegram";
  if (item.platform === "discord") return "Discord";
  const name = names?.get(item.sourceId);
  return name && /^[A-Za-z0-9][A-Za-z0-9 .-]{0,31}$/.test(name) ? name : "a launchpad";
}

/** The decision's execution outcome; the owner's max positions is named in plain words ("max 3 positions reached"). */
function outcomeText(outcome: NonNullable<PrivateSignalSummary["executionOutcome"]>): string {
  const limit = /^max_positions:([1-9][0-9]{0,3})$/.exec(outcome.reason ?? "");
  if (limit) return ` Not bought: max ${limit[1]} positions reached.`;
  return ` Trade: ${word(outcome.trade ?? outcome.state)}.`;
}
/** Only finished decisions are narrated; a running one is not news yet. */
export function narrateDecision(item: PrivateSignalSummary, names?: ReadonlyMap<string, string>): CockpitFeedLine | undefined {
  if (item.state !== "completed" && item.state !== "held" && item.state !== "failed") return undefined;
  const source = sourceText(item, names);
  const asset = short(item.assetId);
  const text = item.state === "completed"
    ? `Checked ${asset} from ${source}: ${item.action === "buy" ? "decided to buy" : item.action === "sell" ? "decided to sell"
      : item.action === "hold" ? "no buy (the agent decided to hold)" : "no buy (the agent skipped it)"}.`
      + (item.executionOutcome ? outcomeText(item.executionOutcome) : "")
    : item.state === "held" ? `Checked ${asset} from ${source}: no buy (${reasonText(item.reason)}).`
      : `Could not finish checking ${asset} from ${source} (${reasonText(item.reason)}).`;
  const held = item.state === "completed" && /^max_positions:/.test(item.executionOutcome?.reason ?? "");
  const mark: CockpitRecordMark = item.state === "failed" ? "failed"
    : item.state === "held" ? (typeof item.reason === "string" && ROUTINE_HOLDS.has(item.reason) ? "check" : "held")
      : held ? "held" : "check";
  return { id: `decision:${item.jobId}:${item.state}:${item.executionOutcome?.trade ?? item.executionOutcome?.state ?? ""}`, text, mark };
}

/** The record mark of a trade state: only `completed` is a confirmed outcome; `closed_by_owner` is evidence of nothing (unknown). */
const TRADE_MARK: Readonly<Record<PrivateSubmissionState, CockpitRecordMark>> = Object.freeze({
  signed: "submit", submitted_known: "submit", submitted_unknown: "submit", facts_pending: "unknown", disputed: "unknown",
  completed: "done", failed_onchain: "failed", expired_not_landed: "failed", closed_by_owner: "unknown",
});
function tradeMark(state: string): CockpitRecordMark {
  return Object.hasOwn(TRADE_MARK, state) ? TRADE_MARK[state as PrivateSubmissionState] : "unknown";
}

/** A trade state change. A completed sell is narrated by its position (trigger and result), not here. */
export function narrateTrade(view: PrivateSubmissionView): CockpitFeedLine | undefined {
  const state = word(view.state);
  let text: string;
  if (view.direction === "buy") {
    let sol = "? SOL";
    try { sol = privateLamportsToSol(view.grossInLamports); } catch { sol = "? SOL"; }
    text = view.state === "completed" ? `Bought ${short(view.outputMint)} for ${sol}.` : `Buy of ${short(view.outputMint)} for ${sol}: ${state}.`;
  } else {
    if (view.state === "completed") return undefined;
    text = `Sell of ${short(view.inputMint)}: ${state}.`;
  }
  // No command name here (A1): the hold is named; reviewing it is outside the cockpit for now.
  if (view.securityHold) text += " Held for your review; nothing more is sent for it.";
  return { id: `trade:${view.attemptKey}:${view.state}`, text, mark: view.securityHold ? "held" : tradeMark(view.state) };
}

const TRIGGER_TEXT: Readonly<Record<string, string>> = Object.freeze({ stop_loss: "Stop-loss", take_profit: "Take-profit", trailing_stop: "Trailing stop" });
/** One exit sale between two reads of a position: its trigger (remembered while it was pending) and the realized result of the sold part. */
export function narrateExit(before: PrivatePositionView, after: PrivatePositionView, trigger: string | undefined): CockpitFeedLine | undefined {
  if (after.positionId !== before.positionId || after.exits <= before.exits) return undefined;
  const sold = BigInt(before.remainingUnits) - BigInt(after.remainingUnits);
  const label = trigger && Object.hasOwn(TRIGGER_TEXT, trigger) ? TRIGGER_TEXT[trigger]! : "An exit";
  const token = short(after.tokenMint);
  let result: string;
  let mark: CockpitRecordMark = "unknown";
  if (sold <= 0n) result = "nothing was sold";
  else if (!after.proceedsComplete) result = "the result is still being confirmed";
  else {
    mark = "done";
    const original = BigInt(after.originalUnits);
    const cost = original > 0n ? BigInt(after.costLamports) * sold / original : 0n;
    result = formatSignedSol(BigInt(after.proceedsLamports) - BigInt(before.proceedsLamports) - cost);
  }
  return { id: `exit:${after.positionId}:${after.exits}`, text: `${label} sold ${token}${after.state === "closed" ? "" : " (part)"}: ${result}.`, mark };
}

export interface CockpitFeedReaders {
  decisions(): Promise<readonly PrivateSignalSummary[]>;
  trades(): Promise<readonly PrivateSubmissionView[]>;
  /** K5b: open and recently closed positions, for exit narration (optional: without it, exits are narrated by their trade line only). */
  positions?(): Promise<readonly PrivatePositionView[]>;
  /** K5b: launchpad id to name, from the runner's catalog readback. */
  sources?(): Promise<ReadonlyMap<string, string> | undefined>;
  /** K5b: the trade journal's total count (the readback holds only the newest attempts). */
  tradeTotal?(): number | undefined;
}
export type CockpitFeed = (() => Promise<CockpitFeedLine[]>) & { counters(): CockpitCounters | undefined };

/** New lines since the cockpit opened. The first read only takes a baseline, so old history is not replayed. */
export function createCockpitFeed(read: CockpitFeedReaders): CockpitFeed {
  const seen = new Set<string>();
  let baseline = false;
  let counters: CockpitCounters | undefined;
  const positions = new Map<string, { view: PrivatePositionView; trigger?: string }>();
  let names: ReadonlyMap<string, string> | undefined;
  let sourcesRead = false;
  const feed = async (): Promise<CockpitFeedLine[]> => {
    const lines: CockpitFeedLine[] = [];
    let ok = true;
    // One catalog read per agent in this cockpit run, not awaited (it can wait on Balchemy); until it lands a launchpad is named generically.
    if (read.sources && !sourcesRead) { sourcesRead = true; void read.sources().then((value) => { names = value; }, () => undefined); }
    const decisions = await read.decisions().catch(() => { ok = false; return [] as readonly PrivateSignalSummary[]; });
    const trades = await read.trades().catch(() => { ok = false; return [] as readonly PrivateSubmissionView[]; });
    const views = read.positions ? await read.positions().catch(() => undefined) : undefined;
    if (ok) {
      counters = { signals: decisions.reduce((max, item) => Math.max(max, item.ordinal), 0),
        decisions: decisions.filter((item) => item.state === "completed" || item.state === "held" || item.state === "failed").length,
        trades: read.tradeTotal?.() ?? trades.length };
    }
    // The baseline is taken only from a complete read, so a failed first read never makes the next one replay history.
    if (!ok && !baseline) return lines;
    const exits: CockpitFeedLine[] = [];
    for (const view of views ?? []) {
      const known = positions.get(view.positionId);
      const line = known ? narrateExit(known.view, view, known.trigger) : undefined;
      if (line) exits.push(line);
      // The trigger is remembered only until its sale is narrated, so a later exit never borrows an older trigger.
      const trigger = view.pendingExit ? view.pendingExit.trigger : line ? undefined : known?.trigger;
      positions.set(view.positionId, { view, ...(trigger ? { trigger } : {}) });
    }
    for (const line of [...[...decisions].reverse().map((item) => narrateDecision(item, names)), ...[...trades].reverse().map(narrateTrade), ...exits]) {
      if (!line || seen.has(line.id)) continue;
      seen.add(line.id);
      if (baseline) lines.push(line);
    }
    baseline = true;
    return lines;
  };
  return Object.assign(feed, { counters: () => counters });
}
