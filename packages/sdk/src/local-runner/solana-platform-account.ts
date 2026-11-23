import { createHash } from "node:crypto";
import { base58Decode, base58Encode, invalidFor, WSOL } from "./runner-proof-transport";

/** Dependency-free Solana program-derived addresses for the S5 sell fee account (a port of the runner's
 * private-solana-tx-validator derivation, pinned to the Rust engine's exported golden). */
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const invalid: () => never = invalidFor("Solana address");

const P = (1n << 255n) - 19n;
function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n; let b = ((base % P) + P) % P; let e = exponent;
  while (e > 0n) { if (e & 1n) result = (result * b) % P; b = (b * b) % P; e >>= 1n; }
  return result;
}
const EDWARDS_D = ((P - 121665n) * modPow(121666n, P - 2n)) % P;
/** curve25519-dalek `CompressedEdwardsY::decompress().is_some()`: the low 255 bits (reduced mod p) are a valid y exactly
 * when (y^2 - 1) / (d * y^2 + 1) is a square (zero included). */
function isOnEd25519Curve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n; for (let index = 31; index >= 0; index--) y = (y << 8n) | BigInt(bytes[index] as number);
  y = (y & ((1n << 255n) - 1n)) % P;
  const y2 = (y * y) % P; const u = (y2 - 1n + P) % P; const v = (EDWARDS_D * y2 + 1n) % P;
  if (u === 0n) return true;
  return modPow((u * modPow(v, P - 2n)) % P, (P - 1n) / 2n) === 1n;
}
function keyBytes(address: string): Uint8Array {
  const bytes = typeof address === "string" ? base58Decode(address) : null;
  if (!bytes || bytes.length !== 32 || base58Encode(bytes) !== address) return invalid();
  return bytes;
}
/** `Pubkey::find_program_address`: the first off-curve sha256(seeds || bump || program || "ProgramDerivedAddress"), bump 255 -> 0. */
function findProgramAddress(seeds: readonly Uint8Array[], programId: string): string {
  const program = keyBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const digest = createHash("sha256").update(Buffer.concat([...seeds, Uint8Array.from([bump]), program, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!isOnEd25519Curve(digest)) return base58Encode(digest);
  }
  return invalid();
}
/** The platform's WSOL associated token account (Token program): the single sell fee account (engine platform_wsol_account). */
export function runnerPlatformWsolAccount(feeRecipient: string): string {
  return findProgramAddress([keyBytes(feeRecipient), keyBytes(TOKEN_PROGRAM), keyBytes(WSOL)], ASSOCIATED_TOKEN_PROGRAM);
}
/** Conservative sell proceeds floor t - ceil(t * bps / 10000) (engine min_out_after_platform_fee). */
export function runnerMinOutAfterPlatformFee(threshold: bigint, bps: number): bigint {
  return threshold - (threshold * BigInt(bps) + 9999n) / 10000n;
}
