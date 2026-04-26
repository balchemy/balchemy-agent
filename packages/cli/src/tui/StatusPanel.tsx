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

interface StatusPanelProps {
  status: StatusData;
  width?: number;
  compact?: boolean;
  height?: number;
}

function toneColor(tone: ReturnType<typeof getSessionBadge>["tone"]): "green" | "red" | "cyan" | "yellow" {
  if (tone === "live") return "green";
  if (tone === "danger") return "red";
  if (tone === "brand") return "cyan";
  return "yellow";
}

function Header({ title }: { title: string }): React.ReactElement {
  return <Text color="white" bold>{title}</Text>;
}

export function StatusPanel({
  status,
  width = 30,
  compact = false,
  height,
}: StatusPanelProps): React.ReactElement {
  const dividerWidth = compact ? 18 : Math.max(width - 4, 18);
  const spendWidth = compact ? 12 : 16;
  const isLowBalance = status.balanceSol < 0.01;
  const sessionBadge = getSessionBadge(status);
  const shortLayout = height !== undefined && height < 22;
  const walletRows = status.wallets.slice(0, 2);
  const positionRows = status.activeTrades.slice(0, 2);

  if (shortLayout) {
    return (
      <Box
        flexDirection="column"
        width={compact ? undefined : width}
        height={height}
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        paddingY={0}
        overflowY="hidden"
      >
        <Box>
          <Text color={toneColor(sessionBadge.tone)} bold>{sessionBadge.label}</Text>
          <Text dimColor>  {status.status}</Text>
        </Box>
        <Text dimColor>
          {status.provider ? `${status.provider} / ${truncateMiddle(status.model ?? "default", compact ? 10 : 13, 4)}` : "provider pending"}
        </Text>

        <Box>
          <Text color="green" bold>{status.balanceSol.toFixed(4)} SOL</Text>
          <Text dimColor>  ${status.balanceUsd.toFixed(2)}</Text>
        </Box>
        {isLowBalance && <Text color="yellow">Fund before live execution</Text>}

        <Box marginTop={1}>
          <Text color="white" bold>Wallets</Text>
          {walletRows.length === 0 && <Text dimColor>  pending setup</Text>}
        </Box>
        {walletRows.map((wallet) => (
          <Box key={`${wallet.chain}-${wallet.address}`}>
            <Text color={wallet.chain === "solana" ? "cyan" : "yellow"} bold>
              {wallet.chain === "solana" ? "SOL" : "BASE"}
            </Text>
            <Text dimColor>  {truncateMiddle(wallet.address, compact ? 8 : 10, 5)}</Text>
          </Box>
        ))}

        <Box marginTop={1}>
          <Text color="cyan">E {status.eventsReceived}</Text>
          <Text dimColor>  D {status.decisionsExecuted}  </Text>
          <Text color="green">T {status.tradesExecuted}</Text>
          <Text dimColor>  {formatUptime(status.uptime)}</Text>
        </Box>

        <Box marginTop={1}>
          <Text color="white" bold>Positions</Text>
          {positionRows.length === 0 && <Text dimColor>  none</Text>}
        </Box>
        {positionRows.map((trade) => (
          <Box key={`${trade.token}-${trade.action}-${trade.amount}-${trade.timestamp}`}>
            <Text color={trade.action === "buy" ? "green" : "red"} bold>
              {trade.action === "buy" ? "BUY" : "SELL"}
            </Text>
            <Text dimColor>  {truncateMiddle(trade.token, compact ? 6 : 7, 3)}  {trade.amount}</Text>
          </Box>
        ))}

        <Box marginTop={1}>
          <Text color="cyan">{meter(status.llmCostToday, status.maxDailyLlmCost, spendWidth)}</Text>
          <Text dimColor>  ${status.llmCostToday.toFixed(2)} / ${status.maxDailyLlmCost.toFixed(2)}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={compact ? undefined : width}
      height={height}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      paddingY={0}
      overflowY="hidden"
    >
      <Box flexDirection="column">
        <Box>
          <Text color={toneColor(sessionBadge.tone)} bold>{sessionBadge.label}</Text>
          <Text dimColor>  {status.status}</Text>
        </Box>
        <Text dimColor>
          {status.provider ? `${status.provider} / ${truncateMiddle(status.model ?? "default", compact ? 10 : 13, 4)}` : "provider pending"}
        </Text>
      </Box>

      <Divider width={dividerWidth} />

      <Header title="Capital" />
      <Box>
        <Text color="green" bold>{status.balanceSol.toFixed(4)} SOL</Text>
        <Text dimColor>  ${status.balanceUsd.toFixed(2)}</Text>
      </Box>
      {isLowBalance && <Text color="yellow">Fund before live execution</Text>}

      <Divider width={dividerWidth} />

      <Header title="Wallets" />
      {status.wallets.length === 0 ? (
        <Text dimColor>pending setup</Text>
      ) : (
        walletRows.map((wallet) => (
          <Box key={`${wallet.chain}-${wallet.address}`}>
            <Text color={wallet.chain === "solana" ? "cyan" : "yellow"} bold>
              {wallet.chain === "solana" ? "SOL" : "BASE"}
            </Text>
            <Text dimColor>  {truncateMiddle(wallet.address, compact ? 8 : 10, 5)}</Text>
          </Box>
        ))
      )}

      <Divider width={dividerWidth} />

      <Header title="Runtime" />
      <Box>
        <Text color="cyan">E {status.eventsReceived}</Text>
        <Text dimColor>  D {status.decisionsExecuted}  </Text>
        <Text color="green">T {status.tradesExecuted}</Text>
      </Box>
      <Text dimColor>Uptime {formatUptime(status.uptime)}</Text>

      <Divider width={dividerWidth} />

      <Header title="Positions" />
      {status.activeTrades.length === 0 && <Text dimColor>No live positions</Text>}
      {positionRows.map((trade) => (
        <Box key={`${trade.token}-${trade.action}-${trade.amount}-${trade.timestamp}`}>
          <Text color={trade.action === "buy" ? "green" : "red"} bold>
            {trade.action === "buy" ? "BUY" : "SELL"}
          </Text>
          <Text dimColor>  {truncateMiddle(trade.token, compact ? 6 : 7, 3)}  {trade.amount}</Text>
        </Box>
      ))}
      {status.activeTrades.length > 2 && <Text dimColor>+{status.activeTrades.length - 2} more</Text>}

      <Divider width={dividerWidth} />

      <Header title="LLM" />
      <Text color="cyan">{meter(status.llmCostToday, status.maxDailyLlmCost, spendWidth)}</Text>
      <Text dimColor>{`$${status.llmCostToday.toFixed(2)} / $${status.maxDailyLlmCost.toFixed(2)}`}</Text>
    </Box>
  );
}
