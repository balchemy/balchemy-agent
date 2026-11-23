/** Owner-local authoring. This channel never grants execution authority. */
import { exactKeys, isId, isRecord, MAX_FRAME_BYTES } from "./protocol.js";
import type { ExpectedRuleHead, PrivateRuleErrorCode, RuleHead, RuleCommitReceipt, RuleRevisionSummary } from "./private-rule-store.js";
import { MAX_PRIVATE_RULE_DOCUMENT_BYTES } from "./private-rule-store.js";
import { parsePrivateChangeEntries, type PrivateChangeEntries } from "./private-change-entries.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";

export const RULE_PAGE_BYTES = 6 * 1024;
export const MAX_RULE_DOCUMENT_BYTES = MAX_PRIVATE_RULE_DOCUMENT_BYTES;
export type RuleDigest = `sha256:${string}`;
export type RuleRevisionId = `brr_${string}`;
export interface PrivateRuleBinding {
  channel: "private_rules"; version: 1; id: string;
  localProfileId: string; instanceId: string; agentId: string; chain: "solana" | "base";
}
export type PrivateRuleRequest = PrivateRuleBinding & (
  { action: "head" }
  | ({ action: "propose"; proposalId: string; exactSource: string } & ExpectedRuleHead)
  | ({ action: "rollback"; proposalId: string; targetRevisionId: RuleRevisionId } & ExpectedRuleHead)
  /** The owner's explicit approval setting, proposed against the current confirmed head (never revision 0). */
  | ({ action: "approval"; proposalId: string; setting: "off" | "on" } & ExpectedRuleHead)
  | { action: "proposal_read"; proposalId: string; offset: number }
  | { action: "revision_read"; revisionId: RuleRevisionId; offset: number }
  /** A2a: `passphrase` (optional) is the trading-wallet socket proof of a raising confirm; the daemon decides from the stored proposal. */
  | ({ action: "confirm"; operationId: string; proposalId: string; proposalDigest: RuleDigest; passphrase?: string } & ExpectedRuleHead)
  | { action: "receipt"; operationId: string }
  | { action: "history"; beforeRevision: number | null }
);
export interface RuleDocumentPage {
  documentId: string; digest: RuleDigest; totalBytes: number; offset: number; base64: string; nextOffset: number | null;
}
export type PrivateRuleData = { kind: "head"; head: RuleHead }
  | { kind: "proposal"; proposalId: string; proposalDigest: RuleDigest }
  | { kind: "page"; page: RuleDocumentPage }
  /** `entries` only on a confirm's receipt when the agent was armed when the confirm began (owner decision of 17 Nov 2026,
   * private-change-entries.ts); never on a receipt read. */
  | { kind: "receipt"; receipt: RuleCommitReceipt | null; entries?: PrivateChangeEntries }
  | { kind: "history"; history: RuleRevisionSummary[] };
