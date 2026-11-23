/** A1 one screen: the in-screen card host. Every setup step and every card runs the owner's existing command through the injected
 * `write`/`createPrompt`/`guardSignals` seam; this host is that seam's screen side, so nothing leaves the alternate screen for readline.
 * - One card at a time (a step card may host its command's card: the newest is shown; closing it shows the step again).
 * - While a card is open it owns the input: chat and slash commands are not read. Esc (or Ctrl+C) answers the pending prompt with
 *   null, exactly what the commands already treat as "cancelled, nothing changed", and stops any wait of the card (its abort signal and
 *   the commands' signal cleanups).
 * - Answers are returned verbatim (no trim, no case change); `confirm` compares the exact phrase, so every typed phrase is unchanged.
 * - Card text is code-built and sanitized (ANSI, control and bidi characters removed). It never enters the conversation, the model,
 *   memory or export: only the explicit result (or, for a non-secret card, its last line) becomes one `Balchemy` row when it closes.
 * - Secret cards (a wallet key, a passphrase, an API key) are modal: only their own command or Esc closes them, a feed update or a
 *   model reply never does; hidden fields echo `•`; the keystore's clear-screen request drops the body; everything is discarded on close.
 * No React here: the screens subscribe to `snapshot()`. */
import type { CockpitIo } from "../../cockpit/cockpit-flow.js";
import { CLEAR_SCREEN } from "../../runner/private-trading-keystore-ui.js";
import type { CockpitCardMeta } from "../../cockpit/cockpit-cards.js";

export interface CardKey {
  return?: boolean; escape?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean;
  pageUp?: boolean; pageDown?: boolean; upArrow?: boolean; downArrow?: boolean;
}
/** One body line. `pre`: shown as written (a QR code, aligned columns), cut to the width instead of re-wrapped. */
export interface CardBodyLine { text: string; pre: boolean }
export interface CardInputView {
  field: string; hidden: boolean;
  /** What the input line shows: the typed text, or one `•` per character for a hidden field. Never the hidden value itself. */
  shown: string;
  /** A rule text read line by line (ends with :done). */
  multi: boolean;
}
export interface CardView {
  id: number; meta: CockpitCardMeta;
  /** The card or the card it hosts shows or takes a secret. */
  secret: boolean;
  body: readonly CardBodyLine[];
  /** The full question of the pending prompt when it does not fit the field name (shown as the last body line). */
  question?: string;
  input?: CardInputView;
  /** Esc was pressed; the command is finishing ("Closing…"). */
  closing: boolean;
  /** Rows scrolled up from the end of the body (PgUp/PgDn). */
  offset: number;
}
/** `agentId`: the agent the row belongs to (set by the flow); a chat shows only its own agent's rows. */
export interface HostRow { id: number; text: string; agentId?: string }
export interface CardHostSnapshot {
  card?: CardView;
  /** Code-built `Balchemy` rows: card results and text written while no card was open. */
  rows: readonly HostRow[];
  /** Counts closed top-level cards; `escaped` tells whether the last one was left with Esc. */
  closed: number; escaped: boolean;
}
export interface CardScope {
  readonly signal: AbortSignal;
  /** Closes the card. `result`: the Balchemy row that records it (default: the last line of a non-secret card). */
  close(result?: string): void;
}
/** One prompt object that satisfies every command's prompt type (WalletPrompt, RulePrompt, SizingPrompt, BudgetPrompt, RpcPrompt). */
export interface CardPrompt {
  readonly closed: boolean;
  line(label: string): Promise<string | null>;
  secret(label: string): Promise<string | null>;
  source(): Promise<string | null>;
  confirm(phrase: string, alternates?: readonly string[]): Promise<boolean>;
  close(): void;
}
/** `card` and `edit` are replaced (not intersected): a call resolves to one signature, and the host always offers both. */
export type CardIo = Omit<CockpitIo, "card" | "edit" | "agent"> & { card(meta: CockpitCardMeta): CardScope; edit(question: string, initial: string): Promise<string | null>;
  agent(agentId: string): void };

