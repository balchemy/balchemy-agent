// src/tui/StatusPanel.tsx — Modernized with cleaner sections
import React from "react";
import { Box, Text } from "ink";
import type { StatusData } from "./types.js";

function Divider(): React.ReactElement {
  return (
    <Box marginY={0}>
      <Text dimColor>{"\u2500".repeat(24)}</Text>
    </Box>
  );
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 1) + "\u2026" : s;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

interface StatusPanelProps {
  status: StatusData;
}

export function StatusPanel({ status }: StatusPanelProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={28}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      {/* Connection */}
      <Box flexDirection="column">
        <Box>
          <Text color={status.sseConnected ? "green" : "yellow"} bold>
            {status.sseConnected ? "\u25cf" : "\u25cb"}{" "}
          </Text>
          <Text color={status.sseConnected ? "green" : "yellow"} bold>
            {status.sseConnected ? "Connected" : "Connecting"}
          </Text>
        </Box>
        <Text dimColor>  {status.status}</Text>
      </Box>

      <Divider />

      {/* LLM */}
      {status.provider && (
        <>
          <Box flexDirection="column">
            <Text dimColor>{status.provider}/{truncate(status.model ?? "default", 16)}</Text>
          </Box>
          <Divider />
        </>
      )}

      {/* Balance */}
      <Box flexDirection="column">
        <Text color="green" bold>{status.balanceSol.toFixed(4)} SOL</Text>
        <Text dimColor>~${status.balanceUsd.toFixed(2)}</Text>
      </Box>

      <Divider />

      {/* Wallets */}
      <Box flexDirection="column">
        {status.wallets.map((w) => (
          <Text key={w.chain} dimColor>
            {w.chain === "solana" ? "\u25c6" : "\u25c7"} {truncate(w.address, 18)}
          </Text>
        ))}
        {status.wallets.length === 0 && <Text dimColor>No wallets</Text>}
      </Box>

      <Divider />

      {/* Trades */}
      <Box flexDirection="column">
        {status.activeTrades.length === 0 && <Text dimColor>No trades</Text>}
        {status.activeTrades.slice(0, 3).map((t, i) => (
          <Text key={`${t.token}-${i}`} color={t.action === "buy" ? "green" : "red"}>
            {t.action === "buy" ? "\u25b2" : "\u25bc"} {truncate(t.token, 10)} {t.amount}
          </Text>
        ))}
        {status.activeTrades.length > 3 && (
          <Text dimColor>+{status.activeTrades.length - 3} more</Text>
        )}
      </Box>

      <Divider />

      {/* Stats */}
      <Box flexDirection="column">
        <Text dimColor>{status.eventsReceived} events {"\u00b7"} {status.tradesExecuted} trades</Text>
        <Text dimColor>${status.llmCostToday.toFixed(3)} / ${status.maxDailyLlmCost}</Text>
        <Text dimColor>{formatUptime(status.uptime)} uptime</Text>
      </Box>

      {/* Shortcuts */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>^S settings ^L clear</Text>
        <Text dimColor>^Q quit    ^N new</Text>
      </Box>
    </Box>
  );
}
