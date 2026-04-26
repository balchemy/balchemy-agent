// src/tui/StatusPanel.tsx — Calm, compact operator surface
import React from "react";
import { Box, Text } from "ink";
import type { StatusData } from "./types.js";
import { getSessionBadge } from "./status-view.js";

function Divider({ width = 24 }: { width?: number }): React.ReactElement {
  return (
    <Box marginY={0}>
      <Text dimColor>{"-".repeat(width)}</Text>
    </Box>
  );
}

function truncateMiddle(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function meter(value: number, max: number, width: number): string {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0, Math.min(value / safeMax, 1));
  const filled = Math.round(ratio * width);
  return `${"=".repeat(filled)}${"-".repeat(Math.max(width - filled, 0))}`;
}

function SectionTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="white" bold>{title}</Text>
      {subtitle && <Text dimColor>{subtitle}</Text>}
    </Box>
  );
}

function StatRow({
  label,
  value,
  valueColor = "white",
}: {
  label: string;
  value: string;
  valueColor?: "white" | "green" | "yellow" | "red" | "cyan";
}): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{label}</Text>
      <Text>  </Text>
      <Text color={valueColor}>{value}</Text>
    </Box>
  );
}

interface StatusPanelProps {
  status: StatusData;
  width?: number;
  compact?: boolean;
}

export function StatusPanel({
  status,
  width = 30,
  compact = false,
}: StatusPanelProps): React.ReactElement {
  const dividerWidth = compact ? 18 : Math.max(width - 4, 18);
  const spendWidth = compact ? 12 : 16;
  const isLowBalance = status.balanceSol < 0.01;
  const sessionBadge = getSessionBadge(status);

  return (
    <Box
      flexDirection="column"
      width={compact ? undefined : width}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      paddingY={0}
    >
      <SectionTitle title="Control" subtitle="health, balances and live limits" />

      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={sessionBadge.tone === "live" ? "green" : sessionBadge.tone === "danger" ? "red" : sessionBadge.tone === "brand" ? "cyan" : "yellow"} bold>
            {sessionBadge.label}
          </Text>
        </Box>
        <Text dimColor>{status.status}</Text>
        {status.provider && (
          <Text dimColor>
            {status.provider} / {truncateMiddle(status.model ?? "default", compact ? 10 : 13, 4)}
          </Text>
        )}
      </Box>

      <Divider width={dividerWidth} />

      <SectionTitle title="Balance" />
      <Box flexDirection="column" marginBottom={1}>
        <Text color="green" bold>{status.balanceSol.toFixed(4)} SOL</Text>
        <Text dimColor>{`$${status.balanceUsd.toFixed(2)} USD`}</Text>
        {isLowBalance && <Text color="yellow">Low balance for live execution</Text>}
      </Box>

      <Divider width={dividerWidth} />

      <SectionTitle title="Wallets" />
      <Box flexDirection="column" marginBottom={1}>
        {status.wallets.map((wallet) => (
          <Box key={wallet.chain}>
            <Text color={wallet.chain === "solana" ? "cyan" : "yellow"} bold>
              {wallet.chain === "solana" ? "SOL" : "BASE"}
            </Text>
            <Text dimColor>  {truncateMiddle(wallet.address, compact ? 8 : 10, 5)}</Text>
          </Box>
        ))}
        {status.wallets.length === 0 && <Text dimColor>No wallets connected yet</Text>}
      </Box>

      <Divider width={dividerWidth} />

      <SectionTitle title="Activity" />
      <Box flexDirection="column" marginBottom={1}>
        <StatRow label="Events" value={String(status.eventsReceived)} valueColor="cyan" />
        <StatRow label="Decisions" value={String(status.decisionsExecuted)} />
        <StatRow label="Trades" value={String(status.tradesExecuted)} valueColor="green" />
        <StatRow label="Uptime" value={formatUptime(status.uptime)} />
      </Box>

      <Divider width={dividerWidth} />

      <SectionTitle title="Positions" />
      <Box flexDirection="column" marginBottom={1}>
        {status.activeTrades.length === 0 && <Text dimColor>No live positions</Text>}
        {status.activeTrades.slice(0, 3).map((trade, index) => (
          <Box key={`${trade.token}-${index}`}>
            <Text color={trade.action === "buy" ? "green" : "red"} bold>
              {trade.action === "buy" ? "BUY" : "SELL"}
            </Text>
            <Text dimColor>
              {"  "}
              {truncateMiddle(trade.token, compact ? 6 : 7, 3)}  {trade.amount}
            </Text>
          </Box>
        ))}
        {status.activeTrades.length > 3 && (
          <Text dimColor>+{status.activeTrades.length - 3} more positions</Text>
        )}
      </Box>

      <Divider width={dividerWidth} />

      <SectionTitle title="LLM Spend" />
      <Box flexDirection="column">
        <Text color="cyan">{meter(status.llmCostToday, status.maxDailyLlmCost, spendWidth)}</Text>
        <Text dimColor>
          {`$${status.llmCostToday.toFixed(2)} used of $${status.maxDailyLlmCost.toFixed(2)}`}
        </Text>
        <Text dimColor>Balance refresh runs every 60s</Text>
      </Box>
    </Box>
  );
}
