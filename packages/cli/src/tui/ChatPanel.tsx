// src/tui/ChatPanel.tsx — Polished activity surface with transcript scrolling
import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { ChatMessage } from "./types.js";
import { displayWidth, truncateEnd, truncateMiddle, wrapText } from "./text-layout.js";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

type TextTone = "white" | "red" | "green" | "yellow" | "cyan";

export type TranscriptRow =
  | { kind: "header"; id: string; label: string; labelColor: TextTone; time: string }
  | { kind: "body"; id: string; text: string; color: TextTone; bold?: boolean }
  | { kind: "system"; id: string; label: string; labelColor: TextTone; time: string; body: string };

function getSystemMeta(text: string): { label: string; color: TextTone; body: string } {
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

function compactSystemText(text: string): string {
  return text.replace(/\n{2,}/g, " ").replace(/\s+/g, " ").trim();
}

function messageStyle(msg: ChatMessage): { label: string; color: TextTone; bold?: boolean } {
  switch (msg.type) {
    case "agent":
      return { label: "AI", color: "cyan" };
    case "user":
      return { label: "YOU", color: "yellow" };
    case "trade": {
      const color = msg.action === "buy" ? "green" : "red";
      return { label: msg.action === "buy" ? "BUY" : "SELL", color, bold: true };
    }
    case "error":
      return { label: "ERROR", color: "red" };
    default:
      return { label: "NOTE", color: "white" };
  }
}

function buildSystemRow(msg: ChatMessage, width: number): TranscriptRow {
  const meta = getSystemMeta(msg.text);
  const time = formatTime(msg.timestamp);
  const prefix = `${meta.label}  ${time}  `;
  const bodyWidth = Math.max(0, width - displayWidth(prefix));
  const bodyText = compactSystemText(meta.body);
  return {
    kind: "system",
    id: `${msg.id}:system`,
    label: meta.label,
    labelColor: meta.color,
    time,
    body: bodyWidth > 0 ? truncateMiddle(bodyText, bodyWidth) : "",
  };
}

export function buildTranscriptRows(messages: ChatMessage[], width: number): TranscriptRow[] {
  const messageWidth = Math.max(8, width);
  const bodyWidth = Math.max(8, messageWidth - 1);
  const rows: TranscriptRow[] = [];

  for (const msg of messages) {
    if (msg.type === "system") {
      rows.push(buildSystemRow(msg, messageWidth));
      continue;
    }

    const style = messageStyle(msg);
    rows.push({
      kind: "header",
      id: `${msg.id}:header`,
      label: style.label,
      labelColor: style.color,
      time: formatTime(msg.timestamp),
    });

    const bodyRows = wrapText(msg.text, bodyWidth);
    bodyRows.forEach((line, index) => {
      rows.push({
        kind: "body",
        id: `${msg.id}:body:${index}`,
        text: line,
        color: msg.type === "error" ? "red" : msg.type === "trade" ? style.color : "white",
        bold: style.bold,
      });
    });
  }

  return rows;
}

export function getTranscriptViewport(
  rows: TranscriptRow[],
  viewportRows: number,
  scrollOffset: number,
): {
  visibleRows: TranscriptRow[];
  start: number;
  end: number;
  maxScroll: number;
  scrollOffset: number;
} {
  const visibleCount = Math.max(1, viewportRows);
  const maxScroll = Math.max(0, rows.length - visibleCount);
  const clampedOffset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const end = Math.max(0, rows.length - clampedOffset);
  const start = Math.max(0, end - visibleCount);
  return {
    visibleRows: rows.slice(start, end),
    start,
    end,
    maxScroll,
    scrollOffset: clampedOffset,
  };
}

function TranscriptLine({ row, width }: { row: TranscriptRow; width: number }): React.ReactElement {
  if (row.kind === "system") {
    return (
      <Box marginBottom={0} width={width}>
        <Text color={row.labelColor} bold>{row.label}</Text>
        <Text dimColor>  {row.time}  </Text>
        {row.body.length > 0 && <Text dimColor>{row.body}</Text>}
      </Box>
    );
  }

  if (row.kind === "header") {
    return (
      <Box marginBottom={0} width={width}>
        <Text color={row.labelColor} bold>{row.label}</Text>
        <Text dimColor>  {row.time}</Text>
      </Box>
    );
  }

  return (
    <Box paddingLeft={1} width={width}>
      <Text color={row.color} bold={row.bold}>{row.text}</Text>
    </Box>
  );
}

const THINKING_FRAMES = ["·  ", "·· ", "···", " ··", "  ·"];
const CSI_FRAGMENT_PATTERN = /^(?:\[(?:5|6)(?:;\d+)?~|(?:5|6)(?:;\d+)?~|\[\d*[A-Za-z~]|O[A-Za-z])$/;

export function isTerminalControlInput(input: string): boolean {
  const value = input.replace(/[\r\n]/g, "");
  if (value.length === 0) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return CSI_FRAGMENT_PATTERN.test(value);
}

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

const MIN_SCROLL_STEP = 6;

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
  const [inputValue, setInputValue] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  const prevRowCount = useRef(0);
  const panelWidth = Math.max(18, width);
  const historyWidth = Math.max(8, panelWidth - 2);
  const messageWidth = Math.max(8, historyWidth);
  const promptWidth = Math.max(14, panelWidth - 2);
  const promptLabelWidth = 8;
  const promptContentWidth = Math.max(8, promptWidth - 4);
  const promptValueWidth = Math.max(4, promptContentWidth - promptLabelWidth);
  const viewportRows = Math.max(1, pageSize);
  const transcriptRows = buildTranscriptRows(messages, messageWidth);
  const viewport = getTranscriptViewport(transcriptRows, viewportRows, scrollOffset);
  const scrollStep = Math.max(MIN_SCROLL_STEP, viewportRows - 1);
  const promptTextWidth = Math.max(1, promptValueWidth - 1);
  const placeholder = truncateEnd(
    inputPlaceholder ?? "Ask, adjust rules, or inspect...",
    promptTextWidth,
  );
  const visibleInput = inputValue.length > 0
    ? truncateEnd(inputValue, promptTextWidth)
    : placeholder;

  useEffect(() => {
    const previous = prevRowCount.current;
    const delta = transcriptRows.length - previous;
    if (delta > 0 && scrollOffset > 0) {
      setScrollOffset((prev) => Math.min(prev + delta, Math.max(0, transcriptRows.length - viewportRows)));
    } else if (scrollOffset > viewport.maxScroll) {
      setScrollOffset(viewport.maxScroll);
    }
    prevRowCount.current = transcriptRows.length;
  }, [transcriptRows.length, scrollOffset, viewport.maxScroll, viewportRows]);

  const handleSubmit = useCallback(async () => {
    const value = inputValue.trim();
    if (!value) return;
    setInputValue("");
    setScrollOffset(0);
    await onSend(value);
  }, [inputValue, onSend]);

  useInput((input, key) => {
    if (key.pageUp) {
      setScrollOffset((prev) => Math.min(prev + scrollStep, viewport.maxScroll));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - scrollStep));
      return;
    }

    if (!inputActive || hideInput) return;

    if (key.return) {
      void handleSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      setInputValue((prev) => prev.slice(0, -1));
      return;
    }
    if (
      key.escape
      || key.tab
      || key.upArrow
      || key.downArrow
      || key.leftArrow
      || key.rightArrow
      || key.ctrl
      || isTerminalControlInput(input)
    ) {
      return;
    }

    const printable = input.replace(/[\r\n]/g, "");
    if (printable.length > 0) {
      setInputValue((prev) => `${prev}${printable}`);
    }
  });

  const hasOlder = viewport.start > 0;
  const isAtBottom = viewport.scrollOffset === 0;

  return (
    <Box flexDirection="column" width={panelWidth} flexGrow={1}>
      {hasOlder && (
        <Box paddingX={1} flexShrink={0}>
          <Text dimColor>{truncateEnd(`↑ ${viewport.start} earlier rows · PgUp`, historyWidth)}</Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1} justifyContent="flex-end" width={panelWidth}>
        {viewport.visibleRows.length === 0 && !thinking && (
          <Box flexDirection="column" marginBottom={1} width={messageWidth}>
            <Text color="white" bold>No activity yet</Text>
            <Text dimColor>{truncateEnd("Try: 'check my portfolio' or 'what can you do?'", messageWidth)}</Text>
          </Box>
        )}
        {viewport.visibleRows.map((row) => (
          <TranscriptLine key={row.id} row={row} width={messageWidth} />
        ))}
        {thinking && <ThinkingIndicator width={messageWidth} />}
      </Box>

      {!isAtBottom && (
        <Box paddingX={1} flexShrink={0}>
          <Text dimColor>{truncateEnd(`↓ ${viewport.scrollOffset} newer rows · PgDn`, historyWidth)}</Text>
        </Box>
      )}

      {!hideInput && (
        <Box paddingX={1} paddingY={0} width={panelWidth} flexShrink={0}>
          <Box borderStyle="round" borderColor={inputActive ? "cyan" : "gray"} paddingX={1} width={promptWidth} flexShrink={0}>
            <Text color={inputActive ? "cyan" : "gray"} bold>Prompt</Text>
            <Text dimColor>  </Text>
            {inputActive ? (
              <Box width={promptValueWidth}>
                <Text dimColor={inputValue.length === 0}>{visibleInput}</Text>
                <Text color="cyan">▌</Text>
              </Box>
            ) : (
              <Text dimColor>{truncateEnd("Starting agent session...", promptValueWidth)}</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
