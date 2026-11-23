/** Independent pre-sign validator for an engine-built, unsigned local Solana swap. A faithful port of
 * balchemy-trading-engine `swap_validation.rs` (with `swap_rpc.rs` lookup-table resolution), proving the
 * exact message bytes against two independent sources that must agree: the server's `expected` facts
 * and the runner's own expectation derived from its saved plan, plan-bound assessment and its own RPC.
 * Deny reasons equal the engine's reason strings. This module is pure: no IO, clock, key or signing.
 * Only `private-solana-validated-message.ts` turns a passing verdict into a signable token.
 *
 * Fee basis (engine `local_swap.rs`): a buy pays an exact System transfer of floor(gross x bps / 10000)
 * lamports (`input_lamports`); a sell swaps the whole token input and pays Jupiter's own platform fee in
 * SOL from the proceeds (`output_sol`): the route must carry exactly the global bps (1..=255, Jupiter u8)
 * and credit exactly the platform's WSOL ATA, which the runner derives itself from the plan-bound
 * assessment's fee recipient. No token fee or other transfer leg is accepted. The sell min-out is the
 * engine's conservative floor threshold - ceil(threshold x bps / 10000). The pure validator proves sell
 * bytes (golden vectors); signing a sell stays refused (`direction_unavailable`) until S5 positions.
 *
 * Fee policy (private-fee-policy.ts, owner decision of 13 Nov 2026): on top of the server/runner agreement, the rate must be at
 * most PRIVATE_MAX_FEE_BPS and the agreed recipient one of the runner's allow-listed fee wallets (`fee_policy_rate_above_ceiling`,
 * `fee_policy_recipient_unknown`); the buy transfer must go to exactly that wallet and the sell platform fee account must be the
 * WSOL ATA the runner derives from exactly that wallet, never an account taken from server text. */
import { createHash } from "node:crypto";
import { decodeSolanaV0Message, SolanaTxCodecError, solanaWireSize, SOLANA_MAX_MESSAGE_PARSE_BYTES, SOLANA_MAX_WIRE_BYTES,
  type SolanaCompiledInstruction, type SolanaV0Message } from "./private-solana-tx-codec.js";
import { decodeBase58, encodeBase58, isSolanaAddress } from "./solana-base58.js";
import { PRIVATE_FEE_WALLETS, privateFeePolicyRefusal } from "./private-fee-policy.js";

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
/** Anchor discriminators: sha256("global:<name>")[..8]. */
const JUPITER_ROUTE = Buffer.from("e517cb977ae3ad2a", "hex");
const JUPITER_SHARED_ACCOUNTS_ROUTE = Buffer.from("c1209b3341d69c81", "hex");
/** in_amount u64, quoted_out u64, slippage u16, platform_fee_bps u8. */
const ROUTE_ARGS_TAIL = 19;
const LOOKUP_TABLE_META_SIZE = 56;
/** Engine `local_swap::MAX_LOOKUP_TABLES`. */
export const PRIVATE_SOLANA_MAX_LOOKUP_TABLES = 8;
/** Engine `bot_swap::MAX_PRIORITY_FEE_LAMPORTS`; the runner never accepts a higher ceiling. */
export const PRIVATE_SOLANA_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const BPS = 10_000n;
/** Jupiter encodes the route's platform fee as a u8; a higher sell rate is refused, never clamped. */
export const SOLANA_MAX_PLATFORM_FEE_BPS = 255;
/** Engine `local_swap::FEE_BASIS_*`: a pure function of the direction. */
export const SOLANA_FEE_BASIS = Object.freeze({ buy: "input_lamports", sell: "output_sol" } as const);
export type PrivateSolanaFeeBasis = typeof SOLANA_FEE_BASIS[keyof typeof SOLANA_FEE_BASIS];

export const PRIVATE_SOLANA_SWAP_DENY_REASONS = [
  // Runner envelope (not in the engine): server facts, runner agreement, exact bytes.
  "expected_facts_invalid", "runner_expectation_mismatch", "message_digest_mismatch", "message_decode_invalid",
  "lookup_table_count_exceeded", "validated_facts_mismatch", "validation_unavailable",
  // swap_rpc.rs lookup-table resolution.
  "lookup_table_missing", "lookup_table_owner_invalid", "lookup_table_data_invalid", "lookup_table_deactivated", "lookup_index_out_of_range",
  // swap_validation.rs.
  "expected_swap_invalid", "output_token_program_invalid", "input_token_program_invalid", "wire_size_exceeded", "transaction_not_sanitized",
  "signer_count_invalid", "fee_payer_not_custodial_wallet", "program_not_allowed", "lookup_resolution_mismatch", "duplicate_account_key", "account_index_out_of_range",
  "instruction_account_missing", "compute_budget_accounts_present", "compute_budget_instruction_not_allowed", "compute_unit_limit_missing",
  "priority_fee_overflow", "priority_fee_exceeded", "system_instruction_not_allowed", "system_transfer_source_not_wallet",
  "system_transfer_destination_not_allowed", "ata_instruction_not_allowed", "ata_create_not_allowed", "token_instruction_not_allowed",
  "multiple_jupiter_instructions", "jupiter_route_missing", "jupiter_data_short", "jupiter_destination_mint_mismatch", "jupiter_mint_mismatch",
  "jupiter_instruction_not_allowed", "jupiter_token_program_mismatch", "jupiter_authority_not_wallet", "jupiter_source_not_wallet_wsol_ata",
  "jupiter_destination_not_wallet_ata", "jupiter_source_not_wallet_token_ata", "jupiter_destination_not_wallet_wsol_ata",
  "jupiter_platform_fee_account_present", "jupiter_platform_fee_account_mismatch", "jupiter_in_amount_mismatch", "jupiter_slippage_exceeded",
  "jupiter_platform_fee_not_allowed", "jupiter_platform_fee_bps_mismatch",
  "wrap_amount_mismatch", "fee_transfer_mismatch", "min_out_below_order_floor", "min_out_overflow", "wsol_close_not_final",
  "wsol_close_before_route", "wsol_close_missing",
  // Runner fee policy (private-fee-policy.ts), not in the engine.
  "fee_policy_rate_above_ceiling", "fee_policy_recipient_unknown",
] as const;
export type PrivateSolanaSwapDenyReason = typeof PRIVATE_SOLANA_SWAP_DENY_REASONS[number];
class Denied extends Error { constructor(readonly reason: PrivateSolanaSwapDenyReason) { super(reason); } }
function deny(reason: PrivateSolanaSwapDenyReason): never { throw new Denied(reason); }

// ── keys, program-derived addresses ────────────────────────────────────────────────────────────

