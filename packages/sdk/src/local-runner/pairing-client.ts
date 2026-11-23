import { createHash } from "node:crypto";
import { HttpClient } from "../client/http-client";
import { AgentSdkError } from "../errors/agent-sdk-error";

/** Public identity wire contract. No owner session or trading authority. */
export interface LocalAgentPairingBindingV1 {
  version: 1;
  purpose: "balchemy.local-agent.create";
  challengeId: string;
  agentId: string;
  ownerUserId: string;
  sessionBinding: string;
  walletAccountId: string;
  walletChain: "solana" | "base";
  walletAddress: string;
  walletVerifiedAt: string;
  chainId: string;
  domain: string;
  uri: string;
  runnerPublicKey: string;
  localIntentNonce: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export type RunnerPairingReadResource = "challenge" | "receipt";
export interface RunnerPairingReadNonce {
  version: 1;
  purpose: "balchemy.local-agent.runner-read.v1";
  audience: string;
  nonceId: string;
  challengeId: string;
  runnerPublicKey: string;
  localIntentNonce: string;
  resource: RunnerPairingReadResource;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}
export interface RunnerPairingChallenge {
  resource: "challenge";
  challengeId: string;
  agentId: string;
  message: string;
  expiresAt: string;
  walletChain: "solana" | "base";
  walletSignatureEncoding: "base58" | "hex";
  runnerSignatureEncoding: "base64";
  binding: LocalAgentPairingBindingV1;
  bindingDigest: string;
}
export interface RunnerPairingReceipt {
  resource: "receipt";
  agentId: string;
  pairingState: "paired";
  executionAuthority: "none";
  pairedAt: string;
  binding: LocalAgentPairingBindingV1;
  bindingDigest: string;
}
export type RunnerPairingReadResponse = RunnerPairingChallenge | RunnerPairingReceipt;
export interface RunnerPairingIdentity {
  frontendOrigin: string;
  runnerPublicKey: string;
  localIntentNonce: string;
}

const READ_PATH = "/nest/local-agents/pairing/runner-read";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const BINDING_KEYS = ["version", "purpose", "challengeId", "agentId", "ownerUserId", "sessionBinding", "walletAccountId", "walletChain", "walletAddress", "walletVerifiedAt", "chainId", "domain", "uri", "runnerPublicKey", "localIntentNonce", "nonce", "issuedAt", "expiresAt"] as const;
const READ_KEYS = ["version", "purpose", "audience", "nonceId", "challengeId", "runnerPublicKey", "localIntentNonce", "resource", "nonce", "issuedAt", "expiresAt"] as const;
const CLOCK_SKEW_MS = 5_000;

function invalid(): never {
  throw new AgentSdkError({ code: "invalid_response", message: "Invalid local-agent pairing response", details: { retryable: false } });
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) invalid();
}
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value); }
function canonicalBase64(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || value.length !== 24) invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid();
  return time;
}
function trustedOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
    return url.origin;
  } catch { return invalid(); }
}
function identity(input: RunnerPairingIdentity): RunnerPairingIdentity {
  if (!canonicalBase64(input.runnerPublicKey, 32) || !matches(input.localIntentNonce, HEX32)) invalid();
  return { frontendOrigin: trustedOrigin(input.frontendOrigin), runnerPublicKey: input.runnerPublicKey, localIntentNonce: input.localIntentNonce };
}

/** Exactly the public wire tuple used by both wallet and runner pairing proofs. */
export function pairingBindingDigest(binding: LocalAgentPairingBindingV1): string {
  return createHash("sha256").update(JSON.stringify(BINDING_KEYS.map((key) => binding[key])), "utf8").digest("hex");
}

export function validateRunnerPairingReadNonce(value: unknown, expected: RunnerPairingIdentity & { challengeId: string; resource: RunnerPairingReadResource }, now = Date.now()): RunnerPairingReadNonce {
  const pinned = identity(expected);
  exact(value, READ_KEYS);
  if (!matches(expected.challengeId, UUID) || !["challenge", "receipt"].includes(expected.resource)
    || value.version !== 1 || value.purpose !== "balchemy.local-agent.runner-read.v1"
    || value.audience !== `${pinned.frontendOrigin}/api${READ_PATH}` || !matches(value.nonceId, UUID)
    || value.challengeId !== expected.challengeId || value.resource !== expected.resource
    || value.runnerPublicKey !== pinned.runnerPublicKey || value.localIntentNonce !== pinned.localIntentNonce
    || !matches(value.nonce, HEX32)) invalid();
  const issued = timestamp(value.issuedAt);
  const expires = timestamp(value.expiresAt);
  if (issued > now + CLOCK_SKEW_MS || expires <= now || expires <= issued || expires - issued > 60_000) invalid();
  return { ...value } as unknown as RunnerPairingReadNonce;
}

