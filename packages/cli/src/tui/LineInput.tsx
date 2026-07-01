// src/tui/LineInput.tsx - Single-line Ink input backed by Balchemy's prompt editor.
import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  applyPromptEditorInput,
  getPromptViewport,
  type PromptEditorState,
} from "./ChatPanel.js";
import { truncateEnd } from "./text-layout.js";

const PROMPT_CURSOR = "▌";

interface LineInputProps {
  active?: boolean;
  allowEmptySubmit?: boolean;
  clearOnSubmit?: boolean;
  placeholder?: string;
  width: number;
  onSubmit: (value: string) => void;
}

export function LineInput({
  active = true,
  allowEmptySubmit = false,
  clearOnSubmit = true,
  placeholder = "Enter value...",
  width,
  onSubmit,
}: LineInputProps): React.ReactElement {
  const [state, setState] = useState<PromptEditorState>({ value: "", cursorIndex: 0 });
  const inputWidth = Math.max(4, width);
  const textWidth = Math.max(1, inputWidth - 1);
  const viewport = getPromptViewport(state.value, state.cursorIndex, textWidth);
  const chars = Array.from(viewport.text);
  const beforeCursor = chars.slice(0, viewport.cursorIndex).join("");
  const afterCursor = chars.slice(viewport.cursorIndex).join("");

  const submit = useCallback(() => {
    const value = state.value.trim();
    if (value.length === 0 && !allowEmptySubmit) return;
    if (clearOnSubmit) {
      setState({ value: "", cursorIndex: 0 });
    }
    onSubmit(value);
  }, [allowEmptySubmit, clearOnSubmit, onSubmit, state.value]);

  useInput((input, key) => {
    if (!active) return;
    if (key.return) {
      submit();
      return;
    }
    setState((prev) => applyPromptEditorInput(prev, input, key));
  }, { isActive: active });

  return (
    <Box width={inputWidth}>
      {state.value.length === 0 ? (
        <>
          <Text color="cyan">{active ? PROMPT_CURSOR : " "}</Text>
          <Text dimColor>{truncateEnd(placeholder, textWidth)}</Text>
        </>
      ) : (
        <>
          <Text>{beforeCursor}</Text>
          <Text color="cyan">{active ? PROMPT_CURSOR : " "}</Text>
          <Text>{afterCursor}</Text>
        </>
      )}
    </Box>
  );
}
