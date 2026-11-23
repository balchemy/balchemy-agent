/** The cockpit chat screen: the conversation on the left, capital, positions, AI spend and mode on the right, and one card at a time
 * above the input. Ctrl+Q leaves. Text that looks like a secret is stopped here and never reaches the model.
 * A1 render (KOKPIT-SPEC §2, §3, §5): a header strip (wordmark, agent, and at 60-95 columns the status strip), a rule, the conversation
 * with a fixed label gutter (You / Agent / Balchemy / HH:MM, conversation.ts), the card or its chip, a notice row, a rule, the input
 * (wrapping to at most 4 rows) and one hints row. At 96 columns and wider a side panel with a left border shows the mode block (never
 * cut), notices, positions, wallet, activity and the AI model, each fact "as of HH:MM" after a failed read and "not readable" after
 * three (cockpit-panel.ts). Every mode change also writes a record row. Untrusted text is sanitised at this boundary (safe-text.ts).
 * Colour only reinforces labels and marks (theme.ts) and is off with NO_COLOR.
 * A1 one screen: Ctrl+E (or /card, or a risk-raising command) asks the flow to run the card; the screen stays mounted and the card is
 * drawn here from the card host (card-host.ts), between the conversation and the input. While it is open it owns every key. Esc returns
 * to the chat and leaves the chip "▸ <what is waiting> · Ctrl+E opens it"; Ctrl+E opens it again. No card path leaves the screen.
 * K5b: slash commands are parsed ONLY from the line typed into the input here (the Enter key), never from a model reply or a feed
 * line. Risk-lowering commands act at once; risk-raising ones open a code-built card with the command's own typed confirmation
 * (cockpit-commands.ts). Ctrl+S opens the settings, Ctrl+N the agents, `?` the help; PgUp/PgDn scroll. */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout, type Key } from "ink";
import { applyPromptEditorInput, isTranscriptPageDownInput, isTranscriptPageUpInput, type PromptEditorState } from "../ChatPanel.js";
import { displayWidth, sliceToWidth, wrapText } from "../text-layout.js";
import type { CardHost, CardHostSnapshot } from "./card-host.js";
import { CardFrame, cardChipRow, cardFrameRows } from "./card-view.js";
import { cockpitLayout, conversationRows, formatClock, headerRow, promptRows, type ConversationEntry, type ConversationRow } from "./conversation.js";
import { safeText } from "./safe-text.js";
import { processCockpitTheme, type CockpitRecordMark, type CockpitTheme } from "./theme.js";
import { TerminalError } from "../../errors.js";
import { requestPrivateBrain, type PrivateBrainTarget } from "../../runner/private-brain-client.js";
import { PrivateChatSession, privateModelSummary, type PrivateBrainTransport } from "../../runner/private-brain-ui.js";
import { splitSetupCard } from "../../runner/private-setup-card.js";
import { privateSecretKind, privateSecretRefusal } from "../../runner/private-secret-guard.js";
import { SETUP_STEPS, type SetupStepState } from "../../runner/setup-state.js";
import type { PrivatePositionView } from "../../runner/private-position-protocol.js";
import type { PrivateLaunchpadView } from "../../runner/private-launchpads.js";
import { cardLabel, parseCockpitCard, type CockpitCard } from "../../cockpit/cockpit-cards.js";
import type { CockpitChatExit } from "../../cockpit/cockpit-flow.js";
import { applyCockpitSetting, classifySources, cockpitHelpLines, cockpitLanguageNote, COCKPIT_LANGUAGES, COCKPIT_SETTINGS, nextCockpitLanguage,
  parseSlashCommand, runCockpitCommand, unavailableCommandDeps, type CockpitAgentRow, type CockpitCommandDeps, type CockpitCommandOutcome,
  type CockpitCommandState, type CockpitLanguage } from "../../cockpit/cockpit-commands.js";
import { COCKPIT_UNREADABLE_AFTER, cockpitModeKey, cockpitModeRecord, cockpitModeView, cockpitPanelFit, cockpitPanelRows, cockpitStatusStrip,
  factFreshness, observeFact, seedFact, skipFact, type CockpitCounters, type CockpitFact, type CockpitFactState, type CockpitFreshness, type CockpitMode,
  type CockpitPanelFacts } from "../../cockpit/cockpit-panel.js";
import { formatPrivateModelUsd } from "../../runner/private-model-prices.js";