const P = 2n ** 255n - 19n;
function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n; let b = ((base % P) + P) % P; let e = exponent;
  while (e > 0n) { if (e & 1n) result = (result * b) % P; b = (b * b) % P; e >>= 1n; }
  return result;
}
const EDWARDS_D = ((P - 121665n) * modPow(121666n, P - 2n)) % P;
/** curve25519-dalek `CompressedEdwardsY::decompress().is_some()`: the low 255 bits (reduced mod p)
 * are a valid y exactly when (y²−1)/(d·y²+1) is a square (zero included). */
export function isOnEd25519Curve(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return false;
  let y = 0n; for (let index = 31; index >= 0; index--) y = (y << 8n) | BigInt(bytes[index]!);
  y = (y & ((1n << 255n) - 1n)) % P;
  const y2 = (y * y) % P; const u = (y2 - 1n + P) % P; const v = (EDWARDS_D * y2 + 1n) % P;
  if (u === 0n) return true;
  return modPow((u * modPow(v, P - 2n)) % P, (P - 1n) / 2n) === 1n;
}
function keyBytes(address: string): Buffer { const bytes = decodeBase58(address, 32); if (!bytes) throw new Error("Invalid Solana address"); return bytes; }
/** `Pubkey::find_program_address`: the first off-curve sha256(seeds‖bump‖program‖"ProgramDerivedAddress"), bump 255→0. */
export function findSolanaProgramAddress(seeds: readonly Uint8Array[], programId: string): string {
  const program = keyBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const digest = createHash("sha256").update(Buffer.concat([...seeds, Buffer.from([bump]), program, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!isOnEd25519Curve(digest)) return encodeBase58(digest);
  }
  throw new Error("No program address");
}
export function solanaAssociatedTokenAddress(owner: string, tokenProgram: string, mint: string): string {
  return findSolanaProgramAddress([keyBytes(owner), keyBytes(tokenProgram), keyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM);
}
/** Engine `platform_wsol_account`: the platform's single WSOL ATA, the sell fee account for every mint. */
export function solanaPlatformWsolAccount(feeRecipient: string): string { return solanaAssociatedTokenAddress(feeRecipient, TOKEN_PROGRAM, WSOL_MINT); }

// ── lookup tables (swap_rpc.rs) ──────────────────────────────────────────────────────────────

/** One fetched account as the runner's own RPC returned it (or a golden vector carries it). */
export interface PrivateSolanaLookupTableAccount { readonly key: string; readonly owner: string; readonly data: Uint8Array }
export interface PrivateSolanaLoadedAddresses { readonly writable: readonly string[]; readonly readonly: readonly string[] }
function readU32(bytes: Uint8Array, offset: number): number | undefined {
  return offset + 4 <= bytes.length ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32LE(offset) : undefined;
}
function readU64(bytes: Uint8Array, offset: number): bigint | undefined {
  return offset + 8 <= bytes.length ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readBigUInt64LE(offset) : undefined;
}
/** `parse_active_lookup_table`: foreign owner, malformed data or a deactivated table denies. */
export function parseActiveLookupTable(account: PrivateSolanaLookupTableAccount): string[] {
  if (account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) deny("lookup_table_owner_invalid");
  const data = account.data;
  if (!(data instanceof Uint8Array) || data.length < LOOKUP_TABLE_META_SIZE || (data.length - LOOKUP_TABLE_META_SIZE) % 32 !== 0) deny("lookup_table_data_invalid");
  const discriminator = readU32(data, 0); const deactivationSlot = readU64(data, 4);
  if (discriminator !== 1) deny("lookup_table_data_invalid");
  if (deactivationSlot !== U64_MAX) deny("lookup_table_deactivated");
  const addresses: string[] = [];
  for (let offset = LOOKUP_TABLE_META_SIZE; offset < data.length; offset += 32) addresses.push(encodeBase58(data.subarray(offset, offset + 32)));
  return addresses;
}
/** `resolve_loaded_addresses`: message order; every writable index, then every readonly index. */
export function resolveLookupTables(message: SolanaV0Message, tables: readonly PrivateSolanaLookupTableAccount[]): PrivateSolanaLoadedAddresses {
  const writable: string[] = []; const readonly: string[] = [];
  for (const lookup of message.addressTableLookups) {
    const key = encodeBase58(lookup.accountKey);
    const table = tables.find((candidate) => candidate.key === key);
    if (!table) deny("lookup_table_missing");
    const addresses = parseActiveLookupTable(table);
    const pick = (index: number): string => addresses[index] ?? deny("lookup_index_out_of_range");
    for (const index of lookup.writableIndexes) writable.push(pick(index));
    for (const index of lookup.readonlyIndexes) readonly.push(pick(index));
  }
  return { writable, readonly };
}

// ── expectations ────────────────────────────────────────────────────────────────────────────

/** The server's `LocalSwapExpected` facts (engine `local_swap.rs`), closed schema, canonical text. */
export interface PrivateSolanaServerExpected {
  direction: "buy" | "sell"; wallet: string; inputMint: string; outputMint: string; inputTokenProgram: string; outputTokenProgram: string;
  tokenDecimals: number; grossIn: string;
  /** Buy: exact input lamports. Sell: the quote's `platformFee.amount` in lamports (informational, bounded by bps). */
  feeAmount: string; feeBasis: PrivateSolanaFeeBasis; feeRateBps: number; feeRecipient: string;
  /** Buy: the platform wallet ("" when the fee is 0). Sell: the platform's WSOL ATA ("" only at a zero rate). */
  feeRecipientAccount: string;
  feePolicyDigest: string; netIn: string; quotedOut: string; minOut: string; slippageBps: number; maxPriorityFeeLamports: string;
}
/** What the runner itself expects, from its saved plan, plan-bound assessment, own mint read and own ceiling. */
export interface PrivateSolanaRunnerExpectation {
  direction: "buy" | "sell"; wallet: string; inputMint: string; outputMint: string;
  /** Owner program and decimals of the non-WSOL mint, read from the runner's own RPC (see privateSolanaMintFacts). */
  tokenProgram: string; tokenDecimals: number;
  /** Exactly the plan's amount in base units. */
  grossIn: string; slippageBps: number;
  /** `input_lamports` for a buy, `output_sol` for a sell. */
  feeBasis: PrivateSolanaFeeBasis;
  /** The plan-bound assessment's global fee policy. A sell's fee account is the WSOL ATA the validator derives
   * from `feeRecipient` itself; the server's account text is only compared against it. */
  feeRateBps: number; feeRecipient: string; feePolicyDigest: string;
  /** The assessment's minimum output (sell: the conservative proceeds floor); the server's may not be worse. Null only when no bound exists. */
  minOutBound: string | null;
  maxPriorityFeeLamports: string;
}
export interface PrivateSolanaSwapValidationInput {
  /** Unsigned v0 message bytes exactly as returned for signing. */
  message: Uint8Array;
  /** Lowercase hex sha256 the server bound to the message. */
  messageSha256: string;
  expected: unknown;
  /** Lookup-table accounts read from the runner's own RPC (or carried by a golden vector). */
  lookupTables: readonly PrivateSolanaLookupTableAccount[];
  runner: PrivateSolanaRunnerExpectation;
}
interface PrivateSolanaValidatedCommon {
  readonly wallet: string; readonly sourceAta: string; readonly destinationAta: string; readonly inAmount: string; readonly quotedOut: string;
  readonly slippageBps: number; readonly minOut: string; readonly wrapLamports: string; readonly priorityFeeLamports: string;
  readonly createdAtas: number; readonly messageSha256: string; readonly blockhash: string;
  /** Static, then lookup-writable, then lookup-readonly keys, as simulation indexes them. */
  readonly accountKeys: readonly string[];
}
export interface PrivateSolanaValidatedBuy extends PrivateSolanaValidatedCommon {
  readonly direction: "buy"; readonly outputMint: string; readonly outputTokenProgram: string; readonly feeAmount: string; readonly feeRecipient: string;
}
/** Engine `ValidatedSell`: `destinationAta` is the wallet's WSOL ATA, `minOut` the floor net of the platform fee. */
export interface PrivateSolanaValidatedSell extends PrivateSolanaValidatedCommon {
  readonly direction: "sell"; readonly inputMint: string; readonly inputTokenProgram: string; readonly routeMinOut: string;
  /** 0 and "" when the global rate is zero. */
  readonly platformFeeBps: number; readonly platformFeeAccount: string;
}
export type PrivateSolanaValidatedSwap = PrivateSolanaValidatedBuy | PrivateSolanaValidatedSell;
export type PrivateSolanaSwapVerdict = { readonly ok: true; readonly swap: PrivateSolanaValidatedSwap }
  | { readonly ok: false; readonly reason: PrivateSolanaSwapDenyReason };

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(fields, key))
    && Object.values(fields).every((field) => "value" in field && field.enumerable);
}
export function canonicalU64(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return undefined;
  const parsed = BigInt(value); return parsed <= U64_MAX ? parsed : undefined;
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}
export function solanaFeePolicyDigest(rateBps: number, recipient: string): string {
  return createHash("sha256").update(JSON.stringify(["balchemy.solana-fee-policy.v1", "backend_global_fee_config", rateBps, recipient]), "utf8").digest("hex");
}
/** floor(gross × bps / 10000) and the conserved remainder: the one global (buy) fee rule. */
export function solanaFeeSplit(gross: bigint, rateBps: number): { fee: bigint; net: bigint } {
  const fee = (gross * BigInt(rateBps)) / BPS; return { fee, net: gross - fee };
}
/** Engine `min_out_after_platform_fee`: min_out − ceil(min_out × bps / 10000), which holds whether Jupiter's
 * slippage check runs before or after its platform-fee deduction. */
