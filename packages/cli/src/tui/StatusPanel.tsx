// src/tui/StatusPanel.tsx
import React from "react";
import { Box, Text } from "ink";
import type { StatusData } from "./types.js";

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">{title}</Text>
      {children}
    </Box>
  );
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 2) + ".." : s;
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
  const statusColor =
    status.status === "running" ? "green" :
    status.status === "starting" ? "yellow" : "red";

  return (
    <Box
      flexDirection="column"
      width={28}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {/* Connection + Agent Status */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={status.sseConnected ? "green" : "yellow"} bold>
            {status.sseConnected ? "\u25cf" : "\u25cb"}{" "}
          </Text>
          <Text color={status.sseConnected ? "green" : "yellow"}>
            {status.sseConnected ? "Connected" : "Connecting"}
          </Text>
        </Box>
        <Box>
          <Text color={statusColor} bold>
            {status.status === "running" ? "\u25b6" : "\u25a0"}{" "}
          </Text>
          <Text color={statusColor}>{status.status}</Text>
        </Box>
      </Box>

      {/* LLM Info */}
      {status.provider && (
        <Section title="LLM">
          <Text dimColor>{status.provider}</Text>
          <Text dimColor>{truncate(status.model ?? "default", 22)}</Text>
        </Section>
      )}

      {/* Balance */}
      <Section title="Balance">
        <Text color="green" bold>{status.balanceSol.toFixed(4)} SOL</Text>
        <Text dimColor>~${status.balanceUsd.toFixed(2)}</Text>
      </Section>

      {/* Wallets */}
      <Section title="Wallets">
        {status.wallets.map((w) => (
          <Text key={w.chain} dimColor>
            {w.chain === "solana" ? "SOL" : "EVM"} {truncate(w.address, 16)}
          </Text>
        ))}
        {status.wallets.length === 0 && <Text dimColor>-</Text>}
      </Section>

      {/* Active Trades */}
      <Section title="Trades">
        {status.activeTrades.length === 0 && <Text dimColor>-</Text>}
        {status.activeTrades.slice(0, 3).map((t, i) => (
          <Text key={`${t.token}-${i}`} color={t.action === "buy" ? "green" : "red"}>
            {t.action === "buy" ? "+" : "-"} {truncate(t.token, 10)} {t.amount}
          </Text>
        ))}
        {status.activeTrades.length > 3 && (
          <Text dimColor>+{status.activeTrades.length - 3} more</Text>
        )}
      </Section>

      {/* Recent Tools */}
      {status.recentTools.length > 0 && (
        <Section title="Tools">
          {status.recentTools.slice(-3).map((t, i) => (
            <Text key={`tool-${i}`} dimColor>
              {t.success ? "\u2713" : "\u2717"} {truncate(t.name, 14)} {t.durationMs}ms
            </Text>
          ))}
        </Section>
      )}

      {/* Stats */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{status.eventsReceived} events</Text>
        <Text dimColor>{status.tradesExecuted} trades</Text>
        <Text dimColor>${status.llmCostToday.toFixed(4)} / ${status.maxDailyLlmCost}</Text>
        <Text dimColor>{formatUptime(status.uptime)} uptime</Text>
      </Box>

      {/* Help */}
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>Commands</Text>
        <Text dimColor>/settings /clear</Text>
        <Text dimColor>/stop /help</Text>
      </Box>
    </Box>
  );
}
