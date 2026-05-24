// src/tui/Wizard.tsx — Ink-based onboarding wizard (replaces readline wizard)
import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { Select, TextInput } from "@inkjs/ui";
import { SecretInput } from "./SecretInput.js";
import { saveAgent } from "../agent-store.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { truncateEnd } from "./text-layout.js";

// ── Provider / Model definitions (shared with old wizard) ────────────────────

interface ProviderDef {
  name: string;
  label: string;
  baseUrl: string;
  sdkProvider: "anthropic" | "openai";
  keyUrl: string;
  models: ModelDef[];
}

interface ModelDef {
  id: string;
  label: string;
  tier: string;
  costHint: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    name: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    sdkProvider: "anthropic",
    keyUrl: "https://www.anthropic.com/api",
    models: [
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", tier: "fast", costHint: "$1/1M in · $5/1M out" },
      { id: "claude-sonnet-4-6-20260217", label: "Claude Sonnet 4.6", tier: "balanced", costHint: "$3/1M in · $15/1M out" },
      { id: "claude-opus-4-6-20260205", label: "Claude Opus 4.6", tier: "powerful", costHint: "$5/1M in · $25/1M out" },
    ],
  },
  {
    name: "openai",
    label: "OpenAI (GPT)",
    baseUrl: "https://api.openai.com/v1",
    sdkProvider: "openai",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-5.4-nano", label: "GPT-5.4 Nano", tier: "fast", costHint: "$0.10/1M in · $0.40/1M out" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", tier: "fast", costHint: "$0.30/1M in · $1.20/1M out" },
      { id: "gpt-5.4", label: "GPT-5.4", tier: "balanced", costHint: "$2.50/1M in · $10/1M out" },
      { id: "o4-mini", label: "o4-mini (reasoning)", tier: "powerful", costHint: "$1.10/1M in · $4.40/1M out" },
    ],
  },
  {
    name: "gemini",
    label: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    sdkProvider: "openai",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", tier: "fast", costHint: "$0.02/1M in · $0.10/1M out" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "fast", costHint: "$0.15/1M in · $0.60/1M out" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", tier: "balanced", costHint: "$1.25/1M in · $10/1M out" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "powerful", costHint: "$1.25/1M in · $10/1M out" },
    ],
  },
  {
    name: "grok",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    sdkProvider: "openai",
    keyUrl: "https://x.ai/api",
    models: [
      { id: "grok-4.1-fast", label: "Grok 4.1 Fast", tier: "fast", costHint: "$0.20/1M in · $0.50/1M out" },
      { id: "grok-4", label: "Grok 4", tier: "balanced", costHint: "$2/1M in · $6/1M out" },
      { id: "grok-4.20", label: "Grok 4.20", tier: "powerful", costHint: "$2/1M in · $6/1M out" },
    ],
  },
  {
    name: "openrouter",
    label: "OpenRouter (multi-provider)",
    baseUrl: "https://openrouter.ai/api/v1",
    sdkProvider: "openai",
    keyUrl: "https://openrouter.ai/keys",
    models: [
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "fast", costHint: "~$0.15/1M in" },
      { id: "x-ai/grok-4.1-fast", label: "Grok 4.1 Fast", tier: "fast", costHint: "~$0.20/1M in" },
      { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini", tier: "fast", costHint: "~$0.30/1M in" },
      { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "balanced", costHint: "~$3/1M in" },
      { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6", tier: "powerful", costHint: "~$5/1M in" },
    ],
  },
];

// ── Walletless onboarding ────────────────────────────────────────────────────

const API_BASE = "https://api.balchemy.ai/api";

interface OnboardingResult {
  apiKey: string;
  endpoint: string;
  publicId: string;
  botId: string;
}

