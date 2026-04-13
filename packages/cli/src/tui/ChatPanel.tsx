// src/tui/ChatPanel.tsx
import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";
import type { ChatMessage } from "./types.js";

const MESSAGE_STYLE: Record<string, { label: string; color: string; labelColor: string }> = {
  agent: { label: "AI", color: "cyan", labelColor: "cyanBright" },
  user: { label: "YOU", color: "white", labelColor: "whiteBright" },
  system: { label: "SYS", color: "gray", labelColor: "gray" },
  trade: { label: "TXN", color: "green", labelColor: "greenBright" },
  error: { label: "ERR", color: "red", labelColor: "redBright" },
};

function MessageLine({ msg }: { msg: ChatMessage }): React.ReactElement {
  const style = MESSAGE_STYLE[msg.type] ?? { label: "---", color: "white", labelColor: "white" };
  const time = new Date(msg.timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Box marginBottom={msg.type === "agent" ? 1 : 0}>
      <Text dimColor>{time} </Text>
      <Text color={style.labelColor} bold>{style.label.padEnd(3)} </Text>
      <Text color={style.color} wrap="wrap">{msg.text}</Text>
    </Box>
  );
}

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  inputActive: boolean;
}

export function ChatPanel({ messages, onSend, inputActive }: ChatPanelProps): React.ReactElement {
  const visibleMessages = messages.slice(-100);
  const [inputKey, setInputKey] = useState(0);

  const handleSubmit = useCallback((value: string) => {
    if (value.trim()) {
      onSend(value.trim());
      setInputKey((k) => k + 1);
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
      <Box paddingX={1} borderStyle="single" borderColor="cyan" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text color="cyan" bold>{">"} </Text>
        {inputActive ? (
          <TextInput
            key={inputKey}
            placeholder="Send a message..."
            onSubmit={handleSubmit}
          />
        ) : (
          <Text dimColor>Starting agent...</Text>
        )}
      </Box>
    </Box>
  );
}
