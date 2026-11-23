/** The function the future S4 executor calls before any signature: reads the mint and every lookup table
 * from the runner's OWN RPC in one call, derives the runner's own expectation from the saved plan and its
 * bound assessment, validates the exact engine bytes, simulates them unsigned, reads the exact rent-exempt minimums of the
 * accounts a buy may create from the same RPC (M35PIN-1), checks blockhash freshness
 * and only then asks the signer module to mint a single-use token. It never signs, sends or persists,
 * and it is not wired into the signal flow (S4). `preparePrivateSolanaSwapSignature` is buy only: saved plans
 * are WSOL → token, so a sell build is refused with `direction_unavailable` before any RPC call.
 *
 * `preparePrivateSolanaExitSignature` is the S5c exit (sell) path: the same sequence for the one pending exit of
 * a position and the complete sell assessment of exactly that exit. The production capabilities carry exits since S5; on the
 * exits-off rollback build (PRIVATE_EXIT_EXECUTION_AVAILABLE false) it refuses `direction_unavailable` before any RPC call. */
import type { RunnerSolanaSellAssessment } from "@balchemyai/agent-sdk";
import { decodeSolanaV0Message, solanaKeyText, unsignedSolanaWireTransaction, SOLANA_MAX_MESSAGE_PARSE_BYTES } from "./private-solana-tx-codec.js";
import { PRIVATE_SOLANA_MAX_LOOKUP_TABLES, privateSolanaMintFacts, validatePrivateSolanaSwap,
  type PrivateSolanaLookupTableAccount, type PrivateSolanaRunnerExpectation, type PrivateSolanaValidatedBuy,
  type PrivateSolanaValidatedSell } from "./private-solana-tx-validator.js";
import { derivePrivateSolanaBuyExpectation, derivePrivateSolanaSellExpectation, PrivateSolanaExpectationError } from "./private-solana-swap-expectation.js";
import { evaluatePrivateSolanaSellSimulation, evaluatePrivateSolanaSimulation, privateSolanaSellSimulationAccounts, privateSolanaSimulationFacts,
  SPL_TOKEN_ACCOUNT_LEN, TOKEN_2022_ATA_LEN, type PrivateSolanaTokenAccountRent } from "./private-solana-simulation.js";
import { isPrivateDualSolanaRpc } from "./private-solana-rpc-sources.js";
import { authorizePrivateSolanaSwapSignature, type PrivateSolanaBuyAuthorization, type PrivateSolanaSellAuthorization,
  type PrivateSolanaSigningAuthorization, type PrivateSolanaSigningDenyReason } from "./private-solana-validated-message.js";
import { PRIVATE_EXECUTION_CAPABILITIES, type PrivateExecutionCapabilities } from "./private-execution-gate.js";
import { isPrivateFeePolicyRefusal, privateFeeWallets, type PrivateFeePolicyRefusal } from "./private-fee-policy.js";
import type { PrivateSolanaAccount, PrivateSolanaRpc } from "./private-solana-rpc.js";
import type { PrivateBuyPlanFacts, PrivateSignalAssessment } from "./private-signal-job.js";
import type { PrivatePosition, PrivatePositionPendingExit } from "./private-positions.js";
import { isSolanaAddress } from "./solana-base58.js";

/** The engine build response fields the runner re-proves. */
export interface PrivateSolanaSwapBuild { unsignedMessageB64: string; messageSha256: string; lastValidBlockHeight: string; expected: unknown }
export interface PrivateSolanaSwapPreflightRequest {
  agentId: string;
  /** The verified local trading wallet address (keystore status), never the pairing wallet. */
  wallet: string;
  plan: PrivateBuyPlanFacts; assessment: PrivateSignalAssessment; build: PrivateSolanaSwapBuild;
  maxPriorityFeeLamports?: bigint;
}
type PrivateSolanaPreflightRefusal = { readonly ok: false;
  readonly reason: "build_invalid" | "message_decode_invalid" | "lookup_table_count_exceeded" | "expectation_unavailable"
    | "rpc_unavailable" | "cancelled" | `mint_not_supported:${string}` | PrivateFeePolicyRefusal | PrivateSolanaSigningDenyReason };
