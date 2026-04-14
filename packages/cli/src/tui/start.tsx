// src/tui/start.tsx
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { TuiConfig } from "./types.js";

export async function startTui(config: TuiConfig): Promise<void> {
  const { waitUntilExit } = render(<App config={config} />);

  // Force process exit after cleanup — prevents hanging on SSE/gRPC connections
  const forceExit = (): void => {
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", forceExit);
  process.on("SIGTERM", forceExit);

  await waitUntilExit();
  // Ensure clean exit even if Ink doesn't trigger process.exit
  process.exit(0);
}
