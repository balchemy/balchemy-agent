import { randomUUID } from "node:crypto";
import { requestPrivateBrain, type PrivateBrainTarget } from "./private-brain-client.js";
import { isId } from "./protocol.js";
import { privateSecretKind, privateSecretRefusal } from "./private-secret-guard.js";
import type { PrivateBrainProvider } from "./private-brain-providers.js";
import { exchangeWithSocketProof, socketProofText, socketProofUnlock, type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";
import { isPrivateBrainText, type PrivateBrainBinding, type PrivateBrainChatCreateRequest, type PrivateBrainErrorCode,
  type PrivateBrainJob, type PrivateBrainModelState, type PrivateBrainVaultState, type PrivateBrainRequest, type PrivateBrainResponse } from "./private-brain-protocol.js";

export type PrivateBrainTransport = (socketPath: string, input: PrivateBrainRequest) => Promise<PrivateBrainResponse>;
export const PRIVATE_CHAT_POLL_MS = 1000;
export const PRIVATE_CHAT_POLL_LIMIT = 30;
export const PRIVATE_CHAT_BOUNDARY = "Rule drafts: review and confirm in runner rules. Trading and arming unavailable.";
export function privateBrainBinding(target: PrivateBrainTarget): PrivateBrainBinding {
  return { channel: "private_brain", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId };
}
export function privateBrainErrorMessage(code: PrivateBrainErrorCode): string {
  const messages: Record<PrivateBrainErrorCode, string> = {
    model_locked: "Model locked. Use runner model for a temporary configuration or runner model-unlock for saved credentials. Restart always requires explicit configuration or unlock.",
    vault_locked: "Saved credentials could not be unlocked. Check the passphrase; the encrypted record was not replaced.",
    vault_missing: "No encrypted model is saved for this agent. Use runner model-save to save one explicitly.",
    revision_conflict: "Model selection changed. Reopen runner model to inspect the current revision before changing it.",
    job_not_found: "This job was not found in the current local profile. Keep its ID; no replacement job was submitted.",
    job_conflict: "This job ID already belongs to a different request. Read the existing result; do not reuse it for new text.",
    journal_full: "Active local job capacity is full. Nothing was removed and no new job was accepted.",
    busy: "The local assistant is busy. This request was not accepted.",
    invalid_request: "The local assistant rejected this request. Check the command and input limits.",
    unknown_agent: "This agent is not registered with the local runner. Inspect runner status first.",
    instance_conflict: "The daemon changed. Detach and reconnect; no request was transferred to another instance.",
    profile_conflict: "The local profile changed. Detach and inspect the runner before continuing.",
    state_unavailable: "Local state could not be confirmed. Keep the job ID and read its result before submitting anything else.",
    provider_unavailable: "The selected model provider is unavailable. No complete reply was produced.",
    research_unavailable: "Required public research is unavailable. No usable research result is implied.",
    invalid_result: "The assistant could not produce a valid complete reply.",
    cancelled: "The job was cancelled.", interrupted: "The job was interrupted. Restarting the daemon does not resume it automatically.",
    closing: "The daemon is closing. Keep the job ID and reconnect after inspecting runner status.",
    proof_required: "Changing the model needs your trading wallet passphrase. Nothing was changed.",
    passphrase_rejected: "Wrong trading wallet passphrase. The model was not changed.",
    wallet_locked: "The trading wallet is locked, so the model change cannot be confirmed. Unlock the wallet first; nothing was changed.",
    proof_throttled: "Too many wrong passphrases in a row. Nothing was changed. Wait a few minutes, then try again.",
  };
  return messages[code];
}
export function privateModelSummary(model: PrivateBrainModelState): string {
  return model.state === "locked" ? `Model locked · revision ${model.revision}`
    : `Model configured: ${model.provider} / ${model.model} · revision ${model.revision} · ${model.source === "vault" ? `saved revision ${model.vaultRevision}` : "temporary"} · provider checked per request`;
}
export function privateVaultSummary(vault: PrivateBrainVaultState): string {
  return vault.saved === "unavailable" ? "Encrypted storage unavailable. Existing records are preserved."
    : vault.saved ? `Encrypted model saved: ${vault.provider} / ${vault.model} · revision ${vault.revision}` : "Encrypted model: none saved";
}
export async function readPrivateModelStatus(target: PrivateBrainTarget, transport = requestPrivateBrain): Promise<PrivateBrainResponse> {
  return transport(target.socketPath, { ...privateBrainBinding(target), action: "model_status" });
}
/** Phase 2 cockpit model step: the saved provider and model, readable without the passphrase (undefined when none or unreadable). */
export async function readPrivateSavedModel(target: PrivateBrainTarget, transport = requestPrivateBrain): Promise<{ provider: PrivateBrainProvider; model: string } | undefined> {
  try {
    const response = await readPrivateModelStatus(target, transport);
    return response.ok && response.vault && response.vault.saved === true ? { provider: response.vault.provider, model: response.vault.model } : undefined;
  } catch { return undefined; }
}
export type PrivateModelOperation = { action: "save"; provider: PrivateBrainProvider; model: string; apiKey: string; passphrase: string }
  | { action: "reselect"; model: string; passphrase: string } | { action: "unlock"; passphrase: string };
export type PrivateModelOperationResult = { kind: "ok" } | { kind: "wrong_passphrase" } | { kind: "failed"; text: string };
/** A2a socket proof of a model change (save, reselect): `known` is the passphrase this model card already holds (the model key's; one
 * passphrase by default), tried as the trading-wallet proof first; `secret` asks the wallet's own once when it is rejected or none is
 * held. A model unlock never carries the wallet proof. */
export interface PrivateModelOperationProof { known?: string; secret?: SocketProofSecret | null; walletTransport?: PrivateTradingWalletTransport }
/** Phase 2 cockpit model step: one credential operation against the current revisions (read first). A lost answer is reported as unknown
 * and never resent. A wrong passphrase changes nothing. A2a: a validated `proof_required` or `wallet_locked` answer (nothing changed) is
 * answered once with the trading-wallet proof, with a fresh frame id. */
export async function runPrivateModelOperation(target: PrivateBrainTarget, operation: PrivateModelOperation,
  transport = requestPrivateBrain, proof: PrivateModelOperationProof = {}): Promise<PrivateModelOperationResult> {
  const failed = (text: string): PrivateModelOperationResult => ({ kind: "failed", text });
  let status: PrivateBrainResponse;
  try { status = await readPrivateModelStatus(target, transport); } catch { return failed("The local runner did not answer. Nothing was changed."); }
  if (!status.ok) return failed(privateBrainErrorMessage(status.error));
  if (!status.model || !status.vault) return failed("The model state could not be confirmed. Nothing was changed.");
  const vault = status.vault;
  if (vault.saved === "unavailable") return failed("Encrypted storage is unavailable on this runner. Nothing was changed.");
  if (operation.action !== "save" && vault.saved !== true) return failed(privateBrainErrorMessage("vault_missing"));
  const model = status.model;
  // A fresh frame id per frame; the trading-wallet proof (`walletPassphrase`) only when the daemon asked for it.
  const build = (walletPassphrase?: string): PrivateBrainRequest => {
    const binding = privateBrainBinding(target);
    const proven = walletPassphrase !== undefined ? { walletPassphrase } : {};
    return operation.action === "save"
      ? { ...binding, action: "model_save", expectedRevision: model.revision, expectedVaultRevision: vault.revision, provider: operation.provider,
        model: operation.model, apiKey: operation.apiKey, passphrase: operation.passphrase, ...proven }
      : operation.action === "reselect"
        ? { ...binding, action: "model_reselect", expectedRevision: model.revision, expectedVaultRevision: vault.revision, model: operation.model,
          passphrase: operation.passphrase, ...proven }
        : { ...binding, action: "model_unlock", expectedRevision: model.revision, expectedVaultRevision: vault.revision, passphrase: operation.passphrase };
  };
  let response: PrivateBrainResponse;
  try {
    const outcome = await exchangeWithSocketProof({ build, send: (request) => transport(target.socketPath, request),
      error: (reply) => (reply.ok ? undefined : reply.error), secret: operation.action === "unlock" ? null : proof.secret ?? null,
      ...(operation.action !== "unlock" && proof.known !== undefined ? { known: proof.known } : {}),
      ...(operation.action !== "unlock" ? { unlock: socketProofUnlock(target, proof.walletTransport) } : {}) });
    if (outcome.kind === "cancelled") return failed("The trading wallet passphrase was not entered. Nothing was changed.");
    if (outcome.kind !== "response") return failed(socketProofText(outcome, target.agentId));
    response = outcome.response;
  } catch { return failed("No answer from the local runner: the change may or may not be saved. Nothing was resent; read balchemy runner model-status first."); }
  if (response.ok) return { kind: "ok" };
  if (response.error === "vault_locked") return { kind: "wrong_passphrase" };
  return failed(privateBrainErrorMessage(response.error));
}
export function privateResultLines(job: PrivateBrainJob): string[] {
  return [`Job ${job.jobId}`, `State: ${job.state}`, ...(job.state === "completed" ? [job.reply!]
    : job.state === "failed" ? [privateBrainErrorMessage(job.error!)]
      : job.state === "cancelled" || job.state === "interrupted" ? [privateBrainErrorMessage(job.state)] : ["The daemon is still working. Reading or closing this terminal does not cancel the job."])];
}
export async function readPrivateResult(target: PrivateBrainTarget, jobId: string, transport = requestPrivateBrain): Promise<PrivateBrainResponse> {
  if (!isId(jobId)) throw new Error("Invalid local job ID");
  return transport(target.socketPath, { ...privateBrainBinding(target), action: "chat_read", jobId });
}
export interface PrivateChatView {
  phase: "loading" | "ready" | "pending" | "unknown" | "waiting" | "blocked";
  model?: PrivateBrainModelState;
  vault?: PrivateBrainVaultState;
  job?: PrivateBrainJob;
  jobId?: string;
  notice: string;
  retryAllowed: boolean;
  replies: readonly { jobId: string; text: string }[];
}
interface ChatDependencies {
  transport?: PrivateBrainTransport;
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
}
/** Ephemeral attachment only: no files, model keys, cancellation or new-job recovery. */
export class PrivateChatSession {
  private readonly target: PrivateBrainTarget;
  private readonly transport: PrivateBrainTransport;
  private readonly schedule: NonNullable<ChatDependencies["schedule"]>;
  private readonly unschedule: NonNullable<ChatDependencies["unschedule"]>;
  private listeners = new Set<() => void>();
  private view: PrivateChatView = { phase: "loading", notice: "Connecting to the local assistant…", retryAllowed: false, replies: [] };
  private intent?: Readonly<PrivateBrainChatCreateRequest>;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private busy = false;
  private reads = 0;
  constructor(target: PrivateBrainTarget, deps: ChatDependencies = {}) {
    this.target = Object.freeze({ ...target }); this.transport = deps.transport ?? requestPrivateBrain;
    this.schedule = deps.schedule ?? setTimeout; this.unschedule = deps.unschedule ?? clearTimeout;
  }
  snapshot = (): PrivateChatView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(change: Partial<PrivateChatView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...change }; for (const listener of this.listeners) listener();
  }
  async connect(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      const response = await this.transport(this.target.socketPath, { ...privateBrainBinding(this.target), action: "model_status" });
      if (!response.ok) this.update({ phase: "blocked", notice: privateBrainErrorMessage(response.error) });
      else if (response.model) this.update({ model: response.model, vault: response.vault, phase: response.model.state === "ready" ? "ready" : "blocked",
        notice: response.model.state === "ready" ? "Enter a message to start a private job." : privateBrainErrorMessage("model_locked") });
    } catch { this.update({ phase: "blocked", notice: "Local runner unavailable. Inspect runner status; this connection did not start a daemon." }); }
    finally { this.busy = false; }
  }
  async submit(text: string): Promise<void> {
    if (this.disposed || this.busy || this.view.phase !== "ready") return;
    if (!isPrivateBrainText(text)) { this.update({ notice: "Use non-empty text within 8 KiB (JSON UTF-8), without terminal control characters." }); return; }
    // Checked here first (the runner refuses it too): a secret never leaves this process, and the chat stays ready.
    const secret = privateSecretKind(text);
    if (secret) { this.update({ notice: privateSecretRefusal(secret) }); return; }
    this.intent = Object.freeze({ ...privateBrainBinding(this.target), action: "chat_create", jobId: randomUUID(), text });
    this.reads = 0;
    this.update({ phase: "pending", job: undefined, jobId: this.intent.jobId, notice: "Submitting this job…", retryAllowed: false });
    await this.sendIntent();
  }
  private async sendIntent(): Promise<void> {
    if (this.disposed || this.busy || !this.intent) return;
    this.busy = true;
    try { this.accept(await this.transport(this.target.socketPath, this.intent)); }
    catch {
      this.update({ phase: "unknown", notice: "Acknowledgement lost. Checking this same job ID…", retryAllowed: false });
      this.busy = false;
      if (!this.disposed) await this.check();
    } finally { this.busy = false; }
  }
  private accept(response: PrivateBrainResponse): void {
    if (this.disposed) return;
    if (!response.ok) {
      const canRetry = response.error === "job_not_found" && Boolean(this.intent);
      this.update({ phase: canRetry || response.error === "state_unavailable" ? "unknown" : "blocked", notice: privateBrainErrorMessage(response.error), retryAllowed: canRetry }); return;
    }
    const job = response.job;
    if (!job || job.jobId !== this.view.jobId) {
      this.update({ phase: "unknown", notice: "The job response could not be matched. Keep its ID and check again.", retryAllowed: false }); return;
    }
    if (job.state === "queued" || job.state === "running") {
      this.update({ phase: "pending", job, notice: `Job ${job.state}. Closing the terminal only detaches.`, retryAllowed: false });
      if (this.reads >= PRIVATE_CHAT_POLL_LIMIT) {
        this.update({ phase: "waiting", notice: "Polling paused after 30 reads. Use /check to read this job again." });
      } else {
        if (this.timer) this.unschedule(this.timer);
        this.timer = this.schedule(() => { this.timer = undefined; void this.check(true); }, PRIVATE_CHAT_POLL_MS);
      }
      return;
    }
    this.intent = undefined;
    const reply = { jobId: job.jobId, text: privateResultLines(job).slice(1).join("\n") };
    const replies = this.view.replies.some((item) => item.jobId === job.jobId)
      ? this.view.replies.map((item) => item.jobId === job.jobId ? reply : item) : [...this.view.replies, reply];
    this.update({ phase: "ready", job, retryAllowed: false,
      notice: job.state === "completed" ? "Reply complete. Enter another message or /exit to detach." : privateBrainErrorMessage(job.state === "failed" ? job.error! : job.state),
      replies });
  }
  async check(automatic = false): Promise<void> {
    if (this.disposed || this.busy || !this.view.jobId) return;
    if (this.timer) { this.unschedule(this.timer); this.timer = undefined; }
    if (!automatic) this.reads = 0;
    this.reads++; this.busy = true;
    try { this.accept(await readPrivateResult(this.target, this.view.jobId, this.transport)); }
    catch { this.update({ phase: "unknown", notice: "The local result is unavailable. Keep the job ID; /check only reads it. No replacement job was submitted.", retryAllowed: false }); }
    finally { this.busy = false; }
  }
  async retrySame(): Promise<void> {
    if (!this.view.retryAllowed || !this.intent || this.disposed || this.busy) return;
    this.update({ phase: "pending", notice: "Resubmitting the exact same job ID and text…", retryAllowed: false });
    await this.sendIntent();
  }
  detach(): void {
    this.disposed = true; if (this.timer) this.unschedule(this.timer); this.timer = undefined;
    this.intent = undefined; this.listeners.clear();
  }
}
