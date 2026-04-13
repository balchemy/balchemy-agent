// src/tui/start.tsx
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { TuiConfig } from "./types.js";

export async function startTui(config: TuiConfig): Promise<void> {
  const { waitUntilExit } = render(<App config={config} />);

  // Handle SIGINT/SIGTERM gracefully
  const shutdown = (): void => {
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await waitUntilExit();
}