async function walletlessOnboard(agentName: string): Promise<OnboardingResult | null> {
  const initRes = await fetch(`${API_BASE}/public/erc8004/onboarding/walletless/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: agentName }),
  });
  const initData = (await initRes.json()) as { success: boolean; data?: { tempId: string }; error?: unknown };
  if (!initData.success || !initData.data?.tempId) return null;

  const provRes = await fetch(`${API_BASE}/public/erc8004/onboarding/walletless/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempId: initData.data.tempId }),
  });
  const provData = (await provRes.json()) as {
    success: boolean;
    data?: OnboardingResult;
    error?: unknown;
  };
  if (!provData.success || !provData.data) return null;
  return provData.data;
}

// ── API key validation ───────────────────────────────────────────────────────

async function validateApiKey(provider: ProviderDef, apiKey: string): Promise<boolean> {
  try {
    if (provider.sdkProvider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(8_000),
      });
      return res.status !== 401 && res.status !== 403;
    }
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true; // network error — can't validate, continue
  }
}

// ── File generation ──────────────────────────────────────────────────────────

function generateYaml(p: ProviderDef, m: ModelDef, publicId: string, maxCost: number): string {
  const baseUrlLine = p.sdkProvider === "openai" && p.name !== "openai"
    ? `  base_url: "${p.baseUrl}"\n`
    : "";
  return [
    `# Balchemy Agent Configuration`,
    `# Generated by balchemy`,
    `# Agent: ${publicId} | Provider: ${p.label} | Model: ${m.id}`,
    ``,
    `mcp_endpoint: "\${MCP_ENDPOINT}"`,
    `api_key: "\${BALCHEMY_API_KEY}"`,
    ``,
    `llm:`,
    `  provider: ${p.sdkProvider}`,
    `  api_key: "\${LLM_API_KEY}"`,
    `  model: ${m.id}`,
    baseUrlLine ? baseUrlLine.trimEnd() : null,
    `  max_daily_usd: ${maxCost}`,
    `  timeout_ms: 15000`,
    ``,
    `strategy: custom`,
    `shadow_mode: false`,
    ``,
    `behavior_rules:`,
    ``,
  ].filter((l) => l !== null).join("\n");
}

