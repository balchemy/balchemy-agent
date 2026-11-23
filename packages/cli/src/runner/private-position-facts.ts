/** S5c: the exact token units one finalized buy credited to the runner's own wallet, proven independently from the transaction
 * the runner's OWN RPC returns at finalized commitment (getTransaction, json encoding: account keys are text). Balchemy's `completed`
 * says the engine proved the fills; Balchemy returns no fill amounts to the runner, so the units a position may later sell are
 * re-proven here, never taken on trust. Pure and bounded; any doubt is a refusal (the position is not opened, it is held).
 *
 * credit = sum(postTokenBalances.amount) - sum(preTokenBalances.amount) over the token accounts OWNED by the wallet for the
 * mint. The transaction must be this exact signature, finalized without error, and every balance entry of that mint must name its
 * owner (older RPC shapes without `owner` are refused, never guessed).
 * Final audit part 3 N2: the rows are read with the sell parser's rules (sellRows): each row is indexed (accountIndex) into the
 * transaction's keys (the static keys, then meta.loadedAddresses writable and readonly), names a base58 owner and mint, and appears at
 * most once per account and list. The transaction carries exactly one signature (the journaled one) and the wallet as its fee payer
 * (key 0), as every buy the runner signs does. A wallet-owned account of the mint with a post row but no pre row must have been created
 * by this transaction (a token account that existed before has a pre row; an RPC that drops it would credit the account's whole
 * balance): its lamports rose, OR (fix of the N2 regression) the transaction itself initializes it. The second arm exists because anyone
 * may pre-fund the bot's future ATA with at least rent before the buy; the ATA program then moves no lamports into it, yet an honest buy
 * creates it. Initialized means: a top-level (message.instructions) or inner (meta.innerInstructions[*].instructions) instruction of the
 * SPL Token or Token-2022 program, resolved in the same key list as the rows, that is InitializeAccount (tag 1, 1 byte, accounts
 * [account, mint, owner, rent]), InitializeAccount2 (tag 16, 33 bytes, [account, mint, rent]) or InitializeAccount3 (tag 18, 33 bytes,
 * [account, mint]), whose initialized account (accounts[0]) is that account and whose mint (accounts[1]) is the bought mint. The ATA
 * program's Create emits exactly such an inner InitializeAccount3 (seen in the real capture-2 buy simulations, which create the WSOL and
 * Token-2022 ATAs). Any malformed or unexpected instruction shape is no proof (never a refusal by itself): the lamport arm, or else
 * token_account_not_fresh, decides as before. No upper bound is added: the swap's output may legitimately exceed the quote (positive
 * slippage), and the only lower bound, minOut, is the caller's (private-exit-worker.ts); the per-(agent, wallet, mint) engine guard caps
 * the sells. */
import { decodeBase58 } from "./solana-base58.js";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./private-solana-tx-validator.js";

export const PRIVATE_BUY_FACTS_REFUSALS = ["transaction_missing", "transaction_malformed", "transaction_failed", "signature_mismatch",
  "balances_missing", "credit_not_positive", "fee_payer_mismatch", "token_account_not_fresh"] as const;
export type PrivateBuyFactsRefusal = typeof PRIVATE_BUY_FACTS_REFUSALS[number];
export type PrivateBuyTokenCredit = { readonly outcome: "proven"; readonly units: string } | { readonly outcome: "refused"; readonly reason: PrivateBuyFactsRefusal };

const MAX_BALANCES = 256;
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
class Refused extends Error { constructor(readonly reason: PrivateBuyFactsRefusal) { super(reason); } }
function refuse(reason: PrivateBuyFactsRefusal): never { throw new Refused(reason); }
/** The sell parser's refusals mapped to the buy's codes (the same rule, the buy's names). */
const BUY_REASON: Readonly<Partial<Record<PrivateSellFactsRefusal, PrivateBuyFactsRefusal>>> = Object.freeze({ balances_missing: "balances_missing",
  transaction_malformed: "transaction_malformed" });
