/** Explicit owner authoring on the private socket; never model approval or execution.
 *
 * `rules <agent> <chain> approval off|on` is the one deterministic owner setting for trade approval (never inferred from
 * rule text): it proposes the current confirmed revision's exact source again with only the approval fields changed,
 * shows that diff, and is confirmed with a typed phrase in a real terminal. Turning approval off (or any confirmation that
 * makes the effective policy automatic, such as a rollback) requires `APPROVAL OFF <agent>`. Confirming rules of an armed
 * agent pauses its new entries while the rules are saved (daemon, private-change-entries.ts); they resume when the new rules still
 * allow automatic entries, and exits keep running throughout. */
import * as readline from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { BehaviorRuleCompilerService, coachBehaviorRuleCompilation, isBehaviorRuleRevisionIntegrityValid,
  validateBehaviorRules, type BehaviorRuleCompilation, type BehaviorRuleRevision, type BehaviorRules } from "@balchemyai/agent-rules";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { readPrivateBrainTarget } from "./private-brain-client.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { privateRuleBinding, readPrivateRuleDocument, requestPrivateRule, PrivateRuleRequestError, PrivateRuleTransportError,
  type PrivateRuleTarget, type PrivateRuleTransport } from "./private-rule-client.js";
import { parsePrivateRuleRequest, parsePrivateRuleResponse, isRuleDigest, isRuleRevisionId, isRuleSource,
  type PrivateRuleRequest, type PrivateRuleData } from "./private-rule-protocol.js";
import { exactKeys, isId, isRecord } from "./protocol.js";
import { PRIVATE_EXECUTION_CAPABILITIES } from "./private-execution-gate.js";
import { parsePrivateChangeEntries, privateChangeEntriesLines, PRIVATE_CHANGE_UNSAVED_TEXT, type PrivateChangeEntries } from "./private-change-entries.js";
import { isTrustedPrivateRuleContext, privateRuleApprovalContext, privateRuleDefaultContext,
  type RuleProposal, type RuleHead, type RuleCommitReceipt, type RuleScope, type RuleContext } from "./private-rule-store.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, terminalSocketProofSecret, type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";

export type RuleCommand = { agentId: string; chain: "solana" | "base" } & (
  { action: "status" } | { action: "show" } | { action: "edit" } | { action: "review"; proposalId: string }
  | { action: "rollback"; revisionId: `brr_${string}` } | { action: "receipt"; operationId: string }
  | { action: "approval"; setting: "off" | "on" }
  | { action: "history"; beforeRevision: number | null }
);
export interface RulePrompt {
  readonly closed: boolean;
  source(): Promise<string | null>;
  /** True only for the exact phrase or one of the exact alternates (such as the full operation ID). */
  confirm(phrase: string, alternates?: readonly string[]): Promise<boolean>;
  close(): void;
  /** A2a (optional): a hidden field for the trading-wallet socket proof, asked only when the daemon answers `proof_required` after the
   * typed confirmation (the cockpit card's). The readline CLI prompt has none: the command then opens a raw-mode prompt once it is closed. */
  secret?(label: string): Promise<string | null>;
}
/** A1 review line of a changed rule path the plain review has no sentence for (cockpit-setup.ts setupProposalReview). Owner decision of
 * 23 Nov 2026: a review that shows such a line BLOCKS the confirmation (no typed phrase is asked, nothing is sent). */
export const PRIVATE_RULE_REVIEW_UNDESCRIBED = "A rule this review cannot describe yet: ";
export const PRIVATE_RULE_UNDESCRIBED_BLOCKED = "These rules contain a rule this review cannot describe in plain words (named above), so they cannot be "
  + "confirmed here. Nothing was changed. Write the directive without that part; the full rule document stays reviewable outside the cockpit "
  + "with the runner's rules command.";
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHAT_RULE_ID = /^chat-rule-([0-9a-f]{64})$/;
/** The typed confirmation of one operation (owner decision of 16 Nov 2026). For a random UUID or a chat-drafted proposal's
 * hash ID it is `CONFIRM` and the first 8 characters of the random or hash part (as pairing does), and the whole ID is also
 * accepted. Any other ID shape has no unique short form, so its whole ID is required. */