export function solanaMinOutAfterPlatformFee(minOut: bigint, feeBps: number): bigint {
  return minOut - (minOut * BigInt(feeBps) + BPS - 1n) / BPS;
}
/** Threshold rounding (finding F1, M3.5 captures; engine `jupiter::slippage_threshold_floor`). With p = quotedOut x (10000 −
 * slippage), real Jupiter quotes carry the ceiling ceil(p / 10000); the exact floor floor(p / 10000) stays accepted (earlier
 * quotes and the engine's own reports carry it). The server's `minOut` must be one of the two (sell: net of the platform fee),
 * nothing else, so it is never below what the slippage allows. Whichever it is, the runner proves and reports the floor: the
 * route's on-chain slippage check enforces it under either rounding, which no capture pins yet. */
export function solanaSlippageThresholds(quotedOut: bigint, slippageBps: number): { floor: bigint; ceiling: bigint } {
  const scaled = quotedOut * (BPS - BigInt(slippageBps)); return { floor: scaled / BPS, ceiling: (scaled + BPS - 1n) / BPS };
}
/** The order floor the bytes must prove: the slippage floor of the server's quote, net of a sell's platform fee. */
function serverOrderFloor(server: PrivateSolanaServerExpected): bigint {
  const { floor } = solanaSlippageThresholds(BigInt(server.quotedOut), server.slippageBps);
  return server.direction === "sell" && server.feeRateBps > 0 ? solanaMinOutAfterPlatformFee(floor, server.feeRateBps) : floor;
}
const EXPECTED_KEYS = ["direction", "wallet", "inputMint", "outputMint", "inputTokenProgram", "outputTokenProgram", "tokenDecimals", "grossIn",
  "feeAmount", "feeBasis", "feeRateBps", "feeRecipient", "feeRecipientAccount", "feePolicyDigest", "netIn", "quotedOut", "minOut", "slippageBps",
  "maxPriorityFeeLamports"];
