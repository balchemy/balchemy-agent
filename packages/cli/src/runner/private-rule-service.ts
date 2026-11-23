import * as fs from "node:fs";
import type { RunnerBrainObservation } from "@balchemyai/agent-sdk";
import { isId } from "./protocol.js";
import { createHash } from "node:crypto";
import type { BehaviorRules, BehaviorRuleRevision } from "@balchemyai/agent-rules";
import { PrivateRuleStore, PrivateRuleStoreError, PRIVATE_RULE_SNAPSHOT_FILE, PRIVATE_RULE_INITIALIZED_FILE, privateRuleDefaultContext,
  type PrivateRuleStoreOptions, type ProposeRuleInput, type RuleContext } from "./private-rule-store.js";
import { parsePrivateRuleRequest, privateRuleFailure, privateRuleSuccess, RULE_PAGE_BYTES, MAX_RULE_DOCUMENT_BYTES,
  type PrivateRuleRequest, type PrivateRuleResponse, type RuleDocumentPage } from "./private-rule-protocol.js";
import type { RuleHead } from "./private-rule-store.js";
import type { SocketProofRuleProposal } from "./private-socket-proof.js";
import { addRunnerAgent } from "./agent-roster.js";

export interface ConversationRuleView {
  head: RuleHead;
  /** Only private model context, never a server status/telemetry field. */
  current: { exactSource: string; effectiveRules: BehaviorRules; diagnostics: readonly { code: string; message: string; statement?: string }[] } | null;
}
export interface ConversationRuleProposal {
  proposalId: string; chain: "solana" | "base"; state: "compiled" | "held_requires_review" | "invalid"; diagnosticCount: number;
}

/** Whole-document replacement uses a trusted baseline, never the previous head. Neither an IPC client nor a model may
 * supply trusted overrides: the store derives the one trusted context of each proposal kind (an approval setting is a
 * closed off/on enum, never an override value). */