export function operationConfirmation(id: string): { phrase: string; alternates: readonly string[] } {
  const full = `CONFIRM ${id}`;
  const unique = UUID_ID.test(id) ? id : CHAT_RULE_ID.exec(id)?.[1];
  return unique ? { phrase: `CONFIRM ${unique.slice(0, 8)}`, alternates: [full] } : { phrase: full, alternates: [] };
}
export interface RuleCommandOptions {
  args: string[]; directory: string; interactive: boolean;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  write(text: string): void | Promise<void>;
  transport?: PrivateRuleTransport;
  resolveTarget?(agentId: string, chain: "solana" | "base"): PrivateRuleTarget;
  createPrompt?(): RulePrompt;
  /** Phase 2, cockpit cards only: checks an edit proposal after its review and before its typed confirmation. A returned text
   * blocks the confirmation (it is shown; nothing is confirmed). Approval and rollback proposals are never passed here. */
  beforeConfirm?(proposal: RuleProposal): string | undefined;
  /** A1, cockpit cards only: a code-built plain review of the validated proposal replaces the raw JSON preview and the field diff, and
   * the CLI-only lines (proposal and operation IDs with their commands) are not written. Display only: the checks, the typed phrase and
   * the confirmation are unchanged. Without it (the CLI command) the output is unchanged; `--json` keeps the raw documents. */
  review?(proposal: RuleProposal, parent: BehaviorRuleRevision | null): string;
  /** A2a socket proof of a raising confirm (asked only on `proof_required`, after the typed phrase). Undefined: the prompt's own hidden
   * field (the CLI: a raw-mode prompt once its readline prompt is closed); null: no prompt here. */
  proofSecret?: SocketProofSecret | null;
  walletTransport?: PrivateTradingWalletTransport;
}
/** The owner-facing refusal when a rule text states no stop-loss of its own (owner decision of 19 Nov 2026: a missing stop-loss blocks
 * the cockpit's rules confirmation). The base default (-30%) hides a missing clause, so the coach's stop-loss source decides. */
export const PRIVATE_RULE_STOP_LOSS_REQUIRED = "These rules state no stop-loss. A stop-loss is required before the rules can be confirmed: "
  + "add one, for example \"stop loss at 15%\". Nothing was confirmed.";
export function privateRuleStopLossRefusal(compilation: BehaviorRuleCompilation): string | undefined {
  try {
    const coach = coachBehaviorRuleCompilation(compilation);
    return coach.stopLoss.source === "owner_clause" || coach.stopLoss.source === "structured" ? undefined : PRIVATE_RULE_STOP_LOSS_REQUIRED;
  } catch { return "The stop-loss of these rules could not be checked. Nothing was confirmed."; }
}
export interface RuleCommandResult { kind: string; [key: string]: unknown }
function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid private rule command",
    cause: "Use an explicit agent and solana or base, followed by show, edit, review <proposal-id>, history [before-revision], rollback <revision-id>, receipt <operation-id>, or approval off|on.",
    fix: "Rule text is entered only in the interactive edit prompt. Extra arguments, --yes, --force and --quiet are not supported.", exitCode: 2 });
}
export function parseRuleCommandArguments(args: string[]): RuleCommand {
  const [agentId, chain, action = "status", value] = args;
  if (!isId(agentId) || (chain !== "solana" && chain !== "base")) invalid();
  const scope: { agentId: string; chain: "solana" | "base" } = { agentId, chain };
  if (["status", "show", "edit"].includes(action) && args.length === (action === "status" && args.length === 2 ? 2 : 3))
    return { ...scope, action: action as "status" | "show" | "edit" };
  if (action === "review" && args.length === 4 && isId(value)) return { ...scope, action, proposalId: value };
  if (action === "rollback" && args.length === 4 && isRuleRevisionId(value)) return { ...scope, action, revisionId: value };
  if (action === "receipt" && args.length === 4 && isId(value)) return { ...scope, action, operationId: value };
  if (action === "approval" && args.length === 4 && (value === "off" || value === "on")) return { ...scope, action, setting: value };
  if (action === "history" && (args.length === 3 || (args.length === 4 && /^[1-9][0-9]*$/.test(value ?? "")
    && Number.isSafeInteger(Number(value))))) return { ...scope, action, beforeRevision: value === undefined ? null : Number(value) };
  invalid();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const result = JSON.stringify(value); if (result === undefined) throw new PrivateRuleTransportError("invalid_document"); return result;
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function digest(domain: string, value: unknown): string { return `sha256:${createHash("sha256").update(canonical([domain, value])).digest("hex")}`; }
function scope(target: PrivateRuleTarget): RuleScope { return { localProfileId: target.localProfileId, agentId: target.agentId, chain: target.chain }; }
/** The one context a proposal of this kind may carry (rollback: any closed trusted context, checked against its target). */
function expectedContext(input: Record<string, unknown>, context: unknown): RuleContext {
  if (input.kind === "edit") return privateRuleDefaultContext();
  if (input.kind === "approval") return privateRuleApprovalContext(input.setting === "off" ? "off" : "on");
  if (!isTrustedPrivateRuleContext(context)) throw new Error("context");
  return structuredClone(context);
}

/** Effective trade approval of a validated revision or proposal compilation (compiler 1.2.0 records it explicitly). */
export type PrivateRuleApprovalView = "automatic_within_limits" | "approval_required";
export function privateRuleApproval(compiled: { approvalPolicy?: { mode?: unknown } } | undefined, rules: BehaviorRules): PrivateRuleApprovalView {
  return compiled?.approvalPolicy?.mode === "automatic_within_limits" && rules.personality.confirmBeforeTrade === false
    && rules.risk.requireApprovalAboveUsd === undefined && rules.risk.requireApprovalForNewTokens !== true
    ? "automatic_within_limits" : "approval_required";
}
const APPROVAL_PATHS = new Set(["personality.confirmBeforeTrade", "risk.requireApprovalAboveUsd", "risk.requireApprovalForNewTokens"]);
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (isRecord(value)) { for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, out); return; }
  out.set(prefix, JSON.stringify(value));
}
/** Every changed effective-rule field between two rule sets, as `path: before -> after` (absent fields shown as "absent"). */
export function privateRuleDiff(before: BehaviorRules | null, after: BehaviorRules): Array<{ path: string; before: string; after: string }> {
  const a = new Map<string, string>(); const b = new Map<string, string>();
  if (before) flatten(before, "", a); flatten(after, "", b);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((key) => a.get(key) !== b.get(key))
    .map((path) => ({ path, before: a.get(path) ?? "absent", after: b.get(path) ?? "absent" }));
}