/** Runs one sell-parser step with the buy's refusal codes. */
function shared<T>(step: () => T): T {
  try { return step(); } catch (error: unknown) {
    if (error instanceof SellRefused) refuse(BUY_REASON[error.reason] ?? "transaction_malformed");
    throw error;
  }
}

export function privateBuyTokenCredit(transaction: unknown, expected: { signature: string; walletAddress: string; tokenMint: string }): PrivateBuyTokenCredit {
  try {
    if (transaction === null || transaction === undefined) refuse("transaction_missing");
    const wallet = expected.walletAddress; const mint = expected.tokenMint;
    const tx = shared(() => object(transaction)); const meta = shared(() => object(tx.meta)); const body = shared(() => object(tx.transaction));
    const signatures = body.signatures;
    if (!Array.isArray(signatures) || signatures.length < 1 || !signatures.every((item) => typeof item === "string")) refuse("transaction_malformed");
    if (signatures.length !== 1 || signatures[0] !== expected.signature) refuse("signature_mismatch");
    if (!("err" in meta)) refuse("transaction_malformed");
    if (meta.err !== null) refuse("transaction_failed");
    const message = shared(() => object(body.message)); const keys = shared(() => transactionKeys(meta, message));
    if (keys[0] !== wallet) refuse("fee_payer_mismatch");
    const preRows = shared(() => sellRows(meta.preTokenBalances, keys)); const postRows = shared(() => sellRows(meta.postTokenBalances, keys));
    const mine = (rows: readonly SellRow[]): SellRow[] => rows.filter((row) => row.owner === wallet && row.mint === mint);
    const before = new Set(preRows.map((row) => row.account));
    const fresh = mine(postRows).filter((row) => !before.has(row.account));
    if (fresh.length > 0) {
      // Fresh: created by this transaction, shown by its own initialize-account instruction or by its lamports rising here.
      const initialized = initializedTokenAccounts(message, meta, keys, mint);
      const unproven = fresh.filter((row) => !initialized.has(row.account));
      if (unproven.length > 0) {
        const pre = shared(() => lamportList(meta.preBalances, keys.length)); const post = shared(() => lamportList(meta.postBalances, keys.length));
        if (unproven.some((row) => { const index = keys.indexOf(row.account); return !(post[index]! > pre[index]!); })) refuse("token_account_not_fresh");
      }
    }
    const sum = (rows: readonly SellRow[]): bigint => rows.reduce((total, row) => total + row.amount, 0n);
    const credit = sum(mine(postRows)) - sum(mine(preRows));
    if (credit <= 0n || credit > U64_MAX) refuse("credit_not_positive");
    return Object.freeze({ outcome: "proven", units: credit.toString() });
  } catch (error: unknown) {
    return Object.freeze({ outcome: "refused", reason: error instanceof Refused ? error.reason : "transaction_malformed" });
  }
}

