// src/tui/start-wizard.tsx — Launch the Ink-based onboarding wizard
import React from "react";
import { render } from "ink";
import { Wizard } from "./Wizard.js";
import { startTui } from "./start.js";
import type { TuiConfig } from "./types.js";
import { enterInteractiveScreen, leaveInteractiveScreen } from "./terminal-session.js";
import { assertSafeInitDirectory } from "../init-target.js";

export async function startWizard(outDir: string): Promise<void> {
  assertSafeInitDirectory(outDir);
  enterInteractiveScreen();

  return new Promise<void>((resolve) => {
    const { unmount } = render(
      <Wizard
        outDir={outDir}
        onComplete={(config) => {
          unmount();
          leaveInteractiveScreen();

          const tuiConfig: TuiConfig = {
            mcpEndpoint: config.mcpEndpoint,
            apiKey: config.apiKey,
            llmProvider: config.llmProvider,
            llmApiKey: config.llmApiKey,
            llmModel: config.llmModel,
            llmBaseUrl: config.llmBaseUrl,
            maxDailyLlmCost: config.maxDailyLlmCost,
            publicId: config.publicId,
            strategy: config.strategy,
            shadowMode: config.shadowMode,
            behaviorRules: config.behaviorRules,
            autoSeedSubscriptions: false,
          };

          void startTui(tuiConfig).then(resolve);
        }}
      />
    );
  });
}
