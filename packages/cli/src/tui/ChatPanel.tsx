// src/tui/ChatPanel.tsx — Polished activity surface with compact message cards
import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { ChatMessage } from "./types.js";
import { displayWidth, truncateEnd, truncateMiddle, wrapText } from "./text-layout.js";

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

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\n{3,}/g, "\n\n");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 24).trimEnd()}\n... trimmed in activity log`;
}

function WrappedText({
  text,
  width,
  color,
  bold = false,
  maxLines,
}: {
  text: string;
  width: number;
  color: "white" | "red" | "green" | "yellow" | "cyan";
  bold?: boolean;
  maxLines?: number;
}): React.ReactElement {
  const lines = wrapText(text, width, maxLines);
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`} color={color} bold={bold}>{line}</Text>
      ))}
    </Box>
  );
}

interface MessageCardProps {
  label: string;
  labelColor: "cyan" | "yellow" | "green" | "red" | "white";
  msg: ChatMessage;
  width: number;
  children: React.ReactNode;
}

function MessageCard({
  label,
  labelColor,
  msg,
  width,
  children,
}: MessageCardProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={0} width={width}>
      <Box marginBottom={0}>
        <Text color={labelColor} bold>{label}</Text>
        <Text dimColor>  {formatTime(msg.timestamp)}</Text>
      </Box>
      <Box paddingLeft={1} width={width}>
        {children}
      </Box>
    </Box>
  );
}

function AgentMsg({ msg, width }: { msg: ChatMessage; width: number }): React.ReactElement {
  return (
    <MessageCard label="AI" labelColor="cyan" msg={msg} width={width}>
      <WrappedText color="white" width={Math.max(8, width - 1)} text={compactText(msg.text, 1200)} maxLines={16} />
    </MessageCard>
  );
}

function UserMsg({ msg, width }: { msg: ChatMessage; width: number }): React.ReactElement {
  return (
    <MessageCard label="YOU" labelColor="yellow" msg={msg} width={width}>
      <WrappedText color="white" width={Math.max(8, width - 1)} text={compactText(msg.text, 600)} maxLines={10} />
    </MessageCard>
  );
}

function SystemMsg({ msg, width }: { msg: ChatMessage; width: number }): React.ReactElement {
  const meta = getSystemMeta(msg.text);
  const prefix = `${meta.label}  ${formatTime(msg.timestamp)}  `;
  const bodyWidth = Math.max(0, width - displayWidth(prefix));
  const bodyText = compactText(meta.body, 400).replace(/\s+/g, " ");
  const body = bodyWidth > 0 ? truncateMiddle(bodyText, bodyWidth) : "";

  return (
    <Box marginBottom={0} width={width}>
      <Text color={meta.color} bold>{meta.label}</Text>
      <Text dimColor>  {formatTime(msg.timestamp)}  </Text>
      {body.length > 0 && <Text dimColor>{body}</Text>}
    </Box>
  );
}

function TradeMsg({ msg, width }: { msg: ChatMessage; width: number }): React.ReactElement {
  const isBuy = msg.action === "buy";
  const color = isBuy ? "green" : "red";

  return (
    <MessageCard
      label={isBuy ? "BUY" : "SELL"}
      labelColor={color}
      msg={msg}
      width={width}
    >
      <WrappedText color={color} bold width={Math.max(8, width - 1)} text={compactText(msg.text, 600)} maxLines={10} />
    </MessageCard>
  );
}

function ErrorMsg({ msg, width }: { msg: ChatMessage; width: number }): React.ReactElement {
  return (
    <MessageCard label="ERROR" labelColor="red" msg={msg} width={width}>
      <WrappedText color="red" width={Math.max(8, width - 1)} text={compactText(msg.text, 800)} maxLines={10} />
    </MessageCard>
  );
}

function MessageLine({ msg, width }: { msg: ChatMessage; width: number }): React.ReactElement {
  switch (msg.type) {
    case "agent": return <AgentMsg msg={msg} width={width} />;
    case "user": return <UserMsg msg={msg} width={width} />;
    case "trade": return <TradeMsg msg={msg} width={width} />;
    case "error": return <ErrorMsg msg={msg} width={width} />;
    default: return <SystemMsg msg={msg} width={width} />;
  }
}

// ── Thinking indicator ──────────────────────────────────────────────────────

const THINKING_FRAMES = ["·  ", "·· ", "···", " ··", "  ·"];

function ThinkingIndicator({ width }: { width: number }): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % THINKING_FRAMES.length);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box marginBottom={0} width={width}>
      <Text color="cyan" bold>AI</Text>
      <Text dimColor>  </Text>
      <Text color="cyan">{THINKING_FRAMES[frame]}</Text>
    </Box>
  );
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
  width: number;
  thinking?: boolean;
}

export function ChatPanel({
  messages,
  onSend,
  inputActive,
  hideInput = false,
  pageSize = 30,
  inputPlaceholder,
  width,
  thinking = false,
}: ChatPanelProps): React.ReactElement {
  const [inputKey, setInputKey] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const prevCount = useRef(messages.length);
  const panelWidth = Math.max(18, width);
  const historyWidth = Math.max(8, panelWidth - 2);
  const messageWidth = Math.max(8, historyWidth);
  const promptWidth = Math.max(14, panelWidth - 2);
  const promptLabelWidth = 8;
  const promptContentWidth = Math.max(8, promptWidth - 4);
  const promptValueWidth = Math.max(4, promptContentWidth - promptLabelWidth);
  const placeholder = truncateEnd(
    inputPlaceholder ?? "Ask, adjust rules, or inspect...",
    promptValueWidth,
  );

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
    <Box flexDirection="column" width={panelWidth} flexGrow={1}>
      {/* Scroll-up indicator */}
      {hasOlder && (
        <Box paddingX={1} flexShrink={0}>
          <Text dimColor>{truncateEnd(`↑ ${start} earlier items · PgUp`, historyWidth)}</Text>
        </Box>
      )}

      {/* Message history — fills all available space, messages align to bottom */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1} justifyContent="flex-end" width={panelWidth}>
        {visibleMessages.length === 0 && !thinking && (
          <Box flexDirection="column" marginBottom={1} width={messageWidth}>
            <Text color="white" bold>No activity yet</Text>
            <Text dimColor>{truncateEnd("Try: 'check my portfolio' or 'what can you do?'", messageWidth)}</Text>
          </Box>
        )}
        {visibleMessages.map((msg) => (
          <MessageLine key={msg.id} msg={msg} width={messageWidth} />
        ))}
        {thinking && <ThinkingIndicator width={messageWidth} />}
      </Box>

      {/* Scroll-down indicator */}
      {!isAtBottom && (
        <Box paddingX={1} flexShrink={0}>
          <Text dimColor>{truncateEnd(`↓ ${scrollOffset} newer items · PgDn`, historyWidth)}</Text>
        </Box>
      )}

      {/* Prompt — pinned to bottom */}
      {!hideInput && (
        <Box paddingX={1} paddingY={0} width={panelWidth} flexShrink={0}>
          <Box borderStyle="round" borderColor={inputActive ? "cyan" : "gray"} paddingX={1} width={promptWidth} flexShrink={0}>
            <Text color={inputActive ? "cyan" : "gray"} bold>Prompt</Text>
            <Text dimColor>  </Text>
            {inputActive ? (
              <TextInput
                key={inputKey}
                placeholder={placeholder}
                onSubmit={handleSubmit}
              />
            ) : (
              <Text dimColor>{truncateEnd("Starting agent session...", promptValueWidth)}</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
