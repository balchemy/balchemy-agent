/** Owner decision of 21 Nov 2026: right after the owner confirms changed rules in the cockpit (the /directive rules card, a chat-drafted
 * rules review, the approval card, the setup card), the cockpit asks whether the new exit rules (stop-loss, take-profit, trailing stop) also
 * apply to the agent's open positions. Default no: every open position keeps the exits it was opened with. Before the separate typed
 * APPLY <agent> the card shows, per open position, its current and new stop-loss, take-profit and trailing values (or why it stays as it
 * is); after it, what was applied. The runner re-binds only to its current confirmed head, bound by the preview digest
 * (private-exit-rebind.ts). Silent when no open position would change. Every line is built by code from the runner's readback. */
import { randomUUID } from "node:crypto";
import type { PrivateExitSnapshot } from "../runner/private-exit-triggers.js";
import { privateExitSnapshotKey, type PrivateExitRebindSkip } from "../runner/private-positions.js";
import type { PrivateExitRebindPreview, PrivateExitRebindResult } from "../runner/private-exit-rebind.js";
import type { PrivateExitRebindChannelError } from "../runner/private-exit-rebind-protocol.js";

export type CockpitExitRebindPreviewOutcome = { kind: "ok"; preview: PrivateExitRebindPreview } | { kind: "refused"; code: PrivateExitRebindChannelError }
  | { kind: "unavailable" };
export type CockpitExitRebindApplyOutcome = { kind: "ok"; result: PrivateExitRebindResult } | { kind: "refused"; code: PrivateExitRebindChannelError }
  | { kind: "unknown" };
export interface CockpitExitRebindDeps {
  io: { write(text: string): Promise<void>; ask(question: string): Promise<string | null> };
  agentId: string;
  preview(): Promise<CockpitExitRebindPreviewOutcome>;
  apply(input: { operationId: string; revisionId: string; rulesDigest: string; previewDigest: string }): Promise<CockpitExitRebindApplyOutcome>;
  operationId?(): string;
}

export function cockpitExitRebindPhrase(agentId: string): string { return `APPLY ${agentId}`; }

const percent = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;
const token = (mint: string): string => `${mint.slice(0, 4)}…${mint.slice(-4)}`;
/** One exit snapshot in owner words: "stop-loss -10%; take-profit +50% (sell 25%), +100% (sell 75%); trailing stop off". */
export function cockpitExitRulesText(exit: PrivateExitSnapshot): string {
  const ladder = exit.takeProfitLevels.length ? exit.takeProfitLevels.map((level) => `+${percent(level.triggerBps)} (sell ${percent(level.sellBps)})`).join(", ") : "none";
  const trailing = exit.trailingActivateBps !== undefined && exit.trailingStopBps !== undefined
    ? `from +${percent(exit.trailingActivateBps)}, ${percent(exit.trailingStopBps)} below the peak` : "off";
  return `stop-loss -${percent(exit.stopLossBps)}; take-profit ${ladder}; trailing stop ${trailing}`;
}
const SKIP_TEXT: Readonly<Record<PrivateExitRebindSkip, string>> = Object.freeze({
  position_closed: "it is closed",
  position_held: "a sell of it is held for review",
  exit_pending: "a sell of it is in progress",
  already_current: "it already has these exits",
  take_profit_started: "a take-profit level of it already sold and the new ladder does not start with the same levels",
  trailing_armed: "its trailing stop is already armed and the new trailing stop differs",
  sell_in_flight: "a sell of this token is in progress",
  buy_in_flight: "a buy of this token is in progress",
  position_changed: "it changed since this card",
});
const REFUSAL_TEXT: Readonly<Partial<Record<PrivateExitRebindChannelError, string>>> = Object.freeze({
  rules_changed: "the confirmed rules changed again since this card",
  preview_changed: "an open position changed since this card (an exit or a buy ran)",
  buy_preparing: "a buy is being prepared right now",
  clock_rollback: "the system clock moved backwards",
  // A2a socket proof (applying new exits to open positions needs the trading wallet passphrase).
  proof_required: "it needs your trading wallet passphrase, and it was not entered",
  passphrase_rejected: "the trading wallet passphrase was wrong",
  proof_throttled: "too many wrong passphrases in a row; wait a few minutes",
  wallet_locked: "the trading wallet is locked and was not unlocked here",
});

