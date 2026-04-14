// src/tui/App.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp } from "ink";
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
  /** "local" = agent-store, "remote" = MCP call */
  source: "local" | "remote";
}

const SETTINGS_ITEMS: SettingItem[] = [
  { key: "provider", label: "LLM Provider", source: "local" },
  { key: "model", label: "LLM Model", source: "local" },
  { key: "maxDailyCost", label: "Max Daily $", source: "local" },
  { key: "slippage", label: "Slippage (bps)", source: "remote" },
  { key: "strategy", label: "Strategy", source: "remote" },
];

interface SettingsEditState {
  index: number;
  label: string;
  currentValue: string;
}

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

  // App mode — chat (default) | settings-select | settings-edit
  const [appMode, setAppMode] = useState<AppMode>("chat");
  const [settingsEdit, setSettingsEdit] = useState<SettingsEditState | null>(null);
  const [settingsValues, setSettingsValues] = useState<Record<string, string>>({});

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

  // ── Settings helpers ────────────────────────────────────────────────────

  const showSettings = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;

    // Local config
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

    // Show settings message
    addSystemMsg(formatSettingsDisplay(values));

    // Fetch remote settings
    const remote = await bridge.fetchRemoteSettings();
    values.slippage = remote.slippageBps !== undefined ? `${remote.slippageBps}` : "not set";
    values.strategy = remote.strategy ?? "not configured";
    setSettingsValues({ ...values });

    // Update display with fetched values
    addSystemMsg(formatSettingsDisplay(values));
  }, [addSystemMsg]);

  const handleSettingsSelect = useCallback((input: string) => {
    if (input === "/back" || input === "") {
      setAppMode("chat");
      addSystemMsg("Settings closed.");
      return;
    }

    const idx = parseInt(input, 10);
    if (isNaN(idx) || idx < 1 || idx > SETTINGS_ITEMS.length) {
      addSystemMsg(`Type 1-${SETTINGS_ITEMS.length} to edit, /back to close.`);
      return;
    }

    const item = SETTINGS_ITEMS[idx - 1];
    const current = settingsValues[item.key] ?? "?";
    setSettingsEdit({ index: idx - 1, label: item.label, currentValue: current });
    setAppMode("settings-edit");
    addSystemMsg(`Editing ${item.label} (current: ${current})`);
  }, [settingsValues, addSystemMsg]);

  const handleSettingsSave = useCallback(async (value: string) => {
    if (!settingsEdit) return;

    if (value === "/back" || value === "") {
      setAppMode("settings-select");
      setSettingsEdit(null);
      addSystemMsg(formatSettingsDisplay(settingsValues));
      return;
    }

    const item = SETTINGS_ITEMS[settingsEdit.index];
    const bridge = bridgeRef.current;

    if (item.source === "local") {
      // Save to agent-store
      const agent = loadAgent();
      if (!agent) {
        addMessage({ id: randomUUID(), type: "error", text: "No agent found in store.", timestamp: Date.now() });
        setAppMode("settings-select");
        setSettingsEdit(null);
        return;
      }

      switch (item.key) {
        case "provider": {
          const valid = ["anthropic", "openai", "gemini", "grok", "openrouter"];
          if (!valid.includes(value.toLowerCase())) {
            addMessage({ id: randomUUID(), type: "error", text: `Invalid provider. Choose: ${valid.join(", ")}`, timestamp: Date.now() });
            return;
          }
          agent.llmProvider = value.toLowerCase();
          break;
        }
        case "model":
          agent.llmModel = value;
          break;
        case "maxDailyCost": {
          const num = parseFloat(value.replace("$", ""));
          if (isNaN(num) || num <= 0) {
            addMessage({ id: randomUUID(), type: "error", text: "Enter a positive number.", timestamp: Date.now() });
            return;
          }
          agent.maxDailyLlmCost = num;
          break;
        }
      }

      saveAgent(agent);
      settingsValues[item.key] = item.key === "maxDailyCost" ? `$${agent.maxDailyLlmCost?.toFixed(2)}` : value;
      addSystemMsg(`${item.label} updated to: ${value}. Takes effect on restart.`);
    } else if (item.source === "remote" && bridge) {
      // Save via MCP
      if (item.key === "slippage") {
        const bps = parseInt(value, 10);
        if (isNaN(bps) || bps < 1 || bps > 5000) {
          addMessage({ id: randomUUID(), type: "error", text: "Slippage must be 1-5000 bps.", timestamp: Date.now() });
          return;
        }
        const ok = await bridge.updateSlippage(bps);
        if (ok) {
          settingsValues.slippage = `${bps}`;
          addSystemMsg(`Slippage updated to ${bps} bps.`);
        } else {
          addMessage({ id: randomUUID(), type: "error", text: "Failed to update slippage.", timestamp: Date.now() });
        }
      } else if (item.key === "strategy") {
        const ok = await bridge.updateStrategy(value);
        if (ok) {
          settingsValues.strategy = value;
          addSystemMsg(`Strategy updated.`);
        } else {
          addMessage({ id: randomUUID(), type: "error", text: "Failed to update strategy.", timestamp: Date.now() });
        }
      }
    }

    setSettingsValues({ ...settingsValues });
    setAppMode("settings-select");
    setSettingsEdit(null);

    // Re-show menu
    addSystemMsg(formatSettingsDisplay(settingsValues));
  }, [settingsEdit, settingsValues, addMessage, addSystemMsg]);

  // ── Main input handler ──────────────────────────────────────────────────

  const handleSend = useCallback(async (text: string) => {
    // Settings mode routing
    if (appMode === "settings-select") {
      handleSettingsSelect(text);
      return;
    }
    if (appMode === "settings-edit") {
      await handleSettingsSave(text);
      return;
    }

    // Slash commands (chat mode)
    if (text.startsWith("/")) {
      const parts = text.split(" ");
      const cmd = parts[0].toLowerCase();
      switch (cmd) {
        case "/stop":
        case "/exit":
        case "/quit": {
          addSystemMsg("Shutting down...");
          await bridgeRef.current?.stop();
          exit();
          return;
        }
        case "/new": {
          addSystemMsg("Creating new agent... Restarting wizard.");
          clearAgent();
          await bridgeRef.current?.stop();
          exit();
          return;
        }
        case "/switch": {
          addSystemMsg("Switching agent... Clearing cache.");
          clearAgent();
          await bridgeRef.current?.stop();
          exit();
          return;
        }
        case "/settings": {
          await showSettings();
          return;
        }
        case "/help": {
          addSystemMsg(
            "Commands:\n" +
            "  /settings  View & change settings\n" +
            "  /clear     Clear chat history\n" +
            "  /stop      Stop agent and exit\n" +
            "  /new       Create a new agent\n" +
            "  /switch    Switch to different agent\n" +
            "  /help      Show this help",
          );
          return;
        }
        case "/clear": {
          setMessages([]);
          addSystemMsg("Chat cleared.");
          return;
        }
        default: {
          addSystemMsg(`Unknown command: ${cmd}. Type /help for available commands.`);
          return;
        }
      }
    }

    // Regular chat message
    if (bridgeRef.current) {
      await bridgeRef.current.sendUserMessage(text);
    } else {
      addSystemMsg("Agent not ready yet. Try again in a moment.");
    }
  }, [appMode, exit, addSystemMsg, handleSettingsSelect, handleSettingsSave, showSettings]);

  // ── Input placeholder based on mode ─────────────────────────────────────

  const inputPlaceholder =
    appMode === "settings-select"
      ? "Type 1-5 to edit, /back to close..."
      : appMode === "settings-edit"
        ? `New value for ${settingsEdit?.label ?? "setting"}...`
        : undefined;

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
        <Text dimColor> | </Text>
        <Text dimColor>{config.shadowMode ? "SHADOW" : "LIVE MODE"}</Text>
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
    "Type number to edit \u00b7 /back to close",
  ].join("\n");
}
