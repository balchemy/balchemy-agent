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

export interface BuildTranscriptRowsOptions {
  compactSystemRows?: boolean;
}

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

  if (text.startsWith("Degraded:")) {
    return {
      label: "DEGRADED",
      color: "yellow",
      body: text.replace(/^Degraded:\s*/, ""),
    };
  }

  if (text.startsWith("Blocked:")) {
    return {
      label: "BLOCKED",
      color: "red",
      body: text.replace(/^Blocked:\s*/, ""),
    };
  }

  if (text.startsWith("Approval required:")) {
    return {
      label: "APPROVAL",
      color: "yellow",
      body: text.replace(/^Approval required:\s*/, ""),
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
      if (msg.action === "buy") return { label: "BUY", color: "green", bold: true };
      if (msg.action === "sell") return { label: "SELL", color: "red", bold: true };
      return { label: "TRADE", color: "yellow", bold: true };
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

export function buildTranscriptRows(
  messages: ChatMessage[],
  width: number,
  options: BuildTranscriptRowsOptions = {},
): TranscriptRow[] {
  const messageWidth = Math.max(8, width);
  const bodyWidth = Math.max(8, messageWidth - 1);
  const compactSystemRows = options.compactSystemRows ?? true;
  const rows: TranscriptRow[] = [];

  for (const msg of messages) {
    if (msg.type === "system") {
      if (compactSystemRows) {
        rows.push(buildSystemRow(msg, messageWidth));
        continue;
      }

      const meta = getSystemMeta(msg.text);
      rows.push({
        kind: "header",
        id: `${msg.id}:system:header`,
        label: meta.label,
        labelColor: meta.color,
        time: formatTime(msg.timestamp),
      });
      wrapText(meta.body, bodyWidth).forEach((line, index) => {
        rows.push({
          kind: "body",
          id: `${msg.id}:system:body:${index}`,
          text: line,
          color: "white",
        });
      });
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

export function formatTranscriptPlainText(messages: ChatMessage[]): string {
  return messages
    .map((msg) => {
      if (msg.type === "system") {
        const meta = getSystemMeta(msg.text);
        return `${meta.label}  ${formatTime(msg.timestamp)}\n${meta.body}`;
      }

      const style = messageStyle(msg);
      const label = style.label;
      const body = msg.text;
      return `${label}  ${formatTime(msg.timestamp)}\n${body}`;
    })
    .join("\n\n");
}

export function getPromptViewport(
  value: string,
  cursorIndex: number,
  maxWidth: number,
): { text: string; cursorIndex: number } {
  const chars = Array.from(value);
  const cursor = Math.min(Math.max(0, cursorIndex), chars.length);
  const width = Math.max(1, maxWidth);
  let start = Math.max(0, cursor - width + 1);
  let end = Math.min(chars.length, start + width);

  while (cursor > end) {
    start += 1;
    end += 1;
  }
  while (displayWidth(chars.slice(start, end).join("")) > width && start < cursor) {
    start += 1;
  }
  while (displayWidth(chars.slice(start, end).join("")) > width && end > cursor) {
    end -= 1;
  }

  return {
    text: chars.slice(start, end).join(""),
    cursorIndex: cursor - start,
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

const CSI_FRAGMENT_PATTERN = /^(?:\[(?:5|6)(?:;\d+)?~?|\[(?:5|6)|(?:5|6)(?:;\d+)?~|\[\d*[A-Za-z~]|O[A-Za-z])$/;
const PROMPT_CURSOR = "▌";

export interface PromptEditorState {
  value: string;
  cursorIndex: number;
}

export interface PromptInputKey {
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  home?: boolean;
  end?: boolean;
  escape?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export function isTerminalControlInput(input: string): boolean {
  const value = input.replace(/[\r\n]/g, "");
  if (value.length === 0) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return CSI_FRAGMENT_PATTERN.test(value);
}

function isBackspaceInput(input: string): boolean {
  return input === "\u0008" || input === "\u007f";
}

function isDeleteInput(input: string): boolean {
  const value = input.replace(/\u001b/g, "");
  return value === "[3~"
    || value === "3~"
    || /^\[3(?:;\d+)*~$/.test(value)
    || /^3(?:;\d+)*~$/.test(value);
}

function isBackspaceKey(input: string, key: PromptInputKey): boolean {
  if (key.backspace || isBackspaceInput(input)) return true;
  // In macOS terminals the physical Backspace key is often DEL/Delete at the
  // protocol layer. Keep Balchemy's prompt behavior simple: every erase key
  // removes the character left of the cursor.
  return key.delete === true || isDeleteInput(input);
}

export function isTranscriptPageUpInput(input: string): boolean {
  const value = input.replace(/\u001b/g, "");
  return value === "[5"
    || value === "[5~"
    || value === "5~"
    || /^\[5(?:;\d+)*~?$/.test(value)
    || /^5(?:;\d+)*~$/.test(value);
}

export function isTranscriptPageDownInput(input: string): boolean {
  const value = input.replace(/\u001b/g, "");
  return value === "[6"
    || value === "[6~"
    || value === "6~"
    || /^\[6(?:;\d+)*~?$/.test(value)
    || /^6(?:;\d+)*~$/.test(value);
}

export function applyPromptEditorInput(
  state: PromptEditorState,
  input: string,
  key: PromptInputKey,
): PromptEditorState {
  const chars = Array.from(state.value);
  const cursor = Math.min(Math.max(0, state.cursorIndex), chars.length);

  if (key.return) {
    return { value: chars.join(""), cursorIndex: cursor };
  }

  if (isBackspaceKey(input, key)) {
    if (cursor === 0) return { value: chars.join(""), cursorIndex: cursor };
    chars.splice(cursor - 1, 1);
    return { value: chars.join(""), cursorIndex: cursor - 1 };
  }

  if (key.leftArrow) {
    return {
      value: chars.join(""),
      cursorIndex: key.meta ? previousWordStart(chars, cursor) : Math.max(0, cursor - 1),
    };
  }

  if (key.rightArrow) {
    return {
      value: chars.join(""),
      cursorIndex: key.meta ? nextWordEnd(chars, cursor) : Math.min(chars.length, cursor + 1),
    };
  }

  if ((input === "a" && key.ctrl) || key.home) {
    return { value: chars.join(""), cursorIndex: 0 };
  }

  if ((input === "e" && key.ctrl) || key.end) {
    return { value: chars.join(""), cursorIndex: chars.length };
  }

  if (input === "u" && key.ctrl) {
    chars.splice(0, cursor);
    return { value: chars.join(""), cursorIndex: 0 };
  }

  if (input === "k" && key.ctrl) {
    chars.splice(cursor);
    return { value: chars.join(""), cursorIndex: cursor };
  }

  if (input === "w" && key.ctrl) {
    const start = previousWordStart(chars, cursor);
    chars.splice(start, cursor - start);
    return { value: chars.join(""), cursorIndex: start };
  }

  if (key.escape || key.tab || key.upArrow || key.downArrow || key.ctrl || key.meta) {
    return { value: chars.join(""), cursorIndex: cursor };
  }

  if (isTerminalControlInput(input)) {
    return { value: chars.join(""), cursorIndex: cursor };
  }

  const printable = input.replace(/[\r\n]+/g, " ");
  if (printable.length === 0) {
    return { value: chars.join(""), cursorIndex: cursor };
  }

  const inserted = Array.from(printable);
  chars.splice(cursor, 0, ...inserted);
  return { value: chars.join(""), cursorIndex: cursor + inserted.length };
}

function ThinkingIndicator({ width }: { width: number }): React.ReactElement {
  return (
    <Box marginBottom={0} width={width}>
      <Text color="cyan" bold>AI</Text>
      <Text dimColor>  </Text>
      <Text color="cyan">...</Text>
    </Box>
  );
}

const MIN_SCROLL_STEP = 6;
const MIN_ARROW_SCROLL_STEP = 1;

function previousWordStart(chars: string[], cursor: number): number {
  let index = Math.max(0, cursor);
  while (index > 0 && /\s/.test(chars[index - 1] ?? "")) index -= 1;
  while (index > 0 && !/\s/.test(chars[index - 1] ?? "")) index -= 1;
  return index;
}

function nextWordEnd(chars: string[], cursor: number): number {
  let index = Math.min(chars.length, cursor);
  while (index < chars.length && /\s/.test(chars[index] ?? "")) index += 1;
  while (index < chars.length && !/\s/.test(chars[index] ?? "")) index += 1;
  return index;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void | Promise<void>;
  inputActive: boolean;
  hideInput?: boolean;
  pageSize?: number;
  inputPlaceholder?: string;
  width: number;
  thinking?: boolean;
  scrollActive?: boolean;
  arrowScroll?: boolean;
  copyMode?: boolean;
}

function ChatPanelComponent({
  messages,
  onSend,
  inputActive,
  hideInput = false,
  pageSize = 30,
  inputPlaceholder,
  width,
  thinking = false,
  scrollActive = true,
  arrowScroll = false,
  copyMode = false,
}: ChatPanelProps): React.ReactElement {
  const [promptState, setPromptState] = useState<PromptEditorState>({ value: "", cursorIndex: 0 });
  const [scrollOffset, setScrollOffset] = useState(0);
  const prevRowCount = useRef(0);
  const suppressControlFragmentsUntil = useRef(0);
  const panelWidth = Math.max(18, width);
  const horizontalPadding = copyMode ? 0 : 1;
  const historyWidth = Math.max(8, panelWidth - (copyMode ? 0 : 2));
  const messageWidth = Math.max(8, historyWidth);
  const promptWidth = Math.max(14, panelWidth - 2);
  const promptLabelWidth = 8;
  const promptContentWidth = Math.max(8, promptWidth - 4);
  const promptValueWidth = Math.max(4, promptContentWidth - promptLabelWidth);
  const viewportRows = Math.max(1, pageSize);
  const thinkingRows = thinking ? 1 : 0;
  const transcriptViewportRows = Math.max(1, viewportRows - thinkingRows);
  const transcriptRows = buildTranscriptRows(messages, messageWidth, {
    compactSystemRows: !copyMode,
  });
  const viewport = getTranscriptViewport(transcriptRows, transcriptViewportRows, scrollOffset);
  const scrollStep = Math.max(MIN_SCROLL_STEP, transcriptViewportRows - 1);
  const promptTextWidth = Math.max(1, promptValueWidth - 1);
  const placeholder = truncateEnd(
    inputPlaceholder ?? "Ask, adjust rules, or inspect...",
    promptTextWidth,
  );
  const inputValue = promptState.value;
  const cursorIndex = promptState.cursorIndex;
  const promptViewport = getPromptViewport(inputValue, cursorIndex, promptTextWidth);
  const promptChars = Array.from(promptViewport.text);
  const promptBeforeCursor = promptChars.slice(0, promptViewport.cursorIndex).join("");
  const promptAfterCursor = promptChars.slice(promptViewport.cursorIndex).join("");

  useEffect(() => {
    const previous = prevRowCount.current;
    const delta = transcriptRows.length - previous;
    if (delta > 0 && scrollOffset > 0) {
      setScrollOffset((prev) => Math.min(prev + delta, Math.max(0, transcriptRows.length - transcriptViewportRows)));
    } else if (scrollOffset > viewport.maxScroll) {
      setScrollOffset(viewport.maxScroll);
    }
    prevRowCount.current = transcriptRows.length;
  }, [transcriptRows.length, scrollOffset, viewport.maxScroll, transcriptViewportRows]);

  const handleSubmit = useCallback(async () => {
    const value = inputValue.trim();
    if (!value) return;
    setPromptState({ value: "", cursorIndex: 0 });
    setScrollOffset(0);
    await onSend(value);
  }, [inputValue, onSend]);

  useInput((input, key) => {
    if (scrollActive && (key.pageUp || isTranscriptPageUpInput(input))) {
      suppressControlFragmentsUntil.current = Date.now() + 120;
      setScrollOffset((prev) => Math.min(prev + scrollStep, viewport.maxScroll));
      return;
    }
    if (scrollActive && (key.pageDown || isTranscriptPageDownInput(input))) {
      suppressControlFragmentsUntil.current = Date.now() + 120;
      setScrollOffset((prev) => Math.max(0, prev - scrollStep));
      return;
    }
    if (scrollActive && arrowScroll && key.upArrow) {
      suppressControlFragmentsUntil.current = Date.now() + 120;
      setScrollOffset((prev) => Math.min(prev + MIN_ARROW_SCROLL_STEP, viewport.maxScroll));
      return;
    }
    if (scrollActive && arrowScroll && key.downArrow) {
      suppressControlFragmentsUntil.current = Date.now() + 120;
      setScrollOffset((prev) => Math.max(0, prev - MIN_ARROW_SCROLL_STEP));
      return;
    }

    if (!inputActive || hideInput) return;

    if (key.return) {
      void handleSubmit();
      return;
    }

    const now = Date.now();
    const likelyControlFragment = now < suppressControlFragmentsUntil.current
      && /^[\[\]0-9;~A-Za-zO]+$/.test(input.replace(/[\r\n]/g, ""));
    if (likelyControlFragment && !key.backspace && !key.delete && !key.leftArrow && !key.rightArrow) {
      return;
    }

    if (
      key.escape
      || key.tab
      || key.upArrow
      || key.downArrow
      || (key.ctrl && input !== "a" && input !== "e" && input !== "u" && input !== "k" && input !== "w")
    ) {
      suppressControlFragmentsUntil.current = Date.now() + 120;
      return;
    }

    if (key.leftArrow || key.rightArrow) {
      suppressControlFragmentsUntil.current = Date.now() + 120;
    }

    setPromptState((prev) => applyPromptEditorInput(prev, input, key));
  }, { isActive: scrollActive || !hideInput });

  const hasOlder = viewport.start > 0;
  const isAtBottom = viewport.scrollOffset === 0;

  return (
    <Box flexDirection="column" width={panelWidth} flexGrow={1}>
      {hasOlder && (
        <Box paddingX={horizontalPadding} flexShrink={0}>
          <Text dimColor>{truncateEnd(`${viewport.start} older rows · PgUp`, historyWidth)}</Text>
        </Box>
      )}

      <Box
        flexDirection="column"
        height={viewportRows}
        flexShrink={0}
        overflowY="hidden"
        paddingX={horizontalPadding}
        justifyContent="flex-end"
        width={panelWidth}
      >
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
        <Box paddingX={horizontalPadding} flexShrink={0}>
          <Text dimColor>{truncateEnd(`${viewport.scrollOffset} newer rows · PgDn`, historyWidth)}</Text>
        </Box>
      )}

      {!hideInput && (
        <Box paddingX={1} paddingY={0} width={panelWidth} height={3} flexShrink={0}>
          <Box borderStyle="round" borderColor={inputActive ? "cyan" : "gray"} paddingX={1} width={promptWidth} height={3} flexShrink={0}>
            <Text color={inputActive ? "cyan" : "gray"} bold>Prompt</Text>
            <Text dimColor>  </Text>
            {inputActive ? (
              <Box width={promptValueWidth}>
                {inputValue.length === 0 ? (
                  <>
                    <Text color="cyan">{PROMPT_CURSOR}</Text>
                    <Text dimColor>{placeholder}</Text>
                  </>
                ) : (
                  <>
                    <Text>{promptBeforeCursor}</Text>
                    <Text color="cyan">{PROMPT_CURSOR}</Text>
                    <Text>{promptAfterCursor}</Text>
                  </>
                )}
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

export const ChatPanel = React.memo(ChatPanelComponent);