/** Validate the whole immutable document before displaying any private source. */
export function validateRuleProposal(value: unknown, target: PrivateRuleTarget, proposalId: string, expectedDigest?: string): RuleProposal {
  try {
    if (!isRecord(value) || !exactKeys(value, ["input", "context", "compilation", "validation", "createdAt", "proposalDigest"])
      || !isRecord(value.input) || !isRecord(value.compilation) || !isRuleDigest(value.proposalDigest)
      || (expectedDigest !== undefined && value.proposalDigest !== expectedDigest)
      || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) throw new Error("shape");
    const input = value.input;
    const keys = ["localProfileId", "agentId", "chain", "proposalId", "kind", "expectedRevision", "expectedRevisionId"];
    if ((input.kind !== "edit" && input.kind !== "rollback" && input.kind !== "approval") || input.proposalId !== proposalId
      || !same({ localProfileId: input.localProfileId, agentId: input.agentId, chain: input.chain }, scope(target))
      || !exactKeys(input, [...keys, input.kind === "edit" ? "exactSource" : input.kind === "rollback" ? "targetRevisionId" : "setting"])) throw new Error("binding");
    const base = { ...privateRuleBinding(target), proposalId, expectedRevision: input.expectedRevision, expectedRevisionId: input.expectedRevisionId };
    parsePrivateRuleRequest(input.kind === "edit" ? { ...base, action: "propose", exactSource: input.exactSource }
      : input.kind === "rollback" ? { ...base, action: "rollback", targetRevisionId: input.targetRevisionId }
        : { ...base, action: "approval", setting: input.setting });
    const context = expectedContext(input, value.context);
    if (!isRecord(value.compilation.source) || value.compilation.source.kind !== "natural_language"
      || !isRuleSource(value.compilation.source.exactSource)
      || (input.kind === "edit" && input.exactSource !== value.compilation.source.exactSource)
      || !same(value.context, context)) throw new Error("context");
    const compilation = new BehaviorRuleCompilerService().compileNaturalLanguage(value.compilation.source.exactSource,
      context.baseRules, target.chain, context.trustedOverrides);
    if (!same(compilation, value.compilation) || !same(validateBehaviorRules(compilation.rules), value.validation)) throw new Error("compilation");
    const { proposalDigest, ...body } = value;
    if (proposalDigest !== digest("balchemy.private-rule-proposal.v1", body)) throw new Error("digest");
    return structuredClone(value) as unknown as RuleProposal;
  } catch { throw new PrivateRuleTransportError("invalid_document"); }
}
function validateRevision(value: unknown, target: PrivateRuleTarget, revisionId: string): BehaviorRuleRevision {
  try {
    if (!isRecord(value)) throw new Error("shape");
    const revision = value as unknown as BehaviorRuleRevision;
    if (!isBehaviorRuleRevisionIntegrityValid(revision) || revision.chain !== target.chain || revision.revisionId !== revisionId
      || revision.source.kind !== "natural_language" || !isRuleSource(revision.source.exactSource)
      || !isTrustedPrivateRuleContext(revision.source.compilationContext) || !validateBehaviorRules(revision.rules).valid) throw new Error("revision");
    return structuredClone(revision);
  } catch { throw new PrivateRuleTransportError("invalid_document"); }
}
/** JSON keeps control characters escaped. Make invisible direction controls visible too. */
export function privateRuleJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
const APPROVAL_TEXT: Readonly<Record<PrivateRuleApprovalView, string>> = Object.freeze({
  approval_required: "approval required (an armed agent cannot trade; in-app approval is not available yet)",
  automatic_within_limits: "automatic within your per-trade and daily caps (no per-trade approval)",
});
function yesNo(value: boolean): string { return value ? "yes" : "no"; }
function approvalLines(rules: BehaviorRules): string[] {
  return [`  Confirm before every trade: ${yesNo(rules.personality.confirmBeforeTrade)}`,
    `  Approval above a USD amount: ${rules.risk.requireApprovalAboveUsd === undefined ? "none" : `$${rules.risk.requireApprovalAboveUsd}`}`,
    `  Approval for new tokens: ${yesNo(rules.risk.requireApprovalForNewTokens === true)}`];
}
/** The approval diff shown before every confirmation: the effective policy before and after, and every changed field. */
function approvalDiff(proposal: RuleProposal, head: BehaviorRuleRevision | null): string {
  const before = head ? privateRuleApproval(head.compiled, head.rules) : null;
  const after = privateRuleApproval(proposal.compilation.compiled, proposal.compilation.rules);
  const changes = privateRuleDiff(head?.rules ?? null, proposal.compilation.rules);
  const lines = [`Trade approval: ${before ? APPROVAL_TEXT[before] : "no confirmed rules"} -> ${APPROVAL_TEXT[after]}`];
  if (head) lines.push(`Before (revision ${head.revision}):`, ...approvalLines(head.rules));
  lines.push("After:", ...approvalLines(proposal.compilation.rules));
  if (proposal.input.kind === "approval") {
    lines.push(`Rule text: unchanged (the exact source of revision ${proposal.input.expectedRevision}).`,
      changes.every((item) => APPROVAL_PATHS.has(item.path)) ? "Only approval fields change; every other effective rule is identical."
        : "Other effective rules would change too. Confirmation is blocked.");
  }
  lines.push(changes.length === 0 ? "Effective rule changes: none." : "Effective rule changes:",
    ...changes.map((item) => `  ${item.path}: ${item.before} -> ${item.after}`));
  return `${lines.join("\n")}\n`;
}
function preview(proposal: RuleProposal): string {
  if (proposal.input.kind === "approval") {
    return [`Private approval setting proposal ${proposal.input.proposalId}`, `Agent: ${proposal.input.agentId}   Chain: ${proposal.input.chain}`,
      `Base revision: ${proposal.input.expectedRevision}   Digest: ${proposal.proposalDigest}`,
      !proposal.validation.valid ? "Validation failed. This proposal cannot be confirmed."
        : proposal.compilation.status === "compiled" ? "Compilation: compiled." : "Compilation: requires review. Confirmation stores a HELD head; unresolved clauses never execute.",
      `Approval setting: ${proposal.input.setting} (an explicit owner setting; rule text never changes it).`,
      "Complete compiled approval policy:", privateRuleJson(proposal.compilation.compiled.approvalPolicy ?? null),
      "Rule storage only. No activation, trading or arming is performed.", ""].join("\n");
  }
  return [`Private rule proposal ${proposal.input.proposalId}`, `Agent: ${proposal.input.agentId}   Chain: ${proposal.input.chain}`,
    `Base revision: ${proposal.input.expectedRevision}   Digest: ${proposal.proposalDigest}`,
    !proposal.validation.valid ? "Validation failed. This proposal cannot be confirmed."
      : proposal.compilation.status === "compiled" ? "Compilation: compiled." : "Compilation: requires review. Confirmation stores a HELD head; unresolved clauses never execute.",
    "This replaces the entire rule document. The baseline below is explicit; previous clauses and the approval setting are not inherited.",
    "Exact source (JSON preserves every character):", privateRuleJson(proposal.compilation.source.exactSource),
    "Complete baseline and trusted overrides:", privateRuleJson(proposal.context),
    "Complete effective rules:", privateRuleJson(proposal.compilation.rules),
    "Complete compiled artifacts and execution projection:", privateRuleJson(proposal.compilation.compiled),
    "Complete diagnostics:", privateRuleJson(proposal.compilation.diagnostics),
    "Strict rule validation:", privateRuleJson(proposal.validation),
    "Rule storage only. No activation, trading or arming is performed.", ""].join("\n");
}

