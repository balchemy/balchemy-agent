/**
 * Parses agent.config.yaml into AgentLoopConfig.
 * Resolves ${ENV_VAR} references in string values.
 * Validates required fields and throws descriptive errors.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import type { AgentLoopConfig, LlmProvider } from '@balchemyai/agent-sdk';

interface RawConfig {
  mcp_endpoint?: unknown;
  api_key?: unknown;
  llm?: {
    provider?: unknown;
    api_key?: unknown;
    model?: unknown;
    base_url?: unknown;
    max_daily_usd?: unknown;
    timeout_ms?: unknown;
  };
  webhook?: {
    port?: unknown;
    secret?: unknown;
  };
  behavior_rules?: unknown;
  behavior_rules_path?: unknown;
  strategy?: unknown;
  shadow_mode?: unknown;
}

function resolveEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    const envVal = process.env[varName];
    if (envVal === undefined) {
      throw new Error(
        `Environment variable '${varName}' referenced in config is not set`,
      );
    }
    return envVal;
  });
}

function requireString(obj: unknown, fieldPath: string): string {
  if (typeof obj !== 'string' || !obj) {
    throw new Error(`Config field '${fieldPath}' is required and must be a non-empty string`);
  }
  return resolveEnv(obj);
}

function optionalString(obj: unknown): string | undefined {
  if (typeof obj !== 'string' || !obj) return undefined;
  return resolveEnv(obj);
}

function optionalNumber(obj: unknown, defaultVal?: number): number | undefined {
  if (obj === undefined || obj === null) return defaultVal;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') {
    const n = parseFloat(obj);
    if (!isNaN(n)) return n;
  }
  return defaultVal;
}

const VALID_SDK_PROVIDERS: LlmProvider[] = ['anthropic', 'openai', 'custom'];

function parseLlmProvider(raw: unknown): LlmProvider {
  const rawStr = String(raw);
  // Map external provider names to SDK providers
  if (rawStr === 'anthropic') return 'anthropic';
  if (['openai', 'gemini', 'grok', 'openrouter'].includes(rawStr)) return 'openai';
  if (VALID_SDK_PROVIDERS.includes(rawStr as LlmProvider)) return rawStr as LlmProvider;
  throw new Error(
    `Config field 'llm.provider' must be one of: anthropic, openai, gemini, grok, openrouter, custom`,
  );
}

export function loadConfig(configPath: string): AgentLoopConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse YAML config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Config file must be a YAML object');
  }

  const cfg = parsed as RawConfig;

  const mcpEndpoint = requireString(cfg.mcp_endpoint, 'mcp_endpoint');
  const apiKey = requireString(cfg.api_key, 'api_key');

  if (!cfg.llm) {
    throw new Error("Config field 'llm' is required");
  }

  const llmProvider = parseLlmProvider(cfg.llm.provider);
  const llmApiKey = requireString(cfg.llm.api_key, 'llm.api_key');
  const llmModel = optionalString(cfg.llm.model);
  const llmBaseUrl = optionalString(cfg.llm.base_url);
  const maxDailyLlmCost = optionalNumber(cfg.llm.max_daily_usd, 5);
  const llmTimeoutMs = optionalNumber(cfg.llm.timeout_ms, 15_000);

  const webhookPort = cfg.webhook
    ? optionalNumber(cfg.webhook.port, 0) ?? 0
    : 0;
  const webhookSecret = cfg.webhook
    ? optionalString(cfg.webhook.secret)
    : undefined;

  const behaviorRulesPath =
    typeof cfg.behavior_rules_path === 'string' && cfg.behavior_rules_path
      ? cfg.behavior_rules_path
      : undefined;

  const behaviorRules =
    typeof cfg.behavior_rules === 'object' && cfg.behavior_rules !== null
      ? (cfg.behavior_rules as Record<string, unknown>)
      : undefined;

  return {
    mcpEndpoint,
    apiKey,
    llmProvider,
    llmApiKey,
    llmModel,
    llmBaseUrl,
    maxDailyLlmCost,
    llmTimeoutMs,
    webhookPort,
    webhookSecret,
    behaviorRulesPath,
    behaviorRules,
  };
}
