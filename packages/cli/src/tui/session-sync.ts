import type { StoredAgent } from "../agent-store.js";
import { withUpdatedAgentStrategy } from "../agent-store.js";
import type { TuiConfig } from "./types.js";

export function buildStrategyUpdateArgs(
  strategy: string,
  shadowMode: boolean,
): {
  action: "configure_autonomous";
  naturalLanguageRules: string;
  shadowMode: boolean;
} {
  return {
    action: "configure_autonomous",
    naturalLanguageRules: strategy,
    shadowMode,
  };
}

export function toTuiConfig(
  agent: StoredAgent,
  autoSeedSubscriptions = false,
): TuiConfig {
  return {
    mcpEndpoint: agent.mcpEndpoint,
    apiKey: agent.apiKey,
    llmProvider: agent.llmProvider,
    llmApiKey: agent.llmApiKey,
    llmModel: agent.llmModel,
    llmBaseUrl: agent.llmBaseUrl,
    maxDailyLlmCost: agent.maxDailyLlmCost,
    llmTimeoutMs: agent.llmTimeoutMs,
    publicId: agent.publicId,
    strategy: agent.strategy,
    shadowMode: agent.shadowMode,
    behaviorRules: agent.behaviorRules,
    autoSeedSubscriptions,
  };
}

export function persistStrategyAndBuildRestartConfig(params: {
  agent: StoredAgent;
  strategy: string;
  saveAgent: (agent: StoredAgent) => void;
  autoSeedSubscriptions?: boolean;
}): { agent: StoredAgent; restartConfig: TuiConfig } {
  const updatedAgent = withUpdatedAgentStrategy(params.agent, params.strategy);
  params.saveAgent(updatedAgent);

  return {
    agent: updatedAgent,
    restartConfig: toTuiConfig(
      updatedAgent,
      params.autoSeedSubscriptions ?? false,
    ),
  };
}
