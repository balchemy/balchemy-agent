/** The cockpit's status panel, the narrow header strip, the mode block and the PnL arithmetic behind them (KOKPIT-SPEC §5). Every line
 * is built by code from runner readbacks (agent state, wallet balance, positions, the AI budget status, the signal and trade journals);
 * nothing comes from the model. Realized PnL only: a position view carries cost and proceeds, never a live valuation, so unrealized
 * PnL is shown as "not available yet" (never as 0).
 * A1 rules:
 * - The mode block comes first and is never cut: the mode word with its plain consequence, then the runner and wallet line.
 * - Every fact has three states: a value; the last value "as of HH:MM" after a failed read; "not readable" after three failed reads.
 *   Unknown is never drawn as 0, and a mode that was never read is "CHECKING", never SHADOW.
 * - A runner that stops answering (three failed reads of its state) is OFFLINE, and the block says what that means.
 * - Untrusted strings (the model name, notes, a token mint) are sanitised before they are drawn (safe-text.ts). */
import type { PrivatePositionView } from "../runner/private-position-protocol.js";
import { privateLamportsToSol } from "../runner/private-spend-cap.js";
import { formatPrivateModelUsd } from "../runner/private-model-prices.js";
import { formatPrivateDcaStatus } from "../runner/private-dca.js";
import type { RunnerExecutionStatus } from "../runner/protocol.js";
import { displayWidth, sliceToWidth, wrapText } from "../tui/text-layout.js";
import { safeText } from "../tui/cockpit/safe-text.js";
import type { CockpitRecordMark, CockpitRole } from "../tui/cockpit/theme.js";

/** Realized result of one position's sold part: proceeds minus the cost of the units sold (cost pro-rated by units). */
export type CockpitPnl = { kind: "none" } | { kind: "unknown" } | { kind: "realized"; lamports: bigint };

export function positionRealizedPnl(view: Pick<PrivatePositionView, "originalUnits" | "remainingUnits" | "costLamports" | "proceedsLamports"
  | "proceedsComplete" | "exits">): CockpitPnl {
  const original = BigInt(view.originalUnits), remaining = BigInt(view.remainingUnits);
  const sold = original - remaining;
  if (view.exits === 0 && sold === 0n) return { kind: "none" };
  // Incomplete proceeds (a sale still being confirmed) are unknown, never zero.
  if (!view.proceedsComplete) return { kind: "unknown" };
  if (original <= 0n) return { kind: "unknown" };
  const cost = BigInt(view.costLamports) * sold / original;
  return { kind: "realized", lamports: BigInt(view.proceedsLamports) - cost };
}
/** The sum over positions; one unknown makes the total unknown. */
export function totalRealizedPnl(views: readonly Parameters<typeof positionRealizedPnl>[0][]): CockpitPnl {
  let total = 0n; let any = false;
  for (const view of views) {
    const pnl = positionRealizedPnl(view);
    if (pnl.kind === "unknown") return pnl;
    if (pnl.kind === "realized") { total += pnl.lamports; any = true; }
  }
  return any ? { kind: "realized", lamports: total } : { kind: "none" };
}
/** "+0.012 SOL", "-0.003 SOL", "0 SOL" (the lamport formatter is unsigned). */
export function formatSignedSol(lamports: bigint): string {
  if (lamports === 0n) return "0 SOL";
  return `${lamports > 0n ? "+" : "-"}${privateLamportsToSol((lamports < 0n ? -lamports : lamports).toString())}`;
}
export function formatPnl(pnl: CockpitPnl): string {
  return pnl.kind === "realized" ? formatSignedSol(pnl.lamports) : pnl.kind === "unknown" ? "being confirmed" : "nothing sold yet";
}

export type CockpitMode = "shadow" | "armed" | "armed, new buys paused" | "paused" | "stopped" | "live, not armed";
export interface CockpitCounters { signals: number; decisions: number; trades: number }

