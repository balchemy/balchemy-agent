/** The runner's own swap-fee policy (owner decision, items 72c and 77, 13 Nov 2026): the local runner refuses every swap whose
 * fee rate is above PRIVATE_MAX_FEE_BPS or whose fee goes anywhere but a Balchemy Solana fee wallet on the compile-time
 * allow-list below. Balchemy's assessment still names the rate and the recipient; the runner only accepts them inside this
 * policy, so a backend bug or compromise cannot take a larger fee or send it elsewhere. A buy's fee is a System transfer to
 * the named (listed) wallet itself; a sell's fee is Jupiter's platform fee into the WSOL associated token account the runner
 * derives itself from that same named wallet (solanaPlatformWsolAccount), never an account taken from server text.
 *
 * The allow-list and the ceiling are compile-time constants. No env var, CLI flag, file or IPC changes them. The only override
 * is the fee WALLET of the test-only capabilities seam (PrivateExecutionCapabilities.feeWallet, see private-execution-gate.ts):
 * it replaces the list with that one synthetic wallet, and production never sets it. The ceiling is never injectable. A zero
 * rate (no fee, recipient "") is always accepted.
 *
 * Changing the fee wallet (the owner will replace the test-stage wallet; a runner that lists only the old one refuses every swap,
 * stop-loss sells included, once Balchemy names the new one):
 *   1. create the new wallet and its WSOL associated token account on chain;
 *   2. ship a CLI release whose BALCHEMY_SOLANA_FEE_WALLETS lists BOTH the old and the new wallet (and its WSOL ATA);
 *   3. let installed runners update to it;
 *   4. only then switch the backend's TRADING_FEE_WALLET (a backend release);
 *   5. a later CLI release drops the old wallet. */
import { isSolanaAddress } from "./solana-base58.js";

export interface BalchemySolanaFeeWallet {
  /** The fee wallet (public address; receiving needs no key). */
  readonly wallet: string;
  /** Its WSOL associated token account (Token program, WSOL mint), the sell platform fee account. Data for the change procedure
   * and the tests, which assert that the runner's own derivation (solanaPlatformWsolAccount) yields exactly this address; at run
   * time the runner always derives the account itself. */
  readonly wsolAccount: string;
}
/** Every Solana fee wallet the runner accepts. Today one: the test-stage wallet. */
export const BALCHEMY_SOLANA_FEE_WALLETS: readonly BalchemySolanaFeeWallet[] = Object.freeze([
  Object.freeze({ wallet: "ERkafWJorf7JYpqGpB8Y5cAGr24cthot6LeWdoj9Bcin", wsolAccount: "3fP8kY9ZC7WbfCZm11ZadK5ZfTL3csv3evT2ZxrTofBi" }),
]);
/** The allow-listed wallets alone, the production default of every fee-policy check. */
export const PRIVATE_FEE_WALLETS: readonly string[] = Object.freeze(BALCHEMY_SOLANA_FEE_WALLETS.map((entry) => entry.wallet));
/** The highest fee rate the runner accepts, for buys and sells (1.5 %). */
export const PRIVATE_MAX_FEE_BPS = 150;
export const PRIVATE_FEE_POLICY_REFUSALS = ["fee_policy_rate_above_ceiling", "fee_policy_recipient_unknown"] as const;
export type PrivateFeePolicyRefusal = typeof PRIVATE_FEE_POLICY_REFUSALS[number];

export function isPrivateFeePolicyRefusal(value: unknown): value is PrivateFeePolicyRefusal {
  return (PRIVATE_FEE_POLICY_REFUSALS as readonly unknown[]).includes(value);
}
/** The fee wallets in force: the allow-list, unless the test-only capabilities seam names one valid synthetic address. */
export function privateFeeWallets(capabilities?: { readonly feeWallet?: string } | null): readonly string[] {
  const injected = typeof capabilities === "object" && capabilities !== null ? capabilities.feeWallet : undefined;
  return typeof injected === "string" && isSolanaAddress(injected) ? Object.freeze([injected]) : PRIVATE_FEE_WALLETS;
}
/** Null when (rate, recipient) is inside the policy: rate 0 with no recipient, or 1..=PRIVATE_MAX_FEE_BPS to exactly one of
 * `feeWallets`. A malformed rate counts as above the ceiling. */
export function privateFeePolicyRefusal(rateBps: unknown, recipient: unknown,
  feeWallets: readonly string[] = PRIVATE_FEE_WALLETS): PrivateFeePolicyRefusal | null {
  if (typeof rateBps !== "number" || !Number.isInteger(rateBps) || rateBps < 0 || rateBps > PRIVATE_MAX_FEE_BPS) return "fee_policy_rate_above_ceiling";
  if (rateBps === 0) return recipient === "" ? null : "fee_policy_recipient_unknown";
  return typeof recipient === "string" && isSolanaAddress(recipient) && feeWallets.includes(recipient) ? null : "fee_policy_recipient_unknown";
}
