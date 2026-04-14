// src/tui/ChatPanel.tsx
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

// ── Message components per type ──────────────────────────────────────────────

function AgentMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyanBright" bold>AI </Text>
        <Text dimColor>{formatTime(msg.timestamp)}</Text>
      </Box>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="white" wrap="wrap">{msg.text}</Text>
      </Box>
    </Box>
  );
}

function UserMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <Box marginBottom={0}>
      <Text dimColor>{formatTime(msg.timestamp)} </Text>
      <Text color="whiteBright" bold>{">"} </Text>
      <Text color="white" wrap="wrap">{msg.text}</Text>
    </Box>
  );
}

function SystemMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <Box marginBottom={0}>
      <Text dimColor italic>{formatTime(msg.timestamp)} {"\u00b7"} {msg.text}</Text>
    </Box>
  );
}

function TradeMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  const isBuy = msg.action === "buy";
  const color = isBuy ? "green" : "red";
  const labelColor = isBuy ? "greenBright" : "redBright";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={labelColor} bold>{isBuy ? "BUY" : "SELL"} </Text>
        <Text dimColor>{formatTime(msg.timestamp)}</Text>
      </Box>
      <Box borderStyle="round" borderColor={color} paddingX={1}>
        <Text color={color} bold wrap="wrap">{msg.text}</Text>
      </Box>
    </Box>
  );
}

function ErrorMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="redBright" bold>ERR </Text>
        <Text dimColor>{formatTime(msg.timestamp)}</Text>
      </Box>
      <Box borderStyle="single" borderColor="red" paddingX={1}>
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
  onSend: (text: string) => void;
  inputActive: boolean;
  inputPlaceholder?: string;
}

export function ChatPanel({
  messages,
  onSend,
  inputActive,
  inputPlaceholder,
}: ChatPanelProps): React.ReactElement {
  const visibleMessages = messages.slice(-100);
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
            <Text dimColor>Waiting for agent...</Text>
          </Box>
        )}
        {visibleMessages.map((msg) => (
          <MessageLine key={msg.id} msg={msg} />
        ))}
      </Box>

      {/* Input */}
      <Box
        paddingX={1}
        borderStyle="single"
        borderColor="cyan"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text color="cyan" bold>{">"} </Text>
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
