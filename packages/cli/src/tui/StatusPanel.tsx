// src/tui/StatusPanel.tsx — Calm, compact operator surface
import React from "react";
import { Box, Text } from "ink";
import type { StatusData, WalletInfo } from "./types.js";
import { getSessionBadge } from "./status-view.js";
import { displayWidth, truncateMiddle } from "./text-layout.js";

function SectionGap(): React.ReactElement {
  return <Box height={1} />;
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

function fitText(value: string, width: number): string {
  return truncateMiddle(value, Math.max(0, width));
}

export function walletLabel(chain: WalletInfo["chain"]): string {
  return chain === "solana" ? "SOL" : "BASE";
}

function walletRowParts(wallet: WalletInfo, width: number): { label: string; separator: string; address: string } {
  const label = walletLabel(wallet.chain);
  const labelWidth = displayWidth(label);
  const separator = width - labelWidth >= 5 ? "  " : " ";
  const addressWidth = Math.max(0, width - labelWidth - displayWidth(separator));
  return {
    label: fitText(label, width),
    separator: addressWidth > 0 ? separator : "",
    address: addressWidth > 0 ? truncateMiddle(wallet.address, addressWidth) : "",
  };
}

export function formatWalletRow(wallet: WalletInfo, width: number): string {
  const row = walletRowParts(wallet, width);
  return `${row.label}${row.separator}${row.address}`;
}

function WalletRow({
  wallet,
  width,
}: {
  wallet: WalletInfo;
  width: number;
}): React.ReactElement {
  const color = wallet.chain === "solana" ? "cyan" : "yellow";
  const row = walletRowParts(wallet, width);

  return (
    <Box key={`${wallet.chain}-${wallet.address}`} width={width}>
      <Text color={color} bold>{row.label}</Text>
      {row.address.length > 0 && <Text dimColor>{row.separator}{row.address}</Text>}
    </Box>
  );
}

export function selectWalletRows(wallets: WalletInfo[], limit: number): WalletInfo[] {
  const rows: WalletInfo[] = [];
  const solana = wallets.find((wallet) => wallet.chain === "solana");
  const evm = wallets.find((wallet) => wallet.chain === "base");

  if (solana) rows.push(solana);
  if (evm) rows.push(evm);

  for (const wallet of wallets) {
    if (rows.length >= limit) break;
    if (!rows.some((existing) => existing.chain === wallet.chain && existing.address === wallet.address)) {
      rows.push(wallet);
    }
  }

  return rows.slice(0, limit);
}

export function StatusPanel({
  status,
  width = 30,
  compact = false,
  height,
}: StatusPanelProps): React.ReactElement {
  const panelWidth = Math.max(18, width);
  const contentWidth = Math.max(6, panelWidth - 4);
  const spendWidth = Math.min(compact ? 12 : 16, Math.max(8, contentWidth));
  const isLowBalance = status.balanceSol < 0.01;
  const sessionBadge = getSessionBadge(status);
  const shortLayout = height !== undefined && height < 22;
  const walletRows = selectWalletRows(status.wallets, 2);
  const positionRows = status.activeTrades.slice(0, 2);
  const statusTextWidth = Math.max(0, contentWidth - displayWidth(sessionBadge.label) - 2);
  const statusText = fitText(status.status, statusTextWidth);
  const providerText = status.provider
    ? fitText(`${status.provider} / ${status.model ?? "default"}`, contentWidth)
    : fitText("provider pending", contentWidth);
  const capitalText = fitText(`${status.balanceSol.toFixed(4)} SOL  $${status.balanceUsd.toFixed(2)}`, contentWidth);
  const lowBalanceText = fitText("Fund before live", contentWidth);
  const runtimeText = fitText(`E ${status.eventsReceived}  D ${status.decisionsExecuted}  T ${status.tradesExecuted}`, contentWidth);
  const runtimeWithUptime = fitText(`E ${status.eventsReceived}  D ${status.decisionsExecuted}  T ${status.tradesExecuted}  ${formatUptime(status.uptime)}`, contentWidth);
  const llmSpendText = `$${status.llmCostToday.toFixed(2)} / $${status.maxDailyLlmCost.toFixed(2)}`;
  const inlineSpendWidth = Math.max(0, contentWidth - spendWidth - 2);

  if (shortLayout) {
    return (
      <Box
        flexDirection="column"
        width={panelWidth}
        height={height}
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        paddingY={0}
        overflowY="hidden"
      >
        <Box>
          <Text color={toneColor(sessionBadge.tone)} bold>{sessionBadge.label}</Text>
          {statusText.length > 0 && <Text dimColor>  {statusText}</Text>}
        </Box>
        <Text dimColor>{providerText}</Text>

        <Text color="green" bold>{capitalText}</Text>
        {isLowBalance && <Text color="yellow">{lowBalanceText}</Text>}

        <Box marginTop={1}>
          <Text color="white" bold>Wallets</Text>
          {walletRows.length === 0 && <Text dimColor>  pending setup</Text>}
        </Box>
        {walletRows.map((wallet) => (
          <WalletRow key={`${wallet.chain}-${wallet.address}`} wallet={wallet} width={contentWidth} />
        ))}

        <Text color="cyan">{runtimeWithUptime}</Text>

        <Box marginTop={1}>
          <Text color="white" bold>Positions</Text>
          {positionRows.length === 0 && <Text dimColor>  none</Text>}
        </Box>
        {positionRows.map((trade) => (
          <Box key={`${trade.token}-${trade.action}-${trade.amount}-${trade.timestamp}`}>
            <Text color={trade.action === "buy" ? "green" : "red"} bold>
              {trade.action === "buy" ? "BUY" : "SELL"}
            </Text>
            <Text dimColor>  {fitText(`${trade.token} ${trade.amount}`, Math.max(8, contentWidth - 6))}</Text>
          </Box>
        ))}

        <Box marginTop={1}>
          <Text color="cyan">{meter(status.llmCostToday, status.maxDailyLlmCost, spendWidth)}</Text>
          {inlineSpendWidth > 0 && <Text dimColor>  {fitText(llmSpendText, inlineSpendWidth)}</Text>}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={panelWidth}
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
          {statusText.length > 0 && <Text dimColor>  {statusText}</Text>}
        </Box>
        <Text dimColor>{providerText}</Text>
      </Box>

      <SectionGap />

      <Header title="Capital" />
      <Text color="green" bold>{capitalText}</Text>
      {isLowBalance && <Text color="yellow">{lowBalanceText}</Text>}

      <SectionGap />

      <Header title="Wallets" />
      {status.wallets.length === 0 ? (
        <Text dimColor>pending setup</Text>
      ) : (
        walletRows.map((wallet) => (
          <WalletRow key={`${wallet.chain}-${wallet.address}`} wallet={wallet} width={contentWidth} />
        ))
      )}
      {status.wallets.length > walletRows.length && <Text dimColor>+{status.wallets.length - walletRows.length} more</Text>}

      <SectionGap />

      <Header title="Runtime" />
      <Text color="cyan">{runtimeText}</Text>
      <Text dimColor>{fitText(`Uptime ${formatUptime(status.uptime)}`, contentWidth)}</Text>

      <SectionGap />

      <Header title="Positions" />
      {status.activeTrades.length === 0 && <Text dimColor>No live positions</Text>}
      {positionRows.map((trade) => (
        <Box key={`${trade.token}-${trade.action}-${trade.amount}-${trade.timestamp}`}>
          <Text color={trade.action === "buy" ? "green" : "red"} bold>
            {trade.action === "buy" ? "BUY" : "SELL"}
          </Text>
          <Text dimColor>  {fitText(`${trade.token} ${trade.amount}`, Math.max(8, contentWidth - 6))}</Text>
        </Box>
      ))}
      {status.activeTrades.length > 2 && <Text dimColor>+{status.activeTrades.length - 2} more</Text>}

      <SectionGap />

      <Header title="LLM" />
      <Text color="cyan">{meter(status.llmCostToday, status.maxDailyLlmCost, spendWidth)}</Text>
      <Text dimColor>{fitText(llmSpendText, contentWidth)}</Text>
    </Box>
  );
}
