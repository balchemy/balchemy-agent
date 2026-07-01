// src/tui/start.tsx
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { TuiConfig } from "./types.js";
import { enterInteractiveScreen, leaveInteractiveScreen, openInteractiveTerminal } from "./terminal-session.js";

export async function startTui(config: TuiConfig): Promise<void> {
  const terminal = openInteractiveTerminal();
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    leaveInteractiveScreen(terminal.stdout, terminal.stdin);
    terminal.dispose();
  };

  enterInteractiveScreen(terminal.stdout, terminal.stdin);
  const { waitUntilExit } = render(<App config={config} />, {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    stderr: terminal.stderr,
  });

  // Force process exit after cleanup — prevents hanging on SSE/gRPC connections
  const forceExit = (): void => {
    cleanup();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", forceExit);
  process.on("SIGTERM", forceExit);

  await waitUntilExit();
  process.off("SIGINT", forceExit);
  process.off("SIGTERM", forceExit);
  cleanup();
  // Ensure clean exit even if Ink doesn't trigger process.exit
  process.exit(0);
}