/** The confirmed head's exit rules before a rule save (canonical form), or null when none is executable or it cannot be read. Read-only. */
export async function readCockpitExitBaseline(deps: Pick<CockpitExitRebindDeps, "preview">): Promise<string | null> {
  try {
    const read = await deps.preview();
    return read.kind === "ok" ? privateExitSnapshotKey(read.preview.next) : null;
  } catch { return null; }
}

/** Offers the re-bind once after a confirmed rule save. `baseline` (readCockpitExitBaseline before the save): when the save left the head's
 * exit rules exactly as they were (an approval setting, a change of entry rules only), nothing is offered again; null or absent: unknown
 * before, so the offer follows the current head. */
export async function offerCockpitExitRebind(deps: CockpitExitRebindDeps, baseline?: string | null): Promise<void> {
  const { io, agentId } = deps;
  const keep = "Your open positions keep the exits they were opened with.";
  const read = await deps.preview();
  if (read.kind !== "ok") {
    // Not executable rules or a build without automatic exits: nothing could apply, so nothing is offered.
    if (read.kind === "refused" && (read.code === "rules_missing" || read.code === "rules_not_executable" || read.code === "exits_unavailable")) return;
    const why = read.kind === "refused" ? REFUSAL_TEXT[read.code] : undefined;
    await io.write(`The open positions could not be checked${why ? ` (${why})` : ""}. ${keep}\n`);
    return;
  }
  const preview = read.preview;
  if (baseline !== undefined && baseline !== null && privateExitSnapshotKey(preview.next) === baseline) return;
  const items = preview.items.filter((item) => item.skip !== "already_current" && item.skip !== "position_closed");
  if (!items.length) return;
  const eligible = items.filter((item) => item.skip === null);
  const lines = [`Your new exit rules: ${cockpitExitRulesText(preview.next)}.`,
    `Apply them to ${agentId}'s open positions too? By default no: every open position keeps the exits it was opened with.`,
    ...items.map((item) => {
      const now = cockpitExitRulesText(preview.snapshots[item.current]!);
      return item.skip === null ? `  ${token(item.tokenMint)}: now ${now}\n    would become ${cockpitExitRulesText(preview.next)}`
        : `  ${token(item.tokenMint)}: stays as it is (${SKIP_TEXT[item.skip]}): ${now}`;
    })];
  if (!eligible.length) { await io.write(`${[...lines.slice(0, 1), ...lines.slice(2)].join("\n")}\nNone of them can take the new exits now. ${keep}\n`); return; }
  const phrase = cockpitExitRebindPhrase(agentId);
  await io.write(`${lines.join("\n")}\nType exactly ${phrase} to apply the new exits to the ${eligible.length} position${eligible.length === 1 ? "" : "s"} `
    + `marked "would become"; any other answer keeps every position as it is. A position that is already past its new stop-loss or a new `
    + "take-profit level then sells at its next check.\n");
  const answer = await io.ask("> ");
  if (answer?.trim() !== phrase) { await io.write(`Not applied. ${keep}\n`); return; }
  const outcome = await deps.apply({ operationId: (deps.operationId ?? randomUUID)(), revisionId: preview.revisionId, rulesDigest: preview.rulesDigest,
    previewDigest: preview.previewDigest });
  if (outcome.kind === "unknown") { await io.write("The outcome is unknown. Check /positions before another change; nothing was retried.\n"); return; }
  if (outcome.kind === "refused") {
    await io.write(`Nothing was applied${REFUSAL_TEXT[outcome.code] ? `: ${REFUSAL_TEXT[outcome.code]}` : ` (${outcome.code.replace(/_/g, " ")})`}. ${keep}\n`);
    return;
  }
  const mint = new Map(preview.items.map((item) => [item.positionId, item.tokenMint]));
  const done = outcome.result.items.filter((item) => item.outcome === "rebound");
  const result = outcome.result.items.filter((item) => item.outcome === "rebound" || (item.reason !== "already_current" && item.reason !== "position_closed"))
    .map((item) => {
      const name = mint.has(item.positionId) ? token(mint.get(item.positionId)!) : item.positionId;
      return item.outcome === "rebound" ? `  ${name}: now ${cockpitExitRulesText(preview.next)}` : `  ${name}: kept its exits (${SKIP_TEXT[item.reason]})`;
    });
  await io.write(`${done.length ? `Applied the new exits to ${done.length} open position${done.length === 1 ? "" : "s"}.` : "No position took the new exits."}\n`
    + `${result.join("\n")}${result.length ? "\n" : ""}`);
}
