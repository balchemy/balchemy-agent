/** Pure evaluator for a simulated, not-yet-signed local swap over the raw `simulateTransaction` result from the runner's
 * own RPC. The validator proves shape; this proves effects at the simulated slot. Missing evidence denies: an RPC node
 * that omits balances cannot authorize a signature. Numbers outside JSON's exact integer range are missing evidence,
 * never rounded.
 *
 * Buy: a port of balchemy-trading-engine `simulation.rs`. Runner extensions: the fee recipient's lamport credit must
 * equal the fee; the rent part of the wallet debit bound is exact (M35PIN-1): never a hard-coded figure and never a
 * figure the transaction under evaluation chooses (see `outputAccountRent`); and the wallet's WSOL ATA counts as the
 * wallet's own lamports and must be closed (M35PIN-2, see `evaluatePrivateSolanaSimulation`).
 *
 * Sell (S5c, runner-only: engine `simulation.rs` has no sell effect rules): conservative INVARIANTS that hold for any
 * honest Jupiter route, never a model of route internals. Over the exact balances: the wallet-owned input-mint balance
 * falls by exactly the validated input; no other wallet-owned token balance falls; the wallet's WSOL ATA is closed by the
 * end; the wallet's lamport proceeds, net of the network fee, any pre-existing WSOL ATA (its exact pre lamports) and any lamports
 * reclaimed from other wallet token accounts, reach the validated floor; the platform WSOL fee credit stays within the
 * validated bps of the gross proceeds; the source token ATA stays wallet-controlled. These invariants are synthetic-
 * fixture tested and pinned against real captured mainnet sells (M3.5; private-solana-real-sell-simulation.spec.ts states what
 * those captures do not cover, invariant (g) among them). Since S5 (PRIVATE_EXIT_EXECUTION_AVAILABLE true)
 * `authorizePrivateSolanaSwapSignature` authorizes a sell only when they pass; the exits-off rollback build (the flag false)
 * refuses every sell (`direction_unavailable`). */
import type { PrivateSolanaValidatedBuy, PrivateSolanaValidatedSell } from "./private-solana-tx-validator.js";
import { TOKEN_2022_PROGRAM, WSOL_MINT } from "./private-solana-tx-validator.js";
import { encodeBase58, isSolanaAddress } from "./solana-base58.js";

/** Base fee for the single required signature. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** An SPL token account (and the WSOL ATA); a Token-2022 ATA is 170 bytes: the 165-byte base, the account-type byte and the
 * zero-length ImmutableOwner TLV entry the ATA program always adds. The validator only admits Token-2022 mints whose
 * extensions need no account extension, so a Token-2022 ATA created by a validated buy is exactly 170 bytes. */
export const SPL_TOKEN_ACCOUNT_LEN = 165;
export const TOKEN_2022_ATA_LEN = 170;
/** Sanity ceilings for the runner RPC's `getMinimumBalanceForRentExemption` answers: the highest rent mainnet has ever charged
 * for these sizes (2-year exemption at 3480 lamports per byte-year). Current mainnet charges less (1_488_440 for 165 bytes,
 * 1_513_840 for 170). An answer above its ceiling, not positive, or not ordered by size is missing evidence and denies. A
 * lower answer can only tighten the buy bound (a created account's balance must EQUAL it), so no floor beyond 1 is needed. */
export const TOKEN_ACCOUNT_RENT_MAX_LAMPORTS = 2_039_280n;
export const TOKEN_2022_ATA_RENT_MAX_LAMPORTS = 2_074_080n;
const U64_MAX = 18_446_744_073_709_551_615n;
const BPS = 10_000n;