/** The facts the screen tracks for freshness, each from its own readback. */
export type CockpitFact = "mode" | "balance" | "positions" | "budget" | "counters";
/** One tracked fact: its last value, when it was read (ms), and how many reads since then failed to return it. */
export interface CockpitFactState<T> { value?: T; at?: number; misses: number }
/** Failed reads after which a fact is "not readable" (and a runner that does not answer is OFFLINE). */
export const COCKPIT_UNREADABLE_AFTER = 3;
export function seedFact<T>(value: T | undefined, now: number): CockpitFactState<T> {
  return value !== undefined ? { value, at: now, misses: 0 } : { misses: 0 };
}
/** A read that returned the fact refreshes it; a read without it (failed, skipped or still running) counts one miss. */
export function observeFact<T>(previous: CockpitFactState<T>, value: T | undefined, now: number): CockpitFactState<T> {
  return value !== undefined ? { value, at: now, misses: 0 } : { ...previous, misses: previous.misses + 1 };
}
/** A read still running when the next one is due: its facts become "as of HH:MM" at most. Only completed reads that came back without a
 * fact make it "not readable" (or OFFLINE for the mode), so a slow balance or Hub read never shows a runner that answered as offline. */
export function skipFact<T>(previous: CockpitFactState<T>): CockpitFactState<T> {
  return { ...previous, misses: Math.max(previous.misses, 1) };
}
export type CockpitFreshness = { kind: "stale"; asOf: string } | { kind: "unreadable" };
/** Undefined while fresh (or never read); "as of HH:MM" after one miss; "not readable" after three. */
export function factFreshness(state: CockpitFactState<unknown>, clock: (ms: number) => string): CockpitFreshness | undefined {
  if (state.value === undefined || state.misses === 0) return undefined;
  if (state.misses >= COCKPIT_UNREADABLE_AFTER) return { kind: "unreadable" };
  return { kind: "stale", asOf: clock(state.at ?? 0) };
}

export interface CockpitPanelFacts {
  walletAddress?: string;
  /** Already formatted with its unit, such as "0.5 SOL". */
  balanceSol?: string;
  /** Undefined: the runner's state has not been read yet (or not since it went offline). */
  mode?: CockpitMode;
  positions?: readonly PrivatePositionView[];
  budget?: { spentMicroUsd: number; limitMicroUsd: number };
  counters?: CockpitCounters;
  keepAwake?: string;
  model?: string;
  /** Why buys or DCA adds wait (cockpitExecutionNotes), one short line each. */
  notes?: readonly string[];
  /** The trading wallet is locked (its unlock card is the next card). */
  walletLocked?: boolean;
  /** The trading wallet read as unlocked (its setup step is done). Without either, the panel claims neither. */
  walletUnlocked?: boolean;
  /** Freshness per fact; a fact not listed is fresh. */
  freshness?: Partial<Record<CockpitFact, CockpitFreshness>>;
  /** The runner's state did not come back three reads in a row; `lastAnswer` (HH:MM) when it ever did. */
  offline?: { lastAnswer?: string };
  /** The setup checklist, only while setup is unfinished. */
  setup?: readonly { title: string; state: "done" | "todo" | "unknown" }[];
}
/** The owner's plain lines from the runner's execution status: new buys stopped at the max positions, and the DCA worker's line. */
export function cockpitExecutionNotes(execution: RunnerExecutionStatus | undefined): string[] {
  if (!execution) return [];
  const notes: string[] = [];
  const last = execution.queue === "unavailable" ? null : execution.queue.last;
  const limit = /^max_positions:([1-9][0-9]{0,3})$/.exec(last?.reason ?? "");
  if (limit) notes.push(`New buys: max ${limit[1]} positions reached (adds to held tokens continue)`);
  if (last?.reason === "max_positions_unknown") notes.push("New buys: held, the positions could not be counted");
  const dca = execution.dca ? formatPrivateDcaStatus(execution.dca) : null;
  if (dca) notes.push(dca);
  return notes;
}
export function shortAddress(address: string): string {
  const clean = safeText(address);
  return clean.length > 12 ? `${clean.slice(0, 4)}…${clean.slice(-4)}` : clean;
}

