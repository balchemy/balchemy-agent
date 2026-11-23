/** A1: the cockpit's layout and conversation rows as plain strings (KOKPIT-SPEC §2 and §3), so layout and authorship are checked without
 * Ink. Authorship is carried by position, not colour: a fixed 10-column gutter (column 1 blank, the label in columns 2-9, column 10
 * blank) holds `You` (typed on this keyboard), `Agent` (the AI model), `Balchemy` (code-built text) or `HH:MM` (a record of what the
 * runner did, with its mark at column 11 and the text after it). Text starts at column 11 and every wrapped row keeps that indent.
 * Every entry is sanitised here (safe-text.ts), and its paragraphs are drawn under its own indent, so no text can reach the gutter.
 * Breakpoints: below 60 columns the label stands on its own line; 60-95 one column with a status strip in the header; 96-139 a side
 * panel of 36; 140 and wider a panel of 46 and conversation text capped at 90 columns. The screen never grows past 160. */
import { displayWidth, sliceToWidth, truncateEnd, wrapText } from "../text-layout.js";
import { safeParagraphs, safeText } from "./safe-text.js";
import { COCKPIT_UNICODE_GLYPHS, type CockpitGlyphs, type CockpitRecordMark, type CockpitRole } from "./theme.js";

export interface CockpitLayout {
  /** The whole screen width (at most 160). */
  width: number;
  /** The conversation column (header, rules, card, input and hints live in it too). */
  mainWidth: number;
  /** The side panel, left border included (0: no panel). */
  sideWidth: number;
  /** Text columns of the panel (border, padding and a right pad excluded). */
  sideText: number;
  /** The fixed label gutter is used (60 columns and wider). */
  gutter: boolean;
  /** Text columns of a conversation row after the gutter. */
  textWidth: number;
}
export const COCKPIT_GUTTER = 10;
/** Below 60 columns: the indent of every body row, a space, the rail glyph and a space. */
export const NARROW_INDENT = 3;
export function cockpitLayout(columns: number): CockpitLayout {
  const width = Math.max(40, Math.min(160, Math.floor(columns) || 100));
  const sideWidth = width >= 140 ? 46 : width >= 96 ? 36 : 0;
  const mainWidth = width - sideWidth;
  const gutter = width >= 60;
  // Below 60 columns every body row starts with a code-owned rail (` │ `), so untrusted text can never sit where a label stands.
  const room = gutter ? mainWidth - COCKPIT_GUTTER : mainWidth - NARROW_INDENT;
  return { width, mainWidth, sideWidth, sideText: sideWidth ? sideWidth - 3 : 0, gutter, textWidth: Math.max(10, width >= 140 ? Math.min(90, room) : room) };
}

export type ConversationWho = "you" | "agent" | "note" | "feed";
export interface ConversationEntry { key: string; who: ConversationWho; text: string; at?: number; mark?: CockpitRecordMark }
/** One drawn row: the gutter label (or blanks), the record mark (or blanks) and the body. `text` is the whole row as plain text. */
export interface ConversationRow {
  key: string; text: string;
  label: string; labelRole?: CockpitRole;
  mark: string; markRole?: CockpitRole;
  body: string;
}
export const CONVERSATION_LABEL: Readonly<Record<Exclude<ConversationWho, "feed">, string>> = Object.freeze({ you: "You", agent: "Agent", note: "Balchemy" });
const LABEL_ROLE: Readonly<Record<ConversationWho, CockpitRole>> = Object.freeze({ you: "owner", agent: "control", note: "muted", feed: "muted" });
export const MARK_ROLE: Readonly<Record<CockpitRecordMark, CockpitRole | undefined>> = Object.freeze({
  check: undefined, submit: undefined, done: "confirmed", held: "caution", failed: "failure", unknown: "caution" });

/** Local wall-clock time, "14:03". */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function labelOf(entry: ConversationEntry, clock: (ms: number) => string): string {
  return entry.who === "feed" ? (entry.at !== undefined ? clock(entry.at) : "--:--") : CONVERSATION_LABEL[entry.who];
}
/** One blank row whenever the label changes (a run of records counts as one label); none between a typed slash command and its answer. */
function gapBefore(previous: ConversationEntry | undefined, entry: ConversationEntry): boolean {
  if (!previous || previous.who === entry.who) return false;
  return !(previous.who === "you" && entry.who === "note" && previous.text.trimStart().startsWith("/"));
}

