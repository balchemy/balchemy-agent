// src/tui/ChatPanel.tsx — Left-border messages + PgUp/PgDn scroll
import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { ChatMessage } from "./types.js";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Message components — left-border style ───────────────────────────────────

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

const PAGE_SIZE = 30;
const SCROLL_STEP = 5;

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
  const [inputKey, setInputKey] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Auto-scroll to bottom on new messages (only if already at bottom)
  const prevCount = React.useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevCount.current && scrollOffset === 0) {
      // Already at bottom — stay there (no-op)
    } else if (messages.length > prevCount.current && scrollOffset > 0) {
      // New message arrived while scrolled up — keep position stable
      setScrollOffset((prev) => prev + (messages.length - prevCount.current));
    }
    prevCount.current = messages.length;
  }, [messages.length, scrollOffset]);

  // PgUp / PgDn scroll
  useInput((_input, key) => {
    if (key.pageUp) {
      setScrollOffset((prev) => Math.min(prev + SCROLL_STEP, Math.max(0, messages.length - PAGE_SIZE)));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - SCROLL_STEP));
      return;
    }
  });

  // Calculate visible window
  const total = messages.length;
  const end = total - scrollOffset;
  const start = Math.max(0, end - PAGE_SIZE);
  const visibleMessages = messages.slice(start, Math.max(end, 0));
  const hasOlder = start > 0;
  const isAtBottom = scrollOffset === 0;

  const handleSubmit = useCallback(async (value: string) => {
    if (value.trim()) {
      setInputKey((k) => k + 1);
      setScrollOffset(0); // Jump to bottom on send
      await onSend(value.trim());
    }
  }, [onSend]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Scroll-up indicator */}
      {hasOlder && (
        <Box paddingX={1}>
          <Text dimColor>{"\u2191"} {start} older messages — PgUp to scroll</Text>
        </Box>
      )}

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

      {/* Scroll-down indicator */}
      {!isAtBottom && (
        <Box paddingX={1}>
          <Text dimColor>{"\u2193"} {scrollOffset} newer messages — PgDn to scroll</Text>
        </Box>
      )}

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
