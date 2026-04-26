// src/tui/App.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { Select, TextInput } from "@inkjs/ui";
import { ChatPanel } from "./ChatPanel.js";
import { StatusPanel } from "./StatusPanel.js";
import { AgentBridge } from "./AgentBridge.js";
import {
  clearAgent,
  loadAgent,
  saveAgent,
} from "../agent-store.js";
import type { ChatMessage, StatusData, TuiConfig } from "./types.js";
import { randomUUID } from "node:crypto";
import { getSessionBadge } from "./status-view.js";
import {
  persistStrategyAndBuildRestartConfig,
  toTuiConfig,
} from "./session-sync.js";

// ── Constants ────────────────────────────────────────────────────────────────

const INITIAL_STATUS: StatusData = {
  balanceSol: 0,
  balanceUsd: 0,
  wallets: [],
  activeTrades: [],
  eventsReceived: 0,
  decisionsExecuted: 0,
  tradesExecuted: 0,
  llmCostToday: 0,
  maxDailyLlmCost: 5,
  uptime: 0,
  sseConnected: false,
  status: "starting",
};

// ── Settings definitions ─────────────────────────────────────────────────────

type AppMode = "chat" | "settings-select" | "settings-edit-select" | "settings-edit-text" | "settings-edit-apikey";

interface SettingItem {
  key: string;
  label: string;
  source: "local" | "remote";
  type: "select" | "text";
  options?: string[];
}

const SETTINGS_ITEMS: SettingItem[] = [
  { key: "provider", label: "LLM Provider", source: "local", type: "select", options: ["anthropic", "openai", "gemini", "grok", "openrouter"] },
  { key: "model", label: "LLM Model", source: "local", type: "text" },
  { key: "maxDailyCost", label: "Max Daily $", source: "local", type: "text" },
  { key: "slippage", label: "Slippage (bps)", source: "remote", type: "text" },
  { key: "strategy", label: "Strategy", source: "remote", type: "text" },
];

type BadgeTone = "brand" | "live" | "warning" | "danger";

function compactId(value: string, head = 10, tail = 5): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function resolveProviderLabel(provider: string, baseUrl?: string): string {
  if (provider === "anthropic") return "anthropic";
  if (baseUrl?.includes("generativelanguage.googleapis.com")) return "gemini";
  if (baseUrl?.includes("api.x.ai")) return "grok";
  if (baseUrl?.includes("openrouter.ai")) return "openrouter";
  return "openai";
}

