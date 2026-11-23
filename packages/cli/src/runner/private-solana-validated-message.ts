/** The only input a local trading key may sign. A ValidatedSolanaMessage is an
 * opaque, process-local, single-use capability bound to one agent, one signer
 * address and a short expiry. Its state lives in ECMAScript `#private` fields, so
 * a structurally identical object, a Proxy, a Buffer or a string is never
 * signable, and the constructor refuses every caller without this module's
 * unexported capability. The only minting path is `authorizePrivateSolanaSwapSignature` below: the
 * independent S2 validator, the simulation evaluator and blockhash freshness must all pass first. */
import { createHash } from "node:crypto";
import { isId } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import { canonicalU64, validatePrivateSolanaSwap, type PrivateSolanaSwapDenyReason, type PrivateSolanaSwapValidationInput,
  type PrivateSolanaValidatedBuy, type PrivateSolanaValidatedSell } from "./private-solana-tx-validator.js";
import { evaluatePrivateSolanaSellSimulation, evaluatePrivateSolanaSimulation, privateSolanaSimulationFacts, type PrivateSolanaSellSimulationEvidence,
  type PrivateSolanaSimulationDenyReason, type PrivateSolanaSimulationEvidence, type PrivateSolanaTokenAccountRent } from "./private-solana-simulation.js";
import { PRIVATE_EXECUTION_CAPABILITIES, type PrivateExecutionCapabilities } from "./private-execution-gate.js";
import { privateFeeWallets } from "./private-fee-policy.js";

/** Solana packet limit; the validator enforces the exact transaction rules. */
export const MAX_VALIDATED_SOLANA_MESSAGE_BYTES = 1232;
/** The validator mints immediately before signing; a token never outlives this. */
export const MAX_VALIDATED_SOLANA_MESSAGE_TTL_MS = 30_000;
export interface ValidatedSolanaMessageBinding { agentId: string; signerAddress: string }

const MINT = Symbol("balchemy.validated-solana-message.mint");
let consume: (value: unknown, binding: ValidatedSolanaMessageBinding, nowMs: number) => Buffer | undefined;
let branded: (value: unknown) => boolean;

class ValidatedSolanaMessageToken {
  readonly #bytes: Buffer;
  readonly #agentId: string;
  readonly #signerAddress: string;
  readonly #expiresAtMs: number;
  #consumed = false;
  readonly messageSha256: string;

  constructor(capability: symbol, bytes: Buffer, binding: ValidatedSolanaMessageBinding, expiresAtMs: number) {
    if (capability !== MINT) throw new Error("Invalid validated Solana message");
    this.#bytes = bytes; this.#agentId = binding.agentId; this.#signerAddress = binding.signerAddress;
    this.#expiresAtMs = expiresAtMs;
    this.messageSha256 = createHash("sha256").update(bytes).digest("hex");
    Object.freeze(this);
  }

