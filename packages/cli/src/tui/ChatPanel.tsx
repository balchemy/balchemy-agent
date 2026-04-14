// src/tui/ChatPanel.tsx — Modernized design with left-border message styling
import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";
import type { ChatMessage } from "./types.js";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Message components — left-border style (OpenCode-inspired) ───────────────

function AgentMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>{"\u2502"} </Text>
        <Text color="cyan" bold>AI</Text>
        <Text dimColor> {formatTime(msg.timestamp)}</Text>
      </Box>
      <Box>
        <Text color="cyan">{"\u2502"} </Text>
        <Text color="white" wrap="wrap">{msg.text}</Text>
      </Box>
    </Box>
  );
}

function UserMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color="magenta" bold>{"\u2502"} </Text>
        <Text color="white" wrap="wrap">{msg.text}</Text>
        <Text dimColor> {formatTime(msg.timestamp)}</Text>
      </Box>
    </Box>
  );
}

function SystemMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <Box marginBottom={0}>
      <Text dimColor>  {formatTime(msg.timestamp)} {"\u00b7"} {msg.text}</Text>
    </Box>
  );
}

function TradeMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  const isBuy = msg.action === "buy";
  const color = isBuy ? "green" : "red";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color} bold>{"\u2502"} {isBuy ? "\u25b2 BUY" : "\u25bc SELL"}</Text>
        <Text dimColor> {formatTime(msg.timestamp)}</Text>
      </Box>
      <Box>
        <Text color={color}>{"\u2502"} </Text>
        <Text color={color} bold wrap="wrap">{msg.text}</Text>
      </Box>
    </Box>
  );
}

function ErrorMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="red" bold>{"\u2502"} </Text>
        <Text color="red" bold>{"\u2717"} Error</Text>
        <Text dimColor> {formatTime(msg.timestamp)}</Text>
      </Box>
      <Box>
        <Text color="red">{"\u2502"} </Text>
        <Text color="red" wrap="wrap">{msg.text}</Text>
      </Box>
    </Box>
  );
}

function MessageLine({ msg }: { msg: ChatMessage }): React.ReactElement {
  switch (msg.type) {
    case "agent": return <AgentMsg msg={msg} />;
    case "user": return <UserMsg msg={msg} />;
    case "trade": return <TradeMsg msg={msg} />;
    case "error": return <ErrorMsg msg={msg} />;
    default: return <SystemMsg msg={msg} />;
  }
}

// ── ChatPanel ────────────────────────────────────────────────────────────────

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void | Promise<void>;
  inputActive: boolean;
  inputPlaceholder?: string;
}

export function ChatPanel({
  messages,
  onSend,
  inputActive,
  inputPlaceholder,
}: ChatPanelProps): React.ReactElement {
  const visibleMessages = messages.slice(-50);
  const [inputKey, setInputKey] = useState(0);

  const handleSubmit = useCallback(async (value: string) => {
    if (value.trim()) {
      setInputKey((k) => k + 1);
      await onSend(value.trim());
    }
  }, [onSend]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1}>
        {visibleMessages.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>  Waiting for agent...</Text>
          </Box>
        )}
        {visibleMessages.map((msg) => (
          <MessageLine key={msg.id} msg={msg} />
        ))}
      </Box>

      {/* Input area */}
      <Box paddingX={1} paddingY={0}>
        <Text color="cyan" bold>{"\u276f"} </Text>
        {inputActive ? (
          <TextInput
            key={inputKey}
            placeholder={inputPlaceholder ?? "Send a message..."}
            onSubmit={handleSubmit}
          />
        ) : (
          <Text dimColor>Starting agent...</Text>
        )}
      </Box>
    </Box>
  );
}
