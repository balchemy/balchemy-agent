/** Private local IPC. Credentials never enter the job journal or public status. */
import { exactKeys, isId, isRecord, isTimestamp, MAX_FRAME_BYTES } from "./protocol.js";
import type { PrivateModelVaultState } from "./private-model-vault.js";
import { isPrivateBrainModelId, isPrivateBrainProvider, type PrivateBrainProvider } from "./private-brain-providers.js";

export const MAX_PRIVATE_BRAIN_TEXT_BYTES = 8 * 1024;
export const PRIVATE_BRAIN_ERRORS = [
  "model_locked", "vault_locked", "vault_missing", "revision_conflict", "job_not_found", "job_conflict", "journal_full", "busy",
  "invalid_request", "unknown_agent", "instance_conflict", "profile_conflict", "state_unavailable",
  "provider_unavailable", "research_unavailable", "invalid_result", "cancelled", "interrupted", "closing",
  // A2a socket proof of a model change (private-socket-proof.ts; `busy` and `cancelled` are listed above): the trading-wallet passphrase
  // (`walletPassphrase`) is missing, wrong, cannot be checked while the wallet is locked, or was tried too often.
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled",
] as const;
export type PrivateBrainErrorCode = typeof PRIVATE_BRAIN_ERRORS[number];
export type PrivateBrainJobFailure = "provider_unavailable" | "research_unavailable" | "invalid_result";
export type { PrivateBrainProvider } from "./private-brain-providers.js";
export interface PrivateBrainBinding {
  channel: "private_brain";
  version: 1;
  id: string;
  localProfileId: string;
  instanceId: string;
  agentId: string;
}
export type PrivateBrainChatCreateRequest = PrivateBrainBinding & { action: "chat_create"; jobId: string; text: string };
export type PrivateBrainRequest = PrivateBrainChatCreateRequest
  | (PrivateBrainBinding & { action: "chat_read" | "chat_cancel"; jobId: string })
  | (PrivateBrainBinding & { action: "model_status" })
  | (PrivateBrainBinding & { action: "model_lock"; expectedRevision: number })
  /** A2a: `walletPassphrase` (optional, configure, save and reselect) is the TRADING-wallet socket proof of a model change; `passphrase`
   * stays the model vault's own. The daemon decides whether the proof is required. */
  | (PrivateBrainBinding & { action: "model_configure"; expectedRevision: number; provider: PrivateBrainProvider; model: string; apiKey: string; walletPassphrase?: string })
  | (PrivateBrainBinding & { action: "model_save"; expectedRevision: number; expectedVaultRevision: number; provider: PrivateBrainProvider; model: string; apiKey: string; passphrase: string; walletPassphrase?: string })
  | (PrivateBrainBinding & { action: "model_unlock"; expectedRevision: number; expectedVaultRevision: number; passphrase: string })
  /** Phase 2: the saved key with another model of the same provider; the key is never entered again (it never leaves the daemon). */
  | (PrivateBrainBinding & { action: "model_reselect"; expectedRevision: number; expectedVaultRevision: number; model: string; passphrase: string; walletPassphrase?: string });

export type PrivateBrainModelState = { state: "locked"; revision: number }
  | ({ state: "ready"; revision: number; provider: PrivateBrainProvider; model: string }
    & ({ source: "ephemeral" } | { source: "vault"; vaultRevision: number }));
export type PrivateBrainVaultState = PrivateModelVaultState | { saved: "unavailable" };
export const PRIVATE_BRAIN_JOB_STATES = ["queued", "running", "completed", "failed", "cancelled", "interrupted"] as const;
export type PrivateBrainJobState = typeof PRIVATE_BRAIN_JOB_STATES[number];
export interface PrivateBrainJob {
  jobId: string;
  agentId: string;
  originalInstanceId: string;
  modelRevision: number;
  generation: number;
  state: PrivateBrainJobState;
  createdAt: number;
  updatedAt: number;
  /** Complete reply only, never partial provider output or the private input. */
  reply?: string;
  error?: PrivateBrainJobFailure;
}
export type PrivateBrainResponse = PrivateBrainBinding & (
  { ok: true; job: PrivateBrainJob; model?: never; vault?: never }
  | { ok: true; model: PrivateBrainModelState; vault: PrivateBrainVaultState; job?: never }
  | { ok: false; error: PrivateBrainErrorCode }
);

