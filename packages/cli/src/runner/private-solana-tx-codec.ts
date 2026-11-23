/** In-house Solana versioned (v0) message codec for the runner's pre-sign validator. Exactly the
 * bincode/short_vec layout the engine serializes: strict canonical compact-u16, every length bounded
 * by the remaining input, no trailing bytes and no legacy messages. Parsing never signs, resolves
 * lookup tables or trusts any field; the validator proves meaning. No dependencies beyond node. */
import { encodeBase58 } from "./solana-base58.js";

/** Solana packet limit for a serialized transaction (signatures + message). */
export const SOLANA_MAX_WIRE_BYTES = 1232;
export const SOLANA_SIGNATURE_BYTES = 64;
/** Parse ceiling. Larger than a packet on purpose: an oversized message must still decode so the
 * validator can deny it with the engine's exact `wire_size_exceeded` reason. */
export const SOLANA_MAX_MESSAGE_PARSE_BYTES = 4096;
const VERSION_PREFIX = 0x80;

export class SolanaTxCodecError extends Error {
  constructor(readonly code: "message_decode_invalid" | "message_encode_invalid" | "message_too_large" | "wire_size_exceeded") {
    super(`Solana message ${code}`); this.name = "SolanaTxCodecError";
  }
}
export interface SolanaMessageHeader {
  readonly numRequiredSignatures: number; readonly numReadonlySignedAccounts: number; readonly numReadonlyUnsignedAccounts: number;
}
export interface SolanaCompiledInstruction { readonly programIdIndex: number; readonly accounts: Uint8Array; readonly data: Uint8Array }
export interface SolanaAddressTableLookup { readonly accountKey: Uint8Array; readonly writableIndexes: Uint8Array; readonly readonlyIndexes: Uint8Array }
export interface SolanaV0Message {
  readonly version: 0; readonly header: SolanaMessageHeader; readonly staticAccountKeys: readonly Uint8Array[];
  readonly recentBlockhash: Uint8Array; readonly instructions: readonly SolanaCompiledInstruction[];
  readonly addressTableLookups: readonly SolanaAddressTableLookup[];
}
function decodeFail(): never { throw new SolanaTxCodecError("message_decode_invalid"); }
function encodeFail(): never { throw new SolanaTxCodecError("message_encode_invalid"); }
function byte(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255; }

/** Canonical short_vec: at most 3 bytes, no zero continuation byte (alias), third byte has no
 * continuation bit and the value fits u16; mirrors solana `short_vec::visit_byte`. */
export function decodeCompactU16(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  for (let nth = 0; nth < 3; nth++) {
    const position = offset + nth;
    if (position >= bytes.length) decodeFail();
    const element = bytes[position]!;
    if (element === 0 && nth !== 0) decodeFail();
    const done = (element & 0x80) === 0;
    if (nth === 2 && !done) decodeFail();
    value |= (element & 0x7f) << (nth * 7);
    if (value > 0xffff) decodeFail();
    if (done) return { value, next: position + 1 };
  }
  return decodeFail();
}
export function encodeCompactU16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) encodeFail();
  const out: number[] = []; let remaining = value;
  for (;;) {
    const low = remaining & 0x7f; remaining >>= 7;
    if (remaining === 0) { out.push(low); return Buffer.from(out); }
    out.push(low | 0x80);
  }
}

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  u8(): number { if (this.offset >= this.bytes.length) decodeFail(); return this.bytes[this.offset++]!; }
  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) decodeFail();
    const part = Uint8Array.from(this.bytes.subarray(this.offset, this.offset + length)); this.offset += length; return part;
  }
  length(): number { const { value, next } = decodeCompactU16(this.bytes, this.offset); this.offset = next; return value; }
  /** A count of fixed-size items must fit in the remaining input before any allocation. */
  count(itemBytes: number): number {
    const count = this.length(); if (count * itemBytes > this.bytes.length - this.offset) decodeFail(); return count;
  }
  done(): boolean { return this.offset === this.bytes.length; }
}
function freezeMessage(message: SolanaV0Message): SolanaV0Message {
  for (const instruction of message.instructions) Object.freeze(instruction);
  for (const lookup of message.addressTableLookups) Object.freeze(lookup);
  Object.freeze(message.header); Object.freeze(message.staticAccountKeys); Object.freeze(message.instructions);
  Object.freeze(message.addressTableLookups); return Object.freeze(message);
}

/** Strict v0 decode of the exact bytes the wallet would sign. Legacy messages, unknown versions,
 * truncated or over-long input and any trailing byte are refused. */