export type PrivateSolanaPreflightResult = PrivateSolanaBuyAuthorization | PrivateSolanaPreflightRefusal;
export type PrivateSolanaPreflightRpc = Pick<PrivateSolanaRpc, "getMultipleAccounts" | "simulateTransaction" | "isBlockhashValid" | "getBlockHeight">;
/** A buy also reads the exact rent-exempt minimums for the accounts it may create (M35PIN-1); a sell does not need them. */
export type PrivateSolanaBuyPreflightRpc = PrivateSolanaPreflightRpc & Pick<PrivateSolanaRpc, "getMinimumBalanceForRentExemption">;
/** One S5c exit: the position, exactly its pending exit, and the complete sell assessment of exactly that exit. */
export interface PrivateSolanaExitPreflightRequest {
  agentId: string;
  /** The verified local trading wallet address (keystore status); must be the position's wallet. */
  wallet: string;
  position: PrivatePosition; pendingExit: PrivatePositionPendingExit; assessment: RunnerSolanaSellAssessment; build: PrivateSolanaSwapBuild;
  maxPriorityFeeLamports?: bigint;
}
export type PrivateSolanaExitPreflightResult = PrivateSolanaSellAuthorization | PrivateSolanaPreflightRefusal;

/** True when the build's facts name a sell (own data field only; malformed facts are left to the validator). */
function sellBuild(expected: unknown): boolean {
  try {
    const field = typeof expected === "object" && expected !== null ? Object.getOwnPropertyDescriptor(expected, "direction") : undefined;
    return field !== undefined && "value" in field && field.value === "sell";
  } catch { return true; }
}
function strictBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length < 4 || value.length > Math.ceil(SOLANA_MAX_MESSAGE_PARSE_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64"); return bytes.toString("base64") === value ? Uint8Array.from(bytes) : undefined;
}
type Authorized = Extract<PrivateSolanaSigningAuthorization, { ok: true }>;
function buyAuthorized(result: Authorized): result is PrivateSolanaBuyAuthorization { return result.swap.direction === "buy"; }
function sellAuthorized(result: Authorized): result is PrivateSolanaSellAuthorization { return result.swap.direction === "sell"; }
/** An expectation the runner cannot derive: its fixed fee-policy reason, else `expectation_unavailable`. */
function expectationRefusal(error: unknown): PrivateFeePolicyRefusal | "expectation_unavailable" {
  return error instanceof PrivateSolanaExpectationError && isPrivateFeePolicyRefusal(error.code) ? error.code : "expectation_unavailable";
}
/** Owner decision of 17 Nov 2026 (two Balchemy-provided sources): every answering source simulates the same unsigned bytes and EACH
 * raw result must pass the same evaluator before the one authorization (which evaluates the first again and mints the single-use
 * token once). A split verdict is a disagreement: the step is refused (`rpc_unavailable`) and reported. One owner-configured RPC:
 * its single simulation, as before. Results are never compared byte for byte. */
async function simulations(rpc: Pick<PrivateSolanaRpc, "simulateTransaction">, wire: Uint8Array, accounts: readonly string[],
  signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  return isPrivateDualSolanaRpc(rpc) ? rpc.simulateTransactionEach(wire, accounts, signal) : [await rpc.simulateTransaction(wire, accounts, signal)];
}
/** True when every simulation gives the same evaluator verdict (all pass, or all fail); reports a split to the dual reader. */
function simulationsAgree(rpc: unknown, results: readonly Record<string, unknown>[], swap: PrivateSolanaValidatedBuy | PrivateSolanaValidatedSell,
  rent?: PrivateSolanaTokenAccountRent): boolean {
  const verdicts = results.map((result) => {
    const facts = privateSolanaSimulationFacts(result, swap.accountKeys);
    return swap.direction === "buy" ? evaluatePrivateSolanaSimulation(facts, swap, rent).ok : evaluatePrivateSolanaSellSimulation(facts, swap).ok;
  });
  if (verdicts.every((ok) => ok === verdicts[0])) return true;
  if (isPrivateDualSolanaRpc(rpc)) rpc.disagree();
  return false;
}
function lookupTablesFrom(keys: readonly string[], accounts: readonly (PrivateSolanaAccount | null)[]): PrivateSolanaLookupTableAccount[] {
  const tables: PrivateSolanaLookupTableAccount[] = [];
  keys.forEach((key, index) => { const table = accounts[index + 1]; if (table) tables.push({ key, owner: table.owner, data: table.data }); });
  return tables;
}

