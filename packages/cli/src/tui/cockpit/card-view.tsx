/** A1: the in-screen card anatomy (KOKPIT-SPEC §6), as plain rows so layout is checked without Ink:
 *   ── KIND · Title ───────────────────────────── progress ──
 *     code-built body (newest at the bottom; PgUp/PgDn scroll it)
 *   ───────────────────────────────────────────────────────────
 *    field ›  answer▌            (wraps to at most 4 rows)
 *    Enter submit · Esc back to the chat
 * and the one-line chip a card leaves when it waits: "▸ <what is waiting> · Ctrl+E opens it". Every row fits `width`. */
import React from "react";
import { Box, Text } from "ink";
import { COCKPIT_CARD_TONE, type CockpitCardTone } from "../../cockpit/cockpit-cards.js";
import { displayWidth, sliceToWidth, truncateEnd, wrapText } from "../text-layout.js";
import type { CardView } from "./card-host.js";
import { processCockpitTheme, type CockpitRole, type CockpitTheme } from "./theme.js";

export type CardRowRole = "title" | "body" | "rule" | "input" | "hint";
export interface CardRow { role: CardRowRole; text: string; tone?: CockpitCardTone }
/** Rows of the input line at most (owner decision: the input may wrap to 4 rows). */
export const CARD_INPUT_ROWS = 4;

/** A body line wrapped to `width`, keeping its leading indent on every row; a `pre` line is cut into width-sized pieces as written. */
function bodyRows(text: string, pre: boolean, width: number): string[] {
  if (!text) return [""];
  // A line that fits is kept exactly as written (aligned columns keep their spacing).
  if (displayWidth(text) <= width) return [text];
  if (pre) {
    const rows: string[] = []; let rest = text;
    while (rest) { const piece = sliceToWidth(rest, width); if (!piece) break; rows.push(piece); rest = rest.slice(piece.length); }
    return rows.length ? rows : [""];
  }
  const indent = /^ */.exec(text)?.[0] ?? "";
  const room = Math.max(8, width - indent.length);
  return wrapText(text.slice(indent.length), room).map((row) => sliceToWidth(`${indent}${row}`, width));
}
function titleRule(card: CardView, width: number): string {
  const right = card.meta.progress ? ` ${card.meta.progress} ──` : "";
  const room = Math.max(4, width - 3 - displayWidth(right) - 2);
  const label = truncateEnd(`${card.meta.kind} · ${card.meta.title}`, room, "…");
  const left = `── ${label} `;
  return sliceToWidth(`${left}${"─".repeat(Math.max(2, width - displayWidth(left) - displayWidth(right)))}${right}`, width);
}
function hintText(card: CardView): string {
  if (card.closing) return "Closing…";
  if (!card.input) return card.meta.kind === "WAITING" ? "Esc stops waiting (nothing else changes)" : "Working… · Esc stops";
  if (card.input.multi) return "Enter adds a line · :done finishes · Esc back to the chat";
  return card.secret ? "Enter submit · Esc cancels (nothing is kept)" : "Enter submit · Esc back to the chat";
}

/** The card as rows, at most `maxRows` (the body is cut from the top first; the title, rules, input and hint always show). */
export function cardFrameRows(card: CardView, width: number, maxRows: number): CardRow[] {
  const tone = COCKPIT_CARD_TONE[card.meta.kind];
  const inner = Math.max(10, width - 2);
  const body = [...card.body.flatMap((line) => bodyRows(line.text, line.pre, inner)), ...(card.question ? bodyRows(card.question, false, inner) : [])]
    .map((row) => (row ? `  ${row}` : ""));
  const field = card.input ? ` ${card.input.field} ›  ` : " ";
  const typed = card.input ? `${card.input.shown}▌` : card.closing ? "" : "…";
  // The input wraps by width (not by words: a pasted key or phrase is one token); only its last rows show.
  const inputRows: string[] = [];
  let rest = `${field}${typed}`;
  while (rest) { const piece = sliceToWidth(rest, width); if (!piece) break; inputRows.push(piece); rest = rest.slice(piece.length); }
  const input = inputRows.slice(-CARD_INPUT_ROWS).map((row, index, all) => (index === 0 && all.length < inputRows.length
    ? sliceToWidth(` …${Array.from(row).slice(2).join("")}`, width) : row));
  const fixed = 3 + input.length;
  const room = Math.max(1, maxRows - fixed);
  const end = Math.max(0, body.length - Math.min(card.offset, Math.max(0, body.length - room)));
  let shown = body.slice(Math.max(0, end - room), end);
  if (end - room > 0 && shown.length) shown = [sliceToWidth(`  ↑ ${end - room + 1} more rows: PgUp`, width), ...shown.slice(1)];
  if (end < body.length && shown.length) shown = [...shown.slice(0, -1), sliceToWidth(`  ↓ ${body.length - end + 1} more rows: PgDn`, width)];
  return [
    { role: "title", text: titleRule(card, width), tone },
    ...(shown.length ? shown : [""]).map((text): CardRow => ({ role: "body", text })),
    { role: "rule", text: "─".repeat(Math.max(1, width)) },
    ...input.map((text): CardRow => ({ role: "input", text })),
    { role: "hint", text: sliceToWidth(` ${hintText(card)}`, width) },
  ];
}

/** The chip a waiting card leaves above the input. */
export function cardChipRow(label: string, width: number): string {
  const tail = " · Ctrl+E opens it";
  return sliceToWidth(`▸ ${truncateEnd(label, Math.max(4, width - 2 - displayWidth(tail)), "…")}${tail}`, width);
}

/** The card kind's tone as a palette role (theme.ts): the kind word carries the meaning without colour; colour is off with NO_COLOR. */
const ROLE: Readonly<Record<CockpitCardTone, CockpitRole>> = Object.freeze({ control: "control", caution: "caution", danger: "failure" });
export function CardFrame({ rows, theme }: { rows: readonly CardRow[]; theme?: CockpitTheme }): React.ReactElement {
  const palette = theme ?? processCockpitTheme();
  return <Box flexDirection="column">
    {rows.map((row, index) => row.role === "title"
      ? <Text key={`card${index}`} {...palette.style(ROLE[row.tone ?? "control"])} bold>{row.text}</Text>
      : row.role === "input" ? <Text key={`card${index}`}>{row.text}</Text>
      : <Text key={`card${index}`}>{row.text || " "}</Text>)}
  </Box>;
}
