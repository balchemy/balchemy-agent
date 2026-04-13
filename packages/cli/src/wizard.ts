/**
 * Balchemy Agent Setup Wizard
 *
 * Full onboarding flow:
 *   1. BCrow welcome + LLM requirement notice
 *   2. LLM provider selection (Anthropic, OpenAI, Gemini, Grok, OpenRouter)
 *   3. API key input
 *   4. Model selection (per-provider model list)
 *   5. New agent or existing agent
 *   6. Walletless onboarding (auto) or MCP endpoint entry
 *   7. MCP setup_agent wizard (wallets, slippage, autonomous strategy)
 *   8. Write agent.config.yaml + .env
 *   9. Offer to start the agent loop
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { loginWithOpenAI } from "./openai-oauth.js";
import { randomUUID } from "crypto";
import { renderLogo } from "./terminal-logo.js";
import { saveAgent } from "./agent-store.js";

// ── Brand Colors ──────────────────────────────────────────────────────────────

const G = "\x1b[38;2;186;115;6m";   // gold
const W = "\x1b[1;37m";              // white bold
const D = "\x1b[38;5;245m";         // dim
const R = "\x1b[0m";                 // reset
const T = "\x1b[38;2;0;172;176m";   // teal

const WELCOME_TEXT = `
  ${G}B${T}alchemy ${W}Agent${R}  ${D}v0.1.0${R}

  ${D}To deploy a fully autonomous trading bot, you must provide${R}
  ${D}your own LLM. Your agent's strategy, every decision, and the${R}
  ${D}entire execution flow are driven by the model you choose.${R}
  ${D}Select the right provider and model for your trading style${R}
  ${D}${G}— everything is in your hands.${R}
`;

// ── Provider Definitions ──────────────────────────────────────────────────────

interface ProviderDef {
  name: string;
  label: string;
  baseUrl: string;
  sdkProvider: "anthropic" | "openai";
  authHeader: string;
  keyUrl: string; // URL to get API key from dashboard
  models: ModelDef[];
  subscriptions?: SubscriptionTier[];
}

interface ModelDef {
  id: string;
  label: string;
  tier: "fast" | "balanced" | "powerful";
  costHint: string;
}

interface SubscriptionTier {
  name: string;
  label: string;
  price: string;
  models: string[]; // model IDs available in this tier
}

const PROVIDERS: ProviderDef[] = [
  {
    name: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    sdkProvider: "anthropic",
    authHeader: "x-api-key",
    keyUrl: "https://console.anthropic.com/settings/keys",
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
    authHeader: "Authorization",
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
    authHeader: "Authorization",
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
    authHeader: "Authorization",
    keyUrl: "https://console.x.ai/",
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
    authHeader: "Authorization",
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

// ── Strategy Definitions ──────────────────────────────────────────────────────

interface StrategyDef {
  name: string;
  label: string;
  description: string;
  naturalLanguageRules: string;
  preset: string;
}

const STRATEGIES: StrategyDef[] = [
  {
    name: "memecoin-sniper",
    label: "Memecoin Sniper",
    description: "Fast entry on new PumpFun launches, quick exits on pump",
    naturalLanguageRules:
      "Act fast on new token launches. Max 5% portfolio per trade. Stop loss at 30%. Take profit at 50% (sell 25%), 100% (sell 25%), 500% (sell 50%). Max 5 concurrent positions. Prioritize highest volume token when multiple signals fire.",
    preset: "memecoin_sniper",
  },
  {
    name: "dca-accumulator",
    label: "DCA Accumulator",
    description: "Dollar-cost average into tokens at regular intervals",
    naturalLanguageRules:
      "Buy fixed amounts at regular intervals. Max 3% portfolio per trade. Stop loss at 20%. Never buy if 24h volume < $50K. Pause on 30% portfolio drawdown.",
    preset: "dca_accumulator",
  },
  {
    name: "swing-trader",
    label: "Swing Trader",
    description: "Hold positions 2-72h, exit on momentum signals",
    naturalLanguageRules:
      "Hold positions 2-72 hours. Max 10% portfolio per trade. Stop loss at 10%. Take profit at 20%. Only enter tokens with > $100K liquidity and verified contracts.",
    preset: "swing_trader",
  },
  {
    name: "custom",
    label: "Custom Strategy",
    description: "Define your own rules in natural language",
    naturalLanguageRules: "",
    preset: "memecoin_sniper",
  },
];

// ── Spinner ───────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["    ", "   ", "  ", " ", "", " ", "  ", "   "];

class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    this.frame = 0;
    process.stdout.write(`  ${T}${SPINNER_FRAMES[0]}${R} ${this.message}`);
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      process.stdout.write(`\r  ${T}${SPINNER_FRAMES[this.frame]}${R} ${this.message}`);
    }, 100);
  }

  succeed(msg?: string): void {
    this.stop();
    process.stdout.write(`\r  ${T}*${R} ${msg ?? this.message}\n`);
  }

  fail(msg?: string): void {
    this.stop();
    process.stdout.write(`\r  \x1b[1;31mx${R} ${msg ?? this.message}\n`);
  }

  private stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

function spin(message: string): Spinner {
  const s = new Spinner(message);
  s.start();
  return s;
}

// ── Readline Helpers ──────────────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string, defaultVal = ""): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultVal ? ` \x1b[38;5;245m[${defaultVal}]\x1b[0m` : "";
    rl.question(`  ${question}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function askSecret(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question}: `, (answer) => {
      resolve(answer.trim());
    });
  });
}

function askNumber(rl: readline.Interface, question: string, defaultVal: number): Promise<number> {
  return ask(rl, question, String(defaultVal)).then((v) => {
    const n = parseFloat(v);
    return isNaN(n) ? defaultVal : n;
  });
}

function printChoices<T extends { label: string }>(items: T[], extraInfo?: (item: T, i: number) => string): void {
  items.forEach((item, i) => {
    const extra = extraInfo ? `  \x1b[38;5;245m${extraInfo(item, i)}\x1b[0m` : "";
    process.stdout.write(`    \x1b[1;37m${i + 1}.\x1b[0m ${item.label}${extra}\n`);
  });
}

async function askChoice<T extends { label: string }>(
  rl: readline.Interface,
  question: string,
  items: T[],
  extraInfo?: (item: T, i: number) => string,
): Promise<T> {
  process.stdout.write(`\n  \x1b[1;36m${question}\x1b[0m\n`);
  printChoices(items, extraInfo);
  const answer = await ask(rl, `Choose [1-${items.length}]`, "1");
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < items.length) return items[idx];
  return items[0];
}

function printStep(step: number, total: number, label: string): void {
  process.stdout.write(`\n  \x1b[1;35m[${step}/${total}]\x1b[0m \x1b[1;37m${label}\x1b[0m\n`);
}

function printSuccess(msg: string): void {
  process.stdout.write(`  \x1b[1;32m✓\x1b[0m ${msg}\n`);
}

function printInfo(msg: string): void {
  process.stdout.write(`  \x1b[38;5;245m${msg}\x1b[0m\n`);
}

function printError(msg: string): void {
  process.stdout.write(`  \x1b[1;31m✗\x1b[0m ${msg}\n`);
}

// ── MCP Call Helper ───────────────────────────────────────────────────────────

async function mcpCall(
  endpoint: string,
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { message: string } }> {
  const nonce = `nonce-${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "x-request-nonce": nonce,
      "x-request-timestamp": timestamp,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    }),
  });

  const raw = await res.text();
  let jsonStr = raw;
  if (raw.includes("\ndata: ")) {
    const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
    jsonStr = dataLine ? dataLine.slice(6) : raw;
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.error) return { error: parsed.error };
    return { result: parsed.result };
  } catch {
    return { error: { message: `Invalid response: ${raw.slice(0, 200)}` } };
  }
}

async function callSetupTool(
  endpoint: string,
  apiKey: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const resp = await mcpCall(endpoint, apiKey, "tools/call", {
    name: "setup_agent",
    arguments: args,
  });

  if (resp.error) {
    printError(resp.error.message);
    return null;
  }

  const content = (resp.result as { content?: Array<{ text?: string }> })?.content;
  const text = content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { reply: text };
  }
}

function extractAddress(toolResult: Record<string, unknown> | null): string {
  if (!toolResult) return "(failed)";
  // Try structured.address first
  const structured = toolResult.structured as Record<string, unknown> | undefined;
  if (structured?.address && typeof structured.address === "string") return structured.address;
  // Try top-level reply text — extract address pattern
  const reply = String(toolResult.reply ?? JSON.stringify(toolResult));
  const solMatch = reply.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (solMatch) return solMatch[1];
  const evmMatch = reply.match(/(0x[a-fA-F0-9]{40})/);
  if (evmMatch) return evmMatch[1];
  return "(check agent status for address)";
}

function extractField(toolResult: Record<string, unknown> | null, field: string): string | null {
  if (!toolResult) return null;
  const structured = toolResult.structured as Record<string, unknown> | undefined;
  if (structured?.[field] != null) return String(structured[field]);
  if (toolResult[field] != null) return String(toolResult[field]);
  const reply = String(toolResult.reply ?? "");
  return reply || null;
}

// ── Walletless Onboarding ─────────────────────────────────────────────────────

const API_BASE = "https://api.balchemy.ai/api";

interface OnboardingResult {
  apiKey: string;
  endpoint: string;
  publicId: string;
  botId: string;
}

async function walletlessOnboard(agentName: string): Promise<OnboardingResult | null> {
  // Step 1: Init
  const initRes = await fetch(`${API_BASE}/public/erc8004/onboarding/walletless/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: agentName }),
  });
  const initData = (await initRes.json()) as { success: boolean; data?: { tempId: string }; error?: unknown };
  if (!initData.success || !initData.data?.tempId) {
    printError(`Onboarding init failed: ${JSON.stringify(initData.error ?? initData)}`);
    return null;
  }

  // Step 2: Provision
  const provRes = await fetch(`${API_BASE}/public/erc8004/onboarding/walletless/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempId: initData.data.tempId }),
  });
  const provData = (await provRes.json()) as {
    success: boolean;
    data?: { apiKey: string; endpoint: string; publicId: string; botId: string };
    error?: unknown;
  };
  if (!provData.success || !provData.data) {
    printError(`Provisioning failed: ${JSON.stringify(provData.error ?? provData)}`);
    return null;
  }

  return provData.data;
}

// ── YAML + .env Generation ────────────────────────────────────────────────────

interface WizardResult {
  provider: ProviderDef;
  model: ModelDef;
  llmApiKey: string;
  mcpEndpoint: string;
  apiKey: string;
  publicId: string;
  strategy: StrategyDef;
  maxDailyLlmCost: number;
  shadowMode: boolean;
}

function generateYaml(r: WizardResult): string {
  const baseUrlLine =
    r.provider.sdkProvider === "openai" && r.provider.name !== "openai"
      ? `  base_url: "${r.provider.baseUrl}"\n`
      : "";

  return [
    `# Balchemy Agent Configuration`,
    `# Generated by create-balchemy-agent`,
    `# Agent: ${r.publicId} | Provider: ${r.provider.label} | Model: ${r.model.id}`,
    ``,
    `mcp_endpoint: "\${MCP_ENDPOINT}"`,
    `api_key: "\${BALCHEMY_API_KEY}"`,
    ``,
    `llm:`,
    `  provider: ${r.provider.sdkProvider}`,
    `  api_key: "\${LLM_API_KEY}"`,
    `  model: ${r.model.id}`,
    baseUrlLine ? baseUrlLine.trimEnd() : null,
    `  max_daily_usd: ${r.maxDailyLlmCost}`,
    `  timeout_ms: 15000`,
    ``,
    `strategy: ${r.strategy.name}`,
    `shadow_mode: ${r.shadowMode}`,
    ``,
    `behavior_rules:`,
    `  version: "1"`,
    `  preset: ${r.strategy.preset}`,
    r.strategy.naturalLanguageRules
      ? `  rules: "${r.strategy.naturalLanguageRules}"`
      : `  # Define your rules here`,
    ``,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function generateDotEnv(r: WizardResult): string {
  return [
    `# Balchemy Agent — ${r.publicId}`,
    `# Keep this file private — never commit to git`,
    ``,
    `MCP_ENDPOINT=${r.mcpEndpoint}`,
    `BALCHEMY_API_KEY=${r.apiKey}`,
    `LLM_API_KEY=${r.llmApiKey}`,
    ``,
  ].join("\n");
}

// ── Main Wizard ───────────────────────────────────────────────────────────────

export async function runWizard(outDir: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write(renderLogo(20));
  process.stdout.write(WELCOME_TEXT);

  const TOTAL_STEPS = 8;

  try {
    // ── Step 1: LLM Provider ──────────────────────────────────────────────
    printStep(1, TOTAL_STEPS, "LLM Provider");

    const provider = await askChoice(
      rl,
      "Select your LLM provider:",
      PROVIDERS,
      (p) => (p.name === "openrouter" ? "(access all models via one key)" : ""),
    );
    printSuccess(`Provider: ${provider.label}`);

    // ── Step 2: Authentication ──────────────────────────────────────────
    printStep(2, TOTAL_STEPS, "Authentication");

    let llmApiKey = "";
    let useOAuth = false;
    let llmBaseUrlOverride: string | undefined;

    // OpenAI is the only provider with official OAuth support for subscriptions
    if (provider.name === "openai") {
      const authChoice = await askChoice(rl, "How do you want to connect?", [
        { label: "ChatGPT Subscription (log in with browser)" },
        { label: "API Key (pay-per-use)" },
      ]);
      useOAuth = authChoice.label.includes("Subscription");
    }

    if (useOAuth) {
      // OpenAI OAuth PKCE flow
      printInfo("Opening browser — log in with your ChatGPT account...\n");
      try {
        const tokens = await loginWithOpenAI();
        llmApiKey = tokens.accessToken;
        // ChatGPT subscription uses the Codex API endpoint
        llmBaseUrlOverride = "https://api.openai.com/v1";
        printSuccess(`Logged in${tokens.accountId ? ` (${tokens.accountId})` : ""}`);

        // Store refresh token for auto-refresh
        const authCachePath = path.join(process.env.HOME ?? "~", ".balchemy", "auth.json");
        const authDir = path.dirname(authCachePath);
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        fs.writeFileSync(authCachePath, JSON.stringify({
          provider: "openai",
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          accountId: tokens.accountId,
        }, null, 2), "utf8");
        printInfo(`Credentials saved to ${authCachePath}`);
      } catch (err: unknown) {
        printError(`OAuth failed: ${err instanceof Error ? err.message : String(err)}`);
        printInfo("Falling back to API key...\n");
        useOAuth = false;
      }
    }

    if (!useOAuth) {
      // API key flow — open browser to key page
      printInfo(`Opening ${provider.label} API key page...`);
      openBrowser(provider.keyUrl);
      printInfo(`${D}${provider.keyUrl}${R}`);
      printInfo("Copy your API key and paste it below.\n");

      llmApiKey = await askSecret(rl, "Paste your API key");
      if (!llmApiKey) {
        printError("API key is required.");
        rl.close();
        process.exit(1);
      }

      // Validate
      const keySpinner = spin("Validating API key...");
      const keyValid = await validateApiKey(provider, llmApiKey);
      if (keyValid) {
        keySpinner.succeed("API key validated");
      } else {
        keySpinner.succeed("Could not validate (continuing anyway)");
      }
    }

    // ── Step 3: Model Selection ───────────────────────────────────────────
    printStep(3, TOTAL_STEPS, "Model Selection");
    printInfo("Faster models cost less but may make simpler decisions.");
    printInfo("Powerful models cost more but analyze deeper.\n");

    const availableModels = provider.models;

    const model = await askChoice(
      rl,
      "Select model:",
      availableModels,
      (m) => `${m.tier} — ${m.costHint}`,
    );
    printSuccess(`Model: ${model.label} (${model.id})`);

    const maxDailyLlmCost = await askNumber(rl, "Max daily LLM spend (USD)", 5);

    // ── Step 4: Agent ─────────────────────────────────────────────────────
    printStep(4, TOTAL_STEPS, "Agent Setup");

    const agentChoice = await askChoice(rl, "Agent:", [
      { label: "Create new agent", value: "new" },
      { label: "Connect existing agent (I have MCP endpoint + API key)", value: "existing" },
    ]);

    let mcpEndpoint: string;
    let apiKey: string;
    let publicId: string;
    let masterKey: string | null = null;
    let solAddr = "";
    let baseAddr = "";

    if ((agentChoice as { value: string }).value === "new") {
      const agentName = await ask(rl, "Agent name", `agent-${Date.now().toString(36)}`);

      const onboardSpinner = spin("Creating agent via walletless onboarding...");
      const onboard = await walletlessOnboard(agentName);
      if (!onboard) {
        onboardSpinner.fail("Onboarding failed. Check your network and try again.");
        rl.close();
        process.exit(1);
      }

      mcpEndpoint = onboard.endpoint;
      apiKey = onboard.apiKey;
      publicId = onboard.publicId;

      onboardSpinner.succeed(`Agent created: ${publicId}`);
      printSuccess(`MCP endpoint: ${mcpEndpoint}`);
      printSuccess(`API key: ${apiKey}`);

      // ── MCP Setup (same flow as MCP onboarding docs) ──────────────────

      // Step A: Bind developer wallet
      process.stdout.write("\n");
      printStep(5, 8, "Developer Wallet");
      printInfo("Your EVM wallet is used for recovery, Hub access, and withdrawals.");
      printInfo("When you connect this wallet to balchemy.ai, you'll see this bot in your Hub dashboard.\n");
      const walletAddr = await ask(rl, "Your EVM wallet address (0x...)");
      if (walletAddr && walletAddr.startsWith("0x") && walletAddr.length === 42) {
        const bindSpinner = spin("Binding developer wallet...");
        const bindResult = await callSetupTool(mcpEndpoint, apiKey, {
          action: "bind_developer_wallet",
          walletAddress: walletAddr,
          walletAddressConfirm: walletAddr,
        });
        if (bindResult) {
          const reply = String(bindResult.reply ?? "");
          const masterKeyMatch = reply.match(/balc_mk_[A-Za-z0-9_-]+/);
          bindSpinner.succeed("Developer wallet bound");
          if (masterKeyMatch) {
            masterKey = masterKeyMatch[0];
            printSuccess(`Master key: ${masterKey}`);
            printInfo("\x1b[1;33mSave this master key! It cannot be shown again.\x1b[0m");
            printInfo("Use it for: key rotation, wallet changes, bot deletion, recovery.\n");
          }
        } else {
          bindSpinner.fail("Could not bind wallet (you can do this later via chat)");
        }
      } else {
        printInfo("Skipped — you can bind a wallet later via chat.");
      }

      // Step B: Create trading wallets
      printStep(6, 8, "Trading Wallets");
      const solSpinner = spin("Creating Solana wallet...");
      const solResult = await callSetupTool(mcpEndpoint, apiKey, {
        action: "create_wallet",
        chain: "solana",
      });
      solAddr = extractAddress(solResult);
      solSpinner.succeed(`Solana wallet: ${solAddr}`);

      const baseSpinner = spin("Creating Base wallet...");
      const baseResult = await callSetupTool(mcpEndpoint, apiKey, {
        action: "create_wallet",
        chain: "base",
      });
      baseAddr = extractAddress(baseResult);
      baseSpinner.succeed(`Base wallet: ${baseAddr}`);

      printInfo(`\n\x1b[1;33mFund your Solana wallet (${solAddr}) with at least 0.05 SOL to start trading.\x1b[0m\n`);

      // Step C: Configure slippage
      printStep(7, 8, "Slippage");
      printInfo("Default: 200bps (2%). Memecoin trading usually needs 300-500bps (3-5%).");
      const slippageInput = await askNumber(rl, "Slippage in basis points", 300);
      const slipSpinner = spin("Configuring slippage...");
      await callSetupTool(mcpEndpoint, apiKey, {
        action: "configure_slippage",
        slippageBps: slippageInput,
      });
      slipSpinner.succeed(`Slippage: ${slippageInput}bps (${(slippageInput / 100).toFixed(1)}%)`);

      // Step D: Trading strategy (natural language)
      printStep(8, 8, "Trading Strategy");
      printInfo("Describe your strategy in natural language. Your LLM will execute it.");
      printInfo('Example: "PumpFun\'dan yeni tokenleri tara, hacmi 10K+ olanlari al,');
      printInfo(' max 0.01 SOL per trade, 2x\'de yarisini sat, max 1 pozisyon"\n');
      const strategyRules = await ask(
        rl,
        "Your strategy",
        "Max 0.01 SOL per trade, stop loss 30%, take profit 100%, max 1 position",
      );

      const stratSpinner = spin("Configuring autonomous mode (LIVE)...");
      await callSetupTool(mcpEndpoint, apiKey, {
        action: "configure_autonomous",
        preset: "memecoin_sniper",
        shadowMode: false,
        naturalLanguageRules: strategyRules,
      });
      stratSpinner.succeed("Strategy configured (LIVE mode)");
    } else {
      mcpEndpoint = await ask(rl, "MCP endpoint", "https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID");
      apiKey = await askSecret(rl, "Balchemy API key");
      publicId = mcpEndpoint.split("/").filter(Boolean).pop() ?? "unknown";

      if (!apiKey) {
        printError("API key is required.");
        rl.close();
        process.exit(1);
      }

      // Verify connection
      const healthSpinner = spin("Verifying MCP connection...");
      try {
        const healthRes = await fetch(`${mcpEndpoint}/health`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const health = (await healthRes.json()) as { ok?: boolean };
        if (health.ok) {
          healthSpinner.succeed("MCP connected");
        } else {
          healthSpinner.succeed("Unexpected response (continuing)");
        }
      } catch {
        healthSpinner.succeed("Could not reach endpoint (continuing)");
      }
    }

    const strategy = STRATEGIES[0];
    const shadowMode = false;

    // ── Save & Launch ─────────────────────────────────────────────────────
    process.stdout.write("\n");

    const wizardResult: WizardResult = {
      provider,
      model,
      llmApiKey,
      mcpEndpoint,
      apiKey,
      publicId,
      strategy,
      maxDailyLlmCost,
      shadowMode,
    };

    const yamlContent = generateYaml(wizardResult);
    const envContent = generateDotEnv(wizardResult);

    const yamlPath = path.join(outDir, "agent.config.yaml");
    const envPath = path.join(outDir, ".env");

    fs.writeFileSync(yamlPath, yamlContent, "utf8");
    fs.writeFileSync(envPath, envContent, "utf8");

    // .gitignore
    const gitignorePath = path.join(outDir, ".gitignore");
    let gitignore = "";
    if (fs.existsSync(gitignorePath)) {
      gitignore = fs.readFileSync(gitignorePath, "utf8");
    }
    if (!gitignore.includes(".env")) {
      fs.appendFileSync(gitignorePath, "\n.env\n");
    }

    printSuccess(`Config saved: ${yamlPath}`);
    printSuccess(`Secrets saved: ${envPath}`);

    // Save agent credentials for resume
    saveAgent({
      publicId,
      mcpEndpoint,
      apiKey,
      masterKey: masterKey ?? undefined,
      llmProvider: provider.sdkProvider,
      llmApiKey,
      llmModel: model.id,
      llmBaseUrl: provider.name !== "openai" && provider.name !== "anthropic" ? provider.baseUrl : undefined,
      maxDailyLlmCost,
      strategy: strategy.name,
      shadowMode,
      wallets: { solana: solAddr, base: baseAddr },
      createdAt: new Date().toISOString(),
    });
    printSuccess(`Agent cached to ~/.balchemy/agent.json`);

    // ── Done ──────────────────────────────────────────────────────────────

    process.stdout.write(`
  \x1b[1;32m━━━ Setup Complete ━━━\x1b[0m

  Agent:    ${publicId}
  Provider: ${provider.label}
  Model:    ${model.label}
  Mode:     LIVE

  Starting agent...

`);

    // Auto-start TUI — no extra step needed
    {
      rl.close();
      const { startTui } = await import("./tui/start.js");
      await startTui({
        mcpEndpoint,
        apiKey,
        llmProvider: provider.sdkProvider,
        llmApiKey,
        llmModel: model.id,
        llmBaseUrl: provider.name !== "openai" && provider.name !== "anthropic" ? provider.baseUrl : llmBaseUrlOverride,
        maxDailyLlmCost,
        publicId,
        strategy: strategy.name,
        shadowMode,
      });
    }
  } finally {
    rl.close();
  }
}

// ── Browser Helper ────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin"
    ? `open "${url}"`
    : process.platform === "win32"
      ? `start "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore errors — non-critical */ });
}

// ── API Key Validation ────────────────────────────────────────────────────────

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
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // 200 = valid, 401 = invalid, anything else = network issue
      return res.status !== 401;
    }

    // OpenAI-compatible providers
    const url = `${provider.baseUrl}/models`;
    const res = await fetch(url.endsWith("/models") ? url : `${url}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.status !== 401;
  } catch {
    return false; // Network error, don't block
  }
}
