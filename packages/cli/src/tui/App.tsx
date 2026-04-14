// src/tui/App.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Select, TextInput } from "@inkjs/ui";
import { ChatPanel } from "./ChatPanel.js";
import { StatusPanel } from "./StatusPanel.js";
import { AgentBridge } from "./AgentBridge.js";
import { clearAgent, loadAgent, saveAgent } from "../agent-store.js";
import type { ChatMessage, StatusData, TuiConfig } from "./types.js";
import { randomUUID } from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────────────

const INITIAL_STATUS: StatusData = {
  balanceSol: 0,
  balanceUsd: 0,
  wallets: [],
  activeTrades: [],
  recentTools: [],
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

type AppMode = "chat" | "settings-select" | "settings-edit-select" | "settings-edit-text";

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

// ── App ──────────────────────────────────────────────────────────────────────

interface AppProps {
  config: TuiConfig;
}

export function App({ config }: AppProps): React.ReactElement {
  const { exit } = useApp();
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

    // Escape — back to chat from any mode
    if (key.escape) {
      if (mode !== "chat") {
        setAppMode("chat");
        setSettingsEditIndex(-1);
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
      void bridgeRef.current?.stop();
      exit();
      return;
    }
    if (input === "q" && key.ctrl) {
      addSystemMsg("Shutting down...");
      void bridgeRef.current?.stop().finally(() => exit());
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

  // Provider/select value chosen
  const handleSelectValue = useCallback((value: string) => {
    void saveSettingValue(settingsEditIndex, value);
  }, [settingsEditIndex]);

  // Text value submitted
  const handleTextValue = useCallback((value: string) => {
    if (!value.trim()) {
      setAppMode("settings-select");
      setSettingsEditIndex(-1);
      return;
    }
    void saveSettingValue(settingsEditIndex, value.trim());
  }, [settingsEditIndex]);

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
      addSystemMsg(`${item.label} \u2192 ${value}. Restart to apply.`);
    } else if (item.source === "remote" && bridge) {
      if (item.key === "slippage") {
        const bps = parseInt(value, 10);
        if (isNaN(bps) || bps < 1 || bps > 5000) {
          addErrorMsg("Slippage must be 1-5000 bps.");
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
          vals.strategy = value;
          addSystemMsg("Strategy updated.");
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

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box
        borderStyle="single"
        borderColor="cyan"
        borderBottom
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        <Text color="cyan" bold>BALCHEMY</Text>
        <Text dimColor> | </Text>
        <Text dimColor>{config.publicId}</Text>
        <Text dimColor> | </Text>
        <Text color={status.sseConnected ? "green" : "yellow"}>
          {status.sseConnected ? "LIVE" : "CONNECTING"}
        </Text>
        {inSettings && (
          <>
            <Text dimColor> | </Text>
            <Text color="yellow" bold>SETTINGS</Text>
          </>
        )}
      </Box>

      {/* Main content */}
      <Box flexDirection="row" flexGrow={1}>
        <ChatPanel
          messages={messages}
          onSend={handleSend}
          inputActive={chatInputActive}
          inputPlaceholder="Send a message..."
        />
        <StatusPanel status={status} />
      </Box>

      {/* Settings panel — replaces input area when active */}
      {appMode === "settings-select" && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Box marginBottom={0}>
            <Text color="yellow" bold>Settings</Text>
            {settingsLoading && <Text dimColor> loading...</Text>}
          </Box>
          <Select options={settingsOptions} onChange={handleSettingSelected} />
          <Text dimColor>{"\u2191\u2193"} navigate {"\u00b7"} enter select {"\u00b7"} esc close</Text>
        </Box>
      )}

      {appMode === "settings-edit-select" && editItem && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>{editItem.label}</Text>
          <Select options={editSelectOptions} onChange={handleSelectValue} />
          <Text dimColor>{"\u2191\u2193"} navigate {"\u00b7"} enter select {"\u00b7"} esc back</Text>
        </Box>
      )}

      {appMode === "settings-edit-text" && editItem && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>{editItem.label}</Text>
          <Text dimColor>Current: {settingsValues[editItem.key] ?? "?"}</Text>
          <Box>
            <Text color="yellow">{"\u276f"} </Text>
            <TextInput
              key={settingsInputKey}
              placeholder="Enter new value..."
              onSubmit={handleTextValue}
            />
          </Box>
        </Box>
      )}

      {/* Trade confirmation overlay */}
      {tradeConfirm && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0}>
          <Text color="yellow" bold>TRADE </Text>
          <Text color="white">{tradeConfirm.preview} </Text>
          <Text color="yellow">Confirm? </Text>
          <TextInput
            key={confirmKey}
            placeholder="y/n"
            onSubmit={handleConfirmInput}
          />
        </Box>
      )}

      {/* Bottom shortcut bar */}
      <Box
        borderStyle="single"
        borderColor="gray"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
        gap={2}
      >
        <Text><Text color="cyan" bold>^S</Text><Text dimColor> Settings </Text></Text>
        <Text><Text color="cyan" bold>^L</Text><Text dimColor> Clear </Text></Text>
        <Text><Text color="cyan" bold>^N</Text><Text dimColor> New </Text></Text>
        <Text><Text color="cyan" bold>^Q</Text><Text dimColor> Quit </Text></Text>
        <Text><Text color="cyan" bold>ESC</Text><Text dimColor> Back </Text></Text>
      </Box>
    </Box>
  );
}