/** A2a socket proof refusals (private-socket-proof.ts) on a raising confirm. */
export type RuleProofError = "proof_required" | "passphrase_rejected" | "wallet_locked" | "proof_throttled" | "busy" | "cancelled";
export type RuleChannelError = PrivateRuleErrorCode | "instance_conflict" | "closing" | RuleProofError;
const ERRORS: readonly RuleChannelError[] = ["invalid_request", "unknown_agent", "profile_conflict", "invalid_chain",
  "proposal_not_found", "revision_not_found", "proposal_conflict", "operation_conflict", "revision_conflict",
  "context_conflict", "compiler_conflict", "rules_invalid", "proposal_consumed", "proposal_too_large", "journal_full", "state_unavailable", "instance_conflict", "closing",
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled", "busy", "cancelled"];
export type PrivateRuleResponse = PrivateRuleBinding & ({ ok: true; data: PrivateRuleData } | { ok: false; error: RuleChannelError });
export class PrivateRuleProtocolError extends Error {
  constructor() { super("Invalid private rule message"); this.name = "PrivateRuleProtocolError"; }
}
function invalid(): never { throw new PrivateRuleProtocolError(); }
function count(value: unknown, min = 0): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min; }
export function isRuleDigest(value: unknown): value is RuleDigest { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
export function isRuleRevisionId(value: unknown): value is RuleRevisionId { return typeof value === "string" && /^brr_[a-f0-9]{64}$/.test(value); }
export function isRuleSource(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 8000
    && Buffer.byteLength(JSON.stringify(value), "utf8") <= 8192
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value)
    && Buffer.from(value, "utf8").toString("utf8") === value;
}
const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId", "chain"];
function binding(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.channel !== "private_rules" || value.version !== 1 || !isId(value.id)
    || !isId(value.localProfileId) || !isId(value.instanceId) || !isId(value.agentId)
    || (value.chain !== "solana" && value.chain !== "base")) invalid();
}
function expected(value: Record<string, unknown>): void {
  if (!count(value.expectedRevision) || (value.expectedRevision === 0 ? value.expectedRevisionId !== null : !isRuleRevisionId(value.expectedRevisionId))) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
function offset(value: unknown): boolean { return count(value) && value < MAX_RULE_DOCUMENT_BYTES && value % RULE_PAGE_BYTES === 0; }
export function parsePrivateRuleRequest(value: unknown): PrivateRuleRequest {
  binding(value); const keys = [...BINDING, "action"];
  switch (value.action) {
    case "head": break;
    case "propose": case "rollback":
      keys.push("proposalId", "expectedRevision", "expectedRevisionId", value.action === "propose" ? "exactSource" : "targetRevisionId");
      expected(value);
      if (!isId(value.proposalId) || (value.action === "propose" ? !isRuleSource(value.exactSource) : !isRuleRevisionId(value.targetRevisionId))) invalid();
      break;
    case "approval":
      keys.push("proposalId", "expectedRevision", "expectedRevisionId", "setting"); expected(value);
      if (!isId(value.proposalId) || (value.setting !== "off" && value.setting !== "on") || value.expectedRevision === 0) invalid();
      break;
    case "confirm":
      keys.push("operationId", "proposalId", "proposalDigest", "expectedRevision", "expectedRevisionId"); expected(value);
      if (Object.hasOwn(value, "passphrase")) { keys.push("passphrase"); if (!isTradingWalletPassphrase(value.passphrase)) invalid(); }
      if (!isId(value.operationId) || !isId(value.proposalId) || !isRuleDigest(value.proposalDigest)) invalid(); break;
    case "receipt": keys.push("operationId"); if (!isId(value.operationId)) invalid(); break;
    case "proposal_read": keys.push("proposalId", "offset"); if (!isId(value.proposalId) || !offset(value.offset)) invalid(); break;
    case "revision_read": keys.push("revisionId", "offset"); if (!isRuleRevisionId(value.revisionId) || !offset(value.offset)) invalid(); break;
    case "history": keys.push("beforeRevision"); if (value.beforeRevision !== null && !count(value.beforeRevision, 1)) invalid(); break;
    default: invalid();
  }
  if (!exactKeys(value, keys)) invalid(); bounded(value);
  return value as unknown as PrivateRuleRequest;
}
function matchesScope(value: Record<string, unknown>, target: PrivateRuleBinding): boolean {
  return value.localProfileId === target.localProfileId && value.agentId === target.agentId && value.chain === target.chain;
}
function state(value: unknown): boolean { return value === "compiled" || value === "held_requires_review"; }
function compiler(value: unknown): boolean { return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value); }
function head(value: unknown, target: PrivateRuleBinding): void {
  if (!isRecord(value) || !matchesScope(value, target) || !count(value.revision)) invalid();
  const keys = ["localProfileId", "agentId", "chain", "revision", "revisionId", "state"];
  if (value.revision === 0) { if (value.revisionId !== null || value.state !== "empty") invalid(); }
  else {
    keys.push("compilerVersion", "diagnosticCount");
    if (!isRuleRevisionId(value.revisionId) || !state(value.state) || !compiler(value.compilerVersion) || !count(value.diagnosticCount)) invalid();
  }
  if (!exactKeys(value, keys)) invalid();
}
function receipt(value: unknown, target: PrivateRuleBinding): void {
  if (value === null) return;
  if (!isRecord(value) || !exactKeys(value, ["input", "revision", "revisionId", "state", "committedAt", "digest"])
    || !isRecord(value.input) || !matchesScope(value.input, target)
    || !exactKeys(value.input, ["localProfileId", "agentId", "chain", "expectedRevision", "expectedRevisionId", "operationId", "proposalId", "proposalDigest"])
    || !isId(value.input.operationId) || !isId(value.input.proposalId) || !isRuleDigest(value.input.proposalDigest)
    || !count(value.revision, 1) || !isRuleRevisionId(value.revisionId) || !state(value.state)
    || !count(value.committedAt) || !isRuleDigest(value.digest)) invalid();
  expected(value.input);
  if (value.revision !== Number(value.input.expectedRevision) + 1) invalid();
}
export function parsePrivateRuleResponse(value: unknown): PrivateRuleResponse {
  binding(value); const keys = [...BINDING, "ok"];
  if (value.ok === false) { keys.push("error"); if (!ERRORS.includes(value.error as RuleChannelError)) invalid(); }
  else if (value.ok === true) {
    keys.push("data"); const data = value.data; const target = value as unknown as PrivateRuleBinding;
    if (!isRecord(data)) invalid();
    switch (data.kind) {
      case "head": if (!exactKeys(data, ["kind", "head"])) invalid(); head(data.head, target); break;
      case "proposal":
        if (!exactKeys(data, ["kind", "proposalId", "proposalDigest"]) || !isId(data.proposalId) || !isRuleDigest(data.proposalDigest)) invalid(); break;
      case "receipt":
        if (Object.hasOwn(data, "entries")) {
          if (!exactKeys(data, ["kind", "receipt", "entries"]) || data.receipt === null) invalid();
          try { parsePrivateChangeEntries(data.entries); } catch { invalid(); }
        } else if (!exactKeys(data, ["kind", "receipt"])) invalid();
        receipt(data.receipt, target); break;
      case "history":
        if (!exactKeys(data, ["kind", "history"]) || !Array.isArray(data.history) || data.history.length > 10) invalid();
        for (const entry of data.history) {
          if (!isRecord(entry) || !exactKeys(entry, ["localProfileId", "agentId", "chain", "revision", "revisionId", "parentRevisionId", "state", "compilerVersion", "diagnosticCount", "confirmedAt"])
            || !matchesScope(entry, target) || !count(entry.revision, 1) || !isRuleRevisionId(entry.revisionId)
            || (entry.revision === 1 ? entry.parentRevisionId !== null : !isRuleRevisionId(entry.parentRevisionId))
            || !state(entry.state) || !compiler(entry.compilerVersion) || !count(entry.diagnosticCount) || !count(entry.confirmedAt)) invalid();
        } break;
      case "page": {
        if (!exactKeys(data, ["kind", "page"]) || !isRecord(data.page)) invalid(); const page = data.page;
        if (!exactKeys(page, ["documentId", "digest", "totalBytes", "offset", "base64", "nextOffset"])
          || !isId(page.documentId) || !isRuleDigest(page.digest) || !count(page.totalBytes, 1) || page.totalBytes > MAX_RULE_DOCUMENT_BYTES
          || !offset(page.offset) || Number(page.offset) >= page.totalBytes || typeof page.base64 !== "string") invalid();
        const bytes = Buffer.from(page.base64, "base64"); const end = Number(page.offset) + bytes.length;
        if (bytes.toString("base64") !== page.base64 || bytes.length !== Math.min(RULE_PAGE_BYTES, page.totalBytes - Number(page.offset))
          || page.nextOffset !== (end === page.totalBytes ? null : end)) invalid();
        break;
      }
      default: invalid();
    }
  } else invalid();
  if (!exactKeys(value, keys)) invalid(); bounded(value); return value as unknown as PrivateRuleResponse;
}
function responseBinding(request: PrivateRuleRequest): PrivateRuleBinding {
  return { channel: "private_rules", version: 1, id: request.id, localProfileId: request.localProfileId,
    instanceId: request.instanceId, agentId: request.agentId, chain: request.chain };
}
export function privateRuleSuccess(request: PrivateRuleRequest, data: PrivateRuleData): PrivateRuleResponse {
  return parsePrivateRuleResponse({ ...responseBinding(request), ok: true, data });
}
export function privateRuleFailure(request: PrivateRuleRequest, error: RuleChannelError): PrivateRuleResponse {
  return parsePrivateRuleResponse({ ...responseBinding(request), ok: false, error });
}
