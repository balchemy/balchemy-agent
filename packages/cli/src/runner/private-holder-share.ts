/** K1 entry filter `top_holders_pct` (owner decision of 19 Nov 2026: free sources only). For N <= 20 the share is computed from the
 * standard RPC: getTokenSupply and getTokenLargestAccounts through the runner's own reader. With two Balchemy-provided sources these are
 * ENTRY-class reads (private-solana-rpc-sources.ts): both must answer the same values, otherwise the fact is unknown. For N > 20 no free
 * source exists here (getTokenLargestAccounts answers at most 20 and no paid indexer is wired), so the fact is unknown. An unknown fact
 * holds the buy (fail closed, entry rules) and the agent does not buy.
 * What is counted: the largest TOKEN ACCOUNTS of the mint, not owners. One owner with several accounts counts as several, and pool,
 * bonding-curve and exchange accounts are included, so a fresh launch whose curve holds most of the supply shows a high share. */
import { PRIVATE_SOLANA_LARGEST_ACCOUNTS_MAX, type PrivateSolanaRpc } from "./private-solana-rpc.js";

export const PRIVATE_HOLDER_SHARE_EXACT_MAX = PRIVATE_SOLANA_LARGEST_ACCOUNTS_MAX;
/** Shown to the owner (coach and setup text) wherever the fact is explained. */
export const PRIVATE_HOLDER_SHARE_NOTE = "Top-holder share counts the largest token accounts (not owners), from Balchemy's two RPC providers in agreement; "
  + "pool and bonding-curve accounts are included, and more than 20 holders cannot be measured for free, so such a rule holds every buy.";
/** Percent precision kept in the fact (1e-6 %). */
const SCALE = 1_000_000n;
export type PrivateHolderShareReader = Pick<PrivateSolanaRpc, "getTokenSupply" | "getTokenLargestAccounts">;
/** Top-N shares keyed like entryConditionFactKey (`top10_holders_pct`); null means unknown (it never passes a filter). */
export type PrivateHolderShares = Readonly<Record<string, number | null>>;

export function privateHolderShareKey(count: number): string { return `top${count}_holders_pct`; }

/** The share of supply (percent, 0..100) held by the `count` largest accounts, from one agreed read of each method, or null. */
export function privateTopHolderShare(supply: bigint, accounts: readonly { amount: bigint }[], count: number): number | null {
  if (!Number.isSafeInteger(count) || count < 1 || count > PRIVATE_HOLDER_SHARE_EXACT_MAX || supply <= 0n) return null;
  // Fewer accounts than N means every account is listed (an exact sum); an answer of exactly 20 for N = 20 is also exact.
  let held = 0n;
  for (const item of accounts.slice(0, count)) { if (item.amount < 0n) return null; held += item.amount; }
  if (held > supply) return null;
  return Number((held * 100n * SCALE) / supply) / Number(SCALE);
}

/** One supply and one largest-accounts read (both answered by the same reader policy), then each requested N. Any read failure, a
 * disagreement or lag between two sources, a zero supply or N > 20 gives null for that N. Never throws except on cancellation. */
export async function readPrivateHolderShares(rpc: PrivateHolderShareReader | undefined, mint: string, counts: readonly number[],
  signal?: AbortSignal): Promise<PrivateHolderShares> {
  const unique = [...new Set(counts)].filter((count) => Number.isSafeInteger(count) && count >= 1).sort((a, b) => a - b);
  const result: Record<string, number | null> = {};
  for (const count of unique) result[privateHolderShareKey(count)] = null;
  const exact = unique.filter((count) => count <= PRIVATE_HOLDER_SHARE_EXACT_MAX);
  if (!rpc || exact.length === 0) return Object.freeze(result);
  let supply: { amount: bigint }; let largest: { accounts: readonly { amount: bigint }[] };
  try {
    [supply, largest] = await Promise.all([rpc.getTokenSupply(mint, { commitment: "confirmed" }, signal),
      rpc.getTokenLargestAccounts(mint, { commitment: "confirmed" }, signal)]);
  } catch {
    if (signal?.aborted) throw new Error("cancelled");
    return Object.freeze(result);
  }
  for (const count of exact) result[privateHolderShareKey(count)] = privateTopHolderShare(supply.amount, largest.accounts, count);
  return Object.freeze(result);
}
