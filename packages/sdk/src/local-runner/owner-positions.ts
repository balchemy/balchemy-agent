import { exactWith, invalidFor, matches, solanaAddress, timestampWith, UUID, WSOL, type ExactFn } from "./runner-proof-transport";

/** Engine held reasons, highest priority first (blockchain.proto GetLocalAgentPositionResponse). */
export const RUNNER_POSITION_HELD_REASONS = ["position_scan_limit_exceeded", "record_facts_invalid", "position_amount_overflow",
  "buy_facts_disputed", "sell_facts_disputed", "position_overdrawn"] as const;
export type RunnerPositionHeldReason = typeof RUNNER_POSITION_HELD_REASONS[number];
/** Owner notices on a position, present only when there is one. `exits_unavailable`: the agent's runner reports a build without
 * automatic exits, so the position has no stop-loss or take-profit and the runner settles no pending sell of it. */
export const RUNNER_POSITION_NOTICES = ["exits_unavailable"] as const;
export type RunnerPositionNotice = typeof RUNNER_POSITION_NOTICES[number];
/** Positions read per owner request (newest first; `truncated` when more exist). */
export const RUNNER_OWNER_POSITIONS_MAX = 16;
/** One owner-visible position summary computed by the engine only from proven local-signer records. `unavailable` is explicit:
 * the engine could not prove it now, so every amount and time is null. A held position always reports available 0. Amounts
 * are canonical base-10 (token base units; lamports for cost basis and proceeds). Never a chain balance, never execution authority. */
export interface RunnerOwnerPosition {
  tokenMint: string; walletAddress: string; state: "ready" | "held" | "unavailable"; heldReason: "" | RunnerPositionHeldReason;
  availableTokenUnits: string | null; pendingSellTokenUnits: string | null; costBasisLamports: string | null; proceedsLamports: string | null;
  openedAtMs: string | null; lastUpdatedAtMs: string | null; notice?: RunnerPositionNotice;
}
/** Owner Hub read GET /nest/local-agents/positions/:agentId (current owner JWT session; read-only). */
export interface RunnerOwnerPositionsResponse {
  version: 1; agentId: string; items: readonly Readonly<RunnerOwnerPosition>[]; truncated: boolean; serverTime: string;
}

const invalid: () => never = invalidFor("owner positions");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const MAX_MS = BigInt(Number.MAX_SAFE_INTEGER);
const ITEM_KEYS = ["tokenMint", "walletAddress", "state", "heldReason", "availableTokenUnits", "pendingSellTokenUnits", "costBasisLamports",
  "proceedsLamports", "openedAtMs", "lastUpdatedAtMs"] as const;

function u64(value: unknown): string {
  if (!matches(value, U64) || BigInt(value) > U64_MAX) invalid();
  return value as string;
}
/** null (the engine reported none) or canonical milliseconds in [1, MAX_SAFE_INTEGER]. */
function optionalMs(value: unknown): string | null {
  if (value === null) return null;
  const raw = u64(value); if (raw === "0" || BigInt(raw) > MAX_MS) invalid(); return raw;
}
function position(value: unknown): Readonly<RunnerOwnerPosition> {
  exact(value, ITEM_KEYS, ["notice"]);
  const p = value;
  const notice = Object.hasOwn(p, "notice") ? RUNNER_POSITION_NOTICES.find((item) => item === p.notice) ?? invalid() : undefined;
  const noted = notice ? { notice } : {};
  // The (wallet, mint) pairs come from the agent's own closed buy/exit intents: a non-WSOL token mint on a distinct trading wallet.
  if (!solanaAddress(p.tokenMint) || !solanaAddress(p.walletAddress) || p.tokenMint === WSOL || p.walletAddress === WSOL
    || p.walletAddress === p.tokenMint) invalid();
  const base = { tokenMint: p.tokenMint as string, walletAddress: p.walletAddress as string };
  if (p.state === "unavailable") {
    if (p.heldReason !== "" || p.availableTokenUnits !== null || p.pendingSellTokenUnits !== null || p.costBasisLamports !== null
      || p.proceedsLamports !== null || p.openedAtMs !== null || p.lastUpdatedAtMs !== null) invalid();
    return Object.freeze({ ...base, state: "unavailable", heldReason: "", availableTokenUnits: null, pendingSellTokenUnits: null,
      costBasisLamports: null, proceedsLamports: null, openedAtMs: null, lastUpdatedAtMs: null, ...noted });
  }
  const ready = p.state === "ready";
  if (!ready && p.state !== "held") invalid();
  const heldReason = ready ? (p.heldReason === "" ? "" : invalid())
    : RUNNER_POSITION_HELD_REASONS.find((item) => item === p.heldReason) ?? invalid();
  const available = u64(p.availableTokenUnits);
  if (!ready && available !== "0") invalid();
  return Object.freeze({ ...base, state: ready ? "ready" : "held", heldReason, availableTokenUnits: available,
    pendingSellTokenUnits: u64(p.pendingSellTokenUnits), costBasisLamports: u64(p.costBasisLamports), proceedsLamports: u64(p.proceedsLamports),
    openedAtMs: optionalMs(p.openedAtMs), lastUpdatedAtMs: optionalMs(p.lastUpdatedAtMs), ...noted });
}
/** Closed validation of the owner positions read for exactly `agentId`. Items are the agent's distinct (wallet, mint) pairs, at
 * most 16; `truncated` means more existed, so exactly 16 are returned. Anything else fails closed. */
export function validateRunnerOwnerPositionsResponse(value: unknown, agentId: string): RunnerOwnerPositionsResponse {
  if (!matches(agentId, UUID)) invalid();
  exact(value, ["version", "agentId", "items", "truncated", "serverTime"]);
  if (value.version !== 1 || value.agentId !== agentId || typeof value.truncated !== "boolean") invalid();
  timestamp(value.serverTime);
  const list = value.items;
  if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype || list.length > RUNNER_OWNER_POSITIONS_MAX
    || Reflect.ownKeys(list).length !== list.length + 1 || (value.truncated && list.length !== RUNNER_OWNER_POSITIONS_MAX)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(list as unknown[]); const items: Readonly<RunnerOwnerPosition>[] = []; const pairs = new Set<string>();
  for (let i = 0; i < (list as unknown[]).length; i++) {
    const field = descriptors[String(i)];
    if (!field || !("value" in field) || !field.enumerable) invalid();
    const item = position(field.value); const pair = `${item.walletAddress}:${item.tokenMint}`;
    if (pairs.has(pair)) invalid();
    pairs.add(pair); items.push(item);
  }
  return Object.freeze({ version: 1, agentId, items: Object.freeze(items), truncated: value.truncated as boolean, serverTime: value.serverTime as string });
}
