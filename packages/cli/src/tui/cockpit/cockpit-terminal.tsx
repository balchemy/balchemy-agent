/** A1 one screen: the cockpit's single Ink app for the whole `balchemy` run. It enters the alternate screen once (on first use) and
 * leaves it once (close). Setup steps, every card and the chat all draw inside it: a step's prompts become an in-screen card (card-host.ts),
 * and the chat screen stays mounted while a card runs, so nothing drops to plain readline any more.
 * The only exception is `suspend`: the model fallback for a runner without encrypted storage still opens LocalRunnerChat's own screen,
 * so this app is unmounted first and mounted again afterwards (two Ink apps never share the terminal). */
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, render, useInput, useStdout } from "ink";
import { CardHost, type CardIo } from "./card-host.js";
import { CardFrame, cardFrameRows } from "./card-view.js";
import { CockpitScreen, type CockpitScreenProps } from "./CockpitScreen.js";
import { enterInteractiveScreen, leaveInteractiveScreen, openInteractiveTerminal, type InteractiveTerminal } from "../terminal-session.js";
import { gutterRows } from "./conversation.js";
import { processCockpitTheme } from "./theme.js";
import type { CockpitChatExit } from "../../cockpit/cockpit-flow.js";

export type CockpitChatProps = Omit<CockpitScreenProps, "onExit" | "host">;
type ScreenStream = Parameters<typeof enterInteractiveScreen>[0];
type ScreenInput = Parameters<typeof enterInteractiveScreen>[1];
export interface CockpitTerminalOptions {
  /** Test seams: the terminal streams and the alternate-screen switches. */
  open?(): InteractiveTerminal;
  enter?(stream: ScreenStream, input: ScreenInput): void;
  leave?(stream: ScreenStream, input: ScreenInput): void;
  /** Test seam: Ink writes every frame (with CI set it otherwise writes only the last frame, at unmount). */
  debug?: boolean;
}
export interface CockpitTerminal {
  readonly host: CardHost;
  /** The flow's io: text and prompts become in-screen cards and `Balchemy` rows. */
  readonly io: CardIo;
  /** Shows this agent's chat (kept mounted when it is already shown) and resolves with the owner's next exit. A `card` exit does not
   * close anything: the flow runs that card through `io` while the chat stays on screen. */
  chat(props: CockpitChatProps): Promise<CockpitChatExit>;
  /** Runs another full-screen program with this screen unmounted, then mounts it again. */
  suspend<T>(run: () => Promise<T>): Promise<T>;
  /** Leaves the screen once; `message` is printed on the normal screen afterwards (a stop reason). */
  close(message?: string): void;
}

/** One conversation row with the fixed 10-column label gutter (label at column 2, text at column 11, wrapped rows indented): the same
 * renderer as the chat (conversation.ts), sanitised. */
export { gutterRows };

/** The screen before any chat exists (name, runner, model, budget, wallet, Hub link): `Balchemy` rows and the step's card. */
export function SetupFrame({ host, onQuit }: { host: CardHost; onQuit?: () => void }): React.ReactElement {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 100, height: stdout.rows || 30 });
  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns || 100, height: stdout.rows || 30 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);
  const snap = useSyncExternalStore(host.subscribe, host.snapshot, host.snapshot);
  // A card owns every key; without one there is nothing to type into yet (the step is working).
  // With no card open (the runner starting, the version check), Ctrl+C or Ctrl+Q stops balchemy as an interrupt would.
  useInput((value, key) => { if (!host.key(value, key) && key.ctrl && (value === "c" || value === "q")) onQuit?.(); });
  const width = Math.max(40, Math.min(160, size.width)), height = Math.max(12, size.height);
  const card = snap.card ? cardFrameRows(snap.card, width, Math.max(7, height - 6)) : [];
  const footer = card.length ? [] : [" Working on the setup. A card opens here when a step needs you."];
  const room = Math.max(1, height - 2 - card.length - footer.length);
  const lines = snap.rows.flatMap((row) => [...gutterRows("Balchemy", row.text, width), ""]).slice(-room);
  const theme = processCockpitTheme();
  return <Box flexDirection="column" width={width} height={height}>
    <Text>{" "}<Text {...theme.style("control")}>Balchemy</Text></Text>
    <Text {...theme.style("muted")}>{theme.glyphs.rule.repeat(width)}</Text>
    <Box flexDirection="column" height={room} justifyContent="flex-end">
      {lines.map((line, index) => <Text key={`r${index}`} wrap="truncate">{line || " "}</Text>)}
    </Box>
    <CardFrame rows={card} theme={theme} />
    {footer.map((line, index) => <Text key={`f${index}`}>{line}</Text>)}
  </Box>;
}