export const PRIVATE_SOLANA_SIMULATION_DENY_REASONS = ["simulation_failed", "simulation_evidence_missing", "fee_overflow",
  "network_fee_exceeded", "wallet_lamport_debit_exceeded", "duplicate_token_balance_row", "output_balance_missing",
  "output_account_mismatch", "output_balance_decreased", "output_below_min_out", "wallet_token_balance_decreased",
  "output_account_state_missing", "output_account_authority_changed", "fee_recipient_credit_mismatch", "created_account_rent_mismatch",
  // Sell invariants.
  "input_debit_mismatch", "wsol_not_closed", "proceeds_below_min_out", "platform_fee_exceeded"] as const;
export type PrivateSolanaSimulationDenyReason = typeof PRIVATE_SOLANA_SIMULATION_DENY_REASONS[number];
class Denied extends Error { constructor(readonly reason: PrivateSolanaSimulationDenyReason) { super(reason); } }
function deny(reason: PrivateSolanaSimulationDenyReason): never { throw new Denied(reason); }

export interface PrivateSolanaTokenBalance { readonly account: string; readonly mint: string; readonly owner: string; readonly amount: bigint }
export interface PrivateSolanaTokenAccountAuthorities { readonly mint: string; readonly owner: string; readonly hasDelegate: boolean; readonly hasCloseAuthority: boolean }
/** One requested post-simulation account; `null` when the RPC reports none (closed or never created). */
export interface PrivateSolanaPostAccount { readonly lamports: bigint; readonly owner: string; readonly data: Uint8Array }
/** Exact evidence extracted from one simulation; a malformed field is `undefined`. */
export interface PrivateSolanaSimulationFacts {
  readonly failed: boolean; readonly fee?: bigint; readonly preBalances?: readonly bigint[]; readonly postBalances?: readonly bigint[];
  readonly preTokenBalances?: readonly PrivateSolanaTokenBalance[]; readonly postTokenBalances?: readonly PrivateSolanaTokenBalance[];
  /** Post-state of the output ATA, requested as `accounts.addresses = [outputAtaPost]` in base64 (buy). */
  readonly outputAtaPost?: PrivateSolanaTokenAccountAuthorities;
  /** Every requested post-state in request order (sell: see `privateSolanaSellSimulationAccounts`). */
  readonly postAccounts?: readonly (PrivateSolanaPostAccount | null)[];
}
/** The runner's own RPC answers to `getMinimumBalanceForRentExemption`, taken with the simulation evidence of a buy:
 * `splToken` for 165 bytes (the WSOL ATA and a Token-program output ATA), `token2022Ata` for 170 bytes. */
export interface PrivateSolanaTokenAccountRent { readonly splToken: bigint; readonly token2022Ata: bigint }
/** `walletLamportDebit` is `spent` (wallet plus its WSOL ATA, see the buy evaluator), shown as 0 when the wallet gained. */
export interface PrivateSolanaSimulationEvidence {
  readonly networkFee: string; readonly walletLamportDebit: string; readonly outputReceived: string; readonly feeRecipientCredit: string;
}
export type PrivateSolanaSimulationVerdict = { readonly ok: true; readonly evidence: PrivateSolanaSimulationEvidence }
  | { readonly ok: false; readonly reason: PrivateSolanaSimulationDenyReason };
/** Sell effects proven at the simulated slot (exact integer text; `platformFeeCredit` is "0" at a zero rate). */
export interface PrivateSolanaSellSimulationEvidence {
  readonly networkFee: string; readonly inputDebit: string; readonly proceeds: string; readonly platformFeeCredit: string;
}
export type PrivateSolanaSellSimulationVerdict = { readonly ok: true; readonly evidence: PrivateSolanaSellSimulationEvidence }
  | { readonly ok: false; readonly reason: PrivateSolanaSimulationDenyReason };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function lamports(value: unknown): bigint | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}