/** One readline owner. Input typed during reads/output is discarded, not queued as approval. */
export function createRulePrompt(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, terminal = true): RulePrompt {
  const rl = readline.createInterface({ input, output, terminal, historySize: 0 });
  let closed = false; let line: ((value: string) => void) | undefined; let cancel: (() => void) | undefined;
  const finish = (): void => { closed = true; line = undefined; const pending = cancel; cancel = undefined; pending?.(); };
  rl.on("line", (value) => line?.(value)); rl.on("close", finish); rl.on("SIGINT", () => rl.close());
  return {
    get closed() { return closed; },
    source: () => new Promise<string | null>((resolve) => {
      if (closed) { resolve(null); return; }
      const lines: string[] = [];
      const end = (value: string | null): void => { line = undefined; cancel = undefined; resolve(value); };
      cancel = () => resolve(null);
      line = (value) => {
        if (value === ":cancel") { end(null); return; }
        if (value === ":done") { end(lines.join("\n")); return; }
        lines.push(value);
        if (Buffer.byteLength(JSON.stringify(lines.join("\n")), "utf8") > 8192) { end(lines.join("\n")); return; }
        rl.prompt();
      };
      rl.setPrompt("rules> "); rl.prompt();
    }),
    confirm: (phrase, alternates = []) => new Promise<boolean>((resolve) => {
      if (closed) { resolve(false); return; }
      if (terminal) rl.write("", { ctrl: true, name: "u" });
      cancel = () => resolve(false);
      line = (value) => { line = undefined; cancel = undefined; resolve(value === phrase || alternates.includes(value)); };
      rl.setPrompt("approval> "); rl.prompt();
    }),
    close: () => rl.close(),
  };
}