function generateDotEnv(endpoint: string, apiKey: string, llmApiKey: string, publicId: string): string {
  return [
    `# Balchemy Agent — ${publicId}`,
    `# Keep this file private — never commit to git`,
    ``,
    `MCP_ENDPOINT=${endpoint}`,
    `BALCHEMY_API_KEY=${apiKey}`,
    `LLM_API_KEY=${llmApiKey}`,
    ``,
  ].join("\n");
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin"
    ? `open "${url}"`
    : process.platform === "win32"
      ? `start "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function maskValue(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

// ── Step types ───────────────────────────────────────────────────────────────

type FilePlanAction = "create" | "overwrite" | "append" | "skip";

interface FilePlanItem {
  action: FilePlanAction;
  path: string;
  exists: boolean;
  wouldOverwrite: boolean;
  containsSecret: boolean;
}

type WizardStep = "provider" | "apikey" | "model" | "agent" | "agent-name" | "agent-endpoint" | "agent-apikey" | "daily-cost" | "file-review" | "launching" | "done";

interface WizardState {
  provider: ProviderDef | null;
  llmApiKey: string;
  model: ModelDef | null;
  agentType: "new" | "existing" | null;
  agentName: string;
  mcpEndpoint: string;
  balchemyApiKey: string;
  publicId: string;
  maxDailyCost: number;
  keyValid: boolean | null;
  error: string | null;
}

// ── Wizard component ─────────────────────────────────────────────────────────

interface WizardProps {
  outDir: string;
  onComplete: (config: {
    mcpEndpoint: string;
    apiKey: string;
    llmProvider: string;
    llmApiKey: string;
    llmModel: string;
    llmBaseUrl?: string;
    maxDailyLlmCost: number;
    publicId: string;
    strategy: string;
    shadowMode: boolean;
    behaviorRules: Record<string, unknown>;
  }) => void;
}

export function Wizard({ outDir, onComplete }: WizardProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const contentWidth = Math.max(30, Math.min(termWidth - 4, 76));
  const [step, setStep] = useState<WizardStep>("provider");
  const [state, setState] = useState<WizardState>({
    provider: null,
    llmApiKey: "",
    model: null,
    agentType: null,
    agentName: "",
    mcpEndpoint: "",
    balchemyApiKey: "",
    publicId: "",
    maxDailyCost: 5,
    keyValid: null,
    error: null,
  });

  const [inputKey, setInputKey] = useState(0);
  const [pendingLaunch, setPendingLaunch] = useState<{
    mcpEndpoint: string;
    apiKey: string;
    publicId: string;
  } | null>(null);

  // Esc → go back one step
  useInput((_input, key) => {
    if (key.escape) {
      const backMap: Partial<Record<WizardStep, WizardStep>> = {
        apikey: "provider",
        model: "apikey",
        agent: "model",
        "agent-name": "agent",
        "agent-endpoint": "agent",
        "agent-apikey": "agent-endpoint",
        "daily-cost": "agent",
        "file-review": state.agentType === "existing" ? "agent-apikey" : "agent-name",
      };
      const prev = backMap[step];
      if (prev) {
        setStep(prev);
        setState((s) => ({ ...s, error: null }));
        setInputKey((k) => k + 1);
      }
    }
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  // Step header
  const stepNumbers: Record<WizardStep, number> = {
    provider: 1, apikey: 2, model: 3, agent: 4,
    "agent-name": 4, "agent-endpoint": 4, "agent-apikey": 4,
    "daily-cost": 3, "file-review": 4, launching: 4, done: 4,
  };
  const stepLabels: Record<WizardStep, string> = {
    provider: "LLM Provider", apikey: "Authentication", model: "Model Selection",
    agent: "Agent Setup", "agent-name": "Agent Setup", "agent-endpoint": "Agent Setup",
    "agent-apikey": "Agent Setup", "daily-cost": "Model Selection",
    "file-review": "File Review", launching: "Launching", done: "Ready",
  };
  const currentStep = stepNumbers[step];
  const totalSteps = 4;

  // ── Provider step ──────────────────────────────────────────────────────
  const providerOptions = PROVIDERS.map((p) => ({
    label: p.label,
    value: p.name,
  }));

  const handleProviderSelect = useCallback((value: string) => {
    const provider = PROVIDERS.find((p) => p.name === value) ?? PROVIDERS[0];
    setState((s) => ({ ...s, provider, error: null }));
    openBrowser(provider.keyUrl);
    setStep("apikey");
  }, []);

  // ── API key step ───────────────────────────────────────────────────────
  const handleApiKeySubmit = useCallback(async (value: string) => {
    if (!value.trim()) {
      setState((s) => ({ ...s, error: "API key is required." }));
      return;
    }
    const provider = state.provider;
    if (!provider) return;

    setState((s) => ({ ...s, llmApiKey: value.trim(), keyValid: null, error: null }));

    const valid = await validateApiKey(provider, value.trim());
    setState((s) => ({ ...s, llmApiKey: value.trim(), keyValid: valid }));

    if (valid === false) {
      setState((s) => ({ ...s, error: "Key rejected by provider. Check and try again." }));
      setInputKey((k) => k + 1);
      return;
    }

    setStep("model");
  }, [state.provider]);

  // ── Model step ─────────────────────────────────────────────────────────
  const modelOptions = (state.provider?.models ?? []).map((m) => ({
    label: `${m.label}  ${m.tier} — ${m.costHint}`,
    value: m.id,
  }));

  const handleModelSelect = useCallback((value: string) => {
    const model = state.provider?.models.find((m) => m.id === value) ?? state.provider?.models[0] ?? null;
    setState((s) => ({ ...s, model, error: null }));
    setStep("daily-cost");
    setInputKey((k) => k + 1);
  }, [state.provider]);

  // ── Daily cost step ────────────────────────────────────────────────────
  const handleDailyCost = useCallback((value: string) => {
    const num = parseFloat(value.replace("$", "").trim() || "5");
    const cost = Number.isFinite(num) && num > 0 ? num : 5;
    setState((s) => ({ ...s, maxDailyCost: cost, error: null }));
    setStep("agent");
  }, []);

  // ── Agent step ─────────────────────────────────────────────────────────
  const agentOptions = [
    { label: "Create new agent", value: "new" },
    { label: "Connect existing agent", value: "existing" },
  ];

  const handleAgentSelect = useCallback((value: string) => {
    setState((s) => ({ ...s, agentType: value as "new" | "existing", error: null }));
    setInputKey((k) => k + 1);
    if (value === "new") {
      setStep("agent-name");
    } else {
      setStep("agent-endpoint");
    }
  }, []);

  // ── Agent name (new) ──────────────────────────────────────────────────
  const handleAgentName = useCallback(async (value: string) => {
    const name = value.trim() || `agent-${Date.now().toString(36)}`;
    setState((s) => ({ ...s, agentName: name, error: null }));
    setStep("launching");

    const result = await walletlessOnboard(name);
    if (!result) {
      setState((s) => ({ ...s, error: "Onboarding failed. Check network and try again." }));
      setStep("agent-name");
      setInputKey((k) => k + 1);
      return;
    }

    setState((s) => ({
      ...s,
      mcpEndpoint: result.endpoint,
      balchemyApiKey: result.apiKey,
      publicId: result.publicId,
    }));

    setPendingLaunch({ mcpEndpoint: result.endpoint, apiKey: result.apiKey, publicId: result.publicId });
    setStep("file-review");
    setInputKey((k) => k + 1);
  }, []);

  // ── Agent endpoint + key (existing) ───────────────────────────────────
  const handleEndpoint = useCallback((value: string) => {
    const endpoint = value.trim();
    if (!endpoint) {
      setState((s) => ({ ...s, error: "Endpoint is required." }));
      return;
    }
    setState((s) => ({ ...s, mcpEndpoint: endpoint, error: null }));
    setStep("agent-apikey");
    setInputKey((k) => k + 1);
  }, []);

  const handleBalchemyApiKey = useCallback((value: string) => {
    if (!value.trim()) {
      setState((s) => ({ ...s, error: "API key is required." }));
      return;
    }
    const apiKey = value.trim();
    const publicId = state.mcpEndpoint.split("/").filter(Boolean).pop() ?? "unknown";
    setState((s) => ({ ...s, balchemyApiKey: apiKey, publicId, error: null }));
    setPendingLaunch({ mcpEndpoint: state.mcpEndpoint, apiKey, publicId });
    setStep("file-review");
    setInputKey((k) => k + 1);
  }, [state.mcpEndpoint]);

  // ── File review + finalize ─────────────────────────────────────────────
  const buildFilePlan = useCallback((): FilePlanItem[] => {
    const yamlPath = path.join(outDir, "agent.config.yaml");
    const envPath = path.join(outDir, ".env");
    const gitignorePath = path.join(outDir, ".gitignore");
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    return [
      {
        action: fs.existsSync(yamlPath) ? "overwrite" : "create",
        path: yamlPath,
        exists: fs.existsSync(yamlPath),
        wouldOverwrite: fs.existsSync(yamlPath),
        containsSecret: false,
      },
      {
        action: fs.existsSync(envPath) ? "overwrite" : "create",
        path: envPath,
        exists: fs.existsSync(envPath),
        wouldOverwrite: fs.existsSync(envPath),
        containsSecret: true,
      },
      {
        action: gitignore.includes(".env") ? "skip" : (fs.existsSync(gitignorePath) ? "append" : "create"),
        path: gitignorePath,
        exists: fs.existsSync(gitignorePath),
        wouldOverwrite: false,
        containsSecret: false,
      },
    ];
  }, [outDir]);

  const filePlan = buildFilePlan();
  const filePlanHasOverwrites = filePlan.some((item) => item.wouldOverwrite);

  const finalize = useCallback((mcpEndpoint: string, apiKey: string, publicId: string) => {
    const provider = state.provider!;
    const model = state.model!;
    const llmApiKey = state.llmApiKey;
    const maxDailyCost = state.maxDailyCost;

    // Write files
    const yamlContent = generateYaml(provider, model, publicId, maxDailyCost);
    const envContent = generateDotEnv(mcpEndpoint, apiKey, llmApiKey, publicId);
    const yamlPath = path.join(outDir, "agent.config.yaml");
    const envPath = path.join(outDir, ".env");

    fs.writeFileSync(yamlPath, yamlContent, "utf8");
    fs.writeFileSync(envPath, envContent, "utf8");

    // Ensure .gitignore
    const gitignorePath = path.join(outDir, ".gitignore");
    let gitignore = "";
    if (fs.existsSync(gitignorePath)) {
      gitignore = fs.readFileSync(gitignorePath, "utf8");
    }
    if (!gitignore.includes(".env")) {
      fs.appendFileSync(gitignorePath, "\n.env\n");
    }

    // Save to agent store
    const llmBaseUrl = provider.name !== "openai" && provider.name !== "anthropic" ? provider.baseUrl : undefined;
    saveAgent({
      publicId,
      mcpEndpoint,
      apiKey,
      llmProvider: provider.sdkProvider,
      llmApiKey,
      llmModel: model.id,
      llmBaseUrl,
      maxDailyLlmCost: maxDailyCost,
      strategy: "custom",
      shadowMode: false,
      behaviorRules: {},
      wallets: {},
      createdAt: new Date().toISOString(),
    });

    setStep("done");

    // Trigger TUI launch
    setTimeout(() => {
      onComplete({
        mcpEndpoint,
        apiKey,
        llmProvider: provider.sdkProvider,
        llmApiKey,
        llmModel: model.id,
        llmBaseUrl,
        maxDailyLlmCost: maxDailyCost,
        publicId,
        strategy: "custom",
        shadowMode: false,
        behaviorRules: {},
      });
    }, 800);
  }, [state, outDir, onComplete]);

  const handleFileReview = useCallback((value: string) => {
    const normalized = value.trim().toLowerCase();
    const required = filePlanHasOverwrites ? "overwrite" : "write";
    if (normalized !== required || !pendingLaunch) {
      setState((s) => ({ ...s, error: `Type ${required} to continue, or Esc to go back.` }));
      setInputKey((k) => k + 1);
      return;
    }
    setState((s) => ({ ...s, error: null }));
    setStep("launching");
    finalize(pendingLaunch.mcpEndpoint, pendingLaunch.apiKey, pendingLaunch.publicId);
  }, [filePlanHasOverwrites, finalize, pendingLaunch]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text backgroundColor="cyan" color="black" bold> BALCHEMY </Text>
        <Text color="white" bold> Agent Setup</Text>
        <Text dimColor>  Step {currentStep}/{totalSteps} · {stepLabels[step]}</Text>
      </Box>

      {/* Step content */}
      <Box flexDirection="column" marginLeft={1}>
        {step === "provider" && (
          <Box flexDirection="column">
            <Text color="white" bold>Select your LLM provider:</Text>
            <Text dimColor>{truncateEnd("This determines which AI model powers your agent.", contentWidth)}</Text>
            <Box marginTop={1}>
              <Select options={providerOptions} onChange={handleProviderSelect} />
            </Box>
          </Box>
        )}

        {step === "apikey" && state.provider && (
          <Box flexDirection="column">
            <Text color="white" bold>Paste your {state.provider.label} API key:</Text>
            <Text dimColor>{truncateEnd(`Get one at: ${state.provider.keyUrl}`, contentWidth)}</Text>
            <Box marginTop={1}>
              <Text color="cyan" bold>Key  </Text>
              <SecretInput key={inputKey} onSubmit={handleApiKeySubmit} placeholder="Paste API key here..." />
            </Box>
          </Box>
        )}

        {step === "model" && state.provider && (
          <Box flexDirection="column">
            <Text color="white" bold>Select model:</Text>
            <Text dimColor>{truncateEnd("Faster models cost less. Powerful models analyze deeper.", contentWidth)}</Text>
            <Box marginTop={1}>
              <Select options={modelOptions} onChange={handleModelSelect} />
            </Box>
          </Box>
        )}

        {step === "daily-cost" && (
          <Box flexDirection="column">
            <Text color="white" bold>Max daily LLM spend (USD):</Text>
            <Text dimColor>{truncateEnd("Safety cap to prevent runaway API costs.", contentWidth)}</Text>
            <Box marginTop={1}>
              <Text color="cyan" bold>$  </Text>
              <TextInput key={inputKey} placeholder="5" onSubmit={handleDailyCost} />
            </Box>
          </Box>
        )}

        {step === "agent" && (
          <Box flexDirection="column">
            <Text color="white" bold>Agent setup:</Text>
            <Text dimColor>{truncateEnd("Create a new agent or connect to an existing one.", contentWidth)}</Text>
            <Box marginTop={1}>
              <Select options={agentOptions} onChange={handleAgentSelect} />
            </Box>
          </Box>
        )}

        {step === "agent-name" && (
          <Box flexDirection="column">
            <Text color="white" bold>Agent name:</Text>
            <Text dimColor>{truncateEnd("Give your agent a name (or press Enter for default).", contentWidth)}</Text>
            <Box marginTop={1}>
              <Text color="cyan" bold>Name  </Text>
              <TextInput key={inputKey} placeholder={`agent-${Date.now().toString(36)}`} onSubmit={handleAgentName} />
            </Box>
          </Box>
        )}

        {step === "agent-endpoint" && (
          <Box flexDirection="column">
            <Text color="white" bold>MCP endpoint:</Text>
            <Text dimColor>{truncateEnd("Your agent's MCP endpoint URL.", contentWidth)}</Text>
            <Box marginTop={1}>
              <Text color="cyan" bold>URL  </Text>
              <TextInput key={inputKey} placeholder="https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID" onSubmit={handleEndpoint} />
            </Box>
          </Box>
        )}

        {step === "agent-apikey" && (
          <Box flexDirection="column">
            <Text color="white" bold>Balchemy API key:</Text>
            <Text dimColor>{truncateEnd("Your agent's Balchemy API key.", contentWidth)}</Text>
            <Box marginTop={1}>
              <Text color="cyan" bold>Key  </Text>
              <SecretInput key={inputKey} onSubmit={handleBalchemyApiKey} placeholder="Paste Balchemy API key..." />
            </Box>
          </Box>
        )}

        {step === "file-review" && (
          <Box flexDirection="column">
            <Text color="white" bold>Review files before writing:</Text>
            <Text dimColor>{truncateEnd("No private values are shown here; .env will contain local credentials.", contentWidth)}</Text>
            <Box marginTop={1} flexDirection="column">
              {filePlan.map((item) => (
                <Text key={item.path} color={item.wouldOverwrite ? "yellow" : "white"}>
                  {item.action.toUpperCase().padEnd(9)} {truncateEnd(item.path, Math.max(18, contentWidth - 22))}{item.containsSecret ? "  secret" : ""}
                </Text>
              ))}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color="yellow" bold>{filePlanHasOverwrites ? "Existing files will be overwritten." : "Files are ready to create."}</Text>
              <Text dimColor>Type {filePlanHasOverwrites ? "overwrite" : "write"} to continue.</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="cyan" bold>Confirm  </Text>
              <TextInput key={inputKey} placeholder={filePlanHasOverwrites ? "overwrite" : "write"} onSubmit={handleFileReview} />
            </Box>
          </Box>
        )}

        {step === "launching" && (
          <Box flexDirection="column">
            <Text color="cyan">Setting up agent...</Text>
          </Box>
        )}

        {step === "done" && (
          <Box flexDirection="column">
            <Text color="green" bold>Agent configured!</Text>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Agent    {state.publicId}</Text>
              <Text dimColor>Model    {state.model?.label ?? "?"}</Text>
              <Text dimColor>API Key  {maskValue(state.balchemyApiKey, 10, 4)}</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="cyan">Starting live cockpit...</Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* Error display */}
      {state.error && (
        <Box marginTop={1} marginLeft={1}>
          <Text color="red" bold>Error: </Text>
          <Text color="red">{state.error}</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} paddingX={1}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>{truncateEnd("Esc back  ^C quit", contentWidth)}</Text>
        </Box>
      </Box>
    </Box>
  );
}
