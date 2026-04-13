// src/tui/App.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp } from "ink";
import { ChatPanel } from "./ChatPanel.js";
import { StatusPanel } from "./StatusPanel.js";
import { AgentBridge } from "./AgentBridge.js";
import { saveAgent, clearAgent } from "../agent-store.js";
import type { ChatMessage, StatusData, TuiConfig } from "./types.js";
import { randomUUID } from "node:crypto";

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

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const addSystemMsg = useCallback((text: string) => {
    addMessage({ id: randomUUID(), type: "system", text, timestamp: Date.now() });
  }, [addMessage]);

  useEffect(() => {
    const bridge = new AgentBridge(config, { addMessage, setStatus });
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

    // Balance updates silently via status panel — no spam messages
    const balanceInterval = setInterval(() => {
      bridge.refreshBalance().catch(() => {});
    }, 60_000);

    return () => {
      clearInterval(balanceInterval);
      bridge.stop().catch(() => {});
    };
  }, [config, addMessage]);

  const handleSend = useCallback(async (text: string) => {
    // Slash commands work even without bridge
    if (text.startsWith("/")) {
      const cmd = text.split(" ")[0].toLowerCase();
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
        case "/provider": {
          addSystemMsg(
            "To change your LLM provider, run:\n" +
            "  npx balchemy init\n" +
            "This starts the setup wizard where you can pick a new provider and model."
          );
          return;
        }
        case "/help": {
          addSystemMsg(
            "Commands:\n" +
            "  /stop      Stop agent and exit\n" +
            "  /clear     Clear chat history\n" +
            "  /new       Create a new agent\n" +
            "  /switch    Switch to different agent\n" +
            "  /provider  Change LLM provider\n" +
            "  /help      Show this help"
          );
          return;
        }
        case "/clear": {
          setMessages([]);
          return;
        }
        default: {
          addSystemMsg(`Unknown command: ${cmd}. Type /help for commands.`);
          return;
        }
      }
    }

    if (bridgeRef.current) {
      await bridgeRef.current.sendUserMessage(text);
    } else {
      addSystemMsg("Agent not ready yet. Try again in a moment.");
    }
  }, [exit, addSystemMsg]);

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" borderBottom borderTop={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color="cyan" bold>BALCHEMY</Text>
        <Text dimColor> | </Text>
        <Text dimColor>{config.publicId}</Text>
        <Text dimColor> | </Text>
        <Text color={status.sseConnected ? "green" : "yellow"}>{status.sseConnected ? "LIVE" : "CONNECTING"}</Text>
        <Text dimColor> | </Text>
        <Text dimColor>{config.shadowMode ? "SHADOW" : "LIVE MODE"}</Text>
      </Box>

      {/* Main content */}
      <Box flexDirection="row" flexGrow={1}>
        <ChatPanel messages={messages} onSend={handleSend} inputActive={inputActive} />
        <StatusPanel status={status} />
      </Box>
    </Box>
  );
}