function HeaderBadge({
  label,
  tone,
}: {
  label: string;
  tone: BadgeTone;
}): React.ReactElement {
  const styles: Record<BadgeTone, { backgroundColor: "cyan" | "green" | "yellow" | "red"; color: "black" | "white" }> = {
    brand: { backgroundColor: "cyan", color: "black" },
    live: { backgroundColor: "green", color: "black" },
    warning: { backgroundColor: "yellow", color: "black" },
    danger: { backgroundColor: "red", color: "white" },
  };
  const style = styles[tone];

  return (
    <Text backgroundColor={style.backgroundColor} color={style.color} bold>
      {" "}
      {label}
      {" "}
    </Text>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

interface AppProps {
  config: TuiConfig;
}

export function App({ config }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;
  const compactLayout = termWidth < 110;
  const statusWidth = termWidth >= 148 ? 34 : termWidth >= 124 ? 30 : 28;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<StatusData>({
    ...INITIAL_STATUS,
    maxDailyLlmCost: config.maxDailyLlmCost ?? 5,
  });
  const [inputActive, setInputActive] = useState(false);
  const bridgeRef = useRef<AgentBridge | null>(null);

  // Settings state
  const [appMode, setAppMode] = useState<AppMode>("chat");
  const appModeRef = useRef<AppMode>("chat");
  const [settingsEditIndex, setSettingsEditIndex] = useState(-1);
  const [settingsValues, setSettingsValues] = useState<Record<string, string>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsInputKey, setSettingsInputKey] = useState(0);

  useEffect(() => { appModeRef.current = appMode; }, [appMode]);

  // Trade confirmation state
  const [tradeConfirm, setTradeConfirm] = useState<{
    preview: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const [confirmKey, setConfirmKey] = useState(0);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const addSystemMsg = useCallback((text: string) => {
    addMessage({ id: randomUUID(), type: "system", text, timestamp: Date.now() });
  }, [addMessage]);

  const addErrorMsg = useCallback((text: string) => {
    addMessage({ id: randomUUID(), type: "error", text, timestamp: Date.now() });
  }, [addMessage]);

  // Trade confirmation callback
  const confirmTrade = useCallback((preview: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setTradeConfirm({ preview, resolve });
      setConfirmKey((k) => k + 1);
    });
  }, []);

  const handleConfirmInput = useCallback((value: string) => {
    const yes = value.toLowerCase() === "y" || value.toLowerCase() === "yes";
    if (tradeConfirm) {
      if (yes) {
        addMessage({ id: randomUUID(), type: "trade", text: `Confirmed: ${tradeConfirm.preview}`, timestamp: Date.now() });
      } else {
        addSystemMsg(`Cancelled: ${tradeConfirm.preview}`);
      }
      tradeConfirm.resolve(yes);
      setTradeConfirm(null);
    }
  }, [tradeConfirm, addMessage, addSystemMsg]);

  // ── Bridge startup ──────────────────────────────────────────────────────

  useEffect(() => {
    const bridge = new AgentBridge(config, { addMessage, setStatus, confirmTrade });
    bridgeRef.current = bridge;

    bridge.start().then(() => {
      setInputActive(true);
    }).catch((err: unknown) => {
      addMessage({
        id: "boot-error",
        type: "error",
        text: `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    });

    const balanceInterval = setInterval(() => {
      bridge.refreshBalance().catch(() => {});
    }, 60_000);

    // Background update checker — every 10 minutes
    return () => {
      clearInterval(balanceInterval);
      bridge.stop().catch(() => {});
    };
  }, [config, addMessage, confirmTrade]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────

  useInput((input, key) => {
    if (tradeConfirm) return;
    if (key.backspace || key.delete) return;

    const mode = appModeRef.current;

    // Escape — step back: edit→select→chat
    if (key.escape) {
      if (mode === "settings-edit-select" || mode === "settings-edit-text" || mode === "settings-edit-apikey") {
        setAppMode("settings-select");
        setSettingsEditIndex(-1);
        setPendingProvider(null);
      } else if (mode === "settings-select") {
        setAppMode("chat");
        addSystemMsg("Settings closed.");
      }
      return;
    }

    // Only handle shortcuts in chat mode — let Select/TextInput handle keys in settings
    if (mode !== "chat") return;

    if (input === "s" && key.ctrl) {
      void openSettings();
      return;
    }
    if (input === "l" && key.ctrl) {
      setMessages([]);
      addSystemMsg("Chat cleared.");
      return;
    }
    if (input === "n" && key.ctrl) {
      addSystemMsg("Creating new agent...");
      clearAgent();
      void bridgeRef.current?.stop().finally(() => exit());
      return;
    }
    if (input === "q" && key.ctrl) {
      addSystemMsg("Shutting down...");
      const timer = setTimeout(() => exit(), 3000); // Timeout fallback
      void bridgeRef.current?.stop().finally(() => { clearTimeout(timer); exit(); });
      return;
    }
  });

  // ── Settings logic ──────────────────────────────────────────────────────

  const openSettings = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;

    setSettingsLoading(true);
    setAppMode("settings-select");

    // Start with local values
    const local = bridge.getLocalConfig();
    const values: Record<string, string> = {
      provider: local.provider,
      model: local.model,
      maxDailyCost: `$${local.maxDailyCost.toFixed(2)}`,
      slippage: "...",
      strategy: "...",
    };

    // Fetch remote
    const remote = await bridge.fetchRemoteSettings();
    values.slippage = remote.slippageBps !== undefined ? `${remote.slippageBps}` : "not set";
    values.strategy = remote.strategy ?? "not configured";

    setSettingsValues(values);
    setSettingsLoading(false);
  }, []);

  // Settings item selected (from Select component)
  const handleSettingSelected = useCallback((value: string) => {
    const idx = parseInt(value, 10);
    const item = SETTINGS_ITEMS[idx];
    if (!item) return;

    setSettingsEditIndex(idx);
    if (item.type === "select") {
      setAppMode("settings-edit-select");
    } else {
      setSettingsInputKey((k) => k + 1);
      setAppMode("settings-edit-text");
    }
  }, []);

  // Provider/select value chosen — if provider, also ask for API key
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);

  const handleSelectValue = useCallback((value: string) => {
    const item = SETTINGS_ITEMS[settingsEditIndex];
    if (item?.key === "provider") {
      // Save provider + base URL, then ask for API key
      const agent = loadAgent();
      if (agent) {
        agent.llmProvider = value === "anthropic" ? "anthropic" : "openai";
        // Set correct base URL for the provider
        const BASE_URLS: Record<string, string | undefined> = {
          openai: undefined, // default
          anthropic: undefined, // handled by Anthropic SDK
          gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
          grok: "https://api.x.ai/v1",
          openrouter: "https://openrouter.ai/api/v1",
        };
        agent.llmBaseUrl = BASE_URLS[value];
        saveAgent(agent);
      }
      const vals = { ...settingsValues, provider: value };
      setSettingsValues(vals);
      setPendingProvider(value);
      setSettingsInputKey((k) => k + 1);
      setAppMode("settings-edit-apikey");
      addSystemMsg(`Provider \u2192 ${value}. Now enter your API key.`);
      return;
    }
    void saveSettingValue(settingsEditIndex, value);
  }, [settingsEditIndex, settingsValues, addSystemMsg]);

  // Text value submitted
  const handleTextValue = useCallback((value: string) => {
    if (!value.trim()) {
      setAppMode("settings-select");
      setSettingsEditIndex(-1);
      return;
    }
    void saveSettingValue(settingsEditIndex, value.trim());
  }, [settingsEditIndex]);

  // API key submitted (after provider change)
  const handleApiKeyValue = useCallback((value: string) => {
    if (!value.trim()) {
      setAppMode("settings-select");
      setSettingsEditIndex(-1);
      setPendingProvider(null);
      return;
    }
    const agent = loadAgent();
    if (agent) {
      agent.llmApiKey = value.trim();
      saveAgent(agent);
      addSystemMsg(`API key saved for ${pendingProvider}. Reconnecting...`);
      const updated = loadAgent();
      const bridge = bridgeRef.current;
      if (updated && bridge) {
        void bridge.restart(
          toTuiConfig(updated, config.autoSeedSubscriptions ?? false)
        ).then(() => addSystemMsg("Reconnected with new provider."))
          .catch(() => addErrorMsg("Reconnect failed. Restart CLI manually."));
      }
    }
    setPendingProvider(null);
    setAppMode("settings-select");
    setSettingsEditIndex(-1);
  }, [pendingProvider, addSystemMsg]);

  const saveSettingValue = useCallback(async (index: number, value: string) => {
    const item = SETTINGS_ITEMS[index];
    if (!item) return;

    const bridge = bridgeRef.current;
    const vals = { ...settingsValues };

    if (item.source === "local") {
      const agent = loadAgent();
      if (!agent) {
        addErrorMsg("No agent found in store.");
        setAppMode("settings-select");
        setSettingsEditIndex(-1);
        return;
      }

      switch (item.key) {
        case "provider":
          agent.llmProvider = value;
          vals.provider = value;
          break;
        case "model":
          agent.llmModel = value;
          vals.model = value;
          break;
        case "maxDailyCost": {
          const num = parseFloat(value.replace("$", ""));
          if (isNaN(num) || num <= 0) {
            addErrorMsg("Enter a positive number.");
            return;
          }
          agent.maxDailyLlmCost = num;
          vals.maxDailyCost = `$${num.toFixed(2)}`;
          break;
        }
      }
      saveAgent(agent);
      addSystemMsg(`${item.label} \u2192 ${value}. Reconnecting...`);
      // Hot-reload: restart bridge with new config from disk
      const updated = loadAgent();
      if (updated && bridge) {
        void bridge.restart(
          toTuiConfig(updated, config.autoSeedSubscriptions ?? false)
        ).then(() => addSystemMsg("Reconnected with new settings."))
          .catch(() => addErrorMsg("Reconnect failed. Restart CLI manually."));
      }
    } else if (item.source === "remote" && bridge) {
      if (item.key === "slippage") {
        const bps = parseInt(value, 10);
        if (isNaN(bps) || bps < 10 || bps > 500) {
          addErrorMsg("Slippage must be 10-500 bps.");
          return;
        }
        const ok = await bridge.updateSlippage(bps);
        if (ok) {
          vals.slippage = `${bps}`;
          addSystemMsg(`Slippage \u2192 ${bps} bps.`);
        } else {
          addErrorMsg("Failed to update slippage.");
        }
      } else if (item.key === "strategy") {
        const ok = await bridge.updateStrategy(value);
        if (ok) {
          const agent = loadAgent();
          if (agent) {
            const synced = persistStrategyAndBuildRestartConfig({
              agent,
              strategy: value,
              saveAgent,
              autoSeedSubscriptions: config.autoSeedSubscriptions ?? false,
            });
            void bridge.restart(synced.restartConfig)
              .then(() => addSystemMsg("Reconnected with updated strategy."))
              .catch(() => addErrorMsg("Reconnect failed. Restart CLI manually."));
            addSystemMsg("Strategy updated. Reconnecting...");
          } else {
            addSystemMsg("Strategy updated.");
          }
          vals.strategy = value;
        } else {
          addErrorMsg("Failed to update strategy.");
        }
      }
    }

    setSettingsValues(vals);
    setAppMode("settings-select");
    setSettingsEditIndex(-1);
  }, [settingsValues, addSystemMsg, addErrorMsg]);

  // ── Chat input handler ──────────────────────────────────────────────────

  const handleSend = useCallback(async (text: string) => {
    if (bridgeRef.current) {
      await bridgeRef.current.sendUserMessage(text);
    } else {
      addSystemMsg("Agent not ready yet.");
    }
  }, [addSystemMsg]);

  // ── Settings panel options ──────────────────────────────────────────────

  const settingsOptions = SETTINGS_ITEMS.map((item, i) => {
    const val = settingsValues[item.key] ?? "...";
    const display = val.length > 30 ? val.slice(0, 27) + "..." : val;
    return { label: `${item.label.padEnd(16)} ${display}`, value: String(i) };
  });

  const editItem = settingsEditIndex >= 0 ? SETTINGS_ITEMS[settingsEditIndex] : null;
  const editSelectOptions = editItem?.options?.map((o) => ({
    label: o === settingsValues[editItem.key] ? `${o}  \u2713` : o,
    value: o,
  })) ?? [];

  // ── Render ──────────────────────────────────────────────────────────────

  const inSettings = appMode !== "chat";
  const chatInputActive = inputActive && !tradeConfirm && !inSettings;
  const providerLabel = status.provider ?? resolveProviderLabel(config.llmProvider, config.llmBaseUrl);
  const headerModel = status.model ?? config.llmModel ?? "default";
  const headerSpend = `$${status.llmCostToday.toFixed(2)} / $${status.maxDailyLlmCost.toFixed(2)}`;
  const sessionBadge = getSessionBadge(status);
  const sessionTone: BadgeTone = sessionBadge.tone;
  const statusTone: BadgeTone = status.status.includes("error")
    ? "danger"
    : status.status === "chat-ready"
      ? "brand"
      : status.sseConnected
      ? "live"
      : "warning";
  const overlayHeight = inSettings || tradeConfirm ? 7 : 0;
  const mainHeight = Math.max(compactLayout ? 12 : 14, termHeight - (compactLayout ? 10 : 8) - overlayHeight);
  const statusPanelHeight = compactLayout ? Math.min(10, Math.max(7, Math.floor(mainHeight * 0.4))) : mainHeight;
  const activityHeight = compactLayout ? Math.max(6, mainHeight - statusPanelHeight - 1) : mainHeight;
  const chatPageSize = Math.max(3, activityHeight - 5);

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box paddingX={1} paddingY={0} flexDirection="column">
        <Box flexDirection={compactLayout ? "column" : "row"}>
          <Box>
            <HeaderBadge label="BALCHEMY" tone="brand" />
            <Text color="white" bold> Agent Cockpit</Text>
          </Box>
          {!compactLayout && <Box flexGrow={1} />}
          <Box marginTop={compactLayout ? 1 : 0}>
            <HeaderBadge label={sessionBadge.label} tone={sessionTone} />
            <Text> </Text>
            <HeaderBadge label={status.status.toUpperCase()} tone={statusTone} />
            {inSettings && (
              <>
                <Text> </Text>
                <HeaderBadge label="SETTINGS" tone="warning" />
              </>
            )}
          </Box>
        </Box>
        {compactLayout ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>{compactId(config.publicId, 12, 5)}</Text>
            <Box>
              <Text color="cyan">{providerLabel}</Text>
              <Text dimColor> / </Text>
              <Text color="white">{compactId(headerModel, 18, 6)}</Text>
              <Text dimColor>  ·  LLM </Text>
              <Text color="white">{headerSpend}</Text>
            </Box>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text dimColor>{compactId(config.publicId, 12, 5)}</Text>
            <Text dimColor>  ·  </Text>
            <Text color="cyan">{providerLabel}</Text>
            <Text dimColor> / </Text>
            <Text color="white">{compactId(headerModel, 18, 6)}</Text>
            <Text dimColor>  ·  LLM </Text>
            <Text color="white">{headerSpend}</Text>
          </Box>
        )}
      </Box>

      {/* Main content */}
      <Box flexDirection={compactLayout ? "column" : "row"} height={mainHeight} paddingX={1} gap={1}>
        <Box flexDirection="column" flexGrow={compactLayout ? 0 : 1} height={activityHeight} borderStyle="round" borderColor="gray" paddingY={0}>
          <Box paddingX={1}>
            <Text color="white" bold>Activity</Text>
            <Text dimColor>  chat, tool traces and live decisions</Text>
          </Box>
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            inputActive={chatInputActive}
            hideInput={inSettings || Boolean(tradeConfirm)}
            pageSize={chatPageSize}
            inputPlaceholder="Ask, adjust rules, or inspect this session..."
          />
        </Box>
        <StatusPanel status={status} width={statusWidth} compact={compactLayout} height={statusPanelHeight} />
      </Box>

      {/* Settings panel — replaces input area when active */}
      {appMode === "settings-select" && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1}>
          <Box marginBottom={0}>
            <Text color="white" bold>Session Settings</Text>
            <Text dimColor>  provider, limits and strategy controls</Text>
            {settingsLoading && <Text dimColor>  loading...</Text>}
          </Box>
          <Select options={settingsOptions} onChange={handleSettingSelected} />
          <Text dimColor>Use arrows to move, Enter to edit, Esc to close.</Text>
        </Box>
      )}

      {appMode === "settings-edit-select" && editItem && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1}>
          <Text color="white" bold>{editItem.label}</Text>
          <Text dimColor>Select a new value for this setting.</Text>
          <Select options={editSelectOptions} onChange={handleSelectValue} />
          <Text dimColor>Use arrows to move, Enter to apply, Esc to go back.</Text>
        </Box>
      )}

      {appMode === "settings-edit-text" && editItem && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1}>
          <Text color="white" bold>{editItem.label}</Text>
          <Text dimColor>Current value  {settingsValues[editItem.key] ?? "?"}</Text>
          <Box>
            <Text color="yellow" bold>New</Text>
            <Text dimColor>  </Text>
            <TextInput
              key={settingsInputKey}
              placeholder="Enter new value..."
              onSubmit={handleTextValue}
            />
          </Box>
        </Box>
      )}

      {appMode === "settings-edit-apikey" && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1}>
          <Text color="white" bold>API Key for {pendingProvider}</Text>
          <Text dimColor>Paste the new key below. Esc skips this step.</Text>
          <Box>
            <Text color="yellow" bold>Key</Text>
            <Text dimColor>  </Text>
            <TextInput
              key={settingsInputKey}
              placeholder="sk-... or key-..."
              onSubmit={handleApiKeyValue}
            />
          </Box>
        </Box>
      )}

      {/* Trade confirmation overlay */}
      {tradeConfirm && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1}>
          <Box marginBottom={1}>
            <HeaderBadge label="TRADE CHECK" tone="warning" />
            <Text dimColor>  review before live execution</Text>
          </Box>
          <Text color="white" wrap="wrap">{tradeConfirm.preview}</Text>
          <Box marginTop={1}>
            <Text color="yellow" bold>Approve</Text>
            <Text dimColor>  type y or n</Text>
          </Box>
          <Box marginTop={1}>
            <TextInput
              key={confirmKey}
              placeholder="y or n"
              onSubmit={handleConfirmInput}
            />
          </Box>
        </Box>
      )}

      {/* Bottom shortcut bar */}
      <Box paddingX={1} marginTop={1}>
        <Box borderStyle="round" borderColor="gray" paddingX={1} flexGrow={1}>
          <Text dimColor>Commands  </Text>
          <Text color="cyan" bold>^S</Text>
          <Text dimColor> settings  </Text>
          <Text color="cyan" bold>^L</Text>
          <Text dimColor> clear  </Text>
          <Text color="cyan" bold>^N</Text>
          <Text dimColor> new  </Text>
          <Text color="cyan" bold>^Q</Text>
          <Text dimColor> quit</Text>
          {inSettings && (
            <>
              <Text dimColor>  </Text>
              <Text color="yellow" bold>ESC</Text>
              <Text dimColor> back</Text>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}