/** S5c: the exact lamport proceeds of one finalized exit sell, proven independently from the transaction the runner's OWN RPC
 * returns for the runner's journaled signature at finalized commitment (getTransaction, json encoding: account keys are text;
 * the static keys followed by meta.loadedAddresses writable then readonly, the order balances are indexed in). The same
 * conservative accounting as the sell simulation (private-solana-simulation.ts), never a model of the route. With W = the
 * wallet (fee payer, key 0) and A = its WSOL ATA:
 *   exactly one signature, the journaled one; meta.err null; key 0 = W
 *   Σ pre − Σ post over W-owned rows of the token mint                       == units (the pending exit's units)
 *   no other W-owned token balance (other mints, A excluded) falls
 *   A is a key of the transaction, has no post token row and zero post lamports
 *   swapOut  = (post_W − pre_W) + fee − wsolBefore − reclaimed                >= 0 (the swap's lamport output, as simulated)
 *     wsolBefore = the exact pre lamports of A (0 when A did not exist; never a rent constant, M35PIN-1); a pre WSOL row whose
 *       lamports do not exceed its amount is contradictory (a token account always holds a positive rent reserve)
 *     reclaimed  = Σ max(0, pre − post lamports) over every other W-owned pre-row account
 *   proceeds = max(0, swapOut − fee)   (L3: what the sale actually added to the wallet, NET of the network fee it paid)
 * The recorded proceeds never add the network fee back, so the position's cost-vs-proceeds readback never overstates a sale;
 * a dust sale whose output does not cover its fee records 0. Ledgers written before L3 keep their (gross) proceeds unchanged and
 * still read: the field keeps its shape, settlement only ever records a PENDING exit, and a completed exit is never re-proven, so
 * no data conversion is needed (with exits disabled in production, no such ledger exists outside tests).
 * `transaction_missing` (no finalized copy is available yet) is the only refusal a later read may change; every other reason
 * is missing or contradictory evidence and is never guessed around. */
export const PRIVATE_SELL_FACTS_REFUSALS = ["transaction_missing", "transaction_malformed", "transaction_failed", "signature_mismatch",
  "fee_payer_mismatch", "balances_missing", "input_debit_mismatch", "wallet_token_balance_decreased", "wsol_account_missing",
  "wsol_account_mismatch", "wsol_not_closed", "proceeds_negative"] as const;
export type PrivateSellFactsRefusal = typeof PRIVATE_SELL_FACTS_REFUSALS[number];
export type PrivateSellProceeds = { readonly ok: true; readonly proceedsLamports: string } | { readonly ok: false; readonly reason: PrivateSellFactsRefusal };
export interface PrivateSellProceedsExpected { signature: string; walletAddress: string; tokenMint: string; units: string; wsolAccount: string }

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_KEYS = 256;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
class SellRefused extends Error { constructor(readonly reason: PrivateSellFactsRefusal) { super(reason); } }
function sellRefuse(reason: PrivateSellFactsRefusal): never { throw new SellRefused(reason); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) sellRefuse("transaction_malformed");
  return value as Record<string, unknown>;
}
function addresses(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_KEYS) sellRefuse("transaction_malformed");
  return (value as unknown[]).map((item) => { if (typeof item !== "string" || !BASE58.test(item)) sellRefuse("transaction_malformed"); return item; });
}
function lamportList(value: unknown, length: number): bigint[] {
  if (!Array.isArray(value) || value.length !== length) sellRefuse("balances_missing");
  return (value as unknown[]).map((item) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) sellRefuse("balances_missing");
    return BigInt(item);
  });
}
/** Static keys, then the lookup-loaded writable and readonly keys (absent only for a message without lookups): the order balances are
 * indexed in. Distinct, at least one. */
