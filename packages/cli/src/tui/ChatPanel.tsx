// src/tui/ChatPanel.tsx — Polished activity surface with compact message cards
import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { ChatMessage } from "./types.js";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getSystemMeta(text: string): { label: string; color: "cyan" | "yellow" | "white"; body: string } {
  if (text.startsWith("Tool:")) {
    return {
      label: "TOOL",
      color: "yellow",
      body: text.replace(/^Tool:\s*/, ""),
    };
  }

  if (text.startsWith("New token:")) {
    return {
      label: "EVENT",
      color: "cyan",
      body: text.replace(/^New token:\s*/, ""),
    };
  }

  return {
    label: "NOTE",
    color: "white",
    body: text,
  };
}

interface MessageCardProps {
  borderColor: "cyan" | "yellow" | "green" | "red" | "gray";
  label: string;
  labelColor: "cyan" | "yellow" | "green" | "red" | "white";
  msg: ChatMessage;
  children: React.ReactNode;
}

function MessageCard({
  borderColor,
  label,
  labelColor,
  msg,
  children,
}: MessageCardProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={0}>
        <Text color={labelColor} bold>{label}</Text>
        <Text dimColor>  {formatTime(msg.timestamp)}</Text>
      </Box>
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        {children}
      </Box>
    </Box>
  );
}

function AgentMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <MessageCard borderColor="cyan" label="AI" labelColor="cyan" msg={msg}>
      <Text color="white" wrap="wrap">{msg.text}</Text>
    </MessageCard>
  );
}

function UserMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <MessageCard borderColor="yellow" label="YOU" labelColor="yellow" msg={msg}>
      <Text color="white" wrap="wrap">{msg.text}</Text>
    </MessageCard>
  );
}

function SystemMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  const meta = getSystemMeta(msg.text);

  return (
    <Box marginBottom={1}>
      <Text color={meta.color} bold>{meta.label}</Text>
      <Text dimColor>  {formatTime(msg.timestamp)}  </Text>
      <Text dimColor wrap="wrap">{meta.body}</Text>
    </Box>
  );
}

function TradeMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  const isBuy = msg.action === "buy";
  const color = isBuy ? "green" : "red";

  return (
    <MessageCard
      borderColor={color}
      label={isBuy ? "BUY" : "SELL"}
      labelColor={color}
      msg={msg}
    >
      <Text color={color} bold wrap="wrap">{msg.text}</Text>
    </MessageCard>
  );
}

function ErrorMsg({ msg }: { msg: ChatMessage }): React.ReactElement {
  return (
    <MessageCard borderColor="red" label="ERROR" labelColor="red" msg={msg}>
      <Text color="red" wrap="wrap">{msg.text}</Text>
    </MessageCard>
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

const SCROLL_STEP = 5;

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void | Promise<void>;
  inputActive: boolean;
  hideInput?: boolean;
  pageSize?: number;
  inputPlaceholder?: string;
}

export function ChatPanel({
  messages,
  onSend,
  inputActive,
  hideInput = false,
  pageSize = 30,
  inputPlaceholder,
}: ChatPanelProps): React.ReactElement {
  const [inputKey, setInputKey] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const prevCount = useRef(messages.length);

  // Auto-scroll to bottom on new messages (only if already at bottom)
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
      setScrollOffset((prev) => Math.min(prev + SCROLL_STEP, Math.max(0, messages.length - pageSize)));
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
  const start = Math.max(0, end - pageSize);
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
          <Text dimColor>{"\u2191"} {start} earlier items  ·  PgUp scrolls history</Text>
        </Box>
      )}

      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1} justifyContent="flex-end">
        {visibleMessages.length === 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="white" bold>No activity yet</Text>
            <Text dimColor>Agent replies, live decisions and tool traces will appear here.</Text>
          </Box>
        )}
        {visibleMessages.map((msg) => (
          <MessageLine key={msg.id} msg={msg} />
        ))}
      </Box>

      {/* Scroll-down indicator */}
      {!isAtBottom && (
        <Box paddingX={1}>
          <Text dimColor>{"\u2193"} {scrollOffset} newer items  ·  PgDn jumps back down</Text>
        </Box>
      )}

      {!hideInput && (
        <Box paddingX={1} paddingY={0}>
          <Box borderStyle="round" borderColor={inputActive ? "cyan" : "gray"} paddingX={1} flexGrow={1}>
            <Text color={inputActive ? "cyan" : "gray"} bold>Prompt</Text>
            <Text dimColor>  </Text>
            {inputActive ? (
              <TextInput
                key={inputKey}
                placeholder={inputPlaceholder ?? "Ask, adjust rules, or inspect the session..."}
                onSubmit={handleSubmit}
              />
            ) : (
              <Text dimColor>Starting agent session...</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