/** Closed, internally consistent server facts, or `expected_facts_invalid`. */
export function parsePrivateSolanaServerExpected(value: unknown): PrivateSolanaServerExpected {
  if (!record(value, EXPECTED_KEYS)) deny("expected_facts_invalid");
  const v = value;
  const direction = v.direction; const buy = direction === "buy";
  const keys = [v.wallet, v.inputMint, v.outputMint, v.inputTokenProgram, v.outputTokenProgram];
  if ((direction !== "buy" && direction !== "sell") || !keys.every(isSolanaAddress)) deny("expected_facts_invalid");
  const token = buy ? v.outputMint : v.inputMint; const tokenProgram = buy ? v.outputTokenProgram : v.inputTokenProgram;
  const gross = canonicalU64(v.grossIn); const fee = canonicalU64(v.feeAmount); const net = canonicalU64(v.netIn);
  const quoted = canonicalU64(v.quotedOut); const minOut = canonicalU64(v.minOut); const priority = canonicalU64(v.maxPriorityFeeLamports);
  if ((buy ? v.inputMint : v.outputMint) !== WSOL_MINT || token === WSOL_MINT || (buy ? v.inputTokenProgram : v.outputTokenProgram) !== TOKEN_PROGRAM
    || (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) || v.wallet === token || v.wallet === WSOL_MINT
    || !integer(v.tokenDecimals, 0, 255) || !integer(v.feeRateBps, 0, 10_000) || !integer(v.slippageBps, 1, 5_000)
    || gross === undefined || gross === 0n || fee === undefined || net === undefined || net === 0n || quoted === undefined || quoted === 0n
    || minOut === undefined || minOut === 0n || priority === undefined || priority > PRIVATE_SOLANA_MAX_PRIORITY_FEE_LAMPORTS
    || v.feeBasis !== SOLANA_FEE_BASIS[direction]) deny("expected_facts_invalid");
  const rate = v.feeRateBps; const recipient = v.feeRecipient; const account = v.feeRecipientAccount;
  if (typeof recipient !== "string" || typeof account !== "string" || typeof v.feePolicyDigest !== "string"
    || (rate === 0 ? recipient !== "" : !isSolanaAddress(recipient) || recipient === v.wallet)
    || v.feePolicyDigest !== solanaFeePolicyDigest(rate, recipient)) deny("expected_facts_invalid");
  // F1: the route threshold is the floor or Jupiter's ceiling (see solanaSlippageThresholds); a zero floor is never usable.
  const thresholds = solanaSlippageThresholds(quoted, v.slippageBps);
  const afterFee = (route: bigint): bigint => (buy || rate === 0 ? route : solanaMinOutAfterPlatformFee(route, rate));
  if (afterFee(thresholds.floor) === 0n || (minOut !== afterFee(thresholds.floor) && minOut !== afterFee(thresholds.ceiling))) deny("expected_facts_invalid");
  if (buy) {
    const split = solanaFeeSplit(gross, rate);
    if (split.fee !== fee || split.net !== net || account !== (fee === 0n ? "" : recipient)) deny("expected_facts_invalid");
  } else if (rate > SOLANA_MAX_PLATFORM_FEE_BPS || net !== gross || account !== (rate === 0 ? "" : solanaPlatformWsolAccount(recipient))
    // Engine `check_sell_quote`: the quoted fee is at most bps of the gross (pre-fee) output.
    || (rate === 0 ? fee !== 0n : fee * BPS > (quoted + fee) * BigInt(rate))) deny("expected_facts_invalid");
  return Object.freeze({ ...(v as unknown as PrivateSolanaServerExpected) });
}
function checkRunnerAgreement(server: PrivateSolanaServerExpected, runner: PrivateSolanaRunnerExpectation): void {
  if (!record(runner, ["direction", "wallet", "inputMint", "outputMint", "tokenProgram", "tokenDecimals", "grossIn", "slippageBps",
    "feeBasis", "feeRateBps", "feeRecipient", "feePolicyDigest", "minOutBound", "maxPriorityFeeLamports"])) deny("runner_expectation_mismatch");
  const buy = server.direction === "buy";
  const gross = canonicalU64(runner.grossIn); const ceiling = canonicalU64(runner.maxPriorityFeeLamports);
  const bound = runner.minOutBound === null ? null : canonicalU64(runner.minOutBound);
  if (runner.direction !== server.direction || runner.wallet !== server.wallet || runner.inputMint !== server.inputMint
    || runner.outputMint !== server.outputMint || runner.tokenProgram !== (buy ? server.outputTokenProgram : server.inputTokenProgram)
    || runner.tokenDecimals !== server.tokenDecimals || gross === undefined || gross !== BigInt(server.grossIn)
    || runner.slippageBps !== server.slippageBps || runner.feeBasis !== server.feeBasis || runner.feeBasis !== SOLANA_FEE_BASIS[runner.direction]
    || runner.feeRateBps !== server.feeRateBps || runner.feeRecipient !== server.feeRecipient
    || runner.feePolicyDigest !== server.feePolicyDigest || runner.feePolicyDigest !== solanaFeePolicyDigest(runner.feeRateBps, runner.feeRecipient)
    || bound === undefined || (bound !== null && BigInt(server.minOut) < bound)
    || ceiling === undefined || BigInt(server.maxPriorityFeeLamports) > ceiling) deny("runner_expectation_mismatch");
  // The runner re-derives the fee terms itself: the buy lamport split, or the sell's own platform WSOL ATA.
  if (buy) {
    const split = solanaFeeSplit(gross, runner.feeRateBps);
    if (split.fee !== BigInt(server.feeAmount) || split.net !== BigInt(server.netIn)) deny("runner_expectation_mismatch");
  } else if (server.feeRecipientAccount !== (runner.feeRateBps === 0 ? "" : solanaPlatformWsolAccount(runner.feeRecipient))) {
    deny("runner_expectation_mismatch");
  }
}

// ── swap_validation.rs ──────────────────────────────────────────────────────────────────────

class Resolved {
  constructor(readonly keys: readonly string[], readonly instructions: readonly SolanaCompiledInstruction[]) {}
  key(index: number): string { return this.keys[index] ?? deny("account_index_out_of_range"); }
  account(accounts: Uint8Array, position: number): string {
    const index = accounts[position]; if (index === undefined) deny("instruction_account_missing"); return this.key(index);
  }
}
/** `VersionedMessage::sanitize` (v0) plus `sanitize_signatures` for a placeholder-signed transaction. */
function sanitized(message: SolanaV0Message, signatures: number): boolean {
  const { header } = message; const staticCount = message.staticAccountKeys.length;
  if (header.numRequiredSignatures + header.numReadonlyUnsignedAccounts > staticCount) return false;
  if (header.numReadonlySignedAccounts >= header.numRequiredSignatures) return false;
  let dynamicCount = 0;
  for (const lookup of message.addressTableLookups) {
    const count = lookup.writableIndexes.length + lookup.readonlyIndexes.length; if (count === 0) return false; dynamicCount += count;
  }
  if (staticCount === 0 || staticCount + dynamicCount > 256) return false;
  const maxAccount = staticCount + dynamicCount - 1; const maxProgram = staticCount - 1;
  for (const instruction of message.instructions) {
    if (instruction.programIdIndex > maxProgram || instruction.programIdIndex === 0) return false;
    if (instruction.accounts.some((index) => index > maxAccount)) return false;
  }
  return signatures === header.numRequiredSignatures && signatures <= staticCount;
}
/** `resolve`: wire size, sanitize, exactly one signer that is the fee-paying wallet, unique keys. */
function resolve(bytes: Uint8Array, message: SolanaV0Message, loaded: PrivateSolanaLoadedAddresses, wallet: string): Resolved {
  // The engine serializes with one placeholder signature per required signer.
  const signatures = message.header.numRequiredSignatures;
  if (solanaWireSize(bytes.length, signatures) > SOLANA_MAX_WIRE_BYTES) deny("wire_size_exceeded");
  if (!sanitized(message, signatures)) deny("transaction_not_sanitized");
  if (signatures !== 1) deny("signer_count_invalid");
  if (message.header.numRequiredSignatures !== 1 || message.header.numReadonlySignedAccounts !== 0) deny("signer_count_invalid");
  const staticKeys = message.staticAccountKeys.map((key) => encodeBase58(key));
  if (staticKeys[0] !== wallet) deny("fee_payer_not_custodial_wallet");
  const lookupWritable = message.addressTableLookups.reduce((sum, lookup) => sum + lookup.writableIndexes.length, 0);
  const lookupReadonly = message.addressTableLookups.reduce((sum, lookup) => sum + lookup.readonlyIndexes.length, 0);
  if (loaded.writable.length !== lookupWritable || loaded.readonly.length !== lookupReadonly) deny("lookup_resolution_mismatch");
  const keys = [...staticKeys, ...loaded.writable, ...loaded.readonly];
  if (new Set(keys).size !== keys.length) deny("duplicate_account_key");
  return new Resolved(keys, message.instructions);
}
function same(data: Uint8Array, ...expected: number[]): boolean { return data.length === expected.length && expected.every((value, index) => data[index] === value); }
function ataData(data: Uint8Array): boolean { return data.length === 0 || same(data, 0) || same(data, 1); }

