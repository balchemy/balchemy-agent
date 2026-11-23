/** The runner's own swap expectation, independent of the server's build response. A buy derives only from the
 * saved resolved plan, the assessment record bound to that exact plan (re-parsed here), the local trading
 * wallet address, mint facts read from the runner's own RPC and the runner's priority-fee ceiling; an exit sell
 * derives from the position, its pending exit, the complete sell assessment for exactly that exit and the same
 * local facts. Both refuse a fee outside the runner's own fee policy (private-fee-policy.ts: at most 150 bps, to an
 * allow-listed fee wallet) with its fixed reason (`fee_policy_rate_above_ceiling`, `fee_policy_recipient_unknown`). */
import type { RunnerSolanaSellAssessment } from "@balchemyai/agent-sdk";
import { parsePrivateSignalAssessment, type PrivateBuyPlanFacts, type PrivateSignalAssessment, type PrivateSignalAssessmentEvidence } from "./private-signal-job.js";
import type { PrivatePosition, PrivatePositionPendingExit } from "./private-positions.js";
import { isSolanaAddress } from "./solana-base58.js";
import { PRIVATE_FEE_WALLETS, privateFeePolicyRefusal, type PrivateFeePolicyRefusal } from "./private-fee-policy.js";
import { canonicalU64, PRIVATE_SOLANA_MAX_PRIORITY_FEE_LAMPORTS, SOLANA_FEE_BASIS, SOLANA_MAX_PLATFORM_FEE_BPS, solanaFeePolicyDigest,
  solanaFeeSplit, solanaMinOutAfterPlatformFee, solanaPlatformWsolAccount, WSOL_MINT, type PrivateSolanaMintFacts,
  type PrivateSolanaRunnerExpectation } from "./private-solana-tx-validator.js";

export class PrivateSolanaExpectationError extends Error {
  constructor(readonly code: "plan_not_executable_input" | "assessment_not_complete" | "fee_rate_unrepresentable" | "invalid_input"
    | "position_not_executable" | "mint_facts_mismatch" | PrivateFeePolicyRefusal) {
    super(`Local Solana swap expectation ${code}`); this.name = "PrivateSolanaExpectationError";
  }
}
interface LocalFacts {
  wallet: string; mint: PrivateSolanaMintFacts; maxPriorityFeeLamports?: bigint;
  /** The fee policy's wallets (privateFeeWallets of the capabilities seam); absent: the allow-list PRIVATE_FEE_WALLETS. */
  feeWallets?: readonly string[];
}
/** The runner's fee policy over the assessment's (rate, recipient). */
function checkFeePolicy(rateBps: number, recipient: string, local: LocalFacts): void {
  const refusal = privateFeePolicyRefusal(rateBps, recipient, local?.feeWallets ?? PRIVATE_FEE_WALLETS);
  if (refusal) throw new PrivateSolanaExpectationError(refusal);
}
function localFacts(local: LocalFacts, tokenMint: string): { tokenProgram: string; decimals: number; ceiling: bigint } {
  const ceiling = local?.maxPriorityFeeLamports ?? PRIVATE_SOLANA_MAX_PRIORITY_FEE_LAMPORTS;
  const mint = local?.mint;
  if (!mint || !mint.ok) throw new PrivateSolanaExpectationError("invalid_input");
  if (!isSolanaAddress(local.wallet) || local.wallet === tokenMint
    || typeof ceiling !== "bigint" || ceiling < 0n || ceiling > PRIVATE_SOLANA_MAX_PRIORITY_FEE_LAMPORTS) throw new PrivateSolanaExpectationError("invalid_input");
  return { tokenProgram: mint.tokenProgram, decimals: mint.decimals, ceiling };
}
/** Buy: saved plans are WSOL → token. Server text never contributes to this value. */
export function derivePrivateSolanaBuyExpectation(plan: PrivateBuyPlanFacts, assessment: PrivateSignalAssessment,
  local: LocalFacts): PrivateSolanaRunnerExpectation {
  if (!plan || plan.state !== "resolved" || plan.asset?.chain !== "solana" || !plan.amount || plan.slippageBps === null
    || plan.asset.assetId === WSOL_MINT || !isSolanaAddress(plan.asset.assetId)) throw new PrivateSolanaExpectationError("plan_not_executable_input");
  let bound: PrivateSignalAssessment;
  try { bound = parsePrivateSignalAssessment(assessment, plan); } catch { throw new PrivateSolanaExpectationError("assessment_not_complete"); }
  if (bound.outcome !== "complete" || !bound.quote) throw new PrivateSolanaExpectationError("assessment_not_complete");
  const facts = localFacts(local, plan.asset.assetId);
  if (bound.fee.feeLamports !== solanaFeeSplit(BigInt(plan.amount.amountBaseUnits), bound.fee.rateBps).fee.toString()
    || bound.fee.policyDigest !== solanaFeePolicyDigest(bound.fee.rateBps, bound.fee.recipient)) throw new PrivateSolanaExpectationError("assessment_not_complete");
  checkFeePolicy(bound.fee.rateBps, bound.fee.recipient, local);
  return Object.freeze({ direction: "buy" as const, wallet: local.wallet, inputMint: WSOL_MINT, outputMint: plan.asset.assetId,
    tokenProgram: facts.tokenProgram, tokenDecimals: facts.decimals, grossIn: plan.amount.amountBaseUnits,
    slippageBps: plan.slippageBps, feeBasis: SOLANA_FEE_BASIS.buy, feeRateBps: bound.fee.rateBps, feeRecipient: bound.fee.recipient,
    feePolicyDigest: bound.fee.policyDigest, minOutBound: bound.quote.minOut, maxPriorityFeeLamports: facts.ceiling.toString() });
}