/** Facts for the side panel and the next-step card, all read by code (never by the model). */
export interface CockpitSide {
  checklist: readonly SetupStepState[];
  nextCard?: CockpitCard;
  walletAddress?: string;
  /** Already formatted with its unit, such as "0.5 SOL". */
  balanceSol?: string;
  armed?: boolean;
  /** Phase 1: the runner's keep-awake, one short line (private-keep-awake.ts cockpitKeepAwakeLine). */
  keepAwake?: string;
  /** K5b: the agent's mode (shadow, armed, armed with new buys paused, paused, stopped). Without it the panel says CHECKING (never
   * SHADOW), and OFFLINE once three reads in a row came back without it. */
  mode?: CockpitMode;
  /** K5b: positions (open and recently closed) for the realized PnL. */
  positions?: readonly PrivatePositionView[];
  /** K5b: today's AI spend against the daily budget. */
  budget?: { spentMicroUsd: number; limitMicroUsd: number };
  /** K5b: signals checked, recent decisions and trades. */
  counters?: CockpitCounters;
  /** Why buys or DCA adds wait (cockpitExecutionNotes). */
  notes?: readonly string[];
}
/** A line the cockpit adds to the conversation itself: the agent's narrated activity (decisions, trades), never model text.
 * `mark`: its record mark (cockpit-feed.ts, from closed states only); without one it is a routine check. */
export interface CockpitFeedLine { id: string; text: string; mark?: CockpitRecordMark }
/** The conversation kept by the cockpit across agent switches. `at` (ms) is the time of a record row; `mark` its record mark. */
export interface CockpitMemory {
  entries: Array<{ key: string; who: "you" | "agent" | "note" | "feed"; text: string; at?: number; mark?: CockpitRecordMark }>; seen: Set<string>;
  /** K5b: the reply language chosen with /lang or in the settings. */
  language?: CockpitLanguage;
  /** A1: the last mode shown (its key) and whether it could trade; the baseline for the next mode-change record row. */
  mode?: { key: string; trading: boolean };
}
export interface CockpitScreenProps {
  target: PrivateBrainTarget;
  transport?: PrivateBrainTransport;
  initial: CockpitSide;
  /** Re-reads the side facts; called every few seconds while the screen is open. */
  readSide?(): Promise<CockpitSide>;
  /** New narrated lines since the last call (read-only polling of decisions, trades and positions). */
  readFeed?(): Promise<readonly CockpitFeedLine[]>;
  /** K5b: what the slash commands, the settings and the overlays read and do (production: cockpit-runtime.ts). */
  commands?: CockpitCommandDeps;
  refreshMs?: number;
  /** A message the screen sends once when it opens (the setup handover), as the owner's own words. */
  opening?: string;
  memory?: CockpitMemory;
  /** A1: the in-screen card host (cockpit-terminal.tsx). Its open card owns the input; its `Balchemy` rows join the conversation. */
  host?: CardHost;
  /** Called for every exit. A `card` exit keeps this screen mounted (the flow runs the card in it); the others end this chat. */
  onExit(exit: CockpitChatExit): void;
  /** A1 test seams: the palette (default: from the environment), the clock (ms) and the HH:MM formatter. */
  theme?: CockpitTheme;
  now?(): number;
  clock?(ms: number): string;
}
const NO_HOST: CardHostSnapshot = Object.freeze({ rows: [], closed: 0, escaped: false });
const noHostSubscribe = (): (() => void) => () => {};
const noHostSnapshot = (): CardHostSnapshot => NO_HOST;
type Entry = ConversationEntry;
/** The facts tracked for freshness ("as of HH:MM" after a failed read, "not readable" after three). */
interface Tracked {
  mode: CockpitFactState<CockpitMode>; balance: CockpitFactState<string>; positions: CockpitFactState<readonly PrivatePositionView[]>;
  budget: CockpitFactState<{ spentMicroUsd: number; limitMicroUsd: number }>; counters: CockpitFactState<CockpitCounters>;
}
function seedTracked(side: CockpitSide, now: number): Tracked {
  return { mode: seedFact(side.mode, now), balance: seedFact(side.balanceSol, now), positions: seedFact(side.positions, now),
    budget: seedFact(side.budget, now), counters: seedFact(side.counters, now) };
}
/** One read of the side facts (undefined: the read failed, or was still running when the next one was due). */
function observeTracked(tracked: Tracked, side: CockpitSide | undefined, now: number): Tracked {
  return { mode: observeFact(tracked.mode, side?.mode, now), balance: observeFact(tracked.balance, side?.balanceSol, now),
    positions: observeFact(tracked.positions, side?.positions, now), budget: observeFact(tracked.budget, side?.budget, now),
    counters: observeFact(tracked.counters, side?.counters, now) };
}
/** A read still running when the next is due: "as of" at most, never "not readable" or OFFLINE (cockpit-panel.ts skipFact). */
function skipTracked(tracked: Tracked): Tracked {
  return { mode: skipFact(tracked.mode), balance: skipFact(tracked.balance), positions: skipFact(tracked.positions), budget: skipFact(tracked.budget),
    counters: skipFact(tracked.counters) };
}
/** Fits key hints into one row, dropping from the end. */
function fitHints(items: readonly string[], width: number): string {
  const keep = [...items];
  while (keep.length > 1 && displayWidth(` ${keep.join(" · ")}`) > width) keep.pop();
  return sliceToWidth(` ${keep.join(" · ")}`, width);
}
type Overlay =
  | { kind: "help"; offset: number }
  | { kind: "settings"; index: number; editing?: string; values: Record<string, string> }
  | { kind: "agents"; index: number; rows: CockpitAgentRow[] }
  | { kind: "signals"; index: number; view?: PrivateLaunchpadView; selected: string[]; review: boolean };