interface ComputeBudget { unitLimit?: number; unitPrice?: bigint }
function recordComputeBudget(data: Uint8Array, accounts: Uint8Array, budget: ComputeBudget): void {
  if (accounts.length !== 0) deny("compute_budget_accounts_present");
  if (data[0] === 2 && data.length === 5 && budget.unitLimit === undefined) budget.unitLimit = readU32(data, 1);
  else if (data[0] === 3 && data.length === 9 && budget.unitPrice === undefined) budget.unitPrice = readU64(data, 1);
  else deny("compute_budget_instruction_not_allowed");
}
function priorityFeeLamports(budget: ComputeBudget): bigint {
  if (budget.unitPrice === undefined) return 0n;
  // A price without an explicit limit is charged on the runtime default; deny instead of guessing.
  if (budget.unitLimit === undefined) deny("compute_unit_limit_missing");
  const micro = BigInt(budget.unitLimit) * budget.unitPrice; const lamports = (micro + 999_999n) / 1_000_000n;
  if (lamports > U64_MAX) deny("priority_fee_overflow");
  return lamports;
}
/** The route's slippage floor: deliberately the floor (finding F1, see solanaSlippageThresholds). */
function minOutAfterSlippage(quotedOut: bigint, slippageBps: number): bigint {
  const value = (quotedOut * (BPS - BigInt(slippageBps))) / BPS; if (value > U64_MAX) deny("min_out_overflow"); return value;
}
/** Sell-side Jupiter platform fee on the WSOL output (engine `PlatformFee`). */
interface PlatformFee { feeAccount: string; feeBps: number }
interface RouteExpectation {
  wallet: string; sourceMint: string; destinationMint: string; sourceAccount: string; destinationAccount: string;
  /** Owner program of `destinationMint` (buy: the runner-agreed mint owner; sell: the Token program for WSOL): route account 0. */
  destinationTokenProgram: string;
  inAmount: bigint; maxSlippageBps: number; sourceDenial: PrivateSolanaSwapDenyReason; destinationDenial: PrivateSolanaSwapDenyReason;
  /** Null: the route must carry no platform fee (buy, zero-rate sell). */
  platformFee: PlatformFee | null;
}
interface Route { inAmount: bigint; quotedOut: bigint; slippageBps: number }
function validateJupiterRoute(resolved: Resolved, data: Uint8Array, accounts: Uint8Array, expected: RouteExpectation): Route {
  if (data.length < 8) deny("jupiter_data_short");
  const discriminator = Buffer.from(data.subarray(0, 8));
  // (authority, source, destination, platform fee account) positions.
  let positions: [number, number, number, number];
  if (discriminator.equals(JUPITER_ROUTE)) {
    if (resolved.account(accounts, 5) !== expected.destinationMint) deny("jupiter_destination_mint_mismatch");
    positions = [1, 2, 3, 6];
  } else if (discriminator.equals(JUPITER_SHARED_ACCOUNTS_ROUTE)) {
    if (resolved.account(accounts, 7) !== expected.sourceMint || resolved.account(accounts, 8) !== expected.destinationMint) deny("jupiter_mint_mismatch");
    // Account 0 follows the same destination-mint rule below. Unverified for this instruction: no real Token-2022
    // shared_accounts_route buy has been captured (M3.5 has route captures only).
    positions = [2, 3, 6, 9];
  } else deny("jupiter_instruction_not_allowed");
  // Finding F2 (M3.5 captures): account 0 is the destination mint's token program, Token-2022 for a buy into a Token-2022
  // mint and the Token program for a sell (WSOL out). Only Token or Token-2022 can ever match.
  if ((expected.destinationTokenProgram !== TOKEN_PROGRAM && expected.destinationTokenProgram !== TOKEN_2022_PROGRAM)
    || resolved.account(accounts, 0) !== expected.destinationTokenProgram) deny("jupiter_token_program_mismatch");
  if (resolved.account(accounts, positions[0]) !== expected.wallet) deny("jupiter_authority_not_wallet");
  if (resolved.account(accounts, positions[1]) !== expected.sourceAccount) deny(expected.sourceDenial);
  if (resolved.account(accounts, positions[2]) !== expected.destinationAccount) deny(expected.destinationDenial);
  // Anchor encodes an absent optional account as the program id.
  const platformFeeAccount = resolved.account(accounts, positions[3]);
  if (!expected.platformFee && platformFeeAccount !== JUPITER_V6_PROGRAM) deny("jupiter_platform_fee_account_present");
  if (expected.platformFee && platformFeeAccount !== expected.platformFee.feeAccount) deny("jupiter_platform_fee_account_mismatch");
  if (data.length < 8 + ROUTE_ARGS_TAIL) deny("jupiter_data_short");
  const tail = data.subarray(data.length - ROUTE_ARGS_TAIL);
  const inAmount = readU64(tail, 0)!; const quotedOut = readU64(tail, 8)!;
  const slippageBps = tail[16]! | (tail[17]! << 8); const platformFeeBps = tail[18]!;
  if (inAmount !== expected.inAmount) deny("jupiter_in_amount_mismatch");
  if (slippageBps > expected.maxSlippageBps || slippageBps >= 10_000) deny("jupiter_slippage_exceeded");
  if (!expected.platformFee && platformFeeBps !== 0) deny("jupiter_platform_fee_not_allowed");
  if (expected.platformFee && platformFeeBps !== expected.platformFee.feeBps) deny("jupiter_platform_fee_bps_mismatch");
  return { inAmount, quotedOut, slippageBps };
}