/** Narrow read-purpose bytes; never use this as a generic supplied-text signer. */
export function runnerPairingReadMessage(value: RunnerPairingReadNonce, expected: RunnerPairingIdentity & { challengeId: string; resource: RunnerPairingReadResource }, now = Date.now()): string {
  const nonce = validateRunnerPairingReadNonce(value, expected, now);
  return JSON.stringify(READ_KEYS.map((key) => nonce[key]));
}

function binding(value: unknown, expected: RunnerPairingIdentity & { challengeId: string }, now: number): LocalAgentPairingBindingV1 {
  exact(value, BINDING_KEYS);
  if (value.version !== 1 || value.purpose !== "balchemy.local-agent.create"
    || value.challengeId !== expected.challengeId || !matches(value.challengeId, UUID) || !matches(value.agentId, UUID)
    || !matches(value.ownerUserId, OBJECT_ID) || !matches(value.walletAccountId, OBJECT_ID)
    || !matches(value.sessionBinding, HEX32) || !matches(value.nonce, HEX32)
    || value.runnerPublicKey !== expected.runnerPublicKey || value.localIntentNonce !== expected.localIntentNonce
    || value.domain !== new URL(expected.frontendOrigin).host.toLowerCase() || value.uri !== `${expected.frontendOrigin}/hub/agents`) invalid();
  if (value.walletChain === "base") {
    if (value.chainId !== "eip155:8453" || !matches(value.walletAddress, /^0x[0-9a-f]{40}$/)) invalid();
  } else if (value.walletChain === "solana") {
    if (!matches(value.walletAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      || !["solana:mainnet", "solana:mainnet-beta", "solana:devnet", "solana:testnet"].includes(String(value.chainId))) invalid();
  } else invalid();
  const issued = timestamp(value.issuedAt);
  const expires = timestamp(value.expiresAt);
  if (timestamp(value.walletVerifiedAt) > issued || issued > now + CLOCK_SKEW_MS || expires <= issued || expires - issued > 300_000) invalid();
  return { ...value } as unknown as LocalAgentPairingBindingV1;
}

/** Revalidate a persisted public binding without claiming it is pending or committed. */
export function validateRunnerPairingBinding(value: unknown, expected: RunnerPairingIdentity & { challengeId: string }, now = Date.now()): LocalAgentPairingBindingV1 {
  return binding(value, { ...identity(expected), challengeId: expected.challengeId }, now);
}

function expectedPairingMessage(value: LocalAgentPairingBindingV1, supplied: string): string {
  // SIWE displays the checksummed spelling. Only case can differ from the
  // canonical bound EVM address; no extra text or account can enter that line.
  const addressLine = value.walletChain === "base" ? supplied.split("\n")[1] : value.walletAddress;
  if (value.walletChain === "base" && (!matches(addressLine, /^0x[0-9a-fA-F]{40}$/) || addressLine.toLowerCase() !== value.walletAddress)) invalid();
  return [
    `${value.domain} wants you to sign in with your ${value.walletChain === "base" ? "Ethereum" : "Solana"} account:`,
    addressLine, "", `Create local agent ${value.agentId} for owner ${value.ownerUserId} with runner Ed25519 ${value.runnerPublicKey}. Pairing grants no trading authority.`, "",
    `URI: ${value.uri}`, "Version: 1", `Chain ID: ${value.walletChain === "base" ? "8453" : value.chainId}`,
    `Nonce: ${value.nonce}`, `Issued At: ${value.issuedAt}`, `Expiration Time: ${value.expiresAt}`,
    "Resources:", `- urn:balchemy:local-agent-pairing:${pairingBindingDigest(value)}`,
  ].join("\n");
}

export function validateRunnerPairingResponse(value: unknown, expected: RunnerPairingIdentity & { challengeId: string; resource: RunnerPairingReadResource; approvedBindingDigest?: string }, now = Date.now()): RunnerPairingReadResponse {
  const pinned = identity(expected);
  const keys = expected.resource === "challenge"
    ? ["resource", "challengeId", "agentId", "message", "expiresAt", "walletChain", "walletSignatureEncoding", "runnerSignatureEncoding", "binding", "bindingDigest"]
    : ["resource", "agentId", "pairingState", "executionAuthority", "pairedAt", "binding", "bindingDigest"];
  exact(value, keys);
  if (!matches(expected.challengeId, UUID) || !["challenge", "receipt"].includes(expected.resource) || value.resource !== expected.resource) invalid();
  const checked = binding(value.binding, { ...pinned, challengeId: expected.challengeId }, now);
  if (value.bindingDigest !== pairingBindingDigest(checked) || value.agentId !== checked.agentId) invalid();
  if (value.resource === "challenge") {
    if (value.challengeId !== checked.challengeId || value.expiresAt !== checked.expiresAt || value.walletChain !== checked.walletChain
      || value.walletSignatureEncoding !== (checked.walletChain === "base" ? "hex" : "base58") || value.runnerSignatureEncoding !== "base64"
      || timestamp(checked.expiresAt) <= now || typeof value.message !== "string" || value.message.length > 4096
      || value.message !== expectedPairingMessage(checked, value.message)) invalid();
  } else {
    const paired = timestamp(value.pairedAt);
    if (!matches(expected.approvedBindingDigest, HEX32) || value.bindingDigest !== expected.approvedBindingDigest
      || value.pairingState !== "paired" || value.executionAuthority !== "none"
      || paired < timestamp(checked.issuedAt) || paired >= timestamp(checked.expiresAt) || paired > now + CLOCK_SKEW_MS) invalid();
  }
  return { ...value, binding: checked } as unknown as RunnerPairingReadResponse;
}

/** A single-use read of "the challenge for my own intent": no Challenge ID is typed or carried. */
export interface RunnerPairingIntentNonce {
  version: 1;
  purpose: "balchemy.local-agent.runner-intent-read.v1";
  audience: string;
  nonceId: string;
  runnerPublicKey: string;
  localIntentNonce: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}
/** `none`: the owner's page has not created a challenge for this intent yet, or it expired. */
export type RunnerPairingIntentResponse = { resource: "none" } | RunnerPairingChallenge | RunnerPairingReceipt;
export interface RunnerPairingResponseProof { challengeId: string; bindingDigest: string; runnerSignature: string }
export interface RunnerPairingResponseAccepted { state: "accepted"; challengeId: string; bindingDigest: string }

const INTENT_PATH = "/nest/local-agents/pairing/runner/intent";
const RESPONSE_PATH = "/nest/local-agents/pairing/runner/response";
const INTENT_KEYS = ["version", "purpose", "audience", "nonceId", "runnerPublicKey", "localIntentNonce", "nonce", "issuedAt", "expiresAt"] as const;

export function validateRunnerPairingIntentNonce(value: unknown, expected: RunnerPairingIdentity, now = Date.now()): RunnerPairingIntentNonce {
  const pinned = identity(expected);
  exact(value, INTENT_KEYS);
  if (value.version !== 1 || value.purpose !== "balchemy.local-agent.runner-intent-read.v1"
    || value.audience !== `${pinned.frontendOrigin}/api${INTENT_PATH}` || !matches(value.nonceId, UUID)
    || value.runnerPublicKey !== pinned.runnerPublicKey || value.localIntentNonce !== pinned.localIntentNonce
    || !matches(value.nonce, HEX32)) invalid();
  const issued = timestamp(value.issuedAt);
  const expires = timestamp(value.expiresAt);
  if (issued > now + CLOCK_SKEW_MS || expires <= now || expires <= issued || expires - issued > 60_000) invalid();
  return { ...value } as unknown as RunnerPairingIntentNonce;
}

/** Narrow intent-read bytes (a different purpose and shape from every other runner proof); never a generic signer. */
export function runnerPairingIntentReadMessage(value: RunnerPairingIntentNonce, expected: RunnerPairingIdentity, now = Date.now()): string {
  const nonce = validateRunnerPairingIntentNonce(value, expected, now);
  return JSON.stringify(INTENT_KEYS.map((key) => nonce[key]));
}

/** A found challenge is checked exactly like the challenge-keyed read; a receipt only against a locally approved digest. */
export function validateRunnerPairingIntentResponse(value: unknown, expected: RunnerPairingIdentity & { approvedBindingDigest?: string }, now = Date.now()): RunnerPairingIntentResponse {
  const pinned = identity(expected);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (record.resource === "none") {
    exact(value, ["resource"]);
    return { resource: "none" };
  }
  if (record.resource === "challenge") {
    if (!matches(record.challengeId, UUID)) invalid();
    return validateRunnerPairingResponse(value, { ...pinned, challengeId: record.challengeId, resource: "challenge" }, now);
  }
  if (record.resource === "receipt") {
    const bound = record.binding as Record<string, unknown> | undefined;
    if (!bound || typeof bound !== "object" || !matches(bound.challengeId, UUID) || !matches(expected.approvedBindingDigest, HEX32)) invalid();
    return validateRunnerPairingResponse(value, { ...pinned, challengeId: bound.challengeId, resource: "receipt",
      approvedBindingDigest: expected.approvedBindingDigest }, now);
  }
  return invalid();
}

export class RunnerPairingClient {
  /** The intent-read signing bytes, reachable without a separate package export. */
  static intentReadMessage(value: RunnerPairingIntentNonce, expected: RunnerPairingIdentity, now = Date.now()): string {
    return runnerPairingIntentReadMessage(value, expected, now);
  }
  private readonly http: HttpClient;
  private readonly pinned: RunnerPairingIdentity;
  constructor(config: RunnerPairingIdentity & { apiBaseUrl: string; timeoutMs?: number; fetchFn?: typeof fetch }) {
    this.pinned = identity(config);
    // Use the same trusted web origin, via its established API proxy. Never
    // follow a URL carried by a nonce, handoff fragment or proof file.
    if (config.apiBaseUrl.replace(/\/$/, "") !== `${this.pinned.frontendOrigin}/api`) invalid();
    this.http = new HttpClient({ baseUrl: config.apiBaseUrl, timeoutMs: config.timeoutMs ?? 10_000,
      fetchFn: config.fetchFn, retry: { maxAttempts: 1 } });
  }
  async requestReadNonce(challengeId: string, resource: RunnerPairingReadResource): Promise<RunnerPairingReadNonce> {
    if (!matches(challengeId, UUID) || !["challenge", "receipt"].includes(resource)) invalid();
    const result = await this.http.post<unknown>(`${READ_PATH}/nonce`, {
      challengeId, runnerPublicKey: this.pinned.runnerPublicKey, localIntentNonce: this.pinned.localIntentNonce, resource,
    }, { kind: "side_effecting", operation: "local-agent:runner-read-nonce" });
    return validateRunnerPairingReadNonce(result, { ...this.pinned, challengeId, resource });
  }
  /** Receipt reads require the exact digest pinned during deliberate local approval. */
  async read(nonce: RunnerPairingReadNonce, runnerSignature: string, approvedBindingDigest?: string): Promise<RunnerPairingReadResponse> {
    const expected = { ...this.pinned, challengeId: nonce.challengeId, resource: nonce.resource, approvedBindingDigest };
    const checked = validateRunnerPairingReadNonce(nonce, expected);
    if (!canonicalBase64(runnerSignature, 64) || (checked.resource === "receipt" && !matches(approvedBindingDigest, HEX32))) invalid();
    const result = await this.http.post<unknown>(READ_PATH, { nonceId: checked.nonceId, runnerSignature },
      { kind: "side_effecting", operation: "local-agent:runner-read" });
    return validateRunnerPairingResponse(result, expected);
  }
  async requestIntentNonce(): Promise<RunnerPairingIntentNonce> {
    const result = await this.http.post<unknown>(`${INTENT_PATH}/nonce`, {
      runnerPublicKey: this.pinned.runnerPublicKey, localIntentNonce: this.pinned.localIntentNonce,
    }, { kind: "side_effecting", operation: "local-agent:runner-intent-nonce" });
    return validateRunnerPairingIntentNonce(result, this.pinned);
  }
  /** A receipt is accepted only for the digest pinned during deliberate local approval. */
  async readIntent(nonce: RunnerPairingIntentNonce, runnerSignature: string, approvedBindingDigest?: string): Promise<RunnerPairingIntentResponse> {
    const checked = validateRunnerPairingIntentNonce(nonce, this.pinned);
    if (!canonicalBase64(runnerSignature, 64) || (approvedBindingDigest !== undefined && !matches(approvedBindingDigest, HEX32))) invalid();
    const result = await this.http.post<unknown>(INTENT_PATH, { nonceId: checked.nonceId, runnerSignature },
      { kind: "side_effecting", operation: "local-agent:runner-intent-read" });
    return validateRunnerPairingIntentResponse(result, { ...this.pinned, approvedBindingDigest });
  }
  /** Relay the runner's pairing signature to the owner's page. The server verifies it; `confirm` verifies it again. */
  async submitResponse(proof: RunnerPairingResponseProof): Promise<RunnerPairingResponseAccepted> {
    if (!matches(proof.challengeId, UUID) || !matches(proof.bindingDigest, HEX32) || !canonicalBase64(proof.runnerSignature, 64)) invalid();
    const result = await this.http.post<unknown>(RESPONSE_PATH, { challengeId: proof.challengeId, runnerSignature: proof.runnerSignature },
      { kind: "side_effecting", operation: "local-agent:runner-pairing-response" });
    exact(result, ["state", "challengeId", "bindingDigest"]);
    if (result.state !== "accepted" || result.challengeId !== proof.challengeId || result.bindingDigest !== proof.bindingDigest) invalid();
    return { state: "accepted", challengeId: proof.challengeId, bindingDigest: proof.bindingDigest };
  }
}
