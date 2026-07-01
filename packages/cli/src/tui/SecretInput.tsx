// src/tui/SecretInput.tsx — Masked text input for API keys and secrets
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface SecretInputProps {
  placeholder?: string;
  mask?: string;
  onSubmit: (value: string) => void;
}

export function SecretInput({
  placeholder = "Paste secret...",
  mask = "•",
  onSubmit,
}: SecretInputProps): React.ReactElement {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    // Ignore control keys
    if (key.ctrl || key.meta || key.escape) return;
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    if (key.pageUp || key.pageDown || key.tab) return;

    if (input) {
      setValue((prev) => prev + input);
    }
  });

  const display = value.length > 0
    ? mask.repeat(Math.min(value.length, 40)) + (value.length > 40 ? "…" : "")
    : "";

  return (
    <Box>
      {display ? (
        <Text color="white">{display}</Text>
      ) : (
        <Text dimColor>{placeholder}</Text>
      )}
    </Box>
  );
}
