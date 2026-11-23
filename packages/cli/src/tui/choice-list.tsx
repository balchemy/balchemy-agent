/** A vertical choice list for the terminal: up/down to move, Enter to choose, and typing to filter by name (large provider
 * catalogs). The pure state functions below hold every rule; the component only renders and forwards keys. */
import React from "react";
import { Box, Text } from "ink";
import type { PromptInputKey } from "./ChatPanel.js";
import { wrapText } from "./text-layout.js";

export interface Choice { value: string; label: string; hint?: string }
export type ChoiceKey = PromptInputKey & { pageUp?: boolean; pageDown?: boolean };
export interface ChoiceListState { query: string; index: number }
export const EMPTY_CHOICE_STATE: ChoiceListState = Object.freeze({ query: "", index: 0 });
const MAX_QUERY = 80;

/** Every whitespace-separated word of the query must appear (case-insensitive) in the label, value or hint. Pinned choices
 * (such as "type an ID") always stay at the end, whatever the filter. */
export function filterChoices(choices: readonly Choice[], query: string, pinned: readonly Choice[] = []): Choice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length ? choices.filter((choice) => {
    const text = `${choice.label} ${choice.value} ${choice.hint ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }) : [...choices];
  return [...matches, ...pinned];
}

/** One key press. `count` is the number of choices currently shown; `submit` is set only for Enter on an existing choice. */
export function applyChoiceInput(state: ChoiceListState, input: string, key: ChoiceKey, count: number, filterable = true): { state: ChoiceListState; submit?: true } {
  const last = Math.max(0, count - 1);
  if (key.return) return count > 0 ? { state: { ...state, index: Math.min(state.index, last) }, submit: true } : { state };
  if (key.upArrow) return { state: { ...state, index: state.index <= 0 ? last : state.index - 1 } };
  if (key.downArrow) return { state: { ...state, index: state.index >= last ? 0 : state.index + 1 } };
  if (key.pageUp) return { state: { ...state, index: Math.max(0, state.index - 10) } };
  if (key.pageDown) return { state: { ...state, index: Math.min(last, state.index + 10) } };
  if (key.home) return { state: { ...state, index: 0 } };
  if (key.end) return { state: { ...state, index: last } };
  if (!filterable) return { state };
  const erase = key.backspace || key.delete || input === "\u0008" || input === "\u007f";
  if (erase) return { state: { query: Array.from(state.query).slice(0, -1).join(""), index: 0 } };
  if (key.ctrl || key.meta || key.escape || key.tab || key.leftArrow || key.rightArrow || !input) return { state };
  // Printable text only; a paste of control sequences changes nothing.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(input)) return { state };
  const query = Array.from(state.query + input).slice(0, MAX_QUERY).join("");
  return { state: { query, index: 0 } };
}

/** The rows to draw: a window of at most `rows` choices that keeps the selected one visible. */
export function choiceWindow(count: number, index: number, rows: number): { start: number; end: number } {
  const size = Math.max(1, rows);
  if (count <= size) return { start: 0, end: count };
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), count - size);
  return { start, end: start + size };
}

export function ChoiceListView({ choices, state, width, rows, filterable, total, noun, pinned = 0 }: { choices: readonly Choice[]; state: ChoiceListState; width: number;
  rows: number; filterable: boolean; total: number; noun: string; pinned?: number }): React.ReactElement {
  const index = Math.min(state.index, Math.max(0, choices.length - 1));
  const { start, end } = choiceWindow(choices.length, index, rows);
  const line = (text: string) => wrapText(text, width)[0] ?? "";
  return <Box flexDirection="column" width={width}>
    {filterable && <Text>{line(`Search: ${state.query}`)}<Text color="cyan">▌</Text></Text>}
    {choices.slice(start, end).map((choice, offset) => {
      const selected = start + offset === index;
      const text = line(`${selected ? "›" : " "} ${choice.label}${choice.hint && choice.hint !== choice.label ? `  ${choice.hint}` : ""}`);
      return <Text key={`${start + offset}:${choice.value}`} color={selected ? "cyan" : undefined}>{text}</Text>;
    })}
    {choices.length === pinned && filterable && state.query.length > 0 && <Text dimColor>{line("Nothing matches. Erase some letters.")}</Text>}
    <Text dimColor>{line(filterable ? `${Math.max(0, choices.length - pinned)} of ${total} ${noun} · type to search · ↑↓ move · Enter choose`
      : "↑↓ move · Enter choose")}</Text>
  </Box>;
}
