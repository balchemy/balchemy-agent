/** Private rule authoring only. Confirmation never arms or authorizes a trade.
 *
 * Trusted compilation contexts are closed: the default baseline with no overrides, or that baseline with the owner's
 * explicit approval-off setting (BEHAVIOR_RULE_APPROVAL_OFF_OVERRIDES). Neither a model, an IPC client nor rule text can
 * supply any other override. An `approval` proposal recompiles the exact source of the head it names under the approval
 * context for its setting, so only the approval fields change; it is confirmed like any other proposal. */
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  BehaviorRuleCompilerService, BEHAVIOR_RULE_APPROVAL_OFF_OVERRIDES, BEHAVIOR_RULE_COMPILER_VERSION, DEFAULT_BEHAVIOR_RULES,
  isBehaviorRuleRevisionIntegrityValid, replayBehaviorRuleCompilation,
  validateBehaviorRules, type BehaviorRuleCompilation, type BehaviorRuleRevision,
  type BehaviorRules, type BehaviorRuleTrustedOverrides,
} from "@balchemyai/agent-rules";
import { exactKeys, isId, isRecord } from "./protocol.js";
import { OwnedJsonSnapshot, OwnedJsonSnapshotError } from "./owned-json-snapshot.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_RULE_SNAPSHOT_FILE = "private-rules.json";
export const PRIVATE_RULE_INITIALIZED_FILE = "private-rules.initialized";
export const MAX_PRIVATE_RULE_RECORDS = 128;
export const MAX_PRIVATE_RULE_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_PRIVATE_RULE_DOCUMENT_BYTES = 256 * 1024;
export interface RuleScope { localProfileId: string; agentId: string; chain: "solana" | "base" }
export interface ExpectedRuleHead { expectedRevision: number; expectedRevisionId: `brr_${string}` | null }
export interface RuleContext { baseRules: BehaviorRules; trustedOverrides: BehaviorRuleTrustedOverrides }
export type PrivateRuleApprovalSetting = "off" | "on";
export type ProposeRuleInput = RuleScope & ExpectedRuleHead & { proposalId: string } & (
  { kind: "edit"; exactSource: string } | { kind: "rollback"; targetRevisionId: `brr_${string}` }
  | { kind: "approval"; setting: PrivateRuleApprovalSetting }
);
/** Whole-document replacement uses this trusted baseline, never the previous head. */
export function privateRuleDefaultContext(): RuleContext {
  return { baseRules: structuredClone(DEFAULT_BEHAVIOR_RULES) as BehaviorRules, trustedOverrides: {} };
}
/** The owner's explicit approval setting: `off` adds exactly the approval-off overrides, `on` restores the defaults. */
export function privateRuleApprovalContext(setting: PrivateRuleApprovalSetting): RuleContext {
  return { baseRules: structuredClone(DEFAULT_BEHAVIOR_RULES) as BehaviorRules,
    trustedOverrides: setting === "off" ? { ...BEHAVIOR_RULE_APPROVAL_OFF_OVERRIDES } : {} };
}
/** True only for one of the two closed trusted contexts. */
export function isTrustedPrivateRuleContext(value: unknown): value is RuleContext {
  try { return equal(value, privateRuleDefaultContext()) || equal(value, privateRuleApprovalContext("off")); } catch { return false; }
}
export interface ConfirmRuleInput extends RuleScope, ExpectedRuleHead {
  operationId: string; proposalId: string; proposalDigest: `sha256:${string}`;
}
export interface RuleProposal {
  input: ProposeRuleInput; context: RuleContext; compilation: BehaviorRuleCompilation;
  validation: { valid: boolean; errors: string[] }; createdAt: number; proposalDigest: `sha256:${string}`;
}
export type ConfirmedRuleState = "compiled" | "held_requires_review";
export interface RuleHead extends RuleScope {
  revision: number; revisionId: `brr_${string}` | null; state: "empty" | ConfirmedRuleState;
  compilerVersion?: string; diagnosticCount?: number;
}
export interface RuleCommitReceipt {
  input: ConfirmRuleInput; revision: number; revisionId: `brr_${string}`;
  state: ConfirmedRuleState; committedAt: number; digest: `sha256:${string}`;
}
export interface RuleRevisionSummary extends RuleScope {
  revision: number; revisionId: `brr_${string}`; parentRevisionId: `brr_${string}` | null;
  state: ConfirmedRuleState; compilerVersion: string; diagnosticCount: number; confirmedAt: number;
}
interface StoredRevision {
  scope: RuleScope; proposalId: string; operationId: string; revision: BehaviorRuleRevision;
  confirmedAt: number; digest: `sha256:${string}`;
}
interface Snapshot {
  schemaVersion: 1; localProfileId: string;
  proposals: RuleProposal[]; revisions: StoredRevision[]; receipts: RuleCommitReceipt[];
}
export type PrivateRuleErrorCode = "invalid_request" | "unknown_agent" | "profile_conflict" | "invalid_chain"
  | "proposal_not_found" | "revision_not_found" | "proposal_conflict" | "operation_conflict"
  | "revision_conflict" | "context_conflict" | "compiler_conflict" | "rules_invalid"
  | "proposal_consumed" | "proposal_too_large" | "journal_full" | "state_unavailable";