const EMPTY: PromptEditorState = { value: "", cursorIndex: 0 };

/** The reply text a job produced, without the status line the shared view adds. */
function replyText(text: string): string { return text.replace(/^State: completed\n/, ""); }
/** A typed overlay value: digits, dots and dollar signs only (anything else is dropped), at most 12 characters. */
function overlayValue(current: string, value: string, key: { backspace?: boolean; delete?: boolean }): string {
  if (key.backspace || key.delete) return current.slice(0, -1);
  return (current + value.replace(/[^0-9.$]/g, "")).slice(0, 12);
}

export function CockpitScreen(props: CockpitScreenProps): React.ReactElement {
  const { target, transport = requestPrivateBrain, onExit, host } = props;
  const { stdout } = useStdout();
  const theme = useMemo(() => props.theme ?? processCockpitTheme(), [props.theme]);
  const now = props.now ?? Date.now, clock = props.clock ?? formatClock;
  const hosted = useSyncExternalStore(host?.subscribe ?? noHostSubscribe, host?.snapshot ?? noHostSnapshot, host?.snapshot ?? noHostSnapshot);
  // The newest host row when this chat mounted: an untagged row older than that belongs to no chat on screen.
  const hostMark = useRef(hosted.rows.reduce((max, row) => Math.max(max, row.id), 0));
  const [size, setSize] = useState({ width: stdout.columns || 100, height: stdout.rows || 30 });
  const session = useMemo(() => new PrivateChatSession(target, { transport }), [target, transport]);
  const chat = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const [side, setSide] = useState<CockpitSide>(props.initial);
  const [tracked, setTracked] = useState<Tracked>(() => seedTracked(props.initial, now()));
  const [entries, setEntriesState] = useState<Entry[]>(() => [...(props.memory?.entries ?? [])]);
  const setEntries = (change: (current: Entry[]) => Entry[]) => setEntriesState((current) => {
    const next = change(current); if (props.memory) props.memory.entries = next.slice(-500); return next;
  });
  const [input, setInput] = useState<PromptEditorState>(EMPTY);
  const [notice, setNotice] = useState("");
  const [proposal, setProposal] = useState<CockpitCard>();
  const [overlay, setOverlayState] = useState<Overlay>();
  const [scroll, setScroll] = useState(0);
  const commands = useMemo(() => props.commands ?? unavailableCommandDeps(target.agentId), [props.commands, target.agentId]);
  const commandState = useRef<CockpitCommandState>({ language: props.memory?.language ?? "auto" });
  const seen = useRef(props.memory?.seen ?? new Set<string>()), opened = useRef(false), ticking = useRef(false), working = useRef(false);
  const overlayRef = useRef<Overlay | undefined>(undefined);
  /** The conversation's visible rows at the last render (one PgUp/PgDn page). */
  const bodyRowsRef = useRef(10), maxOffsetRef = useRef(0);
  /** A1: the card the owner opened last, and the one left with Esc (its chip stays until Ctrl+E opens it again). */
  const requested = useRef<CockpitCard | undefined>(undefined);
  const [waiting, setWaiting] = useState<CockpitCard>();
  const setOverlay = (next: Overlay | undefined) => { overlayRef.current = next; setOverlayState(next); };
  /** No exit closes this screen: a card runs inside it (the card host draws it), and the terminal ends the others. */
  const leave = (value: CockpitChatExit) => {
    if (value.kind === "card") { requested.current = value.card; setWaiting(undefined); }
    onExit(value);
  };
  const note = (...text: string[]) => setEntries((current) => [...current, ...text.map((line, index) => ({ key: `note:${current.length + index}:${Date.now()}`, who: "note" as const, text: line }))]);

  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns || 100, height: stdout.rows || 30 }); stdout.on("resize", resize);
    void session.connect();
    let alive = true;
    const tick = async () => {
      // One refresh at a time: a slow read (Hub, the owner's RPC) never overlaps the next or lands out of order. A read still running
      // when the next is due counts as a missed read, so a hung read shows "as of HH:MM" instead of looking current.
      if (ticking.current) { if (props.readSide) setTracked(skipTracked); return; }
      ticking.current = true;
      try { await refresh(); } finally { ticking.current = false; }
    };
    const refresh = async () => {
      if (props.readSide) {
        let next: CockpitSide | undefined;
        try { next = await props.readSide(); } catch { next = undefined; /* keep the last facts; the read counts as missed */ }
        if (alive) { if (next) setSide(next); const read = next; setTracked((current) => observeTracked(current, read, now())); }
      }
      if (props.readFeed) {
        try {
          const lines = await props.readFeed();
          if (alive && lines.length) setEntries((current) => [...current, ...lines.filter((line) => !seen.current.has(`feed:${line.id}`))
            .map((line) => { seen.current.add(`feed:${line.id}`);
              return { key: `feed:${line.id}`, who: "feed" as const, text: line.text, at: now(), ...(line.mark ? { mark: line.mark } : {}) }; })]);
        } catch { /* the feed is best effort and read-only */ }
      }
    };
    const timer = setInterval(() => { void tick(); }, props.refreshMs ?? 5000);
    void tick();
    return () => { alive = false; clearInterval(timer); stdout.off("resize", resize); session.detach(); };
  }, [session, stdout]);

  // Completed replies join the conversation once; a valid card line becomes the proposal card. Reply text is never parsed for commands.
  useEffect(() => {
    for (const reply of chat.replies) {
      if (seen.current.has(reply.jobId)) continue;
      seen.current.add(reply.jobId);
      const { text, card } = splitSetupCard(replyText(reply.text));
      setEntries((current) => [...current, { key: reply.jobId, who: "agent", text }]);
      const parsed = card ? parseCockpitCard(card) : undefined;
      if (parsed) setProposal(parsed);
    }
  }, [chat.replies]);
  // The opening message goes once, when the model is ready. It is code-built, not typed by the owner, so it is never drawn as a You row.
  useEffect(() => {
    if (opened.current || !props.opening || chat.phase !== "ready") return;
    opened.current = true;
    void session.submit(props.opening);
  }, [chat.phase]);

  // The full trading wallet address goes into the conversation once (to copy for funding); the panel shows it shortened.
  useEffect(() => {
    if (!side.walletAddress || seen.current.has(`wallet:${side.walletAddress}`)) return;
    seen.current.add(`wallet:${side.walletAddress}`);
    setEntries((current) => [...current, { key: `wallet:${side.walletAddress}`, who: "note",
      text: `Your trading wallet: ${side.walletAddress}. Fund it with only what the agent may spend.` }]);
  }, [side.walletAddress]);
  // A1: the card host's code-built rows (card results, step text written outside a card) join the conversation once, as Balchemy rows.
  // Card bodies never do: they live only in the open card and are discarded when it closes.
  useEffect(() => {
    // Only this agent's rows; an untagged row (no agent known yet) only when it was written while this chat is on screen.
    const fresh = hosted.rows.filter((row) => !seen.current.has(`host:${row.id}`)
      && (row.agentId !== undefined ? row.agentId === props.target.agentId : row.id > hostMark.current));
    if (!fresh.length) return;
    for (const row of fresh) seen.current.add(`host:${row.id}`);
    setEntries((current) => [...current, ...fresh.map((row) => ({ key: `host:${row.id}`, who: "note" as const, text: row.text }))]);
  }, [hosted.rows]);
  // The card opened from here and left with Esc stays as the chip (Ctrl+E opens it again); opening a card cleared the previous chip.
  useEffect(() => {
    if (!hosted.closed) return;
    if (hosted.escaped && requested.current) setWaiting(requested.current);
    requested.current = undefined;
  }, [hosted.closed]);
  // A locked wallet blocks everything else, so its card wins over an older proposal. The chip names the card left with Esc first.
  const card = side.nextCard?.kind === "wallet_unlock" ? side.nextCard : proposal ?? side.nextCard;
  const chipCard = waiting ?? card;
  // Ink re-binds the input handler only after a render's effects run; keystrokes read the latest values through this ref,
  // so a fast key never acts on an older card and fast typing never drops characters.
  const latest = useRef({ card: chipCard, input, phase: chat.phase });
  latest.current = { card: chipCard, input, phase: chat.phase };

  // A1: the status facts with their freshness. A mode that has not come back three reads in a row is OFFLINE; one never read is CHECKING.
  const offline = tracked.mode.misses >= COCKPIT_UNREADABLE_AFTER
    ? (tracked.mode.at !== undefined ? { lastAnswer: clock(tracked.mode.at) } : {}) : undefined;
  const freshness: Partial<Record<CockpitFact, CockpitFreshness>> = {};
  for (const fact of ["mode", "balance", "positions", "budget", "counters"] as const) {
    const state = factFreshness(tracked[fact], clock);
    if (state) freshness[fact] = state;
  }
  const unfinished = side.checklist.some((state) => state !== "done");
  const panelFacts: CockpitPanelFacts = {
    ...(!offline && tracked.mode.value !== undefined ? { mode: tracked.mode.value } : {}),
    // Locked: its unlock card is next. Unlocked: the checklist's wallet step is done only when the wallet reads unlocked (setup-state.ts).
    ...(offline ? { offline } : {}), freshness, walletLocked: side.nextCard?.kind === "wallet_unlock",
    walletUnlocked: side.nextCard?.kind !== "wallet_unlock" && side.checklist[SETUP_STEPS.indexOf("Trading wallet")] === "done",
    ...(side.walletAddress ? { walletAddress: side.walletAddress } : {}),
    ...(tracked.balance.value !== undefined ? { balanceSol: tracked.balance.value } : {}),
    ...(tracked.positions.value ? { positions: tracked.positions.value } : {}), ...(tracked.budget.value ? { budget: tracked.budget.value } : {}),
    ...(tracked.counters.value ? { counters: tracked.counters.value } : {}), ...(side.keepAwake ? { keepAwake: side.keepAwake } : {}),
    ...(side.notes?.length ? { notes: side.notes } : {}),
    ...(chat.model ? { model: privateModelSummary(chat.model).replace(/ · provider checked per request$/, "") } : {}),
    ...(unfinished ? { setup: SETUP_STEPS.map((title, index) => ({ title, state: side.checklist[index] ?? ("unknown" as SetupStepState) })) } : {}),
  };
  const modeView = cockpitModeView(panelFacts);
  const modeKey = cockpitModeKey(modeView);
  // Every mode change also writes a record row, so a change is never visible only in the panel. The first known mode is the baseline
  // (kept in memory across agent switches), and CHECKING writes nothing.
  const lastMode = useRef(props.memory?.mode);
  useEffect(() => {
    if (!modeView.record) return;
    const previous = lastMode.current;
    const next = { key: modeKey, trading: modeView.trading };
    lastMode.current = next; if (props.memory) props.memory.mode = next;
    const row = cockpitModeRecord(previous?.key, previous?.trading ?? false, modeView);
    if (!row) return;
    const at = now();
    setEntries((current) => [...current, { key: `mode:${current.length}:${at}`, who: "feed", text: row.text, at, mark: row.mark }]);
  }, [modeKey]);

  const setLanguage = (language: CockpitLanguage) => { commandState.current.language = language; if (props.memory) props.memory.language = language; };
  const openOverlay = async (kind: "help" | "settings" | "agents" | "signals") => {
    if (kind === "help") { setOverlay({ kind: "help", offset: 0 }); return; }
    if (kind === "agents") { setOverlay({ kind: "agents", index: 0, rows: await commands.agents().catch(() => []) }); return; }
    if (kind === "signals") {
      const view = await commands.launchpads().catch(() => undefined);
      setOverlay({ kind: "signals", index: 0, ...(view ? { view } : {}), selected: view ? [...view.subscribedIds] : [], review: false }); return;
    }
    const [budget, sizing] = await Promise.all([commands.budget().catch(() => undefined), commands.sizing().catch(() => undefined)]);
    setOverlay({ kind: "settings", index: 0, values: { model: chat.model ? privateModelSummary(chat.model).replace(/ · provider checked per request$/, "") : "not ready",
      budget: budget ? formatPrivateModelUsd(budget.limitMicroUsd) : "?", slippage: sizing ? String(sizing.slippageBps) : "not set",
      strategy: "show with /directive", language: COCKPIT_LANGUAGES[commandState.current.language], rpc: "Balchemy's connection unless set" } });
  };
  const handle = async (outcome: CockpitCommandOutcome) => {
    if (outcome.kind === "lines") note(...outcome.lines);
    else if (outcome.kind === "language") { setLanguage(outcome.language); note(...outcome.lines); }
    else if (outcome.kind === "overlay") await openOverlay(outcome.overlay);
    else leave(outcome.exit);
  };
  /** One command or setting at a time; a failure is shown and nothing else runs. */
  const work = async (run: () => Promise<CockpitCommandOutcome>) => {
    if (working.current) { setNotice("The last command is still running."); return; }
    working.current = true; setNotice("Working…");
    try { await handle(await run()); setNotice(""); }
    catch (error: unknown) {
      setNotice("");
      note(error instanceof TerminalError ? `${error.title}: ${error.cause} ${error.fix}` : "That command could not finish. Nothing else was changed.");
    } finally { working.current = false; }
  };
  const send = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setScroll(0);
    if (text === "/card") { const current = latest.current.card; if (current) leave({ kind: "card", card: current }); return; }
    // The same job only: /check reads it again, /retry resends the exact same job ID and text. Neither creates another job.
    if (text === "/check") { setNotice(""); void session.check(); return; }
    if (text === "/retry") { setNotice(""); void session.retrySame(); return; }
    // A1: key-shaped text is refused first, before any row shows it: it never reaches the model provider, the conversation or memory.
    const secret = privateSecretKind(text);
    if (secret) { setNotice(""); note(privateSecretRefusal(secret)); return; }
    // Typed by the owner on this keyboard: the only place a slash command is recognised.
    const slash = parseSlashCommand(text);
    if (slash && "unknown" in slash) { setNotice(`Unknown command ${slash.unknown}. Type /help for the list. Nothing was sent to your agent.`); return; }
    if (slash) { setEntries((current) => [...current, { key: `you:${current.length}:${Date.now()}`, who: "you", text }]); void work(() => runCockpitCommand(slash, commands, commandState.current)); return; }
    if (latest.current.phase !== "ready") {
      setNotice(latest.current.phase === "pending" ? "Your agent is still answering. Wait for the reply, then send again."
        : "The last reply is not confirmed yet: type /check to read it again, or /retry to resend the same message."); return;
    }
    setNotice("");
    setEntries((current) => [...current, { key: `you:${current.length}:${Date.now()}`, who: "you", text }]);
    void session.submit(`${cockpitLanguageNote(commandState.current.language)}${text}`);
  };
  const update = (next: PromptEditorState) => { latest.current = { ...latest.current, input: next }; setInput(next); };

  /** Keys while an overlay is open: the overlay takes every key (nothing reaches the input line). */
  const overlayKey = (value: string, key: Key) => {
    const current = overlayRef.current;
    if (!current) return;
    if (key.escape || (key.ctrl && value === "q")) { setOverlay(undefined); return; }
    if (current.kind === "help") {
      // PgUp/PgDn and the arrows scroll the help; any other key closes it.
      const page = Math.max(1, bodyRowsRef.current - 1);
      const step = key.pageDown || isTranscriptPageDownInput(value) ? page : key.downArrow ? 1 : key.pageUp || isTranscriptPageUpInput(value) ? -page : key.upArrow ? -1 : 0;
      setOverlay(step ? { kind: "help", offset: Math.max(0, current.offset + step) } : undefined);
      return;
    }
    const move = (count: number, index: number) => (key.upArrow ? Math.max(0, index - 1) : key.downArrow ? Math.min(count - 1, index + 1) : index);
    if (current.kind === "agents") {
      const count = current.rows.length + 1;
      if (key.upArrow || key.downArrow) { setOverlay({ ...current, index: move(count, current.index) }); return; }
      if (key.return) {
        const row = current.rows[current.index];
        setOverlay(undefined);
        if (!row) leave({ kind: "new" }); else if (!row.current) leave({ kind: "switch", agentId: row.agentId });
      }
      return;
    }
    if (current.kind === "signals") {
      const live = current.view?.launchpads.filter((item) => item.status === "live") ?? [];
      if (key.upArrow || key.downArrow) { setOverlay({ ...current, index: move(Math.max(1, live.length), current.index), review: false }); return; }
      if (value === " " && live[current.index]) {
        const id = live[current.index]!.id;
        setOverlay({ ...current, review: false, selected: current.selected.includes(id) ? current.selected.filter((item) => item !== id) : [...current.selected, id].sort() });
        return;
      }
      if (key.return && current.view) {
        const change = classifySources(current.view.subscribedIds, current.selected);
        if (change === "same") { setOverlay(undefined); note("Signal sources unchanged."); return; }
        // Adding a source widens what the agent researches: one review line first, then Enter again saves.
        if (change === "raise" && !current.review) { setOverlay({ ...current, review: true }); return; }
        setOverlay(undefined);
        void work(async () => ({ kind: "lines", lines: [await commands.setLaunchpads(current.selected)] }));
      }
      return;
    }
    const row = COCKPIT_SETTINGS[current.index];
    if (current.editing !== undefined) {
      if (key.return && row) { const value = current.editing; setOverlay(undefined); void work(() => applyCockpitSetting(row.field, value, commands, commandState.current)); return; }
      setOverlay({ ...current, editing: overlayValue(current.editing, value, key) });
      return;
    }
    if (key.upArrow || key.downArrow) { setOverlay({ ...current, index: move(COCKPIT_SETTINGS.length, current.index) }); return; }
    if (!key.return || !row) return;
    if (row.field === "budget" || row.field === "slippage") { setOverlay({ ...current, editing: "" }); return; }
    if (row.field === "language") {
      const language = nextCockpitLanguage(commandState.current.language);
      setLanguage(language);
      setOverlay({ ...current, values: { ...current.values, language: COCKPIT_LANGUAGES[language] } });
      return;
    }
    setOverlay(undefined);
    void work(() => applyCockpitSetting(row.field, "", commands, commandState.current));
  };

  useInput((value, key) => {
    // An open card owns every key (Esc and Ctrl+C close it); chat input and slash commands are not read meanwhile.
    if (host?.key(value, key)) return;
    if (key.ctrl && value === "c") { leave({ kind: "quit" }); return; }
    if (overlayRef.current) { overlayKey(value, key); return; }
    if (key.ctrl && value === "q") { leave({ kind: "quit" }); return; }
    if (key.ctrl && value === "e") { const current = latest.current.card; if (current) leave({ kind: "card", card: current }); return; }
    if (key.ctrl && value === "s") { void openOverlay("settings"); return; }
    if (key.ctrl && value === "n") { void openOverlay("agents"); return; }
    const page = Math.max(1, bodyRowsRef.current - 1);
    // Clamped to the conversation, so PgDn always moves back down at once after scrolling past the top.
    if (key.pageUp || isTranscriptPageUpInput(value)) { setScroll((current) => Math.min(maxOffsetRef.current, current + page)); return; }
    if (key.pageDown || isTranscriptPageDownInput(value)) { setScroll((current) => Math.max(0, Math.min(maxOffsetRef.current, current) - page)); return; }
    if (value === "?" && latest.current.input.value === "") { void openOverlay("help"); return; }
    if (key.return) { const text = latest.current.input.value; update(EMPTY); send(text); return; }
    const editing = key.backspace || key.delete || key.leftArrow || key.rightArrow || key.home || key.end;
    if (!editing && /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value)) return;
    const next = applyPromptEditorInput(latest.current.input, value.replace(/\t/g, " "), key);
    if (Buffer.byteLength(JSON.stringify(next.value), "utf8") <= 8192) update(next);
  });

  const layout = cockpitLayout(size.width);
  const { width, mainWidth } = layout;
  const height = Math.max(1, size.height);
  const style = theme.style, glyphs = theme.glyphs;
  // Hints hide below 16 rows (`?` still opens the help).
  const hintsShown = height >= 16;
  // A1: an open card is drawn here (between the conversation and the input) and replaces the chip, notices, prompt and hints;
  // otherwise a waiting card is one chip line.
  const openCard = hosted.card ? cardFrameRows(hosted.card, mainWidth, Math.max(7, height - 9)) : undefined;
  const chip = !openCard && chipCard ? cardChipRow(safeText(cardLabel(chipCard)), mainWidth) : undefined;
  const status = openCard ? [] : [notice || chat.notice].map(safeText).filter(Boolean).flatMap((line) => wrapText(line, mainWidth - 1).slice(0, 2).map((row) => ` ${row}`));
  const prompt = openCard ? [] : promptRows(input.value, input.cursorIndex, mainWidth, glyphs);
  const hints = openCard || !hintsShown ? [] : [fitHints(["Enter send", "? help", ...(chipCard ? ["Ctrl+E card"] : []), "Ctrl+Q leave",
    ...(layout.sideWidth ? [] : ["/status"]), "Ctrl+S settings", "Ctrl+N agents", "PgUp/PgDn scroll"], mainWidth)];
  const below = openCard ? openCard.length : (chip ? 1 : 0) + status.length + 1 + prompt.length + hints.length;
  const bodyRows = Math.max(3, height - 2 - below);
  bodyRowsRef.current = bodyRows;
  const overlayLines = overlay ? overlayText(overlay, commandState.current.language).map(safeText).flatMap((line) => wrapText(line, mainWidth - 1)).map((line) => ` ${line}`) : [];
  const rows = conversationRows(entries, layout, glyphs, clock);
  const maxOffset = Math.max(0, rows.length - bodyRows);
  maxOffsetRef.current = maxOffset;
  const offset = Math.min(scroll, maxOffset);
  const overlayOffset = overlay?.kind === "help" ? Math.min(overlay.offset, Math.max(0, overlayLines.length - bodyRows)) : 0;
  const visible: ConversationRow[] = overlayLines.length
    ? overlayLines.slice(overlayOffset, overlayOffset + bodyRows).map((text, index) => ({ key: `o${index}`, text, label: "", mark: "", body: text }))
    : rows.slice(Math.max(0, rows.length - offset - bodyRows), rows.length - offset);
  const scrolled = offset > 0 && !overlay;
  // The header's right side: the scroll state, else the status strip (60-95 columns) or the mode word (below 60); the panel has it wider.
  const strip = scrolled ? [`scrolled up ${offset} rows · PgDn returns`]
    : layout.sideWidth ? [] : layout.gutter ? cockpitStatusStrip(panelFacts) : [modeView.word];
  const head = headerRow(target.agentId, strip, mainWidth);
  const headPad = Math.max(1, mainWidth - displayWidth(head.left) - displayWidth(head.right) - 1);
  const rightMode = !scrolled && head.right.startsWith(modeView.word) ? modeView.word : "";
  const rule = glyphs.rule.repeat(Math.max(1, Math.floor(mainWidth / displayWidth(glyphs.rule))));
  if (size.height < 12) return <Box width={width}><Text wrap="truncate">Make this window at least 12 rows tall.</Text></Box>;
  const main = <Box flexDirection="column" width={mainWidth}>
    <Text wrap="truncate">{" "}<Text {...style("control")}>Balchemy</Text>{head.left.slice(" Balchemy".length)}{" ".repeat(headPad)}{rightMode
      ? <><Text {...style(modeView.role)}>{rightMode}</Text>{head.right.slice(rightMode.length)}</> : head.right}</Text>
    <Text wrap="truncate" {...style("muted")}>{rule}</Text>
    <Box flexDirection="column" height={bodyRows} justifyContent={overlay ? "flex-start" : "flex-end"}>
      {visible.length ? visible.map((row) => <Text key={row.key} wrap="truncate">{row.labelRole
        ? <Text {...style(row.labelRole)}>{row.label}</Text> : row.label}{row.markRole
        ? <Text {...style(row.markRole)}>{row.mark}</Text> : row.mark}{row.body || (row.label || row.mark ? "" : " ")}</Text>)
        : <Text wrap="truncate">{chat.phase === "ready" ? " Say hello, or ask your agent what to do next. Type /help for commands." : " "}</Text>}
    </Box>
    {openCard ? <CardFrame rows={openCard} theme={theme} /> : <>
      {chip ? <Text wrap="truncate">{chip}</Text> : null}
      {status.map((line, index) => <Text key={`status${index}`} wrap="truncate">{line}</Text>)}
      <Text wrap="truncate" {...style("muted")}>{rule}</Text>
      {prompt.map((row, index) => {
        const chars = Array.from(row.text);
        const empty = !input.value && index === 0;
        return <Text key={`p${index}`} wrap="truncate"><Text {...style("control")}>{row.prefix}</Text>{empty
          ? <><Text {...style("control")}>{glyphs.cursor}</Text><Text {...style("muted")}>{sliceToWidth(chat.phase === "ready"
            ? "Message your agent, or type / for commands" : "Waiting for the reply…", Math.max(0, mainWidth - displayWidth(row.prefix) - 1))}</Text></>
          : row.cursorAt !== undefined ? <>{chars.slice(0, row.cursorAt).join("")}<Text {...style("control")}>{glyphs.cursor}</Text>{chars.slice(row.cursorAt).join("")}</>
            : row.text}</Text>;
      })}
      {hints.map((line, index) => <Text key={`h${index}`} wrap="truncate" {...style("muted")}>{line}</Text>)}
    </>}
  </Box>;
  if (!layout.sideWidth) return <Box flexDirection="column" width={width} height={height}>{main}</Box>;
  // The side panel: a left border only (fewer glyphs to copy by accident), never focused, never scrolled; a short terminal cuts it from
  // the bottom and the mode block always stays.
  const panel = cockpitPanelFit(cockpitPanelRows(panelFacts, layout.sideText), height);
  return <Box flexDirection="row" width={width} height={height}>{main}
    <Box flexDirection="column" width={layout.sideWidth} height={height}>
      {Array.from({ length: height }, (_value, index) => {
        const row = panel[index];
        const lead = row?.lead && row.text.startsWith(row.lead) ? row.lead : "";
        return <Text key={`s${index}`} wrap="truncate"><Text {...style("muted")}>{glyphs.border}</Text>{" "}{lead && row?.role
          ? <><Text {...style(row.role)}>{lead}</Text>{row.text.slice(lead.length)}</>
          : row?.heading ? <Text bold>{row.text}</Text> : row?.text ?? ""}</Text>;
      })}
    </Box>
  </Box>;
}