export class PrivateBrainProtocolError extends Error {
  constructor() { super("Invalid private brain message"); this.name = "PrivateBrainProtocolError"; }
}
function invalid(): never { throw new PrivateBrainProtocolError(); }
function revision(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
export function isPrivateBrainText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value)
    && Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PRIVATE_BRAIN_TEXT_BYTES;
}
export function isPrivateModelPassphrase(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 1024 && [...value].length >= 12
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && Buffer.from(value, "utf8").toString("utf8") === value;
}
/** The trading-wallet passphrase policy (private-trading-keystore-protocol.ts isTradingWalletPassphrase), inlined: that module imports
 * this one, so importing it back would be a cycle. Both forms must satisfy the shared policy. */
function walletPassphrase(value: unknown): boolean {
  return isPrivateModelPassphrase(value) && isPrivateModelPassphrase(value.normalize("NFC"));
}
function provider(value: unknown): value is PrivateBrainProvider { return isPrivateBrainProvider(value); }
function model(value: unknown): value is string { return isPrivateBrainModelId(value); }
function binding(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.channel !== "private_brain" || value.version !== 1 || !isId(value.id)
    || !isId(value.localProfileId) || !isId(value.instanceId) || !isId(value.agentId)) invalid();
}
const BINDING_KEYS = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
function boundedFrame(value: unknown): void {
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
  catch { invalid(); }
}

export function parsePrivateBrainRequest(value: unknown): PrivateBrainRequest {
  binding(value);
  const keys = [...BINDING_KEYS, "action"];
  switch (value.action) {
    case "chat_create":
      keys.push("jobId", "text");
      if (!isId(value.jobId) || !isPrivateBrainText(value.text)) invalid();
      break;
    case "chat_read": case "chat_cancel":
      keys.push("jobId"); if (!isId(value.jobId)) invalid(); break;
    case "model_status": break;
    case "model_lock":
      keys.push("expectedRevision"); if (!revision(value.expectedRevision)) invalid(); break;
    case "model_unlock":
      keys.push("expectedRevision", "expectedVaultRevision", "passphrase");
      if (!revision(value.expectedRevision) || !revision(value.expectedVaultRevision, 1) || !isPrivateModelPassphrase(value.passphrase)) invalid();
      break;
    case "model_reselect":
      keys.push("expectedRevision", "expectedVaultRevision", "model", "passphrase");
      if (!revision(value.expectedRevision) || !revision(value.expectedVaultRevision, 1) || !model(value.model)
        || !isPrivateModelPassphrase(value.passphrase)) invalid();
      break;
    case "model_configure": case "model_save":
      keys.push("expectedRevision", "provider", "model", "apiKey");
      if (!revision(value.expectedRevision) || !provider(value.provider) || !model(value.model)
        || typeof value.apiKey !== "string" || !/^[!-~]{1,4096}$/.test(value.apiKey)) invalid();
      if (value.action === "model_save") {
        keys.push("expectedVaultRevision", "passphrase");
        if (!revision(value.expectedVaultRevision) || !isPrivateModelPassphrase(value.passphrase)) invalid();
      }
      break;
    default: invalid();
  }
  if ((value.action === "model_configure" || value.action === "model_save" || value.action === "model_reselect") && Object.hasOwn(value, "walletPassphrase")) {
    keys.push("walletPassphrase"); if (!walletPassphrase(value.walletPassphrase)) invalid();
  }
  if (!exactKeys(value, keys)) invalid();
  boundedFrame(value);
  return value as unknown as PrivateBrainRequest;
}