/** The mode word, its plain consequence and the record row a change to it writes into the conversation. */
export interface CockpitModeView {
  /** "ARMED", "PAUSED", "SHADOW", "NOT ARMED", "STOPPED", "LOCKED", "OFFLINE" or "CHECKING" (not read yet). */
  word: string;
  consequence: string;
  role: CockpitRole;
  /** The agent can buy or sell by itself in this mode (armed, or armed with new buys paused). */
  trading: boolean;
  /** The record row for a change into this mode (undefined: no row, for CHECKING). */
  record?: { mark: CockpitRecordMark; text: string };
}
export function cockpitModeKey(view: Pick<CockpitModeView, "word" | "consequence">): string { return `${view.word} · ${view.consequence}`; }
export function cockpitModeView(facts: Pick<CockpitPanelFacts, "mode" | "walletLocked" | "offline">): CockpitModeView {
  if (facts.offline) return { word: "OFFLINE", consequence: "runner not answering", role: "failure", trading: false,
    record: { mark: "failed", text: "The runner is not answering. Stop-loss and take-profit may not be running." } };
  switch (facts.mode) {
    case undefined: return { word: "CHECKING", consequence: "reading the runner", role: "muted", trading: false };
    case "stopped": return { word: "STOPPED", consequence: "nothing runs", role: "caution", trading: false,
      record: { mark: "held", text: "Stopped: nothing runs. Stop-loss and take-profit are off." } };
    default: break;
  }
  if (facts.walletLocked) return { word: "LOCKED", consequence: "wallet locked", role: "caution", trading: false,
    record: { mark: "held", text: "Trading wallet locked: nothing can be signed until you unlock it." } };
  switch (facts.mode) {
    case "armed": return { word: "ARMED", consequence: "live", role: "control", trading: true,
      record: { mark: "done", text: "Armed: the agent buys and sells by itself inside your rules and limits." } };
    case "armed, new buys paused": return { word: "PAUSED", consequence: "exits still run", role: "caution", trading: true,
      record: { mark: "held", text: "New buys paused. Stop-loss and take-profit keep running." } };
    // Exits run only while armed (private-execution-gate.ts exit_build), so an unarmed pause trades nothing at all.
    case "paused": return { word: "PAUSED", consequence: "cannot trade", role: "caution", trading: false,
      record: { mark: "held", text: "Paused: not armed, nothing trades." } };
    case "live, not armed": return { word: "NOT ARMED", consequence: "cannot trade", role: "muted", trading: false,
      record: { mark: "check", text: "Not armed: the agent cannot trade." } };
    default: return { word: "SHADOW", consequence: "cannot trade", role: "muted", trading: false,
      record: { mark: "check", text: "Shadow mode: the agent cannot trade." } };
  }
}
/** The record row for a mode change, or undefined: the first known mode is a baseline, not a change, and CHECKING never writes one.
 * Leaving a trading mode for one that cannot trade says that the exits stopped too. */
export function cockpitModeRecord(previousKey: string | undefined, previousTrading: boolean, next: CockpitModeView):
  { mark: CockpitRecordMark; text: string } | undefined {
  if (!next.record || previousKey === undefined || previousKey === cockpitModeKey(next)) return undefined;
  if (previousTrading && !next.trading && (next.word === "SHADOW" || next.word === "NOT ARMED" || next.word === "PAUSED")) {
    return { mark: "held", text: "Disarmed: nothing trades. Stop-loss and take-profit are off." };
  }
  return next.record;
}