/** A missing runner is the shared "not running" message, never a rule-verification failure. */
function readRuleBrainTarget(directory: string, agentId: string): ReturnType<typeof readPrivateBrainTarget> {
  try { return readPrivateBrainTarget(directory, agentId); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(directory)); }
}

export async function runPrivateRuleCommand(options: RuleCommandOptions): Promise<RuleCommandResult> {
  const command = parseRuleCommandArguments(options.args);
  if (options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.flags.dryRun) return { kind: "preview", ...command, armed: false, execution: "unavailable" };
  const editing = command.action === "edit" || command.action === "rollback" || command.action === "approval";
  const mayConfirm = editing || (command.action === "review" && options.interactive && !options.flags.json && !options.flags.ci);
  if (editing && (!options.interactive || options.flags.json || options.flags.ci)) throw new TerminalError({
    code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive rule authoring required",
    cause: "Editing, rollback and the approval setting require a visible terminal and explicit owner confirmation.",
    fix: "Run without --json or --ci in a terminal. Read-only show, review, history and receipt commands support JSON.", exitCode: 2 });
  let prompt: RulePrompt | undefined;
  try {
    const discovered = options.resolveTarget ? options.resolveTarget(command.agentId, command.chain)
      : { ...readRuleBrainTarget(options.directory, command.agentId), chain: command.chain };
    const target = Object.freeze({ ...discovered });
    if (target.agentId !== command.agentId || target.chain !== command.chain) throw new PrivateRuleTransportError("invalid_document");
    const transport = options.transport ?? requestPrivateRule;
    const call = async (request: PrivateRuleRequest): Promise<PrivateRuleData> => {
      const response = parsePrivateRuleResponse(await transport(target.socketPath, request));
      if (response.id !== request.id || response.localProfileId !== target.localProfileId || response.instanceId !== target.instanceId
        || response.agentId !== target.agentId || response.chain !== target.chain) throw new PrivateRuleTransportError("invalid_document");
      if (!response.ok) throw new PrivateRuleRequestError(response.error);
      return response.data;
    };
    const head = async (): Promise<RuleHead> => {
      const data = await call({ ...privateRuleBinding(target), action: "head" });
      if (data.kind !== "head") throw new PrivateRuleTransportError("invalid_document"); return data.head;
    };
    const currentHead = async (): Promise<RuleHead | null> => { try { return await head(); } catch { return null; } };
    if (command.action === "status") return { kind: "status", head: await head(), armed: false, execution: "unavailable" };
    if (command.action === "history") {
      const data = await call({ ...privateRuleBinding(target), action: "history", beforeRevision: command.beforeRevision });
      if (data.kind !== "history" || data.history.some((entry, i, all) => (command.beforeRevision !== null && entry.revision >= command.beforeRevision)
        || (i > 0 && entry.revision >= all[i - 1]!.revision))) throw new PrivateRuleTransportError("invalid_document");
      return { kind: "history", history: data.history, nextBeforeRevision: data.history.at(-1)?.revision === 1 ? null : data.history.at(-1)?.revision ?? null };
    }
    if (command.action === "receipt") {
      const data = await call({ ...privateRuleBinding(target), action: "receipt", operationId: command.operationId });
      if (data.kind !== "receipt" || (data.receipt && data.receipt.input.operationId !== command.operationId)) throw new PrivateRuleTransportError("invalid_document");
      return { kind: "receipt", receipt: data.receipt, currentHead: await currentHead(), armed: false, execution: "unavailable" };
    }
    if (command.action === "show") {
      const observed = await head();
      const revision = observed.revisionId === null ? null : validateRevision(await readPrivateRuleDocument(target, { revisionId: observed.revisionId }, transport), target, observed.revisionId);
      return { kind: "show", observedHead: observed, revision, currentHead: await currentHead(), armed: false, execution: "unavailable" };
    }
    const readRevision = async (observed: RuleHead): Promise<BehaviorRuleRevision | null> => observed.revisionId === null ? null
      : validateRevision(await readPrivateRuleDocument(target, { revisionId: observed.revisionId }, transport), target, observed.revisionId);
    let proposalId: string; let proposalDigest: string | undefined;
    if (editing) {
      const observed = await head();
      if (command.action === "approval") {
        const current = await readRevision(observed);
        if (!current) throw new TerminalError({ code: "RUNTIME_ERROR", title: "No confirmed rules",
          cause: `Agent ${command.agentId} has no confirmed ${command.chain} rules, so there is no approval setting to change.`,
          fix: `Write and confirm rules first: balchemy runner rules ${command.agentId} ${command.chain} edit`, exitCode: 2 });
        const now = privateRuleApproval(current.compiled, current.rules);
        if ((command.setting === "off") === (now === "automatic_within_limits")) {
          return { kind: "approval_unchanged", agentId: command.agentId, chain: command.chain, setting: command.setting,
            revision: observed.revision, approval: now, armed: false, execution: "unavailable" };
        }
      }
      prompt = (options.createPrompt ?? createRulePrompt)();
      let exactSource: string | undefined;
      if (command.action === "edit") {
        if (!options.review) await options.write(`Private rules for ${command.agentId} on ${command.chain}. Observed revision: ${observed.revision}.\n`
          + "Whole-file replacement: include every intended clause; previous clauses are not inherited.\n"
          + "Enter rule lines; :done ends input, :cancel or Ctrl+C cancels. These local sentinel lines are not rule text.\n");
        const entered = await prompt.source();
        if (entered === null || prompt.closed) return { kind: "cancelled" };
        if (!isRuleSource(entered)) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid rule text",
          cause: "Enter non-empty text within 8000 characters and 8192 JSON UTF-8 bytes, without terminal control characters.",
          fix: "Nothing was submitted. Shorten or correct the text in a new edit session.", exitCode: 2 });
        exactSource = entered;
      }
      proposalId = randomUUID();
      if (!options.review) await options.write(`Proposal ID: ${proposalId}\nRead this same proposal after an interrupted submission: balchemy runner rules ${command.agentId} ${command.chain} review ${proposalId}\n`);
      if (prompt.closed) return { kind: "cancelled" };
      const request: PrivateRuleRequest = { ...privateRuleBinding(target), proposalId,
        expectedRevision: observed.revision, expectedRevisionId: observed.revisionId,
        ...(command.action === "edit" ? { action: "propose", exactSource: exactSource! } as const
          : command.action === "rollback" ? { action: "rollback", targetRevisionId: command.revisionId } as const
            : { action: "approval", setting: command.setting } as const) };
      let accepted: PrivateRuleData;
      try { accepted = await call(request); }
      catch (error: unknown) {
        if (error instanceof PrivateRuleTransportError) throw new TerminalError({ code: "RUNTIME_OUTCOME_UNKNOWN", title: "Proposal not confirmed",
          cause: "The submission outcome could not be verified. No replacement proposal was submitted.",
          fix: "Read the same proposal ID; do not create a replacement to resolve this unknown outcome.",
          commandSuggestion: `balchemy runner rules ${command.agentId} ${command.chain} review ${proposalId}`, operationId: proposalId, exitCode: 1 });
        throw error;
      }
      if (accepted.kind !== "proposal" || accepted.proposalId !== proposalId) throw new PrivateRuleTransportError("invalid_document");
      proposalDigest = accepted.proposalDigest;
    } else {
      if (command.action !== "review") invalid(); proposalId = command.proposalId;
    }
    const proposal = validateRuleProposal(await readPrivateRuleDocument(target, { proposalId }, transport), target, proposalId, proposalDigest);
    const observed = await head();
    const stale = observed.revision !== proposal.input.expectedRevision || observed.revisionId !== proposal.input.expectedRevisionId;
    if (!mayConfirm) return { kind: "review", proposal, observedHead: observed, stale, armed: false, execution: "unavailable" };
    prompt ??= (options.createPrompt ?? createRulePrompt)();
    if (!options.review) await options.write(preview(proposal));
    if (stale || !proposal.validation.valid) {
      await options.write(options.review ? (stale ? "These rules were changed since this review was made, so it cannot be confirmed. Nothing was changed.\n"
        : "These rules do not pass the runner's check, so they cannot be confirmed. Nothing was changed.\n")
        : stale ? "Proposal base is stale. Confirmation is blocked; current head is shown below.\n" : "Strict validation failed. Confirmation is blocked.\n");
      return { kind: "review_blocked", proposalId, head: observed, stale, validation: proposal.validation };
    }
    // The diff is always against the head this proposal was made for (not stale, checked above).
    const parent = await readRevision(observed);
    const reviewed = options.review ? options.review(proposal, parent) : approvalDiff(proposal, parent);
    await options.write(reviewed);
    // Owner decision of 23 Nov 2026: a plain review that names a changed rule it cannot describe blocks the confirmation.
    if (options.review && reviewed.includes(PRIVATE_RULE_REVIEW_UNDESCRIBED)) {
      await options.write(`${PRIVATE_RULE_UNDESCRIBED_BLOCKED}\n`);
      return { kind: "review_blocked", proposalId, head: observed, stale: false, validation: proposal.validation, reason: PRIVATE_RULE_UNDESCRIBED_BLOCKED };
    }
    const before = parent ? privateRuleApproval(parent.compiled, parent.rules) : "approval_required";
    const after = privateRuleApproval(proposal.compilation.compiled, proposal.compilation.rules);
    if (proposal.input.kind === "approval" && (!parent || parent.source.exactSource !== proposal.compilation.source.exactSource
      || privateRuleDiff(parent.rules, proposal.compilation.rules).some((item) => !APPROVAL_PATHS.has(item.path))
      || after !== (proposal.input.setting === "off" ? "automatic_within_limits" : "approval_required"))) {
      await options.write("The approval proposal does not match the confirmed rules it was made for. Confirmation is blocked.\n");
      return { kind: "review_blocked", proposalId, head: observed, stale: false, validation: proposal.validation };
    }
    const refusal = proposal.input.kind === "edit" && options.beforeConfirm ? options.beforeConfirm(proposal) : undefined;
    if (refusal !== undefined) {
      await options.write(`${refusal}\n`);
      return { kind: "review_blocked", proposalId, head: observed, stale: false, validation: proposal.validation, reason: refusal };
    }
    const operation = operationConfirmation(proposalId);
    let phrase = operation.phrase; let alternates = operation.alternates;
    if (after === "automatic_within_limits" && before !== "automatic_within_limits") {
      phrase = `APPROVAL OFF ${proposal.input.agentId}`; alternates = [];
      await options.write([`Turning trade approval off lets ${proposal.input.agentId} buy automatically, without asking you per trade, whenever it is armed:`,
        `only within your per-trade and daily spend caps, with ${PRIVATE_EXECUTION_CAPABILITIES.exits === true ? "the stop-loss and " : ""}every other safety check still enforced.`,
        PRIVATE_EXECUTION_CAPABILITIES.exits === true ? `Arming stays a separate step (${options.review ? "/arm" : "balchemy runner arm"}). If the agent is armed now, new entries pause while this is saved and then resume; exits keep running.`
          : "Arming is not available in this version (it has no automatic stop-loss exits), so nothing buys automatically yet.", ""].join("\n"));
    } else if (proposal.input.kind === "approval") {
      phrase = `APPROVAL ON ${proposal.input.agentId}`; alternates = [];
      await options.write([`Turning trade approval on means ${proposal.input.agentId} will not trade automatically: arming is refused while approval applies.`,
        "If the agent is armed now, new entries pause while this is saved and stay paused, because approval then applies; exits keep running.", ""].join("\n"));
    } else if (before === "automatic_within_limits" && after !== "automatic_within_limits") {
      await options.write(options.review ? "This revision requires trade approval again, so arming refuses while it applies.\n"
        : `This revision requires trade approval again. To trade automatically within your caps later: balchemy runner rules ${proposal.input.agentId} ${proposal.input.chain} approval off\n`);
    }
    await options.write(`Type exactly ${phrase} to store this revision; any other answer cancels.\n`);
    if (!await prompt.confirm(phrase, alternates) || prompt.closed) return { kind: "cancelled", proposalId };
    const operationId = randomUUID();
    if (!options.review) await options.write(`Confirmation operation: ${operationId}\nRead its historical receipt: balchemy runner rules ${command.agentId} ${command.chain} receipt ${operationId}\n`);
    if (prompt.closed) return { kind: "cancelled", proposalId };
    // A2a: the confirm goes without the proof first; on proof_required the passphrase is asked and the same operation is sent again
    // with a fresh frame id. A transport failure is never resent (the receipt read below).
    const build = (passphrase?: string): PrivateRuleRequest => ({ ...privateRuleBinding(target), action: "confirm", operationId, proposalId,
      proposalDigest: proposal.proposalDigest, expectedRevision: proposal.input.expectedRevision, expectedRevisionId: proposal.input.expectedRevisionId,
      ...(passphrase !== undefined ? { passphrase } : {}) });
    const opened = prompt;
    const own = opened.secret?.bind(opened);
    const secret: SocketProofSecret | null = options.proofSecret !== undefined ? options.proofSecret
      : own ?? (options.createPrompt ? null : terminalSocketProofSecret(true, () => opened.close()));
    type ConfirmReply = { data: PrivateRuleData } | { refused: PrivateRuleRequestError };
    let data: PrivateRuleData;
    try {
      const outcome = await exchangeWithSocketProof<PrivateRuleRequest, ConfirmReply>({ build,
        send: async (sent) => { try { return { data: await call(sent) }; } catch (error: unknown) { if (error instanceof PrivateRuleRequestError) return { refused: error }; throw error; } },
        error: (reply) => ("refused" in reply ? reply.refused.code : undefined), secret, unlock: socketProofUnlock(target, options.walletTransport) });
      if (outcome.kind === "cancelled") return { kind: "cancelled", proposalId };
      if (outcome.kind !== "response") return socketProofFailure(outcome, command.agentId, "Rules not confirmed");
      if ("refused" in outcome.response) throw outcome.response.refused;
      data = outcome.response.data;
    }
    catch (error: unknown) {
      if (error instanceof PrivateRuleRequestError) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Rules not confirmed",
        cause: `Local rule state: ${error.code}.`, fix: `Read the current rules and the operation receipt before another review; do not repeat an unknown confirmation. ${PRIVATE_CHANGE_UNSAVED_TEXT}`,
        commandSuggestion: `balchemy runner rules ${command.agentId} ${command.chain} receipt ${operationId}`, operationId, exitCode: 1 });
      if (!(error instanceof PrivateRuleTransportError)) throw error;
      // Read only. A transport failure never authorizes resending confirmation.
      let receipt: RuleCommitReceipt | null = null;
      try {
        const recovered = await call({ ...privateRuleBinding(target), action: "receipt", operationId });
        if (recovered.kind === "receipt" && recovered.receipt && same(recovered.receipt.input, { ...scope(target), operationId,
          proposalId, proposalDigest: proposal.proposalDigest, expectedRevision: proposal.input.expectedRevision, expectedRevisionId: proposal.input.expectedRevisionId })) receipt = recovered.receipt;
      } catch { /* Preserve the operation ID and unknown outcome. */ }
      return { kind: receipt ? "confirmed" : "outcome_unknown", operationId, receipt, currentHead: await currentHead(), armed: false, execution: "unavailable" };
    }
    if (data.kind !== "receipt" || !data.receipt || !same(data.receipt.input, { ...scope(target), operationId,
      proposalId, proposalDigest: proposal.proposalDigest, expectedRevision: proposal.input.expectedRevision, expectedRevisionId: proposal.input.expectedRevisionId })) throw new PrivateRuleTransportError("invalid_document");
    const entries: PrivateChangeEntries | undefined = data.entries;
    return { kind: "confirmed", operationId, receipt: data.receipt, currentHead: await currentHead(), armed: false, execution: "unavailable", ...(entries ? { entries } : {}) };
  } catch (error: unknown) {
    if (error instanceof TerminalError) throw error;
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Private rules unavailable",
      cause: error instanceof PrivateRuleRequestError ? `Local rule state: ${error.code}.` : "The bound local rule response could not be verified.",
      fix: "Keep existing proposal and operation IDs. Inspect runner status; do not reset private state or repeat an unknown confirmation.", exitCode: 1 });
  } finally { prompt?.close(); }
}

