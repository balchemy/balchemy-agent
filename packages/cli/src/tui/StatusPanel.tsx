// src/tui/StatusPanel.tsx
import React from "react";
import { Box, Text } from "ink";
import type { StatusData } from "./types.js";

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold dimColor>{title}</Text>
      {children}
    </Box>
  );
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 2) + ".." : s;
}

function formatSol(n: number): string {
  return n.toFixed(4);
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
      width={26}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {/* Balance */}
      <Section title="Balance">
        <Text color="green" bold>{formatSol(status.balanceSol)} SOL</Text>
        <Text dimColor>~${status.balanceUsd.toFixed(2)}</Text>
      </Section>

      {/* Wallets */}
      <Section title="Wallets">
        {status.wallets.map((w) => (
          <Text key={w.chain} dimColor>
            {w.chain === "solana" ? "SOL" : "EVM"}: {truncate(w.address, 16)}
          </Text>
        ))}
        {status.wallets.length === 0 && <Text dimColor>No wallets</Text>}
      </Section>

      {/* Active Trades */}
      <Section title="Active Trades">
        {status.activeTrades.length === 0 && <Text dimColor>None</Text>}
        {status.activeTrades.slice(0, 5).map((t, i) => (
          <Box key={`${t.token}-${i}`}>
            <Text color={t.action === "buy" ? "green" : "red"}>
              {truncate(t.token, 10)} {t.amount}
            </Text>
          </Box>
        ))}
      </Section>

      {/* Recent Tools */}
      <Section title="Recent">
        {status.recentTools.length === 0 && <Text dimColor>No calls yet</Text>}
        {status.recentTools.slice(-5).map((t, i) => (
          <Text key={`${t.name}-${i}`} dimColor>
            {t.success ? "+" : "x"} {truncate(t.name, 12)} {t.durationMs}ms
          </Text>
        ))}
      </Section>

      {/* Stats */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>
          {status.sseConnected ? "*" : "o"} {status.status} | {formatUptime(status.uptime)}
        </Text>
        <Text dimColor>
          {status.eventsReceived} events | {status.tradesExecuted} trades
        </Text>
        <Text dimColor>
          LLM: ${status.llmCostToday.toFixed(4)} / ${status.maxDailyLlmCost}
        </Text>
      </Box>

      {/* Commands */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>Commands</Text>
        <Text dimColor>/stop /new /switch</Text>
        <Text dimColor>/clear /help</Text>
      </Box>
    </Box>
  );
}