function context(): RuleContext { return privateRuleDefaultContext(); }
export function ruleDocumentPage(documentId: string, value: unknown, offset: number): RuleDocumentPage {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > MAX_RULE_DOCUMENT_BYTES || offset >= bytes.length) throw new PrivateRuleStoreError("invalid_request");
  const end = Math.min(bytes.length, offset + RULE_PAGE_BYTES);
  return { documentId, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, totalBytes: bytes.length,
    offset, base64: bytes.subarray(offset, end).toString("base64"), nextOffset: end === bytes.length ? null : end };
}
export class PrivateRuleService {
  private store?: PrivateRuleStore;
  private unavailable = false;
  private closed = false;
  private readonly options: PrivateRuleStoreOptions & { instanceId: string };
  private readonly agentList: string[];
  constructor(options: PrivateRuleStoreOptions & { instanceId: string }) {
    this.agentList = [...options.agentIds]; this.options = { ...options, agentIds: this.agentList };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon (no rules yet); the open rule store learns
   * the id; every other agent's rules and revisions are untouched. Idempotent; throws (changing nothing) on an invalid id or past 64. */
  addAgent(agentId: string): void { if (addRunnerAgent(this.agentList, agentId)) this.store?.addAgent(agentId); }
  /** Never opens a private store or reads rule contents just to send a heartbeat. */
  observeConfirmedHead(agentId: string): RunnerBrainObservation["rules"] {
    try {
      if (this.closed || this.unavailable || !this.options.agentIds.includes(agentId)) return "unavailable";
      this.options.assertAvailable();
      if (!this.store) {
        const names = fs.readdirSync(this.options.directory);
        const snapshot = names.includes(PRIVATE_RULE_SNAPSHOT_FILE);
        const marker = names.includes(PRIVATE_RULE_INITIALIZED_FILE);
        return snapshot !== marker ? "unavailable" : snapshot ? "not_checked" : "missing";
      }
      const head = this.store.head({ localProfileId: this.options.localProfileId, agentId, chain: "solana" });
      return !head.revisionId ? "missing" : head.state === "compiled" ? "confirmed" : "held";
    } catch { return "unavailable"; }
  }
  /** Daemon-local authoritative revision. This read grants no execution authority. */
  readConfirmedRevision(agentId: string, chain: "solana" | "base"): { head: RuleHead; revision: BehaviorRuleRevision | null } {
    if (this.closed) throw new PrivateRuleStoreError("state_unavailable");
    const scope = { localProfileId: this.options.localProfileId, agentId, chain };
    this.options.assertAvailable();
    if (!isId(this.options.localProfileId) || !this.options.agentIds.includes(agentId) || (chain !== "solana" && chain !== "base"))
      throw new PrivateRuleStoreError("invalid_request");
    if (!this.store && !this.unavailable) {
      const files = fs.readdirSync(this.options.directory);
      if (!files.includes(PRIVATE_RULE_SNAPSHOT_FILE) && !files.includes(PRIVATE_RULE_INITIALIZED_FILE)) {
        // A status read of a never-configured agent must not initialize rules.
        // One-sided loss still opens the normal validator and fails closed.
        return { head: { ...scope, revision: 0, revisionId: null, state: "empty" }, revision: null };
      }
    }
    const store = this.getStore(); const head = store.head(scope);
    return { head, revision: head.revisionId ? store.revision(scope, head.revisionId) : null };
  }
  /** A2a socket gate: the kind of one stored proposal (a rules confirm is classified from it, never from the frame). Throws when the
   * proposal or the store cannot be read (the gate then treats the confirm as raising). */
  readProposalKind(agentId: string, chain: "solana" | "base", proposalId: string): SocketProofRuleProposal {
    if (this.closed) throw new PrivateRuleStoreError("state_unavailable");
    return this.getStore().proposalKind({ localProfileId: this.options.localProfileId, agentId, chain }, proposalId);
  }
  /** A2a authority watermark: the stored proposal kind that produced the confirmed head (null without a head; never initializes rules). */
  readHeadProposalKind(agentId: string, chain: "solana" | "base"): SocketProofRuleProposal | null {
    const { head } = this.readConfirmedRevision(agentId, chain);
    if (!head.revisionId) return null;
    return this.getStore().headProposalKind({ localProfileId: this.options.localProfileId, agentId, chain });
  }
  readForConversation(agentId: string, chain: "solana" | "base"): ConversationRuleView {
    if (this.closed) throw new PrivateRuleStoreError("state_unavailable");
    const scope = { localProfileId: this.options.localProfileId, agentId, chain };
    const store = this.getStore(); const head = store.head(scope);
    const revision = head.revisionId ? store.revision(scope, head.revisionId) : null;
    return { head, current: revision ? { exactSource: revision.source.exactSource, effectiveRules: revision.rules, diagnostics: revision.diagnostics } : null };
  }
  /** A language model may draft a proposal against the head it actually read.
   * It cannot confirm one. The private owner command owns that separate action. */
  proposeForConversation(jobId: string, view: ConversationRuleView, exactSource: string): ConversationRuleProposal {
    if (this.closed) throw new PrivateRuleStoreError("state_unavailable");
    const { head } = view;
    const proposalId = `chat-rule-${createHash("sha256").update(JSON.stringify([head.localProfileId, head.agentId, head.chain, jobId])).digest("hex")}`;
    const proposal = this.getStore().propose({ localProfileId: head.localProfileId, agentId: head.agentId, chain: head.chain,
      expectedRevision: head.revision, expectedRevisionId: head.revisionId, kind: "edit", proposalId, exactSource }, context());
    return { proposalId, chain: head.chain, state: !proposal.validation.valid || proposal.compilation.status === "invalid" ? "invalid"
      : proposal.compilation.status === "compiled" ? "compiled" : "held_requires_review",
      diagnosticCount: proposal.compilation.diagnostics.length };
  }
  handle(value: PrivateRuleRequest): PrivateRuleResponse {
    const request = parsePrivateRuleRequest(value);
    try {
      if (this.closed) return privateRuleFailure(request, "closing");
      if (request.localProfileId !== this.options.localProfileId) return privateRuleFailure(request, "profile_conflict");
      if (request.instanceId !== this.options.instanceId) return privateRuleFailure(request, "instance_conflict");
      if (!this.options.agentIds.includes(request.agentId)) return privateRuleFailure(request, "unknown_agent");
      const scope = { localProfileId: request.localProfileId, agentId: request.agentId, chain: request.chain };
      const store = this.getStore();
      switch (request.action) {
        case "head": return privateRuleSuccess(request, { kind: "head", head: store.head(scope) });
        case "propose": case "rollback": case "approval": {
          const input: ProposeRuleInput = { ...scope, proposalId: request.proposalId, expectedRevision: request.expectedRevision,
            expectedRevisionId: request.expectedRevisionId, ...(request.action === "propose" ? { kind: "edit", exactSource: request.exactSource } as const
              : request.action === "rollback" ? { kind: "rollback", targetRevisionId: request.targetRevisionId } as const
                : { kind: "approval", setting: request.setting } as const) };
          const proposal = store.propose(input, this.trustedContext(store, input));
          return privateRuleSuccess(request, { kind: "proposal", proposalId: proposal.input.proposalId, proposalDigest: proposal.proposalDigest });
        }
        case "proposal_read": return privateRuleSuccess(request, { kind: "page",
          page: ruleDocumentPage(request.proposalId, store.proposal(scope, request.proposalId), request.offset) });
        case "revision_read": return privateRuleSuccess(request, { kind: "page",
          page: ruleDocumentPage(request.revisionId, store.revision(scope, request.revisionId), request.offset) });
        case "confirm": {
          // The context is re-derived from the stored proposal input; the store re-checks it against the proposal.
          let current: RuleContext;
          try { current = this.trustedContext(store, store.proposal(scope, request.proposalId).input); } catch { current = context(); }
          return privateRuleSuccess(request, { kind: "receipt", receipt: store.confirm({ ...scope,
            operationId: request.operationId, proposalId: request.proposalId, proposalDigest: request.proposalDigest,
            expectedRevision: request.expectedRevision, expectedRevisionId: request.expectedRevisionId }, current) });
        }
        case "receipt": return privateRuleSuccess(request, { kind: "receipt", receipt: store.receipt(scope, request.operationId) });
        case "history": return privateRuleSuccess(request, { kind: "history", history: store.history(scope, request.beforeRevision, 10) });
      }
    } catch (error: unknown) { return privateRuleFailure(request, error instanceof PrivateRuleStoreError ? error.code : "state_unavailable"); }
  }
  close(): void { this.closed = true; this.store?.close(); }
  private trustedContext(store: PrivateRuleStore, input: ProposeRuleInput): RuleContext {
    try { return store.trustedContextFor(input); }
    catch (error: unknown) { if (input.kind === "edit") return context(); throw error; }
  }
  private getStore(): PrivateRuleStore {
    if (this.unavailable) throw new PrivateRuleStoreError("state_unavailable");
    if (!this.store) {
      try { this.store = new PrivateRuleStore(this.options); }
      catch { this.unavailable = true; throw new PrivateRuleStoreError("state_unavailable"); }
    }
    return this.store;
  }
}