interface Frame {
  id: number; meta: CockpitCardMeta; body: CardBodyLine[]; implicit: boolean; secret: boolean;
  abort: AbortController; cleanups: Set<() => void>;
  /** Waits that Esc stops on their own (the card then continues), newest last. */
  waits: AbortController[];
}
interface Pending {
  frame: Frame; field: string; hidden: boolean; question?: string; multi: boolean; lines: string[];
  value: string; owner?: object; resolve(value: string | null): void;
}

const BODY_LIMIT = 400;
const ROW_LIMIT = 200;
const INPUT_BYTES = 8192;
// CLEAR_SCREEN: the keystore's exact clear-screen request (written after the shown secret key), imported from the keystore so the two
// never drift. It clears the card body, never the terminal. Any other escape sequence in written text is only stripped, so no text
// can wipe review lines above a typed confirmation.
/** Bidi controls and invisible fillers (zero-width space/joiners, word joiner, BOM, braille blank): nothing that hides or reorders text. */
const BIDI = /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\u2800]/g;
/** A QR code or other block drawing: kept as written. */
const BLOCKS = /[\u2580-\u259f]/;

/** Card and row text without terminal escapes, control or bidi characters (no text can draw a fake label or move the cursor). */
export function cardText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]?/g, "")
    .replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(BIDI, "");
}