/** `capabilities` is the test-only seam (its fee wallet only, for a buy); production callers never pass it. */
export async function preparePrivateSolanaSwapSignature(rpc: PrivateSolanaBuyPreflightRpc, request: PrivateSolanaSwapPreflightRequest,
  signal?: AbortSignal, now: () => number = Date.now,
  capabilities: PrivateExecutionCapabilities = PRIVATE_EXECUTION_CAPABILITIES): Promise<PrivateSolanaPreflightResult> {
  const refuse = (reason: PrivateSolanaPreflightRefusal["reason"]): PrivateSolanaPreflightResult => Object.freeze({ ok: false as const, reason });
  const message = strictBase64(request?.build?.unsignedMessageB64);
  if (!message || typeof request.build.messageSha256 !== "string" || typeof request.build.lastValidBlockHeight !== "string") return refuse("build_invalid");
  if (sellBuild(request.build.expected)) return refuse("direction_unavailable");
  let lookupKeys: string[];
  try { lookupKeys = decodeSolanaV0Message(message).addressTableLookups.map((lookup) => solanaKeyText(lookup.accountKey)); }
  catch { return refuse("message_decode_invalid"); }
  if (lookupKeys.length > PRIVATE_SOLANA_MAX_LOOKUP_TABLES) return refuse("lookup_table_count_exceeded");
  const mintAddress = request.plan?.asset?.assetId;
  if (typeof mintAddress !== "string") return refuse("expectation_unavailable");
  try {
    const accounts = await rpc.getMultipleAccounts([mintAddress, ...lookupKeys], { commitment: "confirmed" }, signal);
    const mintAccount = accounts[0];
    const mint = mintAccount ? privateSolanaMintFacts(mintAccount) : { ok: false as const, reason: "mint_not_supported:mint_missing" as const };
    if (!mint.ok) return refuse(mint.reason);
    let runner: PrivateSolanaRunnerExpectation;
    const feeWallets = privateFeeWallets(capabilities);
    try { runner = derivePrivateSolanaBuyExpectation(request.plan, request.assessment, { wallet: request.wallet, mint, feeWallets,
      ...(request.maxPriorityFeeLamports !== undefined ? { maxPriorityFeeLamports: request.maxPriorityFeeLamports } : {}) }); }
    catch (error: unknown) { return refuse(expectationRefusal(error)); }
    const lookupTables = lookupTablesFrom(lookupKeys, accounts);
    const input = { message, messageSha256: request.build.messageSha256, expected: request.build.expected, lookupTables, runner };
    // Shape first: nothing is simulated for bytes the validator refuses.
    const verdict = validatePrivateSolanaSwap(input, feeWallets);
    if (!verdict.ok) return verdict;
    if (verdict.swap.direction !== "buy") return refuse("direction_unavailable");
    const simulated = await simulations(rpc, unsignedSolanaWireTransaction(message), [verdict.swap.destinationAta], signal);
    const simulation = simulated[0];
    // The exact rent the created accounts must hold, from the same RPC as the simulation (the evaluator bounds it; two sources must
    // answer the same figure).
    const tokenAccountRent = { splToken: await rpc.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_LEN, { commitment: "confirmed" }, signal),
      token2022Ata: await rpc.getMinimumBalanceForRentExemption(TOKEN_2022_ATA_LEN, { commitment: "confirmed" }, signal) };
    if (!simulation || !simulationsAgree(rpc, simulated, verdict.swap, tokenAccountRent)) return refuse("rpc_unavailable");
    const blockhash = await rpc.isBlockhashValid(verdict.swap.blockhash, { commitment: "confirmed" }, signal);
    const blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }, signal);
    if (signal?.aborted) return refuse("cancelled");
    const authorized = authorizePrivateSolanaSwapSignature(request.agentId, input, { simulation, blockhashValid: blockhash.valid, blockHeight,
      lastValidBlockHeight: request.build.lastValidBlockHeight, tokenAccountRent }, now(), capabilities);
    if (!authorized.ok || buyAuthorized(authorized)) return authorized;
    return refuse("direction_unavailable");
  } catch { return refuse(signal?.aborted ? "cancelled" : "rpc_unavailable"); }
}