function lamportList(value: unknown): bigint[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const out: bigint[] = []; for (const item of value) { const parsed = lamports(item); if (parsed === undefined) return undefined; out.push(parsed); }
  return out;
}
function canonicalAmount(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return undefined;
  const parsed = BigInt(value); return parsed <= U64_MAX ? parsed : undefined;
}
/** SPL token account (Token-2022 extends the same first 165 bytes). */
export function parseSolanaTokenAccount(data: Uint8Array): PrivateSolanaTokenAccountAuthorities | undefined {
  if (!(data instanceof Uint8Array) || data.length < SPL_TOKEN_ACCOUNT_LEN) return undefined;
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const tag = (offset: number): boolean | undefined => { const value = view.readUInt32LE(offset); return value === 0 ? false : value === 1 ? true : undefined; };
  const hasDelegate = tag(72); const hasCloseAuthority = tag(129);
  if (hasDelegate === undefined || hasCloseAuthority === undefined) return undefined;
  return Object.freeze({ mint: encodeBase58(data.subarray(0, 32)), owner: encodeBase58(data.subarray(32, 64)), hasDelegate, hasCloseAuthority });
}
function tokenRows(value: unknown, accountKeys: readonly string[]): PrivateSolanaTokenBalance[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const rows: PrivateSolanaTokenBalance[] = [];
  for (const row of value) {
    if (!isRecord(row) || !isRecord(row.uiTokenAmount) || typeof row.accountIndex !== "number" || !Number.isInteger(row.accountIndex)) return undefined;
    const account = accountKeys[row.accountIndex]; const amount = canonicalAmount(row.uiTokenAmount.amount);
    if (account === undefined || !isSolanaAddress(row.mint) || !isSolanaAddress(row.owner) || amount === undefined) return undefined;
    rows.push(Object.freeze({ account, mint: row.mint, owner: row.owner, amount }));
  }
  return rows;
}
function base64Data(value: unknown): Uint8Array | undefined {
  if (!Array.isArray(value)) return undefined;
  const [encoded, encoding] = value as unknown[];
  if (encoding !== "base64" || typeof encoded !== "string" || encoded.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  return Uint8Array.from(Buffer.from(encoded, "base64"));
}
function outputAccount(value: unknown): PrivateSolanaTokenAccountAuthorities | undefined {
  if (!Array.isArray(value) || !isRecord(value[0]) || !Array.isArray(value[0].data)) return undefined;
  const [encoded, encoding] = value[0].data as unknown[];
  if (encoding !== "base64" || typeof encoded !== "string" || encoded.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  return parseSolanaTokenAccount(Buffer.from(encoded, "base64"));
}
/** Every requested post-state; one malformed entry makes the whole list missing evidence. */
function postAccounts(value: unknown): (PrivateSolanaPostAccount | null)[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const out: (PrivateSolanaPostAccount | null)[] = [];
  for (const item of value) {
    if (item === null) { out.push(null); continue; }
    if (!isRecord(item) || !isSolanaAddress(item.owner)) return undefined;
    const balance = lamports(item.lamports); const data = base64Data(item.data);
    if (balance === undefined || data === undefined) return undefined;
    out.push(Object.freeze({ lamports: balance, owner: item.owner, data }));
  }
  return out;
}
/** `simulation_facts`: `accountKeys` is the validator's full resolved key list. */
export function privateSolanaSimulationFacts(result: unknown, accountKeys: readonly string[]): PrivateSolanaSimulationFacts {
  if (!isRecord(result)) return Object.freeze({ failed: true });
  return Object.freeze({ failed: result.err !== null && result.err !== undefined, fee: lamports(result.fee),
    preBalances: lamportList(result.preBalances), postBalances: lamportList(result.postBalances),
    preTokenBalances: tokenRows(result.preTokenBalances, accountKeys), postTokenBalances: tokenRows(result.postTokenBalances, accountKeys),
    outputAtaPost: outputAccount(result.accounts), postAccounts: postAccounts(result.accounts) });
}
function balanceOf(rows: readonly PrivateSolanaTokenBalance[], account: string): PrivateSolanaTokenBalance | undefined {
  const matches = rows.filter((row) => row.account === account);
  if (matches.length > 1) deny("duplicate_token_balance_row");
  return matches[0];
}
/** The exact rent evidence, or undefined when any answer is missing, not a bigint, not positive, above its ceiling, or the
 * larger account does not cost more than the smaller one. */
export function privateSolanaTokenAccountRent(value: unknown): PrivateSolanaTokenAccountRent | undefined {
  if (!isRecord(value)) return undefined;
  const { splToken, token2022Ata } = value;
  if (typeof splToken !== "bigint" || typeof token2022Ata !== "bigint" || splToken < 1n || splToken > TOKEN_ACCOUNT_RENT_MAX_LAMPORTS
    || token2022Ata <= splToken || token2022Ata > TOKEN_2022_ATA_RENT_MAX_LAMPORTS) return undefined;
  return Object.freeze({ splToken, token2022Ata });
}
/** The rent the wallet may pay for its output ATA (M35PIN-1). Unless the output ATA provably existed as a token account before
 * (a pre token row AND pre lamports), it counts as created. The ATA program funds a new account only up to the rent-exempt
 * minimum: an address already holding P lamports ends with max(P, rent), the wallet paying only the shortfall. So the post
 * balance must be 0 (closed: the output check denies later) or EXACTLY max(pre, the runner RPC's rent for its size), and the
 * allowance is post - pre (0 for an address pre-funded at or above the rent, so a third party's deposit can neither widen the
 * bound nor block the buy, M35PIN-2b). The figure is never hard-coded and never taken from the transaction under evaluation. */
function outputAccountRent(swap: PrivateSolanaValidatedBuy, rent: PrivateSolanaTokenAccountRent, preTokens: readonly PrivateSolanaTokenBalance[],
  preBalances: readonly bigint[], postBalances: readonly bigint[]): bigint {
  const index = swap.accountKeys.indexOf(swap.destinationAta);
  const before: bigint | undefined = preBalances[index]; const after: bigint | undefined = postBalances[index];
  if (index < 0 || before === undefined || after === undefined) deny("simulation_evidence_missing");
  if (before > 0n && preTokens.some((row) => row.account === swap.destinationAta)) return 0n;
  if (after === 0n) return 0n;
  const exactRent = swap.outputTokenProgram === TOKEN_2022_PROGRAM ? rent.token2022Ata : rent.splToken;
  if (after !== (before > exactRent ? before : exactRent)) deny("created_account_rent_mismatch");
  if (swap.createdAtas < 1) deny("created_account_rent_mismatch");
  return after - before;
}

/** `evaluate_simulation` for a validated buy, plus the exact fee-recipient credit and the exact created-account rent.
 * `rent` is the runner RPC's own rent evidence for this simulation; missing or out-of-range evidence denies.
 * Runner extension (M35PIN-2): the wallet's WSOL ATA A is the wallet's own money. Its lamports are counted with the wallet's,
 * signed and never clamped, and it must be closed (zero post lamports, no post row) by the end:
 *   spent = (pre_W + pre_A) − (post_W + post_A)  <=  inAmount + feeAmount + fee + output ATA rent allowance
 * A pre-existing WSOL balance can therefore neither be taken by the route (it was in pre_A) nor hide an extra wallet debit
 * behind its refund at the close. Every honest engine buy closes A (Jupiter's wrapAndUnwrapSol cleanup, the engine golden). */
export function evaluatePrivateSolanaSimulation(facts: PrivateSolanaSimulationFacts, swap: PrivateSolanaValidatedBuy,
  rent: PrivateSolanaTokenAccountRent | undefined): PrivateSolanaSimulationVerdict {
  try {
    if (facts.failed) deny("simulation_failed");
    const { fee, preBalances, postBalances, preTokenBalances: preTokens, postTokenBalances: postTokens } = facts;
    const pre = preBalances?.[0]; const post = postBalances?.[0];
    if (fee === undefined || pre === undefined || post === undefined || !preTokens || !postTokens) deny("simulation_evidence_missing");
    const exactRent = privateSolanaTokenAccountRent(rent);
    if (!exactRent) deny("simulation_evidence_missing");
    const keys = swap.accountKeys; const wsolIndex = keys.indexOf(swap.sourceAta);
    if (preBalances!.length !== keys.length || postBalances!.length !== keys.length || wsolIndex < 0) deny("simulation_evidence_missing");
    const maxNetworkFee = SIGNATURE_FEE_LAMPORTS + BigInt(swap.priorityFeeLamports);
    if (maxNetworkFee > U64_MAX) deny("fee_overflow");
    if (fee > maxNetworkFee) deny("network_fee_exceeded");
    // M35PIN-2: the WSOL ATA is closed by the end, so everything it held came back to (or left) the wallet's own balance.
    const preWsol = preBalances![wsolIndex]!; const postWsol = postBalances![wsolIndex]!;
    if (postWsol !== 0n || postTokens.some((row) => row.account === swap.sourceAta)) deny("wsol_not_closed");
    const spent = (pre + preWsol) - (post + postWsol);
    const allowedDebit = BigInt(swap.inAmount) + BigInt(swap.feeAmount) + fee
      + outputAccountRent(swap, exactRent, preTokens, preBalances!, postBalances!);
    if (spent > allowedDebit) deny("wallet_lamport_debit_exceeded");
    const debit = spent > 0n ? spent : 0n;
    // Output: the wallet's own output ATA must grow by at least min_out.
    const postRow = balanceOf(postTokens, swap.destinationAta);
    if (!postRow || postRow.mint !== swap.outputMint || postRow.owner !== swap.wallet) deny("output_balance_missing");
    const preRow = balanceOf(preTokens, swap.destinationAta);
    let preOut = 0n;
    if (preRow) { if (preRow.mint !== swap.outputMint || preRow.owner !== swap.wallet) deny("output_account_mismatch"); preOut = preRow.amount; }
    if (postRow.amount < preOut) deny("output_balance_decreased");
    const received = postRow.amount - preOut;
    if (received < BigInt(swap.minOut)) deny("output_below_min_out");
    // No other wallet-owned token balance may decrease. The WSOL ATA is the swap input: funded and consumed within the
    // transaction and closed, everything it held counted in `spent` above.
    for (const row of preTokens.filter((candidate) => candidate.owner === swap.wallet)) {
      if (row.account === swap.sourceAta && row.mint === WSOL_MINT) continue;
      if ((balanceOf(postTokens, row.account)?.amount ?? 0n) < row.amount) deny("wallet_token_balance_decreased");
    }
    // The output account must stay fully controlled by the wallet.
    const authorities = facts.outputAtaPost;
    if (!authorities) deny("output_account_state_missing");
    if (authorities.owner !== swap.wallet || authorities.mint !== swap.outputMint || authorities.hasDelegate || authorities.hasCloseAuthority) {
      deny("output_account_authority_changed");
    }
    // Runner extension: the platform credit is exactly the validated fee (balances are indexed like accountKeys).
    let credit = 0n;
    if (BigInt(swap.feeAmount) > 0n) {
      const index = swap.accountKeys.indexOf(swap.feeRecipient);
      const before = preBalances?.[index]; const after = postBalances?.[index];
      if (index < 0 || preBalances?.length !== swap.accountKeys.length || postBalances?.length !== swap.accountKeys.length
        || before === undefined || after === undefined) deny("simulation_evidence_missing");
      credit = after - before;
      if (credit !== BigInt(swap.feeAmount)) deny("fee_recipient_credit_mismatch");
    }
    return Object.freeze({ ok: true as const, evidence: Object.freeze({ networkFee: fee.toString(), walletLamportDebit: debit.toString(),
      outputReceived: received.toString(), feeRecipientCredit: credit.toString() }) });
  } catch (error: unknown) {
    return Object.freeze({ ok: false as const, reason: error instanceof Denied ? error.reason : "simulation_evidence_missing" });
  }
}

/** The fixed post-state request of a sell simulation, in this order: the source token ATA, the wallet's WSOL ATA, then
 * the platform WSOL fee account when the validated rate is above zero. */
export function privateSolanaSellSimulationAccounts(swap: PrivateSolanaValidatedSell): string[] {
  return swap.platformFeeBps > 0 ? [swap.sourceAta, swap.destinationAta, swap.platformFeeAccount] : [swap.sourceAta, swap.destinationAta];
}
function uniqueRows(rows: readonly PrivateSolanaTokenBalance[]): void {
  if (new Set(rows.map((row) => row.account)).size !== rows.length) deny("duplicate_token_balance_row");
}

/** Conservative sell invariants (see the header). With W = the wallet (fee payer, key 0), A = its WSOL ATA:
 *   inputDebit = Σ pre − Σ post over W-owned rows of the input mint            == inAmount
 *   every other W-owned row (all but the source ATA and A) keeps at least its pre amount
 *   A has no post token row, zero post lamports, and an absent or zero-lamport requested post state
 *   proceeds = (post_W − pre_W) + fee − wsolBefore − reclaimed                 >= minOut
 *     wsolBefore = the exact pre lamports of A (everything its close returns that was already there: its own rent, whatever
 *       rent-exempt minimum it was created under, its WSOL and any unsynced lamports), 0 when A did not exist; a pre WSOL row
 *       whose lamports do not exceed its amount is contradictory evidence (a token account always holds a positive rent reserve)
 *     reclaimed  = Σ max(0, pre − post lamports) over the source ATA and every other W-owned pre-row account
 *   platform credit Δ (post − pre WSOL rows of the fee account, 0 when absent): Δ·10000 <= (proceeds + Δ)·bps (bps > 0)
 *   the source ATA's requested post state, when present, keeps W as owner, the input mint, no delegate or close authority. */
export function evaluatePrivateSolanaSellSimulation(facts: PrivateSolanaSimulationFacts, swap: PrivateSolanaValidatedSell): PrivateSolanaSellSimulationVerdict {
  try {
    if (facts.failed) deny("simulation_failed");
    const { fee, preBalances: preLamports, postBalances: postLamports, preTokenBalances: preTokens, postTokenBalances: postTokens } = facts;
    const keys = swap.accountKeys; const requested = privateSolanaSellSimulationAccounts(swap); const accounts = facts.postAccounts;
    const wallet = swap.wallet; const wsolIndex = keys.indexOf(swap.destinationAta); const sourceIndex = keys.indexOf(swap.sourceAta);
    if (fee === undefined || !preLamports || !postLamports || preLamports.length !== keys.length || postLamports.length !== keys.length
      || !preTokens || !postTokens || !accounts || accounts.length !== requested.length || keys[0] !== wallet || wsolIndex < 0 || sourceIndex < 0) {
      deny("simulation_evidence_missing");
    }
    const maxNetworkFee = SIGNATURE_FEE_LAMPORTS + BigInt(swap.priorityFeeLamports);
    if (maxNetworkFee > U64_MAX) deny("fee_overflow");
    if (fee > maxNetworkFee) deny("network_fee_exceeded");
    uniqueRows(preTokens); uniqueRows(postTokens);
    // (b) Exact input debit over every wallet-owned row of the input mint.
    const inputHeld = (rows: readonly PrivateSolanaTokenBalance[]): bigint => rows
      .filter((row) => row.owner === wallet && row.mint === swap.inputMint).reduce((total, row) => total + row.amount, 0n);
    const inputDebit = inputHeld(preTokens) - inputHeld(postTokens);
    if (inputDebit !== BigInt(swap.inAmount)) deny("input_debit_mismatch");
    // (c) No other wallet-owned token balance falls (a changed owner or mint counts as gone).
    for (const row of preTokens) {
      if (row.owner !== wallet || row.account === swap.sourceAta || row.account === swap.destinationAta) continue;
      const after = postTokens.find((candidate) => candidate.account === row.account);
      if ((after && after.owner === wallet && after.mint === row.mint ? after.amount : 0n) < row.amount) deny("wallet_token_balance_decreased");
    }
    // (d) The wallet's WSOL ATA is closed by the end.
    const wsolPost = accounts[1];
    if (postTokens.some((row) => row.account === swap.destinationAta) || postLamports[wsolIndex] !== 0n
      || (wsolPost && wsolPost.lamports !== 0n)) deny("wsol_not_closed");
    // (e) Proceeds in lamports, net of everything the close or the route could return that was already the wallet's.
    const preWsol = preTokens.find((row) => row.account === swap.destinationAta);
    if (preWsol && (preWsol.owner !== wallet || preWsol.mint !== WSOL_MINT)) deny("output_account_mismatch");
    // M35PIN-1: A's real pre lamports, never a rent constant (an old-rent and a new-rent account both close for exactly these).
    const preWsolLamports = preLamports[wsolIndex]!;
    if (preWsol && preWsolLamports <= preWsol.amount) deny("simulation_evidence_missing");
    const wsolBefore = preWsolLamports;
    const reclaimFrom = new Set<number>([sourceIndex]);
    for (const row of preTokens) if (row.owner === wallet && row.account !== swap.destinationAta) reclaimFrom.add(keys.indexOf(row.account));
    let reclaimed = 0n;
    for (const index of reclaimFrom) {
      const before: bigint | undefined = preLamports[index]; const after: bigint | undefined = postLamports[index];
      if (before === undefined || after === undefined) deny("simulation_evidence_missing");
      if (before > after) reclaimed += before - after;
    }
    const proceeds = postLamports[0]! - preLamports[0]! + fee - wsolBefore - reclaimed;
    if (proceeds < BigInt(swap.minOut)) deny("proceeds_below_min_out");
    // (f) The platform's WSOL fee credit stays within the validated bps of the gross (proceeds + fee) output.
    let platformFeeCredit = 0n;
    if (swap.platformFeeBps > 0) {
      const before = preTokens.find((row) => row.account === swap.platformFeeAccount);
      const after = postTokens.find((row) => row.account === swap.platformFeeAccount);
      if ((before && before.mint !== WSOL_MINT) || (after && after.mint !== WSOL_MINT)) deny("simulation_evidence_missing");
      platformFeeCredit = (after?.amount ?? 0n) - (before?.amount ?? 0n);
      if (platformFeeCredit * BPS > (proceeds + platformFeeCredit) * BigInt(swap.platformFeeBps)) deny("platform_fee_exceeded");
    }
    // (g) The source token ATA, when it still exists, stays fully controlled by the wallet.
    const source = accounts[0];
    if (source && source.lamports !== 0n) {
      const authorities = parseSolanaTokenAccount(source.data);
      if (!authorities) deny("output_account_state_missing");
      if (source.owner !== swap.inputTokenProgram || authorities.owner !== wallet || authorities.mint !== swap.inputMint
        || authorities.hasDelegate || authorities.hasCloseAuthority) deny("output_account_authority_changed");
    }
    return Object.freeze({ ok: true as const, evidence: Object.freeze({ networkFee: fee.toString(), inputDebit: inputDebit.toString(),
      proceeds: proceeds.toString(), platformFeeCredit: platformFeeCredit.toString() }) });
  } catch (error: unknown) {
    return Object.freeze({ ok: false as const, reason: error instanceof Denied ? error.reason : "simulation_evidence_missing" });
  }
}