export class PrivateRuleStoreError extends Error {
  constructor(readonly code: PrivateRuleErrorCode) { super(`Private rules ${code}`); this.name = "PrivateRuleStoreError"; }
}
export interface PrivateRuleStoreOptions {
  directory: string; localProfileId: string; agentIds: readonly string[]; assertAvailable(): void;
}
function fail(code: PrivateRuleErrorCode): never { throw new PrivateRuleStoreError(code); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const result = JSON.stringify(value); if (result === undefined) fail("invalid_request"); return result;
}
function hash(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical([domain, value]), "utf8").digest("hex")}`;
}
function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function counter(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function revisionId(value: unknown): value is `brr_${string}` { return typeof value === "string" && /^brr_[a-f0-9]{64}$/.test(value); }
function digest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function scopeOf(value: RuleScope): RuleScope { return { localProfileId: value.localProfileId, agentId: value.agentId, chain: value.chain }; }
function sameScope(a: RuleScope, b: RuleScope): boolean { return a.localProfileId === b.localProfileId && a.agentId === b.agentId && a.chain === b.chain; }
function state(revision: BehaviorRuleRevision): ConfirmedRuleState { return revision.compilationStatus === "compiled" ? "compiled" : "held_requires_review"; }
const scopeKeys = ["localProfileId", "agentId", "chain"];
const expectedKeys = ["expectedRevision", "expectedRevisionId"];
const compiler = new BehaviorRuleCompilerService();

export class PrivateRuleStore {
  private readonly options: PrivateRuleStoreOptions;
  private readonly agentList: string[];
  private readonly storage: OwnedJsonSnapshot<Snapshot>;
  private snapshot: Snapshot;

  constructor(options: PrivateRuleStoreOptions) {
    if (!isId(options.localProfileId) || !Array.isArray(options.agentIds) || !options.agentIds.length
      || options.agentIds.length > 64 || options.agentIds.some((id) => !isId(id))
      || new Set(options.agentIds).size !== options.agentIds.length || typeof options.assertAvailable !== "function"
      || typeof options.directory !== "string" || !path.isAbsolute(options.directory)) fail("invalid_request");
    this.agentList = [...options.agentIds]; this.options = { ...options, agentIds: this.agentList };
    this.snapshot = { schemaVersion: 1, localProfileId: options.localProfileId, proposals: [], revisions: [], receipts: [] };
    let storage: OwnedJsonSnapshot<Snapshot> | undefined;
    try {
      storage = new OwnedJsonSnapshot({ directory: options.directory,
        snapshotFile: PRIVATE_RULE_SNAPSHOT_FILE, markerFile: PRIVATE_RULE_INITIALIZED_FILE,
        marker: { schemaVersion: 1, localProfileId: options.localProfileId }, maximumBytes: MAX_PRIVATE_RULE_SNAPSHOT_BYTES,
        initial: this.snapshot, decode: (value) => this.decode(value), assertAvailable: () => options.assertAvailable() });
      this.storage = storage;
      this.snapshot = storage.read();
    } catch { storage?.close(); fail("state_unavailable"); }
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.agentList, agentId); }

  propose(value: ProposeRuleInput, context: RuleContext): RuleProposal {
    const input = this.parseProposalInput(value); this.assertAvailable();
    const previous = this.snapshot.proposals.find((item) => item.input.proposalId === input.proposalId);
    if (previous) {
      if (!equal(previous.input, input)) fail("proposal_conflict");
      return structuredClone(previous);
    }
    this.expectHead(input);
    if (this.snapshot.proposals.length >= MAX_PRIVATE_RULE_RECORDS) fail("journal_full");
    const compilation = this.compileInput(input, context);
    const captured = compilation.source.kind === "natural_language" ? compilation.source.compilationContext : null;
    if (!captured) fail("rules_invalid");
    if (!equal(context, captured)) fail("context_conflict");
    const body = { input, context: captured, compilation, validation: validateBehaviorRules(compilation.rules), createdAt: Date.now() };
    const proposal: RuleProposal = { ...body, proposalDigest: hash("balchemy.private-rule-proposal.v1", body) };
    if (Buffer.byteLength(JSON.stringify(proposal), "utf8") > MAX_PRIVATE_RULE_DOCUMENT_BYTES) fail("proposal_too_large");
    const next = structuredClone(this.snapshot); next.proposals.push(proposal); this.commit(next);
    return structuredClone(proposal);
  }

  confirm(value: ConfirmRuleInput, currentContext: RuleContext): RuleCommitReceipt {
    const input = this.parseConfirmInput(value); this.assertAvailable();
    const previous = this.snapshot.receipts.find((item) => item.input.operationId === input.operationId);
    if (previous) {
      if (!equal(previous.input, input)) fail("operation_conflict");
      return structuredClone(previous);
    }
    const proposal = this.findProposal(input, input.proposalId);
    if (proposal.proposalDigest !== input.proposalDigest) fail("proposal_conflict");
    if (this.snapshot.revisions.some((item) => item.proposalId === input.proposalId)) fail("proposal_consumed");
    if (proposal.input.expectedRevision !== input.expectedRevision || proposal.input.expectedRevisionId !== input.expectedRevisionId) fail("revision_conflict");
    this.expectHead(input);
    if (this.snapshot.revisions.length >= MAX_PRIVATE_RULE_RECORDS || this.snapshot.receipts.length >= MAX_PRIVATE_RULE_RECORDS) fail("journal_full");
    if (proposal.compilation.compilerVersion !== BEHAVIOR_RULE_COMPILER_VERSION) fail("compiler_conflict");
    if (!equal(currentContext, proposal.context)) fail("context_conflict");
    const fresh = this.compileInput(proposal.input, currentContext);
    if (!equal(fresh, proposal.compilation)) fail("context_conflict");
    if (!proposal.validation.valid || !validateBehaviorRules(fresh.rules).valid) fail("rules_invalid");
    const nextRevision = input.expectedRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) fail("revision_conflict");
    const transition = { revision: nextRevision, parentRevisionId: input.expectedRevisionId, chain: input.chain };
    const revision = proposal.input.kind === "rollback"
      ? compiler.reissueRevision(this.findRevision(input, proposal.input.targetRevisionId).revision, transition)
      : compiler.createRevision(fresh, transition);
    if (!isBehaviorRuleRevisionIntegrityValid(revision)) fail("rules_invalid");
    if (Buffer.byteLength(JSON.stringify(revision), "utf8") > MAX_PRIVATE_RULE_DOCUMENT_BYTES) fail("proposal_too_large");
    const confirmedAt = Math.max(Date.now(), proposal.createdAt);
    const recordBody = { scope: scopeOf(input), proposalId: input.proposalId, operationId: input.operationId, revision, confirmedAt };
    const receiptBody = { input, revision: revision.revision, revisionId: revision.revisionId, state: state(revision), committedAt: confirmedAt };
    const receipt: RuleCommitReceipt = { ...receiptBody, digest: hash("balchemy.private-rule-receipt.v1", receiptBody) };
    const next = structuredClone(this.snapshot);
    next.revisions.push({ ...recordBody, digest: hash("balchemy.private-rule-record.v1", recordBody) });
    next.receipts.push(receipt); this.commit(next); return structuredClone(receipt);
  }

  head(scope: RuleScope): RuleHead {
    this.checkScope(scope); this.assertAvailable();
    const found = this.snapshot.revisions.filter((item) => sameScope(item.scope, scope)).at(-1);
    return found ? { ...scopeOf(scope), revision: found.revision.revision, revisionId: found.revision.revisionId,
      state: state(found.revision), compilerVersion: found.revision.compilerVersion, diagnosticCount: found.revision.diagnostics.length }
      : { ...scopeOf(scope), revision: 0, revisionId: null, state: "empty" };
  }
  /** Daemon-private owner authoring data; never companion/status output. */
  proposal(scope: RuleScope, id: string): RuleProposal {
    this.checkScope(scope); this.assertAvailable(); return structuredClone(this.findProposal(scope, id));
  }
  /** A2a (socket proof and authority watermark): the kind of one STORED proposal; the setting for an approval proposal. Throws
   * `proposal_not_found` like `proposal()`. */
  proposalKind(scope: RuleScope, id: string): { kind: "edit" | "rollback" } | { kind: "approval"; setting: PrivateRuleApprovalSetting } {
    this.checkScope(scope); this.assertAvailable();
    const input = this.findProposal(scope, id).input;
    return input.kind === "approval" ? { kind: "approval", setting: input.setting } : { kind: input.kind };
  }
  /** A2a authority watermark: the stored proposal kind that produced the confirmed head, or null when there is no head. A head whose
   * proposal record is missing throws `proposal_not_found` (the caller fails closed). */
  headProposalKind(scope: RuleScope): { kind: "edit" | "rollback" } | { kind: "approval"; setting: PrivateRuleApprovalSetting } | null {
    this.checkScope(scope); this.assertAvailable();
    const found = this.snapshot.revisions.filter((item) => sameScope(item.scope, scope)).at(-1);
    return found ? this.proposalKind(scope, found.proposalId) : null;
  }
  /** Daemon-private owner rule source; never companion/status output. */
  revision(scope: RuleScope, id: string): BehaviorRuleRevision {
    this.checkScope(scope); this.assertAvailable(); return structuredClone(this.findRevision(scope, id).revision);
  }
  receipt(scope: RuleScope, id: string): RuleCommitReceipt | null {
    this.checkScope(scope); this.assertAvailable(); if (!isId(id)) fail("invalid_request");
    return structuredClone(this.snapshot.receipts.find((item) => item.input.operationId === id && sameScope(item.input, scope)) ?? null);
  }
  history(scope: RuleScope, beforeRevision: number | null = null, limit = 20): RuleRevisionSummary[] {
    this.checkScope(scope); this.assertAvailable();
    if ((beforeRevision !== null && (!counter(beforeRevision) || beforeRevision < 1)) || !counter(limit) || limit > 50) fail("invalid_request");
    return this.snapshot.revisions.filter((item) => sameScope(item.scope, scope)
      && (beforeRevision === null || item.revision.revision < beforeRevision)).reverse().slice(0, limit).map((item) => ({
        ...scopeOf(scope), revision: item.revision.revision, revisionId: item.revision.revisionId,
        parentRevisionId: item.revision.parentRevisionId, state: state(item.revision), compilerVersion: item.revision.compilerVersion,
        diagnosticCount: item.revision.diagnostics.length, confirmedAt: item.confirmedAt,
      }));
  }
  assertAvailable(): void { try { this.storage.assertAvailable(); } catch { fail("state_unavailable"); } }
  close(): void { this.storage.close(); }

  private checkScope(value: unknown): asserts value is RuleScope {
    if (!isRecord(value) || !exactKeys(value, scopeKeys) || !isId(value.localProfileId) || !isId(value.agentId)) fail("invalid_request");
    if (value.localProfileId !== this.options.localProfileId) fail("profile_conflict");
    if (!this.options.agentIds.includes(value.agentId)) fail("unknown_agent");
    if (value.chain !== "solana" && value.chain !== "base") fail("invalid_chain");
  }
  private expected(value: Record<string, unknown>): void {
    if (!counter(value.expectedRevision) || (value.expectedRevision === 0 ? value.expectedRevisionId !== null : !revisionId(value.expectedRevisionId))) fail("invalid_request");
  }
  private parseProposalInput(value: unknown): ProposeRuleInput {
    if (!isRecord(value) || (value.kind !== "edit" && value.kind !== "rollback" && value.kind !== "approval") || !isId(value.proposalId)
      || !exactKeys(value, [...scopeKeys, ...expectedKeys, "proposalId", "kind",
        value.kind === "edit" ? "exactSource" : value.kind === "rollback" ? "targetRevisionId" : "setting"])) fail("invalid_request");
    this.checkScope(scopeOf(value as unknown as RuleScope)); this.expected(value);
    if (value.kind === "edit") {
      if (typeof value.exactSource !== "string" || !value.exactSource.trim() || value.exactSource.length > 8000
        || Buffer.byteLength(JSON.stringify(value.exactSource), "utf8") > 8192
        || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value.exactSource)
        || Buffer.from(value.exactSource, "utf8").toString("utf8") !== value.exactSource) fail("invalid_request");
    } else if (value.kind === "rollback") { if (!revisionId(value.targetRevisionId)) fail("invalid_request"); }
    else if ((value.setting !== "off" && value.setting !== "on") || value.expectedRevision === 0) fail("invalid_request");
    return structuredClone(value) as unknown as ProposeRuleInput;
  }
  private parseConfirmInput(value: unknown): ConfirmRuleInput {
    if (!isRecord(value) || !exactKeys(value, [...scopeKeys, ...expectedKeys, "operationId", "proposalId", "proposalDigest"])
      || !isId(value.operationId) || !isId(value.proposalId) || !digest(value.proposalDigest)) fail("invalid_request");
    this.checkScope(scopeOf(value as unknown as RuleScope)); this.expected(value);
    return structuredClone(value) as unknown as ConfirmRuleInput;
  }
  private expectHead(input: RuleScope & ExpectedRuleHead): void {
    const current = this.head(scopeOf(input));
    if (current.revision !== input.expectedRevision || current.revisionId !== input.expectedRevisionId) fail("revision_conflict");
  }
  private findProposal(scope: RuleScope, id: string): RuleProposal {
    if (!isId(id)) fail("invalid_request");
    const found = this.snapshot.proposals.find((item) => item.input.proposalId === id && sameScope(item.input, scope));
    if (!found) fail("proposal_not_found"); return found;
  }
  private findRevision(scope: RuleScope, id: string): StoredRevision {
    if (!revisionId(id)) fail("invalid_request");
    const found = this.snapshot.revisions.find((item) => item.revision.revisionId === id && sameScope(item.scope, scope));
    if (!found) fail("revision_not_found"); return found;
  }
  /** The one trusted context for a proposal input: default for an edit, the approval context for its setting, and the
   * target revision's own (trusted) context for a rollback. Callers pass it back; propose/confirm re-check it. */
  trustedContextFor(value: ProposeRuleInput): RuleContext {
    const input = this.parseProposalInput(value); this.assertAvailable();
    if (input.kind === "edit") return privateRuleDefaultContext();
    if (input.kind === "approval") return privateRuleApprovalContext(input.setting);
    const target = this.findRevision(input, input.targetRevisionId).revision;
    const captured = target.source.kind === "natural_language" ? target.source.compilationContext : null;
    if (!isTrustedPrivateRuleContext(captured)) fail("context_conflict");
    return structuredClone(captured);
  }
  private compileInput(input: ProposeRuleInput, context: RuleContext): BehaviorRuleCompilation {
    if (!isRecord(context) || !exactKeys(context, ["baseRules", "trustedOverrides"]) || Buffer.byteLength(canonical(context), "utf8") > 64 * 1024) fail("invalid_request");
    if (!isTrustedPrivateRuleContext(context)) fail("context_conflict");
    if (input.kind === "approval" && !equal(context, privateRuleApprovalContext(input.setting))) fail("context_conflict");
    if (input.kind === "edit" && !equal(context, privateRuleDefaultContext())) fail("context_conflict");
    const target = input.kind === "rollback" ? this.findRevision(input, input.targetRevisionId).revision : null;
    if (target && target.compilerVersion !== BEHAVIOR_RULE_COMPILER_VERSION) fail("compiler_conflict");
    // An approval change keeps the exact source of the head it was proposed against; only the approval fields change.
    if (input.kind === "approval" && input.expectedRevisionId === null) fail("revision_not_found");
    const parent = input.kind === "approval" ? this.findRevision(input, input.expectedRevisionId!).revision : null;
    if (parent && parent.source.kind !== "natural_language") fail("rules_invalid");
    let compilation: BehaviorRuleCompilation;
    try { compilation = compiler.compileNaturalLanguage(input.kind === "edit" ? input.exactSource : (target ?? parent)!.source.exactSource,
      context.baseRules, input.chain, context.trustedOverrides); }
    catch { fail("rules_invalid"); }
    if (target && (!isBehaviorRuleRevisionIntegrityValid(target) || !equal(compilation, this.compilationOf(target)))) fail("context_conflict");
    return compilation;
  }
  private compilationOf(revision: BehaviorRuleRevision): BehaviorRuleCompilation {
    return { compilerVersion: revision.compilerVersion, status: revision.compilationStatus, chain: revision.chain,
      source: revision.source, rules: revision.rules, rulesDigest: revision.rulesDigest, compiled: revision.compiled,
      compiledDigest: revision.compiledDigest, diagnostics: revision.diagnostics };
  }
  private commit(next: Snapshot): void {
    try { this.storage.commit(next); this.snapshot = next; }
    catch (error: unknown) {
      if (error instanceof OwnedJsonSnapshotError && error.code === "snapshot_too_large") fail("journal_full");
      fail("state_unavailable");
    }
  }

  private decode(value: unknown): Snapshot {
    if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId", "proposals", "revisions", "receipts"])
      || value.schemaVersion !== 1 || value.localProfileId !== this.options.localProfileId
      || !Array.isArray(value.proposals) || !Array.isArray(value.revisions) || !Array.isArray(value.receipts)
      || [value.proposals, value.revisions, value.receipts].some((items) => items.length > MAX_PRIVATE_RULE_RECORDS)) fail("state_unavailable");
    const proposals: RuleProposal[] = []; const ids = new Set<string>();
    for (const raw of value.proposals) {
      if (!isRecord(raw) || !exactKeys(raw, ["input", "context", "compilation", "validation", "createdAt", "proposalDigest"])
        || !counter(raw.createdAt) || !digest(raw.proposalDigest) || !isRecord(raw.context)
        || !exactKeys(raw.context, ["baseRules", "trustedOverrides"])
        || Buffer.byteLength(canonical(raw.context), "utf8") > 64 * 1024
        || Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_PRIVATE_RULE_DOCUMENT_BYTES) fail("state_unavailable");
      const input = this.parseProposalInput(raw.input);
      if (ids.has(input.proposalId)) fail("state_unavailable"); ids.add(input.proposalId);
      const candidate = raw as unknown as RuleProposal;
      if (!isTrustedPrivateRuleContext(candidate.context)
        || (input.kind === "approval" && !equal(candidate.context, privateRuleApprovalContext(input.setting)))
        || (input.kind === "edit" && !equal(candidate.context, privateRuleDefaultContext()))) fail("state_unavailable");
      const source = candidate.compilation?.source;
      if (source?.kind !== "natural_language" || (input.kind === "edit" && source.exactSource !== input.exactSource)) fail("state_unavailable");
      // Readback validates the exact historical compiler without upgrading or
      // rewriting accepted bytes. New confirmation still requires current code.
      const compilation = replayBehaviorRuleCompilation(candidate.compilation);
      if (compilation.chain !== input.chain) fail("state_unavailable");
      if (!equal(compilation, candidate.compilation) || !equal(compilation.source.kind === "natural_language" ? compilation.source.compilationContext : null, candidate.context)
        || !equal(validateBehaviorRules(compilation.rules), candidate.validation)) fail("state_unavailable");
      const { proposalDigest, ...body } = candidate;
      if (proposalDigest !== hash("balchemy.private-rule-proposal.v1", body)) fail("state_unavailable");
      proposals.push(candidate);
    }
    const revisions: StoredRevision[] = []; const operations = new Set<string>(); const consumed = new Set<string>();
    for (const raw of value.revisions) {
      if (!isRecord(raw) || !exactKeys(raw, ["scope", "proposalId", "operationId", "revision", "confirmedAt", "digest"])
        || !counter(raw.confirmedAt) || !digest(raw.digest) || !isId(raw.proposalId) || !isId(raw.operationId)) fail("state_unavailable");
      this.checkScope(raw.scope); const item = raw as unknown as StoredRevision;
      const proposal = proposals.find((entry) => entry.input.proposalId === item.proposalId && sameScope(entry.input, item.scope));
      const prior = revisions.filter((entry) => sameScope(entry.scope, item.scope)).at(-1)?.revision;
      if (!proposal || !proposal.validation.valid || consumed.has(item.proposalId) || operations.has(item.operationId)
        || proposal.input.expectedRevision !== (prior?.revision ?? 0) || proposal.input.expectedRevisionId !== (prior?.revisionId ?? null)
        || item.confirmedAt < proposal.createdAt) fail("state_unavailable");
      const canonicalRevision = compiler.createRevision(proposal.compilation, { revision: (prior?.revision ?? 0) + 1,
        parentRevisionId: prior?.revisionId ?? null, chain: item.scope.chain });
      if (!equal(canonicalRevision, item.revision) || !isBehaviorRuleRevisionIntegrityValid(item.revision)
        || Buffer.byteLength(JSON.stringify(item.revision), "utf8") > MAX_PRIVATE_RULE_DOCUMENT_BYTES) fail("state_unavailable");
      if (proposal.input.kind === "rollback") {
        const targetId = proposal.input.targetRevisionId;
        const target = revisions.find((entry) => entry.revision.revisionId === targetId && sameScope(entry.scope, item.scope));
        if (!target || target.revision.revision > proposal.input.expectedRevision
          || !equal(this.compilationOf(target.revision), proposal.compilation)) fail("state_unavailable");
      }
      const { digest: recordDigest, ...body } = item;
      if (recordDigest !== hash("balchemy.private-rule-record.v1", body)) fail("state_unavailable");
      operations.add(item.operationId); consumed.add(item.proposalId); revisions.push(item);
    }
    const receipts: RuleCommitReceipt[] = []; const receiptIds = new Set<string>();
    for (const raw of value.receipts) {
      if (!isRecord(raw) || !exactKeys(raw, ["input", "revision", "revisionId", "state", "committedAt", "digest"])) fail("state_unavailable");
      const input = this.parseConfirmInput(raw.input); const item = raw as unknown as RuleCommitReceipt;
      const record = revisions.find((entry) => entry.operationId === input.operationId && sameScope(entry.scope, input));
      const proposal = proposals.find((entry) => entry.input.proposalId === input.proposalId && sameScope(entry.input, input));
      if (!record || !proposal || receiptIds.has(input.operationId) || record.proposalId !== input.proposalId
        || input.proposalDigest !== proposal.proposalDigest || input.expectedRevision !== proposal.input.expectedRevision
        || input.expectedRevisionId !== proposal.input.expectedRevisionId || item.revision !== record.revision.revision
        || item.revisionId !== record.revision.revisionId || item.state !== state(record.revision) || item.committedAt !== record.confirmedAt) fail("state_unavailable");
      const { digest: receiptDigest, ...body } = item;
      if (receiptDigest !== hash("balchemy.private-rule-receipt.v1", body)) fail("state_unavailable");
      receiptIds.add(input.operationId); receipts.push(item);
    }
    if (receipts.length !== revisions.length) fail("state_unavailable");
    for (const proposal of proposals) {
      if (proposal.input.expectedRevision > 0 && !revisions.some((item) => sameScope(item.scope, proposal.input)
        && item.revision.revision === proposal.input.expectedRevision && item.revision.revisionId === proposal.input.expectedRevisionId)) fail("state_unavailable");
      if (proposal.input.kind === "rollback") {
        const targetId = proposal.input.targetRevisionId;
        const target = revisions.find((item) => sameScope(item.scope, proposal.input) && item.revision.revisionId === targetId);
        if (!target || target.revision.revision > proposal.input.expectedRevision
          || !equal(this.compilationOf(target.revision), proposal.compilation)) fail("state_unavailable");
      }
      if (proposal.input.kind === "approval") {
        const parentId = proposal.input.expectedRevisionId;
        const parent = revisions.find((item) => sameScope(item.scope, proposal.input) && item.revision.revisionId === parentId);
        if (!parent || parent.revision.source.exactSource !== proposal.compilation.source.exactSource) fail("state_unavailable");
      }
    }
    return { schemaVersion: 1, localProfileId: this.options.localProfileId, proposals, revisions, receipts };
  }
}