interface ExpectedBuy {
  wallet: string; outputMint: string; outputTokenProgram: string; inAmount: bigint; maxSlippageBps: number; minOut: bigint;
  feeTransfer: { feeWallet: string; lamports: bigint } | null; maxPriorityFeeLamports: bigint;
}
/** `validate_swap` (buy: WSOL → token). */
function validateBuy(bytes: Uint8Array, message: SolanaV0Message, loaded: PrivateSolanaLoadedAddresses, expected: ExpectedBuy) {
  if (expected.inAmount === 0n || expected.outputMint === WSOL_MINT) deny("expected_swap_invalid");
  if (expected.outputTokenProgram !== TOKEN_PROGRAM && expected.outputTokenProgram !== TOKEN_2022_PROGRAM) deny("output_token_program_invalid");
  const resolved = resolve(bytes, message, loaded, expected.wallet);
  const wallet = expected.wallet;
  const wsolAta = solanaAssociatedTokenAddress(wallet, TOKEN_PROGRAM, WSOL_MINT);
  const outputAta = solanaAssociatedTokenAddress(wallet, expected.outputTokenProgram, expected.outputMint);
  const budget: ComputeBudget = {}; let wrap: bigint | undefined; let fee: bigint | undefined; let createdAtas = 0; let route: Route | undefined;
  for (const instruction of resolved.instructions) {
    const program = resolved.key(instruction.programIdIndex); const { data, accounts } = instruction;
    if (program === COMPUTE_BUDGET_PROGRAM) recordComputeBudget(data, accounts, budget);
    else if (program === SYSTEM_PROGRAM) {
      if (data.length !== 12 || readU32(data, 0) !== 2 || accounts.length !== 2) deny("system_instruction_not_allowed");
      const lamports = readU64(data, 4)!;
      if (resolved.account(accounts, 0) !== wallet) deny("system_transfer_source_not_wallet");
      const destination = resolved.account(accounts, 1);
      if (destination === wsolAta && wrap === undefined) wrap = lamports;
      else if (expected.feeTransfer?.feeWallet === destination && fee === undefined) fee = lamports;
      else deny("system_transfer_destination_not_allowed");
    } else if (program === ASSOCIATED_TOKEN_PROGRAM) {
      if (!ataData(data) || accounts.length !== 6) deny("ata_instruction_not_allowed");
      const [funder, ata, owner, mint, system, tokenProgram] = [0, 1, 2, 3, 4, 5].map((position) => resolved.account(accounts, position));
      const allowed = funder === wallet && owner === wallet && system === SYSTEM_PROGRAM
        && ((mint === WSOL_MINT && tokenProgram === TOKEN_PROGRAM && ata === wsolAta)
          || (mint === expected.outputMint && tokenProgram === expected.outputTokenProgram && ata === outputAta));
      if (!allowed || ++createdAtas > 2) deny("ata_create_not_allowed");
    } else if (program === TOKEN_PROGRAM) {
      const sync = same(data, 17) && accounts.length === 1 && resolved.account(accounts, 0) === wsolAta;
      const close = !sync && same(data, 9) && accounts.length === 3 && resolved.account(accounts, 0) === wsolAta
        && resolved.account(accounts, 1) === wallet && resolved.account(accounts, 2) === wallet;
      if (!sync && !close) deny("token_instruction_not_allowed");
    } else if (program === JUPITER_V6_PROGRAM) {
      if (route) deny("multiple_jupiter_instructions");
      route = validateJupiterRoute(resolved, data, accounts, { wallet, sourceMint: WSOL_MINT, destinationMint: expected.outputMint,
        destinationTokenProgram: expected.outputTokenProgram,
        sourceAccount: wsolAta, destinationAccount: outputAta, inAmount: expected.inAmount, maxSlippageBps: expected.maxSlippageBps,
        sourceDenial: "jupiter_source_not_wallet_wsol_ata", destinationDenial: "jupiter_destination_not_wallet_ata", platformFee: null });
    } else deny("program_not_allowed");
  }
  if (!route) deny("jupiter_route_missing");
  const wrapLamports = wrap ?? 0n;
  if (wrapLamports !== 0n && wrapLamports !== route.inAmount) deny("wrap_amount_mismatch");
  let feeLamports: bigint;
  if (expected.feeTransfer && fee !== undefined && expected.feeTransfer.lamports === fee && fee > 0n) feeLamports = fee;
  else if (expected.feeTransfer && fee === undefined && expected.feeTransfer.lamports === 0n) feeLamports = 0n;
  else if (!expected.feeTransfer && fee === undefined) feeLamports = 0n;
  else deny("fee_transfer_mismatch");
  const priority = priorityFeeLamports(budget);
  if (priority > expected.maxPriorityFeeLamports) deny("priority_fee_exceeded");
  const minOut = minOutAfterSlippage(route.quotedOut, route.slippageBps);
  if (minOut < expected.minOut || minOut === 0n) deny("min_out_below_order_floor");
  return { resolved, wsolAta, outputAta, route, minOut, wrapLamports, feeLamports, priority, createdAtas };
}

interface ExpectedSell {
  wallet: string; inputMint: string; inputTokenProgram: string; inAmount: bigint; maxSlippageBps: number; minOut: bigint;
  platformFee: PlatformFee | null; maxPriorityFeeLamports: bigint;
}
/** `validate_sell` (token → WSOL): no System instruction, only the wallet's own WSOL ATA may be created, no
 * transfer of any kind by the Token or input token program (the fee is the route's own WSOL platform fee),
 * exactly one route carrying exactly `platformFee`, and the WSOL close after the route as the final instruction. */