/** One panel row. `role` colours the leading word or mark only (the mode word, a notice's `!`); headings are flush left. */
export interface CockpitPanelRow { text: string; role?: CockpitRole; lead?: string; heading?: boolean }
const VALUE = 13;
function value(label: string, text: string): string { return `  ${label.padEnd(VALUE)} ${text}`; }
function heading(title: string, freshness: CockpitFreshness | undefined, width: number): CockpitPanelRow {
  if (!freshness || freshness.kind === "unreadable") return { text: title, heading: true };
  const note = `as of ${freshness.asOf}`;
  const pad = Math.max(2, width - displayWidth(title) - displayWidth(note));
  return { text: `${title}${" ".repeat(pad)}${note}`, heading: true };
}
/** A row wrapped to the panel width; wrapped rows keep the row's indent plus `hang`. */
function wrapped(text: string, width: number, hang = 0, extra: Omit<CockpitPanelRow, "text"> = {}): CockpitPanelRow[] {
  const indent = /^ */.exec(text)?.[0] ?? "";
  const pad = " ".repeat(indent.length + hang);
  return wrapText(text.slice(indent.length), Math.max(8, width - indent.length - hang)).map((row, index) =>
    (index === 0 ? { ...extra, text: sliceToWidth(`${indent}${row}`, width) } : { text: sliceToWidth(`${pad}${row}`, width) }));
}
function positionRow(view: PrivatePositionView, width: number): string {
  const token = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(view.tokenMint) ? shortAddress(view.tokenMint) : "(token)";
  const state = view.state === "held" ? "held" : view.pendingExit ? "selling" : "open";
  const cost = privateLamportsToSol(view.costLamports);
  return sliceToWidth(`  ${token}  ${cost}  ${state}`, width);
}