  static {
    branded = (value: unknown): boolean => typeof value === "object" && value !== null && #bytes in value
      && !(value as ValidatedSolanaMessageToken).#consumed;
    consume = (value, binding, nowMs) => {
      if (typeof value !== "object" || value === null || !(#bytes in value)) return undefined;
      const token = value as ValidatedSolanaMessageToken;
      if (token.#consumed) return undefined;
      // Any presentation spends the token, including a refused one: it is never replayable.
      token.#consumed = true;
      try {
        if (token.#agentId !== binding.agentId || token.#signerAddress !== binding.signerAddress
          || !Number.isFinite(nowMs) || nowMs >= token.#expiresAtMs) return undefined;
        return Buffer.from(token.#bytes);
      } finally { token.#bytes.fill(0); }
    };
  }
}
export type { ValidatedSolanaMessageToken as ValidatedSolanaMessage };

/** True only for an unspent token minted by this module. Never consumes it. */
export function isValidatedSolanaMessage(value: unknown): boolean { return branded(value); }

/** Spends the token once and returns a fresh copy of its bytes only when it is bound to
 * exactly this agent and signer address and has not expired. Undefined for anything else. */
export function consumeValidatedSolanaMessage(value: unknown, binding: ValidatedSolanaMessageBinding,
  nowMs: number = Date.now()): Buffer | undefined {
  return consume(value, binding, nowMs);
}

/** Deliberately not exported. Called only by `authorizePrivateSolanaSwapSignature` after every
 * deterministic check passed. Do not export it for convenience or tests. */
function mintValidatedSolanaMessage(message: Uint8Array, binding: ValidatedSolanaMessageBinding, expiresAtMs: number,
  nowMs: number = Date.now()): ValidatedSolanaMessageToken {
  if (!(message instanceof Uint8Array) || message.length < 1 || message.length > MAX_VALIDATED_SOLANA_MESSAGE_BYTES
    || typeof binding !== "object" || binding === null || !isId(binding.agentId) || !isSolanaAddress(binding.signerAddress)
    || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + MAX_VALIDATED_SOLANA_MESSAGE_TTL_MS) {
    throw new Error("Invalid validated Solana message");
  }
  return new ValidatedSolanaMessageToken(MINT, Buffer.from(message),
    { agentId: binding.agentId, signerAddress: binding.signerAddress }, expiresAtMs);
}

/** The blockhash must stay valid this many blocks past the runner's own observed height. */
export const PRIVATE_SOLANA_MIN_BLOCK_HEIGHT_MARGIN = 20n;
/** A Solana blockhash is valid for 150 blocks: getLatestBlockhash reports lastValidBlockHeight = the blockhash's block height + 150. */
export const PRIVATE_SOLANA_BLOCKHASH_LIFETIME_BLOCKS = 150n;
/** F3: the most Balchemy's lastValidBlockHeight may exceed the runner's own observed height + PRIVATE_SOLANA_BLOCKHASH_LIFETIME_BLOCKS.
 * A genuine value is at most about that sum: it is reported against the build's blockhash, which is never newer than Balchemy's
 * view of the tip, and the runner observes its height (confirmed) after the build. The slack only absorbs a runner RPC that lags
 * Balchemy's view (a processed-commitment blockhash, a slower node: 30 blocks, about 12 s). An overstated value is refused
 * before signing, because the settlement expiry proof (private-submission.ts #provenExpired) needs a finalized height more
 * than PRIVATE_EXIT_EXPIRY_MARGIN_BLOCKS past it: an
 * unbounded value would keep an expired exit pending, and its wallet held, for as long as the server liked. With this bound the
 * proof's height condition is met at most 150 + 30 + 150 = 330 blocks past the observed height, plus the finalization lag (about
 * 2.5 min in all). */
export const PRIVATE_SOLANA_MAX_BLOCK_HEIGHT_SLACK = 30n;
/** Observations from the runner's own RPC for these exact bytes, taken after the build. */
export interface PrivateSolanaSigningEvidence {
  /** Raw `simulateTransaction` value (sigVerify false, the build's blockhash; accounts = [output ATA] for a buy,
   * `privateSolanaSellSimulationAccounts` for a sell). */
  simulation: unknown;
  /** `isBlockhashValid` for the message's blockhash, observed after simulation. */
  blockhashValid: boolean;
  /** `getBlockHeight`, observed after simulation. */
  blockHeight: bigint;
  /** The build's `lastValidBlockHeight` (canonical u64 text). */
  lastValidBlockHeight: string;
  /** `getMinimumBalanceForRentExemption` for 165 and 170 bytes from the same RPC, observed with the simulation. Required for a
   * buy (missing or out-of-range evidence denies `simulation_evidence_missing`); a sell never reads it. */
  tokenAccountRent?: PrivateSolanaTokenAccountRent;
}
export type PrivateSolanaSigningDenyReason = PrivateSolanaSwapDenyReason | PrivateSolanaSimulationDenyReason
  | "binding_invalid" | "blockhash_invalid" | "blockhash_expiring" | "blockhash_height_overstated" | "direction_unavailable";
export type PrivateSolanaBuyAuthorization = {
  readonly ok: true; readonly message: ValidatedSolanaMessageToken; readonly swap: PrivateSolanaValidatedBuy;
  readonly simulation: PrivateSolanaSimulationEvidence; readonly expiresAtMs: number;
};
export type PrivateSolanaSellAuthorization = {
  readonly ok: true; readonly message: ValidatedSolanaMessageToken; readonly swap: PrivateSolanaValidatedSell;
  readonly simulation: PrivateSolanaSellSimulationEvidence; readonly expiresAtMs: number;
};
export type PrivateSolanaSigningAuthorization = PrivateSolanaBuyAuthorization | PrivateSolanaSellAuthorization
  | { readonly ok: false; readonly reason: PrivateSolanaSigningDenyReason };

/** The single path to a signable token. Re-runs the independent validator over a private copy of the
 * bytes, evaluates the simulation against the proven facts, requires a fresh blockhash with margin (and a lastValidBlockHeight
 * no more than one blockhash lifetime plus slack past the observed height), and
 * only then mints a single-use token bound to this agent, the proven trading wallet and at most 30 s.
 * A validated sell (S5c exit) is authorized only when `capabilities.exits` is true AND its conservative sell
 * invariants pass (see private-solana-simulation.ts); the production capabilities carry `exits` since S5, and on the exits-off
 * rollback build (PRIVATE_EXIT_EXECUTION_AVAILABLE false) every sell is refused with `direction_unavailable` and never mints.
 * `capabilities` is a test-only seam: production callers never pass it. Buys are unaffected by its `exits` flag; its
 * `feeWallet` (absent in production: the allow-listed Balchemy fee wallets) is the fee policy's recipient for both directions.
 * Never signs, sends or persists; S4 decides whether a minted token is ever presented to the keystore. */
export function authorizePrivateSolanaSwapSignature(agentId: string, input: PrivateSolanaSwapValidationInput,
  evidence: PrivateSolanaSigningEvidence, nowMs: number = Date.now(),
  capabilities: PrivateExecutionCapabilities = PRIVATE_EXECUTION_CAPABILITIES): PrivateSolanaSigningAuthorization {
  const refuse = (reason: PrivateSolanaSigningDenyReason): PrivateSolanaSigningAuthorization => Object.freeze({ ok: false as const, reason });
  if (!isId(agentId) || !Number.isSafeInteger(nowMs) || nowMs < 0 || !input || typeof input !== "object"
    || !(input.message instanceof Uint8Array) || !evidence || typeof evidence !== "object") return refuse("binding_invalid");
  const bytes = Uint8Array.from(input.message);
  try {
    const verdict = validatePrivateSolanaSwap({ message: bytes, messageSha256: input.messageSha256, expected: input.expected,
      lookupTables: input.lookupTables, runner: input.runner }, privateFeeWallets(capabilities));
    if (!verdict.ok) return refuse(verdict.reason);
    const swap = verdict.swap;
    const fresh = (): PrivateSolanaSigningDenyReason | null => {
      const lastValid = canonicalU64(evidence.lastValidBlockHeight);
      if (evidence.blockhashValid !== true) return "blockhash_invalid";
      if (typeof evidence.blockHeight !== "bigint" || evidence.blockHeight < 0n || lastValid === undefined
        || evidence.blockHeight + PRIVATE_SOLANA_MIN_BLOCK_HEIGHT_MARGIN > lastValid) return "blockhash_expiring";
      // F3: never past one blockhash lifetime (plus slack) beyond the observed height, so the expiry stays provable.
      if (lastValid > evidence.blockHeight + PRIVATE_SOLANA_BLOCKHASH_LIFETIME_BLOCKS + PRIVATE_SOLANA_MAX_BLOCK_HEIGHT_SLACK) {
        return "blockhash_height_overstated";
      }
      return null;
    };
    const facts = (): ReturnType<typeof privateSolanaSimulationFacts> => privateSolanaSimulationFacts(evidence.simulation, swap.accountKeys);
    if (swap.direction === "buy") {
      const simulated = evaluatePrivateSolanaSimulation(facts(), swap, evidence.tokenAccountRent);
      if (!simulated.ok) return refuse(simulated.reason);
      const stale = fresh(); if (stale) return refuse(stale);
      const expiresAtMs = nowMs + MAX_VALIDATED_SOLANA_MESSAGE_TTL_MS;
      const message = mintValidatedSolanaMessage(bytes, { agentId, signerAddress: swap.wallet }, expiresAtMs, nowMs);
      return Object.freeze({ ok: true as const, message, swap, simulation: simulated.evidence, expiresAtMs });
    }
    // Sell: refused before any evaluation unless the exits capability is explicitly on.
    if (typeof capabilities !== "object" || capabilities === null || capabilities.exits !== true) return refuse("direction_unavailable");
    const simulated = evaluatePrivateSolanaSellSimulation(facts(), swap);
    if (!simulated.ok) return refuse(simulated.reason);
    const stale = fresh(); if (stale) return refuse(stale);
    const expiresAtMs = nowMs + MAX_VALIDATED_SOLANA_MESSAGE_TTL_MS;
    const message = mintValidatedSolanaMessage(bytes, { agentId, signerAddress: swap.wallet }, expiresAtMs, nowMs);
    return Object.freeze({ ok: true as const, message, swap, simulation: simulated.evidence, expiresAtMs });
  } catch { return refuse("binding_invalid"); }
  finally { bytes.fill(0); }
}
