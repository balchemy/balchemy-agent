import { AgentSdkError } from "../errors/agent-sdk-error";
import type { RunnerRuntimeTarget } from "./runtime-client";
import { base58Decode, base64, cancelledFor, CLOCK_SKEW_MS, exactWith, HEX, invalidFor, matches, pinTarget, positive, proofHttpClient,
  proofNonceMessage, sha256, signWithin, solanaAddress, targetPart, TARGET_KEYS, timestampWith, UUID, validateProofNonce, waitFor,
  type ExactFn, type RunnerProofNonce } from "./runner-proof-transport";

export type RunnerTradingWalletTarget = RunnerRuntimeTarget;
/** Closed public bind request. The trading key never leaves the runner. */
export interface RunnerTradingWalletRequest { version: 1; chain: "solana"; walletAddress: string }
export type RunnerTradingWalletExpectedTarget = RunnerTradingWalletTarget & { epoch: number; request: RunnerTradingWalletRequest };
export type RunnerTradingWalletNonce = RunnerProofNonce<"balchemy.local-agent.trading-wallet.bind.v1">;
export interface RunnerTradingWalletBinding {
  version: 1; walletBindingId: string; agentId: string; bindingDigest: string; runnerPublicKey: string; chain: "solana";
  walletAddress: string; status: "active" | "revoked"; boundAt: string; revokedAt: string | null; walletBindingDigest: string;
}
export interface RunnerTradingWalletBindResponse {
  version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string; epoch: number;
  binding: Readonly<RunnerTradingWalletBinding>;
}
/** Runner key: sign only runnerTradingWalletNonceMessage after independently checking this context. Base64, 64 bytes. */
export type RunnerTradingWalletSigner = (nonce: Readonly<RunnerTradingWalletNonce>, expected: RunnerTradingWalletExpectedTarget) => string | Promise<string>;
/** Trading key: sign only runnerTradingWalletPossessionMessage (never a Solana message). Base64, 64 bytes. */
export type RunnerTradingWalletPossessionSigner = (nonce: Readonly<RunnerTradingWalletNonce>, expected: RunnerTradingWalletExpectedTarget) => string | Promise<string>;
export interface RunnerTradingWalletClientConfig extends RunnerTradingWalletTarget {
  apiBaseUrl: string; signer: RunnerTradingWalletSigner; walletSigner: RunnerTradingWalletPossessionSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/trading-wallet";
const PURPOSE = "balchemy.local-agent.trading-wallet.bind.v1" as const;
const REQUEST_PURPOSE = "balchemy.local-agent.trading-wallet.request.v1";
const POSSESSION_PURPOSE = "balchemy.local-agent.trading-wallet.possession.v1";
const BINDING_PURPOSE = "balchemy.local-agent.trading-wallet.binding.v1";
const MAX_PAYLOAD_BYTES = 4096;
const invalid: () => never = invalidFor("trading-wallet");
const cancelled = cancelledFor("trading-wallet");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);

