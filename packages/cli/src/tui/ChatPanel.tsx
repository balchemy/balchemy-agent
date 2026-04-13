// src/tui/ChatPanel.tsx
import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";
import type { ChatMessage } from "./types.js";

const MESSAGE_ICONS: Record<string, string> = {
  agent: "[bot]",
  user: "[you]",
  system: "[sys]",
  trade: "[txn]",
  error: "[err]",
};

const MESSAGE_COLORS: Record<string, string> = {
  agent: "cyan",
  user: "white",
  system: "gray",
  trade: "green",
  error: "red",
};

function MessageLine({ msg }: { msg: ChatMessage }): React.ReactElement {
  const icon = MESSAGE_ICONS[msg.type] ?? ".";
  const color = MESSAGE_COLORS[msg.type] ?? "white";
  const time = new Date(msg.timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <Box>
      <Text dimColor>{time} </Text>
      <Text>{icon} </Text>
      <Text color={color} wrap="wrap">{msg.text}</Text>
    </Box>
  );
}

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  inputActive: boolean;
}

export function ChatPanel({ messages, onSend, inputActive }: ChatPanelProps): React.ReactElement {
  // Show last N messages that fit the terminal
  const visibleMessages = messages.slice(-100);
  const [inputKey, setInputKey] = useState(0);

  const handleSubmit = useCallback((value: string) => {
    if (value.trim()) {
      onSend(value.trim());
      // Force re-mount TextInput to clear it
      setInputKey((k) => k + 1);
    }
  }, [onSend]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {visibleMessages.map((msg) => (
          <MessageLine key={msg.id} msg={msg} />
        ))}
      </Box>

      {/* Input area */}
      <Box borderStyle="single" borderColor="cyan" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text color="cyan">{"> "}</Text>
        {inputActive ? (
          <TextInput
            key={inputKey}
            placeholder="Type a message..."
            onSubmit={handleSubmit}
          />
        ) : (
          <Text dimColor>Connecting...</Text>
        )}
      </Box>
    </Box>
  );
}