/** The rows of one entry: the label on the first row, the mark (records) after the gutter, every wrapped row indented the same. */
export function entryRows(entry: ConversationEntry, layout: Pick<CockpitLayout, "gutter" | "textWidth">, glyphs: CockpitGlyphs,
  clock: (ms: number) => string = formatClock): ConversationRow[] {
  const label = labelOf(entry, clock);
  const labelRole = LABEL_ROLE[entry.who];
  const markText = entry.who === "feed" ? glyphs.marks[entry.mark ?? "check"] : "";
  const markRole = entry.mark ? MARK_ROLE[entry.mark] : undefined;
  const markWidth = markText ? displayWidth(markText) + 1 : 0;
  const room = Math.max(4, layout.textWidth - markWidth);
  const paragraphs = safeParagraphs(entry.text);
  const lines = (paragraphs.length ? paragraphs : [""]).flatMap((piece) => (piece ? wrapText(piece, room) : [""]));
  const rows: ConversationRow[] = [];
  const indent = layout.gutter ? " ".repeat(COCKPIT_GUTTER) : ` ${glyphs.border} `;
  if (!layout.gutter) rows.push({ key: `${entry.key}:label`, text: ` ${label}`, label: ` ${label}`, labelRole, mark: "", body: "" });
  lines.forEach((line, index) => {
    const first = index === 0;
    const gutter = layout.gutter && first ? ` ${label.slice(0, 8).padEnd(8)} ` : indent;
    const mark = markText ? (first ? `${markText} ` : " ".repeat(markWidth)) : "";
    rows.push({ key: `${entry.key}:${index}`, text: `${gutter}${mark}${line}`, label: gutter, ...(layout.gutter && first ? { labelRole } : {}),
      mark, ...(first && markRole ? { markRole } : {}), body: line });
  });
  return rows;
}

/** The whole conversation, oldest first, with the spacing rules of KOKPIT-SPEC §3. */
export function conversationRows(entries: readonly ConversationEntry[], layout: Pick<CockpitLayout, "gutter" | "textWidth">, glyphs: CockpitGlyphs,
  clock: (ms: number) => string = formatClock): ConversationRow[] {
  const rows: ConversationRow[] = [];
  entries.forEach((entry, index) => {
    if (gapBefore(entries[index - 1], entry)) rows.push({ key: `${entry.key}:gap`, text: "", label: "", mark: "", body: "" });
    rows.push(...entryRows(entry, layout, glyphs, clock));
  });
  return rows;
}

/** A code-built row with the gutter, as plain strings (the setup screen before the chat exists draws `Balchemy` rows with it). */
export function gutterRows(label: string, text: string, width: number): string[] {
  // The whole `width` is the conversation here (no side panel before the chat exists).
  const gutter = width >= 60;
  const layout = { gutter, textWidth: Math.max(10, width - (gutter ? COCKPIT_GUTTER : NARROW_INDENT)) };
  const name = safeText(label).slice(0, 8);
  return entryRows({ key: "g", who: "note", text }, layout, COCKPIT_UNICODE_GLYPHS)
    .map((row) => (!row.labelRole ? row.text : layout.gutter ? ` ${name.padEnd(8)} ${row.body}` : ` ${name}`));
}

/** The header row: the wordmark and agent on the left; the right side (the status strip, a mode word, or the scroll state) is
 * right-aligned and never wider than the row. `right` items are dropped from the end until they fit; the first one never drops. */
export function headerRow(agentId: string, right: readonly string[], width: number, separator = " · "): { left: string; right: string } {
  const name = safeText(agentId);
  const keep = [...right];
  const fits = (items: readonly string[], leftText: string) => displayWidth(leftText) + 2 + displayWidth(items.join(separator)) + 1 <= width;
  let left = ` Balchemy · ${name}`;
  while (keep.length > 1 && !fits(keep, left)) keep.pop();
  if (keep.length && !fits(keep, left)) {
    // Even the first item does not fit beside the full name: the agent name is shortened, never the mode.
    const room = Math.max(1, width - displayWidth(keep[0]!) - 3 - displayWidth(" Balchemy · "));
    left = ` Balchemy · ${truncateEnd(name, room, "…")}`;
  }
  const rightText = keep.length ? sliceToWidth(keep.join(separator), Math.max(0, width - displayWidth(left) - 3)) : "";
  return { left, right: rightText };
}

/** The chat input: `›` then the text, wrapped by width (a pasted key or phrase is one token, so not by words), at most `maxRows` rows:
 * the window that ends at the cursor's row. `cursorAt` is the cursor's position (in characters) inside `text` on its row. */
export interface PromptRow { prefix: string; text: string; cursorAt?: number }
export function promptRows(value: string, cursorIndex: number, width: number, glyphs: Pick<CockpitGlyphs, "prompt">, maxRows = 4): PromptRow[] {
  const prefix = ` ${glyphs.prompt}  `;
  const indent = " ".repeat(displayWidth(prefix));
  // One column stays free for the cursor.
  const room = Math.max(4, width - displayWidth(prefix) - 1);
  const chars = Array.from(value);
  const cursor = Math.min(Math.max(0, cursorIndex), chars.length);
  const rows: { chars: string[]; start: number }[] = [{ chars: [], start: 0 }];
  let used = 0;
  chars.forEach((char, index) => {
    const w = displayWidth(char);
    if (used + w > room && rows[rows.length - 1]!.chars.length) { rows.push({ chars: [], start: index }); used = 0; }
    rows[rows.length - 1]!.chars.push(char); used += w;
  });
  let at = 0;
  rows.forEach((row, index) => { if (row.start <= cursor) at = index; });
  const from = Math.max(0, at - maxRows + 1);
  return rows.slice(from, from + maxRows).map((row, index) => ({
    prefix: from + index === 0 ? prefix : indent, text: row.chars.join(""),
    ...(from + index === at ? { cursorAt: cursor - row.start } : {}),
  }));
}