/** The field name an input line shows (`limits ›`, `confirm ›`, `api key (hidden) ›`) and, for a long label, the full question. */
export function cardField(label: string, hidden: boolean): { field: string; question?: string } {
  const text = cardText(label).replace(/[\s:>]+$/, "").trim();
  if (!text) return { field: hidden ? "hidden" : "confirm" };
  if (/^[a-z][a-z ]{0,19}$/.test(text)) return { field: hidden ? `${text} (hidden)` : text };
  const name = hidden
    ? /api key/i.test(text) ? "api key" : /secret key/i.test(text) ? "secret key" : /passphrase/i.test(text) ? "passphrase"
      : /rpc|url/i.test(text) ? "rpc url" : "hidden"
    : /model id/i.test(text) ? "model id" : /number|\[1-\d/i.test(text) ? "number" : /name/i.test(text) ? "name"
      : /\$|dollars|budget/i.test(text) ? "usd" : /\bSOL\b/.test(text) ? "sol" : "answer";
  return { field: hidden && name !== "hidden" ? `${name} (hidden)` : name, question: text };
}

export class CardHost {
  private frames: Frame[] = [];
  private pending: Pending | undefined;
  private escaped = false;
  private offset = 0;
  private rows: HostRow[] = [];
  private agent: string | undefined;
  private seq = 0;
  private closedCount = 0;
  private lastEscaped = false;
  private readonly listeners = new Set<() => void>();
  private snap: CardHostSnapshot = { rows: [], closed: 0, escaped: false };

  readonly io: CardIo = {
    write: async (text) => { this.write(text); },
    ask: (question) => this.ask(question, false, false),
    secret: (question) => this.ask(question, true, false),
    edit: (question, initial) => this.ask(question, false, false, undefined, initial),
    agent: (agentId) => { this.setAgent(agentId); },
    card: (meta) => this.open(meta),
  };

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (): CardHostSnapshot => this.snap;
  /** A card is open: it owns every key. */
  active(): boolean { return this.frames.length > 0; }
  /** A card that shows or takes a secret is open (copy mode and export must stay off). */
  secretOpen(): boolean { return this.frames.some((frame) => frame.secret); }

  /** Opens a card (on top of an open one: the step card hosting its command). */
  open(meta: CockpitCardMeta): CardScope {
    const frame = this.push(meta, false);
    let done = false;
    return { signal: frame.abort.signal, close: (result) => { if (done) return; done = true; this.closeFrame(frame, result); } };
  }
  /** A code-built `Balchemy` row in the conversation. */
  row(text: string): void {
    const clean = cardText(text).replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) return;
    this.rows = [...this.rows, { id: ++this.seq, text: clean, ...(this.agent ? { agentId: this.agent } : {}) }].slice(-ROW_LIMIT);
    this.publish();
  }
  /** The agent the following rows belong to. The first agent also takes the rows written before any agent was known (the steps that
   * started the runner and named it), so a switch never replays one agent's rows (results, wallet address) in another's chat. */
  setAgent(agentId: string): void {
    if (this.agent === undefined) this.rows = this.rows.map((row) => (row.agentId ? row : { ...row, agentId }));
    this.agent = agentId;
    this.publish();
  }
  /** A process signal (SIGINT, SIGTERM, SIGHUP): every open card stops as with Esc, so the commands' cleanups run (a shown key is
   * dropped and the keystore clears its screen) before the terminal is restored. */
  stopAll(): void {
    if (!this.frames.length) return;
    // Waits are aborted first, so the escape below always takes its full path (every card's cleanups run), never "stop one wait".
    for (const frame of this.frames) for (const wait of frame.waits.splice(0)) wait.abort();
    this.escape();
  }
  /** The open card's stop signal (Esc); a never-aborted one while no card is open. */
  signal(): AbortSignal { return this.top()?.abort.signal ?? new AbortController().signal; }
  /** A wait inside the open card that Esc stops by itself (a link, a page, a funding wait), as Ctrl+C did on the plain terminal: while
   * it runs and nothing is asked, Esc aborts only this signal and the card continues. A later Esc closes the card. */
  interruptible(): { signal: AbortSignal; release(): void } {
    const frame = this.top();
    const wait = new AbortController();
    if (!frame) return { signal: wait.signal, release: () => {} };
    if (frame.abort.signal.aborted) wait.abort();
    frame.waits.push(wait);
    return { signal: wait.signal, release: () => { const index = frame.waits.indexOf(wait); if (index >= 0) frame.waits.splice(index, 1); } };
  }
  /** The commands' `guardSignals`: in the screen, a card's Esc is the interrupt (Ctrl+C never reaches a raw-mode screen as SIGINT). */
  guardSignals = (cleanup: () => void): (() => void) => {
    const frame = this.top();
    if (!frame) return () => {};
    frame.cleanups.add(cleanup);
    return () => { frame.cleanups.delete(cleanup); };
  };
  /** A fresh prompt for one command run; its answers come from the open card's input line. */
  prompt(): CardPrompt {
    const owner = {};
    let closed = false;
    const isClosed = (): boolean => closed || this.escaped;
    return {
      get closed() { return isClosed(); },
      line: (label) => (closed ? Promise.resolve(null) : this.ask(label, false, false, owner)),
      secret: (label) => (closed ? Promise.resolve(null) : this.ask(label, true, false, owner)),
      source: () => (closed ? Promise.resolve(null) : this.ask("rules", false, true, owner)),
      confirm: async (phrase, alternates = []) => {
        if (closed) return false;
        const answer = await this.ask("confirm", false, false, owner);
        return answer !== null && !closed && (answer === phrase || alternates.includes(answer));
      },
      close: () => { closed = true; if (this.pending?.owner === owner) this.settle(null); },
    };
  }

  /** Text from a command or step: into the open card's body, or a `Balchemy` row while no card is open. */
  write(text: string): void {
    const frame = this.top();
    if (!frame) { this.row(text); return; }
    let rest = text;
    const lastClear = text.lastIndexOf(CLEAR_SCREEN);
    if (lastClear >= 0) { frame.body = []; this.offset = 0; rest = text.slice(lastClear + CLEAR_SCREEN.length); }
    const clean = cardText(rest);
    if (!clean) { this.publish(); return; }
    const lines = clean.split("\n");
    if (clean.endsWith("\n")) lines.pop();
    for (const line of lines) {
      const blank = line.trim() === "";
      const last = frame.body[frame.body.length - 1];
      if (blank && (!last || last.text === "")) continue;
      frame.body.push({ text: blank ? "" : line.replace(/\s+$/, ""), pre: BLOCKS.test(line) });
    }
    if (frame.body.length > BODY_LIMIT) frame.body.splice(0, frame.body.length - BODY_LIMIT);
    this.publish();
  }

  /** One key from the screen. Returns false when no card is open (the chat handles it). */
  key(input: string, key: CardKey): boolean {
    if (!this.frames.length) return false;
    if (key.escape || (key.ctrl && input === "c")) { this.escape(); return true; }
    if (key.pageUp) { this.offset += 5; this.publish(); return true; }
    if (key.pageDown) { this.offset = Math.max(0, this.offset - 5); this.publish(); return true; }
    const pending = this.pending;
    // Ctrl+U clears the input (a prefilled example included).
    if (pending && key.ctrl && input === "u") { pending.value = ""; this.publish(); return true; }
    if (!pending || key.ctrl || key.meta || key.upArrow || key.downArrow) return true;
    if (key.backspace || key.delete) { pending.value = Array.from(pending.value).slice(0, -1).join(""); this.publish(); return true; }
    // A paste can arrive as one chunk ending in Enter: the text before it is the answer; anything after it is dropped, never queued.
    const enter = key.return || /[\r\n]/.test(input);
    // A free-text field of a setup step (io.ask / io.edit: the directive, names, numbers) keeps every pasted line, joined by a space,
    // so a clause on line 2 is not lost silently. A command's own prompt (typed confirmations, limits, keys) keeps only the first line,
    // untrimmed, exactly as on the plain terminal: a pasted phrase is never trimmed or joined into a match.
    const pieces = key.return ? [""] : input.split(/\r\n|[\r\n]/);
    const joined = enter && pieces.length > 1 && !pending.hidden && !pending.multi && pending.owner === undefined
      ? pieces.map((piece) => piece.trim()).filter(Boolean).join(" ") : pieces[0] ?? "";
    // Hidden answers (passphrases, keys) lose only C0/C1 controls, as the keystore prompt does: a passphrase may hold ZWNJ, ZWJ or
    // bidi marks and must reach the unlock and arm gates unchanged. Visible answers also lose bidi and invisible fillers.
    const controlFree = joined.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    const text = pending.hidden ? controlFree : controlFree.replace(BIDI, "");
    if (text && Buffer.byteLength(pending.value + text, "utf8") <= INPUT_BYTES) pending.value += text;
    if (enter) this.submit(pending); else this.publish();
    return true;
  }

  private top(): Frame | undefined { return this.frames[this.frames.length - 1]; }
  private push(meta: CockpitCardMeta, implicit: boolean): Frame {
    const frame: Frame = { id: ++this.seq, meta: { ...meta }, body: [], implicit, secret: meta.secret === true, abort: new AbortController(),
      cleanups: new Set(), waits: [] };
    // Esc already pressed for this stack: a card opened while it finishes is closed at once by its own prompts (they answer null).
    if (this.escaped) frame.abort.abort();
    this.frames.push(frame); this.offset = 0; this.publish();
    return frame;
  }
  private ask(label: string, hidden: boolean, multi: boolean, owner?: object, initial = ""): Promise<string | null> {
    if (this.escaped || this.pending) return Promise.resolve(null);
    let frame = this.top();
    if (!frame) frame = this.push({ kind: "SETUP", title: "Balchemy", ...(hidden ? { secret: true } : {}) }, true);
    if (hidden) frame.secret = true;
    const { field, question } = multi ? { field: "rules", question: "Enter rule lines; :done ends input, :cancel stops" } : cardField(label, hidden);
    return new Promise((resolve) => {
      // A prefilled answer (an example to edit) is sanitised like typed text and kept within the input cap.
      const start = hidden || multi ? "" : cardText(initial).replace(/[\r\n]+/g, " ");
      const value = Buffer.byteLength(start, "utf8") <= INPUT_BYTES ? start : "";
      this.pending = { frame: frame!, field, hidden, multi, lines: [], value, resolve, ...(question ? { question } : {}), ...(owner ? { owner } : {}) };
      this.offset = 0; this.publish();
    });
  }
  private submit(pending: Pending): void {
    const value = pending.value;
    pending.value = "";
    if (pending.multi) {
      if (value === ":done") { this.settle(pending.lines.join("\n")); return; }
      if (value === ":cancel") { this.settle(null); return; }
      pending.lines.push(value);
      pending.frame.body.push({ text: `rules › ${cardText(value)}`, pre: false });
      if (Buffer.byteLength(JSON.stringify(pending.lines.join("\n")), "utf8") > INPUT_BYTES) { this.settle(pending.lines.join("\n")); return; }
      this.publish(); return;
    }
    // A visible answer stays in the card (it never leaves it); a hidden one is not echoed at all.
    if (!pending.hidden) pending.frame.body.push({ text: `${pending.field} › ${cardText(value)}`, pre: false });
    this.settle(value);
  }
  private settle(value: string | null): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.value = "";
    pending.resolve(value);
    if (pending.frame.implicit) this.closeFrame(pending.frame, undefined);
    else this.publish();
  }
  private escape(): void {
    // A running wait with nothing asked: Esc stops that wait only, and the card goes on (it says what stays undone).
    const waiting = this.pending ? undefined : this.top()?.waits.pop();
    if (waiting && !this.escaped) { waiting.abort(); this.publish(); return; }
    if (!this.escaped) {
      this.escaped = true;
      for (const frame of this.frames) {
        for (const wait of frame.waits) wait.abort();
        frame.abort.abort();
        for (const cleanup of [...frame.cleanups]) { try { cleanup(); } catch { /* A cleanup never blocks the others. */ } }
        frame.cleanups.clear();
      }
    }
    this.settle(null);
    this.publish();
  }
  private closeFrame(frame: Frame, result: string | undefined): void {
    const index = this.frames.indexOf(frame);
    if (index < 0) return;
    // Closing a card also closes any card still open on top of it (an error path), and answers a pending prompt with null.
    const closing = this.frames.splice(index);
    if (this.pending && closing.includes(this.pending.frame)) this.settle(null);
    const secret = closing.some((item) => item.secret);
    const last = [...frame.body].reverse().find((line) => line.text.trim() !== "" && !/^[a-z][a-z ()]* › /.test(line.text));
    for (const item of closing) { item.body = []; item.cleanups.clear(); }
    if (result !== undefined) this.row(result);
    else if (!frame.implicit) this.row(secret ? `Closed: ${frame.meta.title}.` : last?.text.trim() ?? `Closed: ${frame.meta.title}.`);
    if (!this.frames.length) {
      this.closedCount++; this.lastEscaped = this.escaped; this.escaped = false; this.offset = 0;
    }
    this.publish();
  }
  private publish(): void {
    const frame = this.top();
    const pending = this.pending && this.pending.frame === frame ? this.pending : undefined;
    const card: CardView | undefined = frame ? {
      id: frame.id, meta: frame.meta, secret: this.frames.some((item) => item.secret), body: [...frame.body], closing: this.escaped, offset: this.offset,
      ...(pending?.question ? { question: pending.question } : {}),
      ...(pending ? { input: { field: pending.field, hidden: pending.hidden, multi: pending.multi,
        shown: pending.hidden ? "•".repeat(Array.from(pending.value).length) : pending.value } } : {}),
    } : undefined;
    this.snap = { ...(card ? { card } : {}), rows: this.rows, closed: this.closedCount, escaped: this.lastEscaped };
    for (const listener of [...this.listeners]) listener();
  }
}