function validateSell(bytes: Uint8Array, message: SolanaV0Message, loaded: PrivateSolanaLoadedAddresses, expected: ExpectedSell) {
  if (expected.inAmount === 0n || expected.inputMint === WSOL_MINT) deny("expected_swap_invalid");
  if (expected.inputTokenProgram !== TOKEN_PROGRAM && expected.inputTokenProgram !== TOKEN_2022_PROGRAM) deny("input_token_program_invalid");
  const wallet = expected.wallet;
  const wsolAta = solanaAssociatedTokenAddress(wallet, TOKEN_PROGRAM, WSOL_MINT);
  const sourceAta = solanaAssociatedTokenAddress(wallet, expected.inputTokenProgram, expected.inputMint);
  const fee = expected.platformFee;
  if (fee && (fee.feeBps === 0 || [sourceAta, wsolAta, wallet].includes(fee.feeAccount))) deny("expected_swap_invalid");
  const resolved = resolve(bytes, message, loaded, wallet);
  const budget: ComputeBudget = {}; let createdAtas = 0; let route: Route | undefined; let closed = false;
  for (const instruction of resolved.instructions) {
    // The WSOL unwrap must be the final instruction: nothing may observe or move the unwrapped lamports afterwards.
    if (closed) deny("wsol_close_not_final");
    const program = resolved.key(instruction.programIdIndex); const { data, accounts } = instruction;
    if (program === COMPUTE_BUDGET_PROGRAM) recordComputeBudget(data, accounts, budget);
    else if (program === SYSTEM_PROGRAM) deny("system_instruction_not_allowed");
    else if (program === ASSOCIATED_TOKEN_PROGRAM) {
      if (!ataData(data) || accounts.length !== 6) deny("ata_instruction_not_allowed");
      const [funder, ata, owner, mint, system, tokenProgram] = [0, 1, 2, 3, 4, 5].map((position) => resolved.account(accounts, position));
      // Only the wallet's own WSOL ATA; never the platform fee ATA.
      const allowed = funder === wallet && ata === wsolAta && owner === wallet && mint === WSOL_MINT && system === SYSTEM_PROGRAM && tokenProgram === TOKEN_PROGRAM;
      if (!allowed || ++createdAtas > 1) deny("ata_create_not_allowed");
    } else if (program === TOKEN_PROGRAM || program === expected.inputTokenProgram) {
      const sync = same(data, 17) && accounts.length === 1 && program === TOKEN_PROGRAM && resolved.account(accounts, 0) === wsolAta;
      const close = !sync && same(data, 9) && accounts.length === 3 && program === TOKEN_PROGRAM && resolved.account(accounts, 0) === wsolAta
        && resolved.account(accounts, 1) === wallet && resolved.account(accounts, 2) === wallet;
      if (close) { if (!route) deny("wsol_close_before_route"); closed = true; }
      else if (!sync) deny("token_instruction_not_allowed");
    } else if (program === JUPITER_V6_PROGRAM) {
      if (route) deny("multiple_jupiter_instructions");
      route = validateJupiterRoute(resolved, data, accounts, { wallet, sourceMint: expected.inputMint, destinationMint: WSOL_MINT,
        destinationTokenProgram: TOKEN_PROGRAM,
        sourceAccount: sourceAta, destinationAccount: wsolAta, inAmount: expected.inAmount, maxSlippageBps: expected.maxSlippageBps,
        sourceDenial: "jupiter_source_not_wallet_token_ata", destinationDenial: "jupiter_destination_not_wallet_wsol_ata", platformFee: fee });
    } else deny("program_not_allowed");
  }
  if (!route) deny("jupiter_route_missing");
  if (!closed) deny("wsol_close_missing");
  const priority = priorityFeeLamports(budget);
  if (priority > expected.maxPriorityFeeLamports) deny("priority_fee_exceeded");
  const routeMinOut = minOutAfterSlippage(route.quotedOut, route.slippageBps);
  const minOut = fee ? solanaMinOutAfterPlatformFee(routeMinOut, fee.feeBps) : routeMinOut;
  if (minOut < expected.minOut || minOut === 0n) deny("min_out_below_order_floor");
  return { resolved, sourceAta, wsolAta, route, routeMinOut, minOut, priority, createdAtas,
    platformFeeBps: fee?.feeBps ?? 0, platformFeeAccount: fee?.feeAccount ?? "" };
}