function transactionKeys(meta: Record<string, unknown>, message: Record<string, unknown>): string[] {
  const lookups = message.addressTableLookups;
  let loadedWritable: string[] = []; let loadedReadonly: string[] = [];
  if (meta.loadedAddresses !== undefined) {
    const loaded = object(meta.loadedAddresses); loadedWritable = addresses(loaded.writable); loadedReadonly = addresses(loaded.readonly);
  } else if (lookups !== undefined && (!Array.isArray(lookups) || lookups.length !== 0)) sellRefuse("transaction_malformed");
  const keys = [...addresses(message.accountKeys), ...loadedWritable, ...loadedReadonly];
  if (keys.length < 1 || keys.length > MAX_KEYS || new Set(keys).size !== keys.length) sellRefuse("transaction_malformed");
  return keys;
}
interface SellRow { account: string; mint: string; owner: string; amount: bigint }
/** Token balance rows indexed into `keys`; every row must name its owner and appear once per account. */
function sellRows(value: unknown, keys: readonly string[]): SellRow[] {
  if (!Array.isArray(value) || value.length > MAX_BALANCES) sellRefuse("balances_missing");
  const rows = (value as unknown[]).map((item): SellRow => {
    const entry = object(item); const index = entry.accountIndex;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= keys.length) sellRefuse("transaction_malformed");
    if (typeof entry.owner !== "string" || !BASE58.test(entry.owner)) sellRefuse("balances_missing");
    const amount = object(entry.uiTokenAmount).amount;
    if (typeof entry.mint !== "string" || !BASE58.test(entry.mint) || typeof amount !== "string" || !U64.test(amount) || BigInt(amount) > U64_MAX) {
      sellRefuse("transaction_malformed");
    }
    return { account: keys[index]!, mint: entry.mint, owner: entry.owner, amount: BigInt(amount) };
  });
  if (new Set(rows.map((row) => row.account)).size !== rows.length) sellRefuse("transaction_malformed");
  return rows;
}
/** N2 fix: the token accounts of `mint` this transaction initializes (privateBuyTokenCredit's module comment). Never throws: any
 * instruction, list or field of an unexpected shape is skipped, so it only ever proves less. The scan is bounded. */
const MAX_SCANNED_INSTRUCTIONS = 1_024;
/** Initialize-account tag -> exact data length and the fewest accounts the instruction takes. */
const INITIALIZE_ACCOUNT: ReadonlyMap<number, { bytes: number; accounts: number }> = new Map([[1, { bytes: 1, accounts: 4 }],
  [16, { bytes: 33, accounts: 3 }], [18, { bytes: 33, accounts: 2 }]]);
function initializedTokenAccounts(message: Record<string, unknown>, meta: Record<string, unknown>, keys: readonly string[], mint: string): Set<string> {
  const found = new Set<string>();
  const lists: unknown[] = [message.instructions];
  const inner = meta.innerInstructions;
  if (Array.isArray(inner)) {
    for (const group of (inner as unknown[]).slice(0, MAX_SCANNED_INSTRUCTIONS)) {
      if (group && typeof group === "object" && !Array.isArray(group)) lists.push((group as Record<string, unknown>).instructions);
    }
  }
  let scanned = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list as unknown[]) {
      scanned += 1;
      if (scanned > MAX_SCANNED_INSTRUCTIONS) return found;
      const account = initializedTokenAccount(item, keys, mint);
      if (account !== undefined) found.add(account);
    }
  }
  return found;
}
function initializedTokenAccount(item: unknown, keys: readonly string[], mint: string): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const instruction = item as Record<string, unknown>;
  const key = (index: unknown): string | undefined => typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < keys.length
    ? keys[index] : undefined;
  const program = key(instruction.programIdIndex);
  if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) return undefined;
  if (!Array.isArray(instruction.accounts)) return undefined;
  const accounts = instruction.accounts as unknown[];
  if (accounts.length > MAX_KEYS || !accounts.every((index) => key(index) !== undefined)) return undefined;
  const data = instruction.data;
  const short = decodeBase58(data, 1); const long = short === undefined ? decodeBase58(data, 33) : undefined;
  const bytes = short ?? long;
  const shape = bytes === undefined ? undefined : INITIALIZE_ACCOUNT.get(bytes[0]!);
  if (!bytes || !shape || bytes.length !== shape.bytes || accounts.length < shape.accounts) return undefined;
  if (key(accounts[1]) !== mint) return undefined;
  return key(accounts[0]);
}