export function parsePrivateBrainModelState(value: unknown): PrivateBrainModelState {
  if (!isRecord(value) || !revision(value.revision)) invalid();
  if (value.state === "locked") {
    if (!exactKeys(value, ["state", "revision"])) invalid();
  } else if (value.state === "ready") {
    const keys = ["state", "revision", "provider", "model", "source"];
    if (value.source === "vault") { keys.push("vaultRevision"); if (!revision(value.vaultRevision, 1)) invalid(); }
    else if (value.source !== "ephemeral") invalid();
    if (!exactKeys(value, keys) || !revision(value.revision, 1)
      || !provider(value.provider) || !model(value.model)) invalid();
  } else invalid();
  return value as unknown as PrivateBrainModelState;
}

export function parsePrivateBrainVaultState(value: unknown): PrivateBrainVaultState {
  if (!isRecord(value)) invalid();
  if (value.saved === "unavailable") {
    if (!exactKeys(value, ["saved"])) invalid();
  } else if (value.saved === false) {
    if (!exactKeys(value, ["saved", "revision"]) || value.revision !== 0) invalid();
  } else if (value.saved === true) {
    if (!exactKeys(value, ["saved", "revision", "provider", "model"]) || !revision(value.revision, 1)
      || !provider(value.provider) || !model(value.model)) invalid();
  } else invalid();
  return value as unknown as PrivateBrainVaultState;
}

export function parsePrivateBrainJob(value: unknown): PrivateBrainJob {
  if (!isRecord(value) || !isId(value.jobId) || !isId(value.agentId) || !isId(value.originalInstanceId)
    || !revision(value.modelRevision, 1) || !revision(value.generation, 1)
    || !PRIVATE_BRAIN_JOB_STATES.includes(value.state as PrivateBrainJobState)
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) invalid();
  const keys = ["jobId", "agentId", "originalInstanceId", "modelRevision", "generation", "state", "createdAt", "updatedAt"];
  if (value.state === "completed") {
    keys.push("reply"); if (!isPrivateBrainText(value.reply)) invalid();
  }
  if (value.state === "failed") {
    keys.push("error");
    if (value.error !== "provider_unavailable" && value.error !== "research_unavailable" && value.error !== "invalid_result") invalid();
  }
  if (!exactKeys(value, keys) || value.generation > 3 || (value.state === "queued" && value.generation !== 1)
    || (value.state === "running" && value.generation !== 2)
    || (value.state !== "queued" && value.state !== "running" && value.generation < 2)
    || ((value.state === "completed" || value.state === "failed") && value.generation !== 3)) invalid();
  return value as unknown as PrivateBrainJob;
}

export function parsePrivateBrainResponse(value: unknown): PrivateBrainResponse {
  binding(value);
  const keys = [...BINDING_KEYS, "ok"];
  if (value.ok === true) {
    if (Object.hasOwn(value, "job")) {
      keys.push("job");
      const job = parsePrivateBrainJob(value.job);
      if (job.agentId !== value.agentId) invalid();
    } else { keys.push("model", "vault"); parsePrivateBrainModelState(value.model); parsePrivateBrainVaultState(value.vault); }
  } else if (value.ok === false) {
    keys.push("error"); if (!PRIVATE_BRAIN_ERRORS.includes(value.error as PrivateBrainErrorCode)) invalid();
  } else invalid();
  if (!exactKeys(value, keys)) invalid();
  boundedFrame(value);
  return value as unknown as PrivateBrainResponse;
}

function responseBinding(request: PrivateBrainRequest): PrivateBrainBinding {
  return { channel: "private_brain", version: 1, id: request.id, localProfileId: request.localProfileId,
    instanceId: request.instanceId, agentId: request.agentId };
}
export function privateBrainSuccess(request: PrivateBrainRequest, data: { job: PrivateBrainJob } | { model: PrivateBrainModelState; vault: PrivateBrainVaultState }): PrivateBrainResponse {
  return parsePrivateBrainResponse({ ...responseBinding(request), ok: true, ...data });
}
export function privateBrainFailure(request: PrivateBrainRequest, error: PrivateBrainErrorCode): PrivateBrainResponse {
  return parsePrivateBrainResponse({ ...responseBinding(request), ok: false, error });
}