/** A position-bound sell (token → WSOL), the core of `derivePrivateSolanaSellExpectation` below. */
export interface PrivateSolanaSellIntent {
  tokenMint: string; amountBaseUnits: string; slippageBps: number;
  /** The assessed conservative proceeds floor (lamports, net of the platform fee); null only when none exists. */
  minOutBound: string | null;
}
/** Sell: the fee is taken in SOL by Jupiter's platform fee (`output_sol`) at the assessment's global
 * bps (refused above 255, never clamped); the validator derives the fee account, the platform's WSOL ATA,
 * from this `feeRecipient` itself. The whole gross amount is swapped; no token fee leg exists. */
export function privateSolanaSellExpectationFromIntent(sell: PrivateSolanaSellIntent,
  fee: Pick<PrivateSignalAssessmentEvidence["fee"], "rateBps" | "recipient" | "policyDigest">, local: LocalFacts): PrivateSolanaRunnerExpectation {
  const amount = canonicalU64(sell?.amountBaseUnits); const bound = sell?.minOutBound === null ? null : canonicalU64(sell?.minOutBound);
  if (!sell || !isSolanaAddress(sell.tokenMint) || sell.tokenMint === WSOL_MINT || amount === undefined || amount === 0n
    || !Number.isSafeInteger(sell.slippageBps) || sell.slippageBps < 1 || sell.slippageBps > 5_000 || bound === undefined || bound === 0n) {
    throw new PrivateSolanaExpectationError("plan_not_executable_input");
  }
  const rate = fee?.rateBps;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0 || rate > 10_000 || typeof fee.recipient !== "string"
    || (rate === 0 ? fee.recipient !== "" : !isSolanaAddress(fee.recipient) || fee.recipient === local?.wallet)
    || fee.policyDigest !== solanaFeePolicyDigest(rate, fee.recipient)) throw new PrivateSolanaExpectationError("assessment_not_complete");
  if (rate > SOLANA_MAX_PLATFORM_FEE_BPS) throw new PrivateSolanaExpectationError("fee_rate_unrepresentable");
  const facts = localFacts(local, sell.tokenMint);
  checkFeePolicy(rate, fee.recipient, local);
  return Object.freeze({ direction: "sell" as const, wallet: local.wallet, inputMint: sell.tokenMint, outputMint: WSOL_MINT,
    tokenProgram: facts.tokenProgram, tokenDecimals: facts.decimals, grossIn: amount.toString(), slippageBps: sell.slippageBps,
    feeBasis: SOLANA_FEE_BASIS.sell, feeRateBps: rate, feeRecipient: fee.recipient, feePolicyDigest: fee.policyDigest,
    minOutBound: bound === null ? null : bound.toString(), maxPriorityFeeLamports: facts.ceiling.toString() });
}