function sha256Hex(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function decode(bytes: Uint8Array): SolanaV0Message {
  try { return decodeSolanaV0Message(bytes); }
  catch (error: unknown) {
    // Beyond the parse ceiling a message cannot fit a packet either way.
    if (error instanceof SolanaTxCodecError && error.code === "message_too_large") deny("wire_size_exceeded");
    return deny("message_decode_invalid");
  }
}
/** Pure, deterministic verdict over the exact bytes. Order: server facts → runner agreement → runner fee policy →
 * bound digest → decode → lookup tables (engine `revalidate`) → `validate_directed_swap` → the
 * engine's post-validation re-check against the exact plan. Never throws for hostile input. */
export function validatePrivateSolanaSwap(input: PrivateSolanaSwapValidationInput,
  /** The allow-listed fee wallets (production callers pass privateFeeWallets(capabilities); only tests inject a synthetic one). */
  feeWallets: readonly string[] = PRIVATE_FEE_WALLETS): PrivateSolanaSwapVerdict {
  try {
    if (!input || typeof input !== "object" || !(input.message instanceof Uint8Array) || !Array.isArray(input.lookupTables)) deny("expected_facts_invalid");
    const server = parsePrivateSolanaServerExpected(input.expected);
    checkRunnerAgreement(server, input.runner);
    // The runner's own fee policy over the (rate, recipient) both sides agreed on: the ceiling and an allow-listed recipient.
    const policy = privateFeePolicyRefusal(server.feeRateBps, server.feeRecipient, feeWallets);
    if (policy) deny(policy);
    const bytes = Uint8Array.from(input.message);
    if (bytes.length > SOLANA_MAX_MESSAGE_PARSE_BYTES) deny("wire_size_exceeded");
    if (typeof input.messageSha256 !== "string" || input.messageSha256 !== sha256Hex(bytes)) deny("message_digest_mismatch");
    const message = decode(bytes);
    if (message.addressTableLookups.length > PRIVATE_SOLANA_MAX_LOOKUP_TABLES) deny("lookup_table_count_exceeded");
    const tables = input.lookupTables.map((table) => {
      if (!table || typeof table.key !== "string" || typeof table.owner !== "string" || !(table.data instanceof Uint8Array)) deny("lookup_table_data_invalid");
      return Object.freeze({ key: table.key, owner: table.owner, data: Uint8Array.from(table.data) });
    });
    const loaded = resolveLookupTables(message, tables);
    const maxPriorityFeeLamports = BigInt(server.maxPriorityFeeLamports);
    // Engine `assemble` re-checks below run against the exact plan, with the runner's own bound.
    const bound = input.runner.minOutBound === null ? null : BigInt(input.runner.minOutBound);
    // F1: the bytes must prove the slippage floor, whichever accepted threshold the server reported.
    const orderFloor = serverOrderFloor(server);
    const common = { wallet: server.wallet, messageSha256: input.messageSha256, blockhash: encodeBase58(message.recentBlockhash) };
    if (server.direction === "sell") {
      // The fee account is derived from the allow-listed recipient the runner itself named (the server agreed), never from server text.
      const platformFee = server.feeRateBps === 0 ? null : { feeAccount: solanaPlatformWsolAccount(input.runner.feeRecipient), feeBps: server.feeRateBps };
      const proven = validateSell(bytes, message, loaded, { wallet: server.wallet, inputMint: server.inputMint,
        inputTokenProgram: server.inputTokenProgram, inAmount: BigInt(server.netIn), maxSlippageBps: server.slippageBps,
        minOut: orderFloor, platformFee, maxPriorityFeeLamports });
      if (proven.route.inAmount !== BigInt(server.netIn) || proven.platformFeeBps !== (platformFee?.feeBps ?? 0)
        || proven.platformFeeAccount !== (platformFee?.feeAccount ?? "") || proven.minOut < orderFloor
        || proven.route.slippageBps > input.runner.slippageBps || (bound !== null && proven.minOut < bound)) deny("validated_facts_mismatch");
      return Object.freeze({ ok: true as const, swap: Object.freeze({ direction: "sell" as const, ...common, inputMint: server.inputMint,
        inputTokenProgram: server.inputTokenProgram, sourceAta: proven.sourceAta, destinationAta: proven.wsolAta,
        inAmount: proven.route.inAmount.toString(), quotedOut: proven.route.quotedOut.toString(), slippageBps: proven.route.slippageBps,
        routeMinOut: proven.routeMinOut.toString(), minOut: proven.minOut.toString(), wrapLamports: "0", platformFeeBps: proven.platformFeeBps,
        platformFeeAccount: proven.platformFeeAccount, priorityFeeLamports: proven.priority.toString(), createdAtas: proven.createdAtas,
        accountKeys: Object.freeze([...proven.resolved.keys]) }) });
    }
    const feeAmount = BigInt(server.feeAmount);
    const proven = validateBuy(bytes, message, loaded, { wallet: server.wallet, outputMint: server.outputMint,
      outputTokenProgram: server.outputTokenProgram, inAmount: BigInt(server.netIn), maxSlippageBps: server.slippageBps,
      // The only allowed fee destination is the allow-listed recipient the runner itself named (the server agreed).
      minOut: orderFloor, feeTransfer: feeAmount === 0n ? null : { feeWallet: input.runner.feeRecipient, lamports: feeAmount },
      maxPriorityFeeLamports });
    if (proven.route.inAmount !== BigInt(server.netIn) || proven.feeLamports !== feeAmount || proven.minOut < orderFloor
      || proven.route.slippageBps > input.runner.slippageBps || (bound !== null && proven.minOut < bound)) deny("validated_facts_mismatch");
    return Object.freeze({ ok: true as const, swap: Object.freeze({ direction: "buy" as const, ...common, outputMint: server.outputMint,
      outputTokenProgram: server.outputTokenProgram, sourceAta: proven.wsolAta, destinationAta: proven.outputAta,
      inAmount: proven.route.inAmount.toString(), quotedOut: proven.route.quotedOut.toString(), slippageBps: proven.route.slippageBps,
      minOut: proven.minOut.toString(), wrapLamports: proven.wrapLamports.toString(), feeAmount: proven.feeLamports.toString(),
      feeRecipient: server.feeRecipient, priorityFeeLamports: proven.priority.toString(), createdAtas: proven.createdAtas,
      accountKeys: Object.freeze([...proven.resolved.keys]) }) });
  } catch (error: unknown) {
    return Object.freeze({ ok: false as const, reason: error instanceof Denied ? error.reason : "validation_unavailable" });
  }
}

// ── runner-side expectation sources ─────────────────────────────────────────────────────────

const SPL_MINT_LEN = 82; const SPL_ACCOUNT_LEN = 165;
const TOKEN_2022_ALLOWED_MINT_EXTENSIONS = [3, 18, 19, 20, 21, 22, 23]; const TOKEN_2022_TRANSFER_FEE_EXTENSIONS = [1, 16];
const TOKEN_2022_TRANSFER_HOOK_EXTENSION = 14;
export type PrivateSolanaMintFacts = { readonly ok: true; readonly tokenProgram: string; readonly decimals: number }
  | { readonly ok: false; readonly reason: `mint_not_supported:${string}` };
/** Token-2022 extension types of a mint (accountType 1) or token account (accountType 2) past the 165-byte base, or undefined
 * when the TLV area is malformed. Exported for the wallet-balance settlement (private-position-balance.ts). */
export function token2022Extensions(data: Uint8Array, accountType: number): number[] | undefined {
  if (data.length <= SPL_ACCOUNT_LEN || data[SPL_ACCOUNT_LEN] !== accountType) return undefined;
  const types: number[] = []; let offset = SPL_ACCOUNT_LEN + 1;
  while (offset < data.length) {
    if (offset + 4 > data.length) return undefined;
    const kind = data[offset]! | (data[offset + 1]! << 8); const length = data[offset + 2]! | (data[offset + 3]! << 8);
    if (kind === 0) { if (data.subarray(offset).some((value) => value !== 0)) return undefined; break; }
    const end = offset + 4 + length; if (end > data.length) return undefined;
    types.push(kind); offset = end;
  }
  return types;
}
/** Port of engine `local_swap::mint_facts`: owner, initialization, decimals and the Token-2022
 * extension policy (transfer fee / hook / unlisted extensions refuse) for a mint the runner read itself. */
export function privateSolanaMintFacts(account: { owner: string; data: Uint8Array; executable: boolean }): PrivateSolanaMintFacts {
  const refuse = (reason: string): PrivateSolanaMintFacts => ({ ok: false, reason: `mint_not_supported:${reason}` });
  if (!account || account.executable !== false || (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM)) return refuse("mint_owner_invalid");
  const data = account.data;
  if (!(data instanceof Uint8Array) || data.length < SPL_MINT_LEN) return refuse("mint_data_invalid");
  if (data[45] !== 1) return refuse("mint_not_initialized");
  if (data.length !== SPL_MINT_LEN) {
    if (account.owner !== TOKEN_2022_PROGRAM || data.length <= SPL_ACCOUNT_LEN || data.subarray(SPL_MINT_LEN, SPL_ACCOUNT_LEN).some((value) => value !== 0)) return refuse("mint_data_invalid");
    const extensions = token2022Extensions(data, 1); if (!extensions) return refuse("mint_data_invalid");
    for (const kind of extensions) {
      if (TOKEN_2022_TRANSFER_FEE_EXTENSIONS.includes(kind)) return refuse("token_2022_transfer_fee");
      if (kind === TOKEN_2022_TRANSFER_HOOK_EXTENSION) return refuse("token_2022_transfer_hook");
      if (!TOKEN_2022_ALLOWED_MINT_EXTENSIONS.includes(kind)) return refuse("token_2022_extension_not_allowed");
    }
  }
  return Object.freeze({ ok: true as const, tokenProgram: account.owner, decimals: data[44]! });
}
