// src/tui/App.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { Select, TextInput } from "@inkjs/ui";
import { ChatPanel } from "./ChatPanel.js";
import { StatusPanel } from "./StatusPanel.js";
import { SecretInput } from "./SecretInput.js";
import { AgentBridge } from "./AgentBridge.js";
import {
  clearAgent,
  loadAgent,
  saveAgent,
} from "../agent-store.js";
import type { ChatMessage, StatusData, TradeConfirmationDetails, TuiConfig } from "./types.js";
import { randomUUID } from "node:crypto";
import { getSessionBadge } from "./status-view.js";
import {
  persistStrategyAndBuildRestartConfig,
  toTuiConfig,
} from "./session-sync.js";
import { truncateEnd, truncateMiddle } from "./text-layout.js";
import { resolveProviderLabel } from "./utils.js";

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

type AppMode = "chat" | "activity-focus" | "help" | "settings-select" | "settings-edit-select" | "settings-edit-text" | "settings-edit-apikey";

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
  return truncateMiddle(value, head + tail + 3);
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

function KeyHelpRow({
  keys,
  label,
  width,
}: {
  keys: string;
  label: string;
  width: number;
}): React.ReactElement {
  return (
    <Text>
      <Text color="cyan" bold>{keys.padEnd(13)}</Text>
      <Text dimColor>{truncateEnd(label, Math.max(8, width - 13))}</Text>
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
  const outerPadding = 2;
  const mainGap = compactLayout ? 0 : 1;
  const availableWidth = Math.max(18, termWidth - outerPadding);
  const statusWidth = compactLayout ? availableWidth : termWidth >= 148 ? 34 : termWidth >= 124 ? 30 : 28;
  const baseActivityPanelWidth = compactLayout
    ? availableWidth
    : Math.max(40, availableWidth - statusWidth - mainGap);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<StatusData>({
    ...INITIAL_STATUS,
    maxDailyLlmCost: config.maxDailyLlmCost ?? 5,
  });
  const [inputActive, setInputActive] = useState(false);
  const [thinking, setThinking] = useState(false);
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
    details: TradeConfirmationDetails;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const [confirmKey, setConfirmKey] = useState(0);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > 2_000 ? next.slice(-2_000) : next;
    });
  }, []);

  const addSystemMsg = useCallback((text: string) => {
    addMessage({ id: randomUUID(), type: "system", text, timestamp: Date.now() });
  }, [addMessage]);

  const addErrorMsg = useCallback((text: string) => {
    addMessage({ id: randomUUID(), type: "error", text, timestamp: Date.now() });
  }, [addMessage]);

  // Trade confirmation callback
  const confirmTrade = useCallback((details: TradeConfirmationDetails): Promise<boolean> => {
    return new Promise((resolve) => {
      setTradeConfirm({ details, resolve });
      setConfirmKey((k) => k + 1);
    });
  }, []);

  const handleConfirmInput = useCallback((value: string) => {
    const normalized = value.trim().toUpperCase();
    const approved = normalized === "TRADE";
    const rejected = normalized === "N" || normalized === "NO" || normalized === "CANCEL" || normalized === "IPTAL";
    if (!tradeConfirm) return;

    if (approved) {
      addMessage({ id: randomUUID(), type: "trade", text: `Confirmed: ${tradeConfirm.details.preview}`, timestamp: Date.now() });
      tradeConfirm.resolve(true);
      setTradeConfirm(null);
      return;
    }

    if (rejected || normalized.length > 0) {
      addSystemMsg(`Cancelled: ${tradeConfirm.details.preview}`);
      tradeConfirm.resolve(false);
      setTradeConfirm(null);
    }
  }, [tradeConfirm, addMessage, addSystemMsg]);

  // ── Bridge startup ──────────────────────────────────────────────────────

  useEffect(() => {
    const bridge = new AgentBridge(config, { addMessage, setStatus, confirmTrade, setThinking });
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
    if (tradeConfirm) {
      if (key.escape) {
        addSystemMsg(`Cancelled: ${tradeConfirm.details.preview}`);
        tradeConfirm.resolve(false);
        setTradeConfirm(null);
      }
      return;
    }
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
      } else if (mode === "help") {
        setAppMode("chat");
      }
      return;
    }

    if (input === "?" && mode === "chat") {
      setAppMode("help");
      return;
    }
    if (input === "?" && mode === "help") {
      setAppMode("chat");
      return;
    }
    if (input === "f" && key.ctrl && (mode === "chat" || mode === "activity-focus")) {
      setAppMode(mode === "activity-focus" ? "chat" : "activity-focus");
      return;
    }

    // Only handle shortcuts in chat mode — let Select/TextInput handle keys in settings/help
    if (mode !== "chat" && mode !== "activity-focus") return;

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
      addSystemMsg("Returning to the launcher. Run balchemy again to create or select an agent.");
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

  const overlayWidth = availableWidth;
  const overlayContentWidth = Math.max(16, overlayWidth - 4);
  const settingsValueWidth = Math.max(8, overlayContentWidth - 18);
  const settingsOptions = SETTINGS_ITEMS.map((item, i) => {
    const val = settingsValues[item.key] ?? "...";
    const display = truncateMiddle(val, settingsValueWidth);
    return { label: `${item.label.padEnd(16)} ${display}`, value: String(i) };
  });

  const editItem = settingsEditIndex >= 0 ? SETTINGS_ITEMS[settingsEditIndex] : null;
  const editSelectOptions = editItem?.options?.map((o) => ({
    label: o === settingsValues[editItem.key] ? `${o}  \u2713` : o,
    value: o,
  })) ?? [];

  // ── Render ──────────────────────────────────────────────────────────────

  const activityFocus = appMode === "activity-focus";
  const activityPanelWidth = activityFocus ? availableWidth : baseActivityPanelWidth;
  const chatPanelWidth = Math.max(18, activityPanelWidth - 2);
  const inSettings = appMode !== "chat" && appMode !== "activity-focus" && appMode !== "help";
  const helpVisible = appMode === "help";
  const overlayVisible = inSettings || helpVisible || Boolean(tradeConfirm);
  const chatInputActive = inputActive && !tradeConfirm && !inSettings && !helpVisible;
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
  const overlayHeight = overlayVisible ? 7 : 0;
  const mainHeight = Math.max(compactLayout ? 12 : 14, termHeight - (compactLayout ? 10 : 8) - overlayHeight);
  const visibleStatusHeight = activityFocus ? 0 : Math.min(10, Math.max(7, Math.floor(mainHeight * 0.4)));
  const statusPanelHeight = compactLayout ? visibleStatusHeight : mainHeight;
  const activityHeight = activityFocus ? mainHeight : compactLayout ? Math.max(6, mainHeight - statusPanelHeight - 1) : mainHeight;
  const chatViewportRows = Math.max(3, activityHeight - 5);
  const statusBadgeLabel = truncateMiddle(status.status.toUpperCase(), compactLayout ? 16 : 18);
  const compactHeaderLine = truncateMiddle(
    `${providerLabel} / ${headerModel} · LLM ${headerSpend}`,
    overlayContentWidth,
  );
  const shortcutLine = truncateEnd(
    `${compactLayout
      ? "^S settings  ^F focus  ? help  ^L clear  ^Q quit  PgUp/PgDn transcript"
      : "^S settings  ^F activity focus  ? help  ^L clear  ^N new  ^Q quit  PgUp/PgDn transcript"}${overlayVisible ? "  ESC back" : ""}`,
    overlayContentWidth,
  );

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
            <HeaderBadge label={statusBadgeLabel} tone={statusTone} />
            {inSettings && (
              <>
                <Text> </Text>
                <HeaderBadge label="SETTINGS" tone="warning" />
              </>
            )}
            {helpVisible && (
              <>
                <Text> </Text>
                <HeaderBadge label="HELP" tone="warning" />
              </>
            )}
          </Box>
        </Box>
        {compactLayout ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>{compactId(config.publicId, 12, 5)}</Text>
            <Text color="cyan">{compactHeaderLine}</Text>
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
      <Box flexDirection={compactLayout ? "column" : "row"} height={mainHeight} paddingX={1} gap={mainGap}>
        {compactLayout && !activityFocus && <StatusPanel status={status} width={statusWidth} compact={compactLayout} height={statusPanelHeight} />}
        <Box flexDirection="column" width={activityPanelWidth} flexShrink={0} height={activityHeight} borderStyle="round" borderColor="gray" paddingY={0}>
          <Box paddingX={1}>
            <Text color="white" bold>Activity</Text>
            {!compactLayout && <Text dimColor>{activityFocus ? "  focus mode: transcript-only selection" : "  chat, tool traces and live decisions"}</Text>}
          </Box>
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            inputActive={chatInputActive}
            hideInput={overlayVisible}
            pageSize={chatViewportRows}
            inputPlaceholder="Ask, adjust rules, or inspect this session..."
            width={chatPanelWidth}
            thinking={thinking}
          />
        </Box>
        {!compactLayout && !activityFocus && <StatusPanel status={status} width={statusWidth} compact={compactLayout} height={statusPanelHeight} />}
      </Box>

      {/* Help panel — replaces input area when active */}
      {helpVisible && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0} flexDirection="column" marginX={1} width={overlayWidth}>
          <Box marginBottom={0}>
            <Text color="white" bold>Keyboard Help</Text>
            {!compactLayout && <Text dimColor>  cockpit shortcuts and safety controls</Text>}
          </Box>
          <KeyHelpRow keys="Ctrl+S" label="Open session settings for provider, model, limits, slippage and strategy." width={overlayContentWidth} />
          <KeyHelpRow keys="Ctrl+L" label="Clear visible chat activity without changing agent state." width={overlayContentWidth} />
          {!compactLayout && <KeyHelpRow keys="Ctrl+N" label="Return to launcher and choose or create another saved agent." width={overlayContentWidth} />}
          <KeyHelpRow keys="Ctrl+F" label="Toggle Activity focus so mouse selection only covers the transcript panel." width={overlayContentWidth} />
          <KeyHelpRow keys="PgUp/PgDn" label="Scroll the transcript by rendered rows while keeping the prompt clean." width={overlayContentWidth} />
          <KeyHelpRow keys="Esc / ?" label="Close this panel; trade prompts only execute when you type TRADE." width={overlayContentWidth} />
        </Box>
      )}

      {/* Settings panel — replaces input area when active */}
      {appMode === "settings-select" && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1} width={overlayWidth}>
          <Box marginBottom={0}>
            <Text color="white" bold>Session Settings</Text>
            {!compactLayout && <Text dimColor>  provider, limits and strategy controls</Text>}
            {settingsLoading && <Text dimColor>  loading...</Text>}
          </Box>
          <Select options={settingsOptions} onChange={handleSettingSelected} />
          <Text dimColor>{truncateMiddle("Use arrows to move, Enter to edit, Esc to close.", overlayContentWidth)}</Text>
        </Box>
      )}

      {appMode === "settings-edit-select" && editItem && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1} width={overlayWidth}>
          <Text color="white" bold>{editItem.label}</Text>
          <Text dimColor>{truncateMiddle("Select a new value for this setting.", overlayContentWidth)}</Text>
          <Select options={editSelectOptions} onChange={handleSelectValue} />
          <Text dimColor>{truncateMiddle("Use arrows to move, Enter to apply, Esc to go back.", overlayContentWidth)}</Text>
        </Box>
      )}

      {appMode === "settings-edit-text" && editItem && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1} width={overlayWidth}>
          <Text color="white" bold>{editItem.label}</Text>
          <Text dimColor>{truncateMiddle(`Current value  ${settingsValues[editItem.key] ?? "?"}`, overlayContentWidth)}</Text>
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
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0} flexDirection="column" marginX={1} width={overlayWidth}>
          <Text color="white" bold>{truncateMiddle(`API Key for ${pendingProvider}`, overlayContentWidth)}</Text>
          <Text dimColor>{truncateMiddle("Paste the new key below. Esc skips this step.", overlayContentWidth)}</Text>
          <Box>
            <Text color="yellow" bold>Key</Text>
            <Text dimColor>  </Text>
            <SecretInput
              key={settingsInputKey}
              placeholder="paste key; it will stay masked"
              onSubmit={handleApiKeyValue}
            />
          </Box>
        </Box>
      )}

      {/* Trade confirmation overlay */}
      {tradeConfirm && (
        <Box borderStyle="round" borderColor="red" paddingX={1} paddingY={0} flexDirection="column" marginX={1} width={overlayWidth}>
          <Box marginBottom={1}>
            <HeaderBadge label="TRADE CHECK" tone="danger" />
            {!compactLayout && <Text dimColor>  review before live execution</Text>}
          </Box>
          <Text color="white" wrap="wrap">{tradeConfirm.details.preview}</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Agent  {truncateMiddle(config.publicId, 28)}</Text>
            <Text dimColor>Host   {truncateMiddle(config.mcpEndpoint, 42)}</Text>
            <Text dimColor>Scope  MCP call through Balchemy execution guard</Text>
            <Text dimColor>Mode   {config.shadowMode ? "shadow / no live order" : "LIVE / broadcasts if approved"}</Text>
            <Text dimColor>Chain  {tradeConfirm.details.chain}</Text>
            <Text dimColor>Intent {truncateEnd(tradeConfirm.details.intent, 52)}</Text>
            <Text dimColor>Token  {truncateMiddle(tradeConfirm.details.token, 52)}</Text>
            <Text dimColor>Amount {tradeConfirm.details.amount}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow" bold>Approve only if agent, host, chain, token and amount all match your intent.</Text>
            <Text dimColor>Type TRADE to execute through MCP, or anything else to cancel.</Text>
          </Box>
          <Box marginTop={1}>
            <TextInput
              key={confirmKey}
              placeholder="TRADE or cancel"
              onSubmit={handleConfirmInput}
            />
          </Box>
        </Box>
      )}

      {/* Bottom shortcut bar */}
      <Box paddingX={1} marginTop={1}>
        <Box borderStyle="round" borderColor="gray" paddingX={1} width={overlayWidth}>
          <Text dimColor>{shortcutLine}</Text>
        </Box>
      </Box>
    </Box>
  );
}