/** S5c exit preflight: reads the position's mint and every lookup table from the runner's own RPC, derives the runner's
 * own sell expectation (position, pending exit, sell assessment, own mint read, own ceiling), validates the exact bytes,
 * simulates them unsigned requesting the post state of the source token ATA, the wallet's WSOL ATA and the platform WSOL
 * fee account, checks blockhash freshness and only then calls the authorization with the same capabilities.
 * `capabilities` is a test-only seam; production callers never pass it, so a sell is authorized exactly when the build's fixed
 * capability carries exits (since S5) and every check passes; the exits-off rollback build refuses every sell. */
export async function preparePrivateSolanaExitSignature(rpc: PrivateSolanaPreflightRpc, request: PrivateSolanaExitPreflightRequest,
  signal?: AbortSignal, now: () => number = Date.now,
  capabilities: PrivateExecutionCapabilities = PRIVATE_EXECUTION_CAPABILITIES): Promise<PrivateSolanaExitPreflightResult> {
  const refuse = (reason: PrivateSolanaPreflightRefusal["reason"]): PrivateSolanaExitPreflightResult => Object.freeze({ ok: false as const, reason });
  // Without the exits capability (the exits-off rollback build) every sell is refused before any RPC call.
  if (typeof capabilities !== "object" || capabilities === null || capabilities.exits !== true) return refuse("direction_unavailable");
  const message = strictBase64(request?.build?.unsignedMessageB64);
  if (!message || typeof request.build.messageSha256 !== "string" || typeof request.build.lastValidBlockHeight !== "string") return refuse("build_invalid");
  if (!sellBuild(request.build.expected)) return refuse("direction_unavailable");
  let lookupKeys: string[];
  try { lookupKeys = decodeSolanaV0Message(message).addressTableLookups.map((lookup) => solanaKeyText(lookup.accountKey)); }
  catch { return refuse("message_decode_invalid"); }
  if (lookupKeys.length > PRIVATE_SOLANA_MAX_LOOKUP_TABLES) return refuse("lookup_table_count_exceeded");
  const mintAddress = request.position?.tokenMint;
  if (!isSolanaAddress(mintAddress)) return refuse("expectation_unavailable");
  try {
    const accounts = await rpc.getMultipleAccounts([mintAddress, ...lookupKeys], { commitment: "confirmed" }, signal);
    const mintAccount = accounts[0];
    const mint = mintAccount ? privateSolanaMintFacts(mintAccount) : { ok: false as const, reason: "mint_not_supported:mint_missing" as const };
    if (!mint.ok) return refuse(mint.reason);
    let runner: PrivateSolanaRunnerExpectation;
    const feeWallets = privateFeeWallets(capabilities);
    try { runner = derivePrivateSolanaSellExpectation(request.position, request.pendingExit, request.assessment, { wallet: request.wallet, mint, feeWallets,
      ...(request.maxPriorityFeeLamports !== undefined ? { maxPriorityFeeLamports: request.maxPriorityFeeLamports } : {}) }); }
    catch (error: unknown) { return refuse(expectationRefusal(error)); }
    const lookupTables = lookupTablesFrom(lookupKeys, accounts);
    const input = { message, messageSha256: request.build.messageSha256, expected: request.build.expected, lookupTables, runner };
    // Shape first: nothing is simulated for bytes the validator refuses.
    const verdict = validatePrivateSolanaSwap(input, feeWallets);
    if (!verdict.ok) return verdict;
    if (verdict.swap.direction !== "sell") return refuse("direction_unavailable");
    const simulated = await simulations(rpc, unsignedSolanaWireTransaction(message), privateSolanaSellSimulationAccounts(verdict.swap), signal);
    const simulation = simulated[0];
    if (!simulation || !simulationsAgree(rpc, simulated, verdict.swap)) return refuse("rpc_unavailable");
    const blockhash = await rpc.isBlockhashValid(verdict.swap.blockhash, { commitment: "confirmed" }, signal);
    const blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }, signal);
    if (signal?.aborted) return refuse("cancelled");
    const authorized = authorizePrivateSolanaSwapSignature(request.agentId, input, { simulation, blockhashValid: blockhash.valid, blockHeight,
      lastValidBlockHeight: request.build.lastValidBlockHeight }, now(), capabilities);
    if (!authorized.ok || sellAuthorized(authorized)) return authorized;
    return refuse("direction_unavailable");
  } catch { return refuse(signal?.aborted ? "cancelled" : "rpc_unavailable"); }
}
