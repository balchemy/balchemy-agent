/** Canonical Bitcoin-alphabet base58 for Solana public keys and the common 64-byte
 * secret export. Exact-length decode only; never logs or retains its input. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = 0n; for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const digits: string[] = [];
  while (value > 0n) { digits.push(ALPHABET[Number(value % 58n)]!); value /= 58n; }
  return "1".repeat(zeros) + digits.reverse().join("");
}

/** Returns a fresh buffer the caller owns (and zeroes), or undefined for any other length. */
export function decodeBase58(text: unknown, length: number): Buffer | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > 128 || !PATTERN.test(text)) return undefined;
  let value = 0n; for (const character of text) value = value * 58n + BigInt(ALPHABET.indexOf(character));
  const zeros = text.match(/^1*/)?.[0].length ?? 0;
  let size = 0; for (let remaining = value; remaining > 0n; remaining >>= 8n) size++;
  if (zeros + size !== length) return undefined;
  const bytes = Buffer.alloc(length);
  for (let index = length - 1; value > 0n; index--) { bytes[index] = Number(value & 0xffn); value >>= 8n; }
  return bytes;
}

export function isSolanaAddress(value: unknown): value is string {
  const bytes = decodeBase58(value, 32); return bytes !== undefined && bytes.length === 32;
}