export function decodeSolanaV0Message(bytes: Uint8Array): SolanaV0Message {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) decodeFail();
  if (bytes.length > SOLANA_MAX_MESSAGE_PARSE_BYTES) throw new SolanaTxCodecError("message_too_large");
  const reader = new Reader(bytes);
  const prefix = reader.u8();
  if ((prefix & VERSION_PREFIX) === 0 || (prefix & 0x7f) !== 0) decodeFail();
  const header: SolanaMessageHeader = { numRequiredSignatures: reader.u8(), numReadonlySignedAccounts: reader.u8(), numReadonlyUnsignedAccounts: reader.u8() };
  const keyCount = reader.count(32); const staticAccountKeys: Uint8Array[] = [];
  for (let index = 0; index < keyCount; index++) staticAccountKeys.push(reader.take(32));
  const recentBlockhash = reader.take(32);
  const instructionCount = reader.count(3); const instructions: SolanaCompiledInstruction[] = [];
  for (let index = 0; index < instructionCount; index++) {
    const programIdIndex = reader.u8(); const accounts = reader.take(reader.length()); const data = reader.take(reader.length());
    instructions.push({ programIdIndex, accounts, data });
  }
  const lookupCount = reader.count(34); const addressTableLookups: SolanaAddressTableLookup[] = [];
  for (let index = 0; index < lookupCount; index++) {
    const accountKey = reader.take(32); const writableIndexes = reader.take(reader.length()); const readonlyIndexes = reader.take(reader.length());
    addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
  }
  if (!reader.done()) decodeFail();
  return freezeMessage({ version: 0, header, staticAccountKeys, recentBlockhash, instructions, addressTableLookups });
}

function bytesOf(value: unknown, length?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length) || value.length > 0xffff) encodeFail();
  return value;
}
/** Canonical v0 serialization; `encodeSolanaV0Message(decodeSolanaV0Message(b))` equals `b`. */
export function encodeSolanaV0Message(message: SolanaV0Message): Buffer {
  const header = message?.header;
  if (!message || message.version !== 0 || !header || ![header.numRequiredSignatures, header.numReadonlySignedAccounts,
    header.numReadonlyUnsignedAccounts].every(byte) || !Array.isArray(message.staticAccountKeys) || !Array.isArray(message.instructions)
    || !Array.isArray(message.addressTableLookups)) encodeFail();
  const parts: Uint8Array[] = [Buffer.from([VERSION_PREFIX, header.numRequiredSignatures, header.numReadonlySignedAccounts,
    header.numReadonlyUnsignedAccounts]), encodeCompactU16(message.staticAccountKeys.length)];
  for (const key of message.staticAccountKeys) parts.push(bytesOf(key, 32));
  parts.push(bytesOf(message.recentBlockhash, 32), encodeCompactU16(message.instructions.length));
  for (const instruction of message.instructions) {
    if (!byte(instruction?.programIdIndex)) encodeFail();
    const accounts = bytesOf(instruction.accounts); const data = bytesOf(instruction.data);
    parts.push(Buffer.from([instruction.programIdIndex]), encodeCompactU16(accounts.length), accounts, encodeCompactU16(data.length), data);
  }
  parts.push(encodeCompactU16(message.addressTableLookups.length));
  for (const lookup of message.addressTableLookups) {
    const writable = bytesOf(lookup?.writableIndexes); const readonly = bytesOf(lookup.readonlyIndexes);
    parts.push(bytesOf(lookup.accountKey, 32), encodeCompactU16(writable.length), writable, encodeCompactU16(readonly.length), readonly);
  }
  return Buffer.concat(parts);
}

/** Serialized transaction size: short_vec signature count, signatures, then the message. */
export function solanaWireSize(messageLength: number, signatureCount: number): number {
  if (!Number.isSafeInteger(messageLength) || messageLength < 1 || !byte(signatureCount)) encodeFail();
  return encodeCompactU16(signatureCount).length + signatureCount * SOLANA_SIGNATURE_BYTES + messageLength;
}
/** Placeholder-signature transaction for `simulateTransaction` with sigVerify=false. */
export function unsignedSolanaWireTransaction(messageBytes: Uint8Array): Buffer {
  const signatures = decodeSolanaV0Message(messageBytes).header.numRequiredSignatures;
  if (solanaWireSize(messageBytes.length, signatures) > SOLANA_MAX_WIRE_BYTES) throw new SolanaTxCodecError("wire_size_exceeded");
  return Buffer.concat([encodeCompactU16(signatures), Buffer.alloc(signatures * SOLANA_SIGNATURE_BYTES), messageBytes]);
}
/** The single-signer wire transaction a validated message becomes once signed. */
export function signedSolanaWireTransaction(messageBytes: Uint8Array, signature: Uint8Array): Buffer {
  const message = decodeSolanaV0Message(messageBytes);
  if (message.header.numRequiredSignatures !== 1 || !(signature instanceof Uint8Array) || signature.length !== SOLANA_SIGNATURE_BYTES) encodeFail();
  if (solanaWireSize(messageBytes.length, 1) > SOLANA_MAX_WIRE_BYTES) throw new SolanaTxCodecError("wire_size_exceeded");
  return Buffer.concat([encodeCompactU16(1), signature, messageBytes]);
}
export function solanaKeyText(key: Uint8Array): string { return encodeBase58(key); }