/** The text of an open overlay (code-built; Esc closes it). */
function overlayText(overlay: Overlay, language: CockpitLanguage): string[] {
  switch (overlay.kind) {
    case "help": return ["PgUp/PgDn scroll this help; any other key closes it.", "", ...cockpitHelpLines()];
    case "agents": return ["Agents: Enter switches; nothing is disarmed (Esc closes)", "The others keep running as they are.",
      ...overlay.rows.map((row, index) => `${index === overlay.index ? "▶" : " "} ${row.agentId}${row.current ? " (this one)" : ""}: ${row.mode}`),
      `${overlay.index === overlay.rows.length ? "▶" : " "} + Add a new agent (/new)`];
    case "signals": {
      if (!overlay.view) return ["Signal sources", "The launchpad list could not be read right now. Nothing was changed. Esc closes."];
      const live = overlay.view.launchpads.filter((item) => item.status === "live");
      const added = overlay.selected.filter((id) => !overlay.view!.subscribedIds.includes(id));
      return ["Signal sources (Up/Down, Space selects, Enter saves, Esc closes)",
        // A1: launchpads that are not live yet are hidden (unfinished options are not shown).
        ...live.map((item, index) => `${index === overlay.index ? "▶" : " "} [${overlay.selected.includes(item.id) ? "x" : " "}] ${item.name} (launchpad)`),
        "   -  Telegram and Discord sources: added and managed on your Hub page",
        ...(overlay.review ? ["", `Adding ${added.join(", ")}: the agent will research its launches. Your rules and limits still decide every buy.`,
          "Press Enter again to save, or Esc to cancel."] : [])];
    }
    case "settings": return ["Settings (Up/Down, Enter; lower values apply at once, higher ones open a card with a typed confirmation; Esc closes)",
      ...COCKPIT_SETTINGS.map((row, index) => {
        const value = row.field === "language" ? COCKPIT_LANGUAGES[language] : overlay.values[row.field] ?? "?";
        const mark = index === overlay.index ? "▶" : " ";
        return index === overlay.index && overlay.editing !== undefined ? `${mark} ${row.label}: ${overlay.editing}_  (Enter applies)`
          : `${mark} ${row.label}: ${value}${index === overlay.index ? `  (${row.hint})` : ""}`;
      })];
  }
}