interface ShellStore { subscribe(listener: () => void): () => void; chat(): CockpitChatProps | undefined }
function CockpitShell({ store, host, onExit, onQuit }: { store: ShellStore; host: CardHost; onExit(exit: CockpitChatExit): void; onQuit(): void }): React.ReactElement {
  const chat = useSyncExternalStore(store.subscribe, store.chat, store.chat);
  return chat ? <CockpitScreen key={chat.target.agentId} {...chat} host={host} onExit={onExit} /> : <SetupFrame host={host} onQuit={onQuit} />;
}

export function createCockpitTerminal(options: CockpitTerminalOptions = {}): CockpitTerminal {
  const host = new CardHost();
  const open = options.open ?? openInteractiveTerminal;
  const enter = options.enter ?? enterInteractiveScreen;
  const leave = options.leave ?? leaveInteractiveScreen;
  let mounted: { terminal: InteractiveTerminal; unmount(): void } | undefined;
  let chatProps: CockpitChatProps | undefined;
  let waiter: ((exit: CockpitChatExit) => void) | undefined;
  let closed = false;
  const listeners = new Set<() => void>();
  const store: ShellStore = {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    chat: () => chatProps,
  };
  const onExit = (exit: CockpitChatExit): void => { const current = waiter; waiter = undefined; current?.(exit); };
  // A signal restores the terminal (a shown secret goes with the alternate screen), then ends the process as the signal would.
  const onSignal = (signal: NodeJS.Signals): void => {
    removeSignals();
    try { host.stopAll(); onExit({ kind: "quit" }); unmount(); } finally { process.kill(process.pid, signal); }
  };
  const removeSignals = (): void => { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); process.off("SIGHUP", onSignal); };
  const mount = (): void => {
    if (mounted || closed) return;
    const terminal = open();
    enter(terminal.stdout, terminal.stdin);
    const app = render(<CockpitShell store={store} host={host} onExit={onExit} onQuit={() => { onSignal("SIGINT"); }} />, {
      stdin: terminal.stdin, stdout: terminal.stdout, stderr: terminal.stderr, exitOnCtrlC: false, patchConsole: false, ...(options.debug ? { debug: true } : {}) });
    mounted = { terminal, unmount: () => app.unmount() };
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal); process.once("SIGHUP", onSignal);
  };
  function unmount(message?: string): void {
    const current = mounted;
    if (!current) { if (message) process.stdout.write(`${message}\n`); return; }
    mounted = undefined; removeSignals();
    try { current.unmount(); }
    finally {
      leave(current.terminal.stdout, current.terminal.stdin);
      if (message) current.terminal.stdout.write(`${message}\n`);
      current.terminal.dispose();
    }
  }
  const io: CardIo = {
    write: async (text) => { mount(); await host.io.write(text); },
    ask: (question) => { mount(); return host.io.ask(question); },
    secret: (question) => { mount(); return host.io.secret(question); },
    edit: (question, initial) => { mount(); return host.io.edit(question, initial); },
    agent: (agentId) => { host.io.agent(agentId); },
    card: (meta) => { mount(); return host.io.card(meta); },
  };
  return {
    host, io,
    chat(props) {
      mount();
      if (!chatProps || chatProps.target.agentId !== props.target.agentId) {
        chatProps = props;
        for (const listener of [...listeners]) listener();
      }
      onExit({ kind: "quit" });
      return new Promise<CockpitChatExit>((resolve) => { waiter = resolve; });
    },
    async suspend(run) {
      const was = mounted !== undefined;
      unmount();
      try { return await run(); } finally { if (was) mount(); }
    },
    close(message) { closed = true; onExit({ kind: "quit" }); unmount(message); },
  };
}