/** The entries outcome of a confirm made while the agent was armed (absent otherwise, and on a receipt recovered after a lost reply). */
function confirmedEntryLines(result: RuleCommandResult): string[] {
  let entries: PrivateChangeEntries | undefined;
  try { entries = result.entries === undefined ? undefined : parsePrivateChangeEntries(result.entries); } catch { entries = undefined; }
  const receipt = result.receipt;
  const agentId = isRecord(receipt) && isRecord(receipt.input) && isId(receipt.input.agentId) ? receipt.input.agentId : "<agent>";
  return privateChangeEntriesLines(entries, agentId);
}
export function formatRuleCommandResult(result: RuleCommandResult): string {
  const explanation = result.kind === "cancelled" ? "Cancelled before confirmation. The daemon remains running."
    : result.kind === "confirmed" ? ["Durable rule receipt confirmed. The receipt records that operation; current head is shown separately.",
      ...confirmedEntryLines(result)].join(" ")
    : result.kind === "outcome_unknown" ? `Confirmation outcome remains unknown. Keep the operation ID and read its receipt; confirmation was not resent. ${PRIVATE_CHANGE_UNSAVED_TEXT}`
    : result.kind === "receipt" ? "Historical operation receipt. A missing receipt does not authorize resubmission; current head is shown separately."
    : result.kind === "status" ? "Rule head metadata. Use show to explicitly display private rule source."
    : result.kind === "show" ? "Private revision observed when this read began. Current head is shown separately."
    : result.kind === "review" ? "Private proposal review only. No confirmation was sent."
    : result.kind === "history" ? "Rule revision history: metadata only."
    : result.kind === "preview" ? "Command preview only. No connection, input prompt or change was made."
    : result.kind === "approval_unchanged" ? (result.setting === "off" ? "Trade approval is already off for the confirmed rules. Nothing was proposed."
      : "Trade approval already applies to the confirmed rules. Nothing was proposed.")
    : "Rule confirmation is blocked.";
  return `${explanation}\n${privateRuleJson(result)}\nRule storage only; execution unavailable and armed false.\n`;
}