/** S5c exit: the runner's own sell expectation for the one pending exit of an open (or held) position, independent of the
 * server build. Inputs: the position and exactly its pending exit; a COMPLETE sell assessment whose request is exactly
 * (position mint → WSOL, the pending exit's units); the runner's own mint read, which must agree with the assessment's
 * accounts; and its priority-fee ceiling. The policy digest is re-derived, the platform WSOL account re-derived, the
 * assessed floor re-checked against its route threshold. Any mismatch throws PrivateSolanaExpectationError. */
export function derivePrivateSolanaSellExpectation(position: PrivatePosition, pendingExit: PrivatePositionPendingExit,
  assessment: RunnerSolanaSellAssessment, local: LocalFacts): PrivateSolanaRunnerExpectation {
  const pending = position?.pendingExit;
  const remaining = canonicalU64(position?.remainingUnits); const units = canonicalU64(pendingExit?.units);
  if (!position || (position.state !== "open" && position.state !== "held") || !pending || !pendingExit
    || pending.reservationId !== pendingExit.reservationId || pending.units !== pendingExit.units || pending.trigger !== pendingExit.trigger
    || pending.level !== pendingExit.level || pending.createdAt !== pendingExit.createdAt
    || !isSolanaAddress(position.tokenMint) || position.tokenMint === WSOL_MINT || position.walletAddress !== local?.wallet
    || remaining === undefined || units === undefined || units === 0n || units > remaining) throw new PrivateSolanaExpectationError("position_not_executable");
  const a = assessment; const quote = a?.quote; const accounts = a?.accounts; const fee = a?.fee;
  if (!a || a.version !== 1 || a.direction !== "sell" || a.status !== "complete" || a.reasonCode !== "" || a.executionAvailable !== false
    || a.inputMint !== position.tokenMint || a.outputMint !== WSOL_MINT || a.grossInputAmount !== pendingExit.units
    || !quote || !accounts || !fee || accounts.mintStatus !== "available" || accounts.mintReason !== ""
    || quote.inputMint !== a.inputMint || quote.outputMint !== WSOL_MINT || quote.inAmount !== a.grossInputAmount
    || quote.slippageBps !== a.slippageBps || quote.platformFeeBps !== fee.rateBps
    || fee.source !== "backend_global_fee_config" || fee.feeBasis !== SOLANA_FEE_BASIS.sell
    || (fee.rateBps === 0 ? fee.recipientAccount !== ""
      : !isSolanaAddress(fee.recipient) || fee.recipientAccount !== solanaPlatformWsolAccount(fee.recipient))) {
    throw new PrivateSolanaExpectationError("assessment_not_complete");
  }
  // The core re-derives the policy digest, refuses a rate above 255 and checks the local wallet and ceiling.
  const expectation = privateSolanaSellExpectationFromIntent({ tokenMint: position.tokenMint, amountBaseUnits: pendingExit.units,
    slippageBps: a.slippageBps, minOutBound: quote.minOut }, { rateBps: fee.rateBps, recipient: fee.recipient, policyDigest: fee.policyDigest }, local);
  const out = canonicalU64(quote.outAmount); const routeMinOut = canonicalU64(quote.routeMinOut);
  if (out === undefined || routeMinOut === undefined || routeMinOut === 0n || routeMinOut > out
    || quote.minOut !== solanaMinOutAfterPlatformFee(routeMinOut, fee.rateBps).toString()) throw new PrivateSolanaExpectationError("assessment_not_complete");
  // The runner's own mint read must agree with what the assessment saw.
  if (expectation.tokenProgram !== accounts.tokenProgram || expectation.tokenDecimals !== accounts.tokenDecimals) {
    throw new PrivateSolanaExpectationError("mint_facts_mismatch");
  }
  return expectation;
}