/** The panel rows for a text width (33 at 36 columns, 43 at 46). The mode block is first, so a short terminal cuts from the bottom. */
export function cockpitPanelRows(facts: CockpitPanelFacts, width = 33): CockpitPanelRow[] {
  const mode = cockpitModeView(facts);
  const fresh = facts.freshness ?? {};
  const rows: CockpitPanelRow[] = [];
  // 1. The mode block (never cut).
  rows.push({ text: sliceToWidth(cockpitModeKey(mode), width), role: mode.role, lead: mode.word });
  if (facts.offline) {
    rows.push({ text: facts.offline.lastAnswer ? `  Last answer ${facts.offline.lastAnswer}` : "  No answer yet" });
    rows.push({ text: "  Exits may not be running" });
  } else {
    const runner = facts.mode === undefined ? "Runner: reading"
      : fresh.mode?.kind === "stale" ? `As of ${fresh.mode.asOf}` : "Runner on";
    // The wallet's state only when a read showed it (a missing read is never drawn as "no wallet" or "unlocked").
    const wallet = facts.walletLocked ? " · wallet locked" : facts.walletUnlocked ? " · wallet unlocked" : "";
    rows.push(...wrapped(`  ${runner}${wallet}`, width));
    if (facts.keepAwake) rows.push(...wrapped(`  ${safeText(facts.keepAwake)}`, width, 2));
  }
  // 2. The setup checklist while setup is unfinished (it replaces Positions).
  const setup = facts.setup;
  if (setup?.length) {
    const done = setup.filter((step) => step.state === "done").length;
    const current = setup.findIndex((step) => step.state !== "done");
    rows.push({ text: "" }, { text: `Setup · ${done} of ${setup.length} done`, heading: true });
    setup.forEach((step, index) => rows.push(...wrapped(`  ${index === current ? "›" : step.state === "done" ? "✓" : step.state === "unknown" ? "?" : "·"} ${step.title}`, width, 2)));
  }
  // 3. Notices, only when present.
  const notes = (facts.notes ?? []).map(safeText).filter(Boolean);
  if (notes.length) {
    rows.push({ text: "" }, { text: "Notices", heading: true });
    for (const note of notes) rows.push(...wrapped(`! ${note}`, width, 2, { role: "caution", lead: "!" }));
  }
  // 4. Positions (not during setup).
  if (!setup?.length) {
    rows.push({ text: "" }, heading("Positions", fresh.positions, width));
    const open = facts.positions?.filter((view) => view.state !== "closed");
    if (fresh.positions?.kind === "unreadable") rows.push({ text: "  not readable" });
    else if (!facts.positions || !open) rows.push({ text: "  not readable yet" });
    else {
      const limit = width >= 43 ? 5 : 3;
      if (!open.length) rows.push({ text: "  No open positions" });
      for (const view of open.slice(0, limit)) rows.push({ text: positionRow(view, width) });
      if (open.length > limit) rows.push({ text: `  +${open.length - limit} more: /positions` });
      rows.push({ text: sliceToWidth(value("Realized", formatPnl(totalRealizedPnl(facts.positions))), width) },
        { text: sliceToWidth(value("Unrealized", "not available yet"), width) });
    }
  }
  // 5. Wallet.
  rows.push({ text: "" }, heading("Wallet", fresh.balance, width));
  rows.push({ text: sliceToWidth(value("Balance", fresh.balance?.kind === "unreadable" ? "not readable"
    : facts.balanceSol !== undefined ? safeText(facts.balanceSol) : "not readable yet"), width) });
  if (facts.walletAddress) rows.push({ text: sliceToWidth(value("Address", shortAddress(facts.walletAddress)), width) });
  // 6. Activity.
  rows.push({ text: "" }, heading("Activity", fresh.counters, width));
  if (fresh.counters?.kind === "unreadable") rows.push({ text: "  not readable" });
  else if (!facts.counters) rows.push({ text: "  not readable yet" });
  else rows.push({ text: sliceToWidth(value("Checked", String(facts.counters.signals)), width) },
    { text: sliceToWidth(value("Trades", String(facts.counters.trades)), width) });
  // 7. The AI model.
  rows.push({ text: "" }, heading("AI model", fresh.budget, width));
  rows.push({ text: fresh.budget?.kind === "unreadable" ? "  not readable" : facts.budget
    ? sliceToWidth(`  ${formatPrivateModelUsd(facts.budget.spentMicroUsd)} of ${formatPrivateModelUsd(facts.budget.limitMicroUsd)} today`, width)
    : "  not readable yet" });
  if (facts.model) rows.push(...wrapped(`  ${safeText(facts.model)}`, width, 2));
  return rows;
}
/** The panel cut to `height` rows: the mode block always shows; a cut panel says that a taller window shows the rest. */
export function cockpitPanelFit(rows: readonly CockpitPanelRow[], height: number): CockpitPanelRow[] {
  if (rows.length <= height) return [...rows];
  const keep = Math.max(3, height - 1);
  const cut = rows.slice(0, keep);
  while (cut.length > 3 && cut[cut.length - 1]!.text === "") cut.pop();
  return [...cut, { text: "… more in a taller window" }];
}
/** The panel's text lines (tests and plain output). */
export function cockpitPanelLines(facts: CockpitPanelFacts, width = 33): string[] {
  return cockpitPanelRows(facts, width).map((row) => row.text);
}

/** The narrow header strip (60-95 columns): the mode word first (it never drops), then balance, open trades and AI spend. Stale or
 * unreadable facts are left out of the strip rather than shown as current; the full status is /status. */
export function cockpitStatusStrip(facts: CockpitPanelFacts): string[] {
  const mode = cockpitModeView(facts);
  const fresh = facts.freshness ?? {};
  const open = facts.positions?.filter((view) => view.state !== "closed");
  return [
    mode.word,
    ...(facts.balanceSol !== undefined && !fresh.balance ? [safeText(facts.balanceSol)] : []),
    ...(open && !fresh.positions ? [`${open.length} open`] : []),
    ...(facts.budget && !fresh.budget ? [`AI ${formatPrivateModelUsd(facts.budget.spentMicroUsd)}/${formatPrivateModelUsd(facts.budget.limitMicroUsd)}`] : []),
  ];
}