export function privateSellProceeds(transaction: unknown, expected: PrivateSellProceedsExpected): PrivateSellProceeds {
  try {
    if (transaction === null || transaction === undefined) sellRefuse("transaction_missing");
    const units = typeof expected?.units === "string" && U64.test(expected.units) ? BigInt(expected.units) : 0n;
    if (units < 1n || units > U64_MAX || typeof expected.signature !== "string" || typeof expected.walletAddress !== "string"
      || typeof expected.tokenMint !== "string" || typeof expected.wsolAccount !== "string" || expected.tokenMint === WSOL_MINT) {
      sellRefuse("transaction_malformed");
    }
    const wallet = expected.walletAddress; const mint = expected.tokenMint; const wsol = expected.wsolAccount;
    const tx = object(transaction); const meta = object(tx.meta); const body = object(tx.transaction); const message = object(body.message);
    const signatures = body.signatures;
    if (!Array.isArray(signatures) || signatures.length < 1 || !signatures.every((item) => typeof item === "string")) sellRefuse("transaction_malformed");
    if (signatures.length !== 1 || signatures[0] !== expected.signature) sellRefuse("signature_mismatch");
    if (!("err" in meta)) sellRefuse("transaction_malformed");
    if (meta.err !== null) sellRefuse("transaction_failed");
    const keys = transactionKeys(meta, message);
    if (keys[0] !== wallet) sellRefuse("fee_payer_mismatch");
    const fee = meta.fee;
    if (typeof fee !== "number" || !Number.isSafeInteger(fee) || fee < 0) sellRefuse("transaction_malformed");
    const pre = lamportList(meta.preBalances, keys.length); const post = lamportList(meta.postBalances, keys.length);
    const preRows = sellRows(meta.preTokenBalances, keys); const postRows = sellRows(meta.postTokenBalances, keys);
    // Exact input debit over every wallet-owned row of the token mint (an account handed to another owner counts as gone).
    const held = (rows: readonly SellRow[]): bigint => rows.filter((row) => row.owner === wallet && row.mint === mint)
      .reduce((total, row) => total + row.amount, 0n);
    if (held(preRows) - held(postRows) !== units) sellRefuse("input_debit_mismatch");
    // No other wallet-owned token balance falls (a changed owner or mint counts as gone).
    for (const row of preRows) {
      if (row.owner !== wallet || row.mint === mint || row.account === wsol) continue;
      const after = postRows.find((candidate) => candidate.account === row.account);
      if ((after && after.owner === wallet && after.mint === row.mint ? after.amount : 0n) < row.amount) sellRefuse("wallet_token_balance_decreased");
    }
    // The wallet's WSOL ATA is closed by the end.
    const wsolIndex = keys.indexOf(wsol);
    if (wsolIndex < 0) sellRefuse("wsol_account_missing");
    if (postRows.some((row) => row.account === wsol) || post[wsolIndex] !== 0n) sellRefuse("wsol_not_closed");
    const preWsol = preRows.find((row) => row.account === wsol);
    if (preWsol && (preWsol.owner !== wallet || preWsol.mint !== WSOL_MINT)) sellRefuse("wsol_account_mismatch");
    // Everything A's close returned that was already there: its real pre lamports, whatever rent it was created under.
    const wsolBefore = pre[wsolIndex]!;
    if (preWsol && wsolBefore <= preWsol.amount) sellRefuse("wsol_account_mismatch");
    // Lamports reclaimed from the wallet's own token accounts (e.g. a closed source ATA) were already the wallet's.
    let reclaimed = 0n;
    for (const row of preRows) {
      if (row.owner !== wallet || row.account === wsol) continue;
      const index = keys.indexOf(row.account); const before = pre[index]!; const after = post[index]!;
      if (before > after) reclaimed += before - after;
    }
    const swapOut = post[0]! - pre[0]! + BigInt(fee) - wsolBefore - reclaimed;
    if (swapOut < 0n || swapOut > U64_MAX) sellRefuse("proceeds_negative");
    const proceeds = swapOut > BigInt(fee) ? swapOut - BigInt(fee) : 0n;
    return Object.freeze({ ok: true as const, proceedsLamports: proceeds.toString() });
  } catch (error: unknown) {
    return Object.freeze({ ok: false as const, reason: error instanceof SellRefused ? error.reason : "transaction_malformed" });
  }
}