function request(value: unknown, runnerPublicKey?: string): Readonly<RunnerTradingWalletRequest> {
  exact(value, ["version", "chain", "walletAddress"]);
  if (value.version !== 1 || value.chain !== "solana" || !solanaAddress(value.walletAddress)) invalid();
  // The runner identity key is never also the trading key.
  const bytes = base58Decode(value.walletAddress as string);
  if (!bytes || (runnerPublicKey !== undefined && Buffer.from(bytes).toString("base64") === runnerPublicKey)) invalid();
  return Object.freeze({ version: 1, chain: "solana", walletAddress: value.walletAddress as string });
}
export function runnerTradingWalletRequestDigest(value: RunnerTradingWalletRequest): string {
  return sha256([REQUEST_PURPOSE, request(value)]);
}
function expected(value: RunnerTradingWalletExpectedTarget): RunnerTradingWalletExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  const pinned = pinTarget(targetPart(value), invalid);
  return Object.freeze({ ...pinned, epoch: value.epoch, request: request(value.request, pinned.runnerPublicKey) });
}
export function validateRunnerTradingWalletNonce(value: unknown, expectedTarget: RunnerTradingWalletExpectedTarget, now = Date.now()): RunnerTradingWalletNonce {
  const pinned = expected(expectedTarget);
  return validateProofNonce(value, pinned, PURPOSE, "trading-wallet/bind", runnerTradingWalletRequestDigest(pinned.request), now, invalid);
}
export function runnerTradingWalletNonceMessage(value: RunnerTradingWalletNonce, expectedTarget: RunnerTradingWalletExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerTradingWalletNonce(value, expectedTarget, now));
}
/** Exact bytes the trading key signs: proves possession bound to this nonce, agent, runner and wallet. */
export function runnerTradingWalletPossessionMessage(value: RunnerTradingWalletNonce, expectedTarget: RunnerTradingWalletExpectedTarget, now = Date.now()): string {
  const n = validateRunnerTradingWalletNonce(value, expectedTarget, now); const pinned = expected(expectedTarget);
  return JSON.stringify([POSSESSION_PURPOSE, n.audience, n.nonceId, n.agentId, n.bindingDigest, n.runnerPublicKey, n.instanceId, n.epoch,
    pinned.request.walletAddress, n.nonce, n.issuedAt, n.expiresAt]);
}
export function runnerTradingWalletBindingDigest(b: Pick<RunnerTradingWalletBinding, "walletBindingId" | "agentId" | "bindingDigest"
  | "runnerPublicKey" | "chain" | "walletAddress" | "boundAt">): string {
  return sha256([BINDING_PURPOSE, b.walletBindingId, b.agentId, b.bindingDigest, b.runnerPublicKey, b.chain, b.walletAddress, b.boundAt]);
}
/** Validates a public binding for this agent and wallet. A bind response must be active. */
export function validateRunnerTradingWalletBinding(value: unknown, expectedTarget: RunnerTradingWalletExpectedTarget, now = Date.now()): Readonly<RunnerTradingWalletBinding> {
  const pinned = expected(expectedTarget);
  exact(value, ["version", "walletBindingId", "agentId", "bindingDigest", "runnerPublicKey", "chain", "walletAddress", "status", "boundAt", "revokedAt", "walletBindingDigest"]);
  if (value.version !== 1 || !matches(value.walletBindingId, UUID) || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest
    || value.runnerPublicKey !== pinned.runnerPublicKey || value.chain !== "solana" || value.walletAddress !== pinned.request.walletAddress
    || value.status !== "active" || value.revokedAt !== null || !matches(value.walletBindingDigest, HEX)
    || timestamp(value.boundAt) > now + CLOCK_SKEW_MS) invalid();
  const binding = Object.freeze({ ...value }) as unknown as Readonly<RunnerTradingWalletBinding>;
  if (runnerTradingWalletBindingDigest(binding) !== binding.walletBindingDigest) invalid();
  return binding;
}
export function validateRunnerTradingWalletBindResponse(value: unknown, expectedTarget: RunnerTradingWalletExpectedTarget, now = Date.now()): RunnerTradingWalletBindResponse {
  const pinned = expected(expectedTarget);
  exact(value, ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch", "binding"]);
  if (!Number.isFinite(now) || value.version !== 1 || value.requestDigest !== runnerTradingWalletRequestDigest(pinned.request)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.instanceId !== pinned.instanceId
    || value.epoch !== pinned.epoch) invalid();
  const result = Object.freeze({ ...value, binding: validateRunnerTradingWalletBinding(value.binding, pinned, now) }) as unknown as RunnerTradingWalletBindResponse;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PAYLOAD_BYTES) invalid();
  return result;
}

export class RunnerTradingWalletClient {
  private readonly pinned: RunnerTradingWalletTarget;
  private readonly signer: RunnerTradingWalletSigner;
  private readonly walletSigner: RunnerTradingWalletPossessionSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerTradingWalletClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer", "walletSigner"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function" || typeof config.walletSigner !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.walletSigner = config.walletSigner; this.timeoutMs = config.timeoutMs ?? 20_000; this.transport = config.fetchFn ?? fetch;
  }
  /** A single bounded attempt; an exact re-bind of the same wallet is idempotent server-side. */
  async bind(input: RunnerTradingWalletRequest, epoch: number, callerSignal?: AbortSignal): Promise<RunnerTradingWalletBindResponse> {
    const operation = expected({ ...this.pinned, epoch, request: input });
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, this.transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerTradingWalletRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:trading-wallet-nonce" }), scope.signal, cancelled);
      const nonce = validateRunnerTradingWalletNonce(data, operation);
      const signature = await signWithin(() => this.signer(nonce, operation), nonce.expiresAt, scope.signal, invalid, cancelled);
      const walletSignature = await signWithin(() => this.walletSigner(nonce, operation), nonce.expiresAt, scope.signal, invalid, cancelled);
      validateRunnerTradingWalletNonce(nonce, operation);
      if (!base64(signature, 64) || !base64(walletSignature, 64) || signature === walletSignature) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/bind`, { nonceId: nonce.nonceId, signature, walletSignature,
        epoch: operation.epoch, request: operation.request }, { kind: "side_effecting", operation: "local-agent:trading-wallet-bind" }), scope.signal, cancelled);
      return validateRunnerTradingWalletBindResponse(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
