// src/tui/App.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
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

type AppMode = "chat" | "settings-select" | "settings-edit";

interface SettingItem {
  key: string;
  label: string;
  source: "local" | "remote";
}

const SETTINGS_ITEMS: SettingItem[] = [
  { key: "provider", label: "LLM Provider", source: "local" },
  { key: "model", label: "LLM Model", source: "local" },
  { key: "maxDailyCost", label: "Max Daily $", source: "local" },
  { key: "slippage", label: "Slippage (bps)", source: "remote" },
  { key: "strategy", label: "Strategy", source: "remote" },
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

  // App mode
  const [appMode, setAppMode] = useState<AppMode>("chat");
  const appModeRef = useRef<AppMode>("chat");
  const [settingsEditIndex, setSettingsEditIndex] = useState(-1);
  const [settingsValues, setSettingsValues] = useState<Record<string, string>>({});
  const settingsValuesRef = useRef<Record<string, string>>({});

  // Keep refs in sync with state (avoids stale closures)
  useEffect(() => { appModeRef.current = appMode; }, [appMode]);
  useEffect(() => { settingsValuesRef.current = settingsValues; }, [settingsValues]);

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

  // ── Keyboard shortcuts (OpenCode-style) ─────────────────────────────────

  useInput((input, key) => {
    // Don't intercept when trade confirmation is active
    if (tradeConfirm) return;
    // Ignore backspace/delete — let TextInput handle them
    if (key.backspace || key.delete) return;

    const mode = appModeRef.current;

    // Escape — always go back to chat
    if (key.escape) {
      if (mode !== "chat") {
        setAppMode("chat");
        setSettingsEditIndex(-1);
        addSystemMsg("Back to chat.");
      }
      return;
    }

    // ctrl+s — toggle settings
    if (input === "s" && key.ctrl) {
      if (mode === "chat") {
        void openSettings();
      } else {
        setAppMode("chat");
        setSettingsEditIndex(-1);
        addSystemMsg("Settings closed.");
      }
      return;
    }

    // ctrl+l — clear chat
    if (input === "l" && key.ctrl) {
      setMessages([]);
      addSystemMsg("Chat cleared.");
      return;
    }

    // ctrl+n — new agent
    if (input === "n" && key.ctrl) {
      addSystemMsg("Creating new agent...");
      clearAgent();
      void bridgeRef.current?.stop();
      exit();
      return;
    }

    // ctrl+q — quit (with cleanup)
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

    const local = bridge.getLocalConfig();
    const values: Record<string, string> = {
      provider: local.provider,
      model: local.model,
      maxDailyCost: `$${local.maxDailyCost.toFixed(2)}`,
      slippage: "loading...",
      strategy: "loading...",
    };
    setSettingsValues({ ...values });
    setAppMode("settings-select");
    addSystemMsg(formatSettingsDisplay(values));

    // Fetch remote settings async
    const remote = await bridge.fetchRemoteSettings();
    const updated = {
      ...values,
      slippage: remote.slippageBps !== undefined ? `${remote.slippageBps}` : "not set",
      strategy: remote.strategy ?? "not configured",
    };
    setSettingsValues(updated);
    addSystemMsg(formatSettingsDisplay(updated));
  }, [addSystemMsg]);

  const handleSettingsInput = useCallback((text: string) => {
    const mode = appModeRef.current;
    const vals = settingsValuesRef.current;

    if (mode === "settings-select") {
      if (text === "" || text.toLowerCase() === "back") {
        setAppMode("chat");
        setSettingsEditIndex(-1);
        addSystemMsg("Settings closed.");
        return;
      }
      const idx = parseInt(text, 10);
      if (isNaN(idx) || idx < 1 || idx > SETTINGS_ITEMS.length) {
        addSystemMsg(`Type 1-${SETTINGS_ITEMS.length} to edit, esc to close.`);
        return;
      }
      const item = SETTINGS_ITEMS[idx - 1];
      const current = vals[item.key] ?? "?";
      setSettingsEditIndex(idx - 1);
      setAppMode("settings-edit");
      addSystemMsg(`Editing ${item.label} (current: ${current})`);
      return;
    }

    if (mode === "settings-edit") {
      if (text === "" || text.toLowerCase() === "back") {
        setAppMode("settings-select");
        setSettingsEditIndex(-1);
        addSystemMsg(formatSettingsDisplay(vals));
        return;
      }
      void saveSettingValue(settingsEditIndex, text);
      return;
    }
  }, [addSystemMsg, settingsEditIndex]);

  const saveSettingValue = useCallback(async (index: number, value: string) => {
    const item = SETTINGS_ITEMS[index];
    if (!item) return;

    const bridge = bridgeRef.current;
    const vals = { ...settingsValuesRef.current };

    if (item.source === "local") {
      const agent = loadAgent();
      if (!agent) {
        addErrorMsg("No agent found in store.");
        setAppMode("settings-select");
        setSettingsEditIndex(-1);
        return;
      }

      switch (item.key) {
        case "provider": {
          const valid = ["anthropic", "openai", "gemini", "grok", "openrouter"];
          if (!valid.includes(value.toLowerCase())) {
            addErrorMsg(`Invalid provider. Choose: ${valid.join(", ")}`);
            return;
          }
          agent.llmProvider = value.toLowerCase();
          vals.provider = value.toLowerCase();
          break;
        }
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
      addSystemMsg(`${item.label} \u2192 ${value}. Takes effect on restart.`);
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

    // Immutable state update
    setSettingsValues(vals);
    setAppMode("settings-select");
    setSettingsEditIndex(-1);
    addSystemMsg(formatSettingsDisplay(vals));
  }, [addSystemMsg, addErrorMsg]);

  // ── Chat input handler ──────────────────────────────────────────────────

  const handleSend = useCallback(async (text: string) => {
    const mode = appModeRef.current;

    // Settings mode input routing
    if (mode === "settings-select" || mode === "settings-edit") {
      handleSettingsInput(text);
      return;
    }

    // Regular chat message
    if (bridgeRef.current) {
      await bridgeRef.current.sendUserMessage(text);
    } else {
      addSystemMsg("Agent not ready yet.");
    }
  }, [handleSettingsInput, addSystemMsg]);

  // ── Input placeholder ───────────────────────────────────────────────────

  const inputPlaceholder =
    appMode === "settings-select"
      ? "Type 1-5 to edit, esc to close..."
      : appMode === "settings-edit"
        ? `Enter new value (esc to cancel)...`
        : "Send a message...";

  // ── Render ──────────────────────────────────────────────────────────────

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
        {appMode !== "chat" && (
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
          inputActive={inputActive && !tradeConfirm}
          inputPlaceholder={inputPlaceholder}
        />
        <StatusPanel status={status} />
      </Box>

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
        <Text>
          <Text color="cyan" bold>^S</Text><Text dimColor> Settings </Text>
        </Text>
        <Text>
          <Text color="cyan" bold>^L</Text><Text dimColor> Clear </Text>
        </Text>
        <Text>
          <Text color="cyan" bold>^N</Text><Text dimColor> New </Text>
        </Text>
        <Text>
          <Text color="cyan" bold>^Q</Text><Text dimColor> Quit </Text>
        </Text>
        <Text>
          <Text color="cyan" bold>ESC</Text><Text dimColor> Back </Text>
        </Text>
      </Box>
    </Box>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatSettingsDisplay(values: Record<string, string>): string {
  const lines = SETTINGS_ITEMS.map((item, i) => {
    const val = values[item.key] ?? "?";
    const display = val.length > 40 ? val.slice(0, 37) + "..." : val;
    return `  ${i + 1}  ${item.label.padEnd(16)} ${display}`;
  });

  return [
    "Settings",
    "\u2500".repeat(38),
    ...lines,
    "",
    "Type number to edit \u00b7 esc to close",
  ].join("\n");
}
