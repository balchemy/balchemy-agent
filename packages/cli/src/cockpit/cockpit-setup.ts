/** The cockpit's setup card (Phase 2, owner-approved order of 19 Nov 2026; A1 wording of 22 Nov 2026): the owner's own directive (three
 * example directives are shown only as inspiration; the deterministic rule coach checks it and asks for a stop-loss only when the text
 * names none), signal sources, spend limits at or below the signed ceiling, the buy size (asked only when the directive gives no amount;
 * slippage is not asked, its default is 1% and Settings > Advanced changes it), funding (address, terminal QR code, a minimum, and a wait
 * until the balance is visible), then ONE plain review of everything the agent will do with ONE typed `CONFIRM <agent>`, and only then the
 * existing arm command (its own review, typed ARM <agent> and passphrase).
 *
 * Nothing is saved before that one confirmation. After it, each value is saved through its existing owner command, unchanged, with
 * that command's own typed phrase answered for exactly the value shown in the summary (the summary covers them; owner decision). A
 * value the summary did not show is never saved here: the rules save is bound to the digests of the compiled rules the summary showed,
 * and a percentage spend limit is fixed into SOL from the wallet balance BEFORE the summary (which shows the SOL amount; the buy size is
 * checked against it) and saved only when the command fixes it to exactly that amount again. This card exists only for the first setup (no confirmed rules yet); every later
 * risk-raising change keeps its own card and typed confirmation. A failed save stops the rest and says what was and was not saved. */
import { BehaviorRuleCompilerService, coachBehaviorRuleCompilation, isTypedEntryCondition, type BehaviorRuleCoachReport, type BehaviorRuleCompilation,
  type BehaviorRuleRevision, type BehaviorRules, type DeterministicBehaviorRuleAmountInstruction, type TypedEntryCondition } from "@balchemyai/agent-rules";
import { isRuleSource } from "../runner/private-rule-protocol.js";
import { privateRuleDefaultContext, type RuleProposal } from "../runner/private-rule-store.js";
import { privateRuleApproval, privateRuleDiff, PRIVATE_RULE_REVIEW_UNDESCRIBED, runPrivateRuleCommand } from "../runner/private-rule-commands.js";
import type { PrivateBrainTarget } from "../runner/private-brain-client.js";
import { lamportsToSol, parsePrivateCapArgument } from "../runner/private-arming-ui.js";
import type { PrivateSpendCapQuote } from "../runner/private-arming-protocol.js";
import { formatPrivateCap, type PrivateCapChoice, type PrivateCapRequest } from "../runner/private-spend-cap.js";
import { parsePrivateSizingArguments } from "../runner/private-sizing-ui.js";
import { PRIVATE_SPEND_CAP_MAX_LAMPORTS } from "../runner/private-spend-cap.js";
import { PRIVATE_DCA_ENABLED, privateCompilationMaxPositions, privateStatedMaxPositions, type PrivateMaxPositions } from "../runner/private-typed-rules.js";
import type { PrivateLaunchpadView } from "../runner/private-launchpads.js";
import { SETUP_DEFAULTS } from "../runner/setup-state.js";
import { renderTerminalQrPlain } from "../tui/terminal-qr.js";
import type { CockpitIo } from "./cockpit-flow.js";

/** A1 (owner decision of 22 Nov 2026): example directives replace the three strategy templates. They are inspiration only: the owner
 * writes their own directive, and a number copies one in as a starting text. Each compiles clean under the 1.3.0 grammar and names
 * neither "new pairs" nor a launchpad (A0 of 22 Nov 2026: those words hold every signal at strategy_facts_missing); a0-template-hold.spec.ts
 * proves each one reaches the model with passing facts. None is a DCA plan (DCA buying is held). */
export const SETUP_EXAMPLE_DIRECTIVES = Object.freeze([
  { id: "quick", title: "Quick exits on liquid tokens",
    text: "liquidity at least 10k; stop loss at 15%; take profit 50% of position at 2x; max 3 positions at a time" },
  { id: "trail", title: "Ride a move with a trailing stop",
    text: "liquidity at least 50k; stop loss at 10%; trailing stop 15% after +30%; max 2 positions at a time" },
  { id: "volume", title: "Active tokens, a fixed small buy",
    text: "volume in the last hour at least 50k; buy 0.05 SOL; take profit 100% of position at 2x; stop loss at 30%; max 3 positions at a time" },
] as const);
/** Room for fees, the token account rent and the priority fee on top of one buy (owner suggestion: about 0.02 SOL). */
export const SETUP_FUNDING_MARGIN_LAMPORTS = 20_000_000n;
const FUNDING_POLL_MS = 5_000;
/** The stop-loss suggested when a directive names none (Enter takes it). */
const STOP_LOSS_SUGGESTION = "15";

/** A cockpit default limit at or below the signed ceiling (both in lamports), as SOL text. */
export function cockpitLimitDefault(fallbackSol: string, ceilingLamports: string | null | undefined): string {
  if (!ceilingLamports) return fallbackSol;
  const fallback = parsePrivateCapArgument(fallbackSol);
  if (fallback.kind !== "lamports") return fallbackSol;
  return BigInt(fallback.lamports) <= BigInt(ceilingLamports) ? fallbackSol : lamportsToSol(ceilingLamports).replace(/ SOL$/, "");
}
/** The minimum funding for one buy of `amountLamports` plus fees, in lamports. */
export function setupFundingMinimum(amountLamports: bigint): bigint { return amountLamports + SETUP_FUNDING_MARGIN_LAMPORTS; }
function solText(lamports: bigint): string { return lamportsToSol(lamports.toString()); }
/** A SOL amount ("0.1") in lamports, or undefined when it is not one. */
function solLamports(value: string): bigint | undefined {
  try { const parsed = parsePrivateCapArgument(value); return parsed.kind === "lamports" ? BigInt(parsed.lamports) : undefined; } catch { return undefined; }
}
/** Slippage in bps as a percent ("100" -> "1%"). */
function slippagePercent(bps: string): string { return `${(Number(bps) / 100).toFixed(2).replace(/\.?0+$/, "")}%`; }
/** One limit of the summary: no limit, an amount, or a fixed percentage with the balance it was fixed from. */
function limitSummary(cap: PrivateCapChoice, basis: PrivateSpendCapQuote["perTradeBasis"]): string {
  if (cap.kind === "none") return "no limit";
  const amount = lamportsToSol(cap.lamports);
  return basis ? `${amount} (${(basis.percentBps / 100).toFixed(2).replace(/\.?0+$/, "")}% of ${lamportsToSol(basis.balanceLamports)}, fixed now)` : amount;
}
/** The lamports of one buy size, or undefined when the runner would refuse the amount or the slippage. */
function sizingLamports(agentId: string, amountSol: string, slippageBps: string): bigint | undefined {
  try {
    const parsed = parsePrivateSizingArguments([agentId, "--amount-sol", amountSol, "--slippage-bps", slippageBps]);
    return parsed.action === "update" ? BigInt(parsed.amountBaseUnits) : undefined;
  } catch { return undefined; }
}

/** The deterministic coach of one directive (no model): the local compile with the same baseline the runner uses, and its checklist. */
export interface SetupRuleReview { compilation: BehaviorRuleCompilation; coach: BehaviorRuleCoachReport; stopLossStated: boolean; understood: boolean }
export function reviewSetupRules(text: string): SetupRuleReview | undefined {
  if (!isRuleSource(text)) return undefined;
  try {
    const context = privateRuleDefaultContext();
    const compilation = new BehaviorRuleCompilerService().compileNaturalLanguage(text, context.baseRules, "solana", context.trustedOverrides);
    const coach = coachBehaviorRuleCompilation(compilation);
    return { compilation, coach, stopLossStated: coach.stopLoss.source === "owner_clause" || coach.stopLoss.source === "structured",
      understood: compilation.status === "compiled" && compilation.diagnostics.length === 0 };
  } catch { return undefined; }
}
function typed(condition: unknown): condition is TypedEntryCondition {
  return typeof condition === "object" && condition !== null && "field" in condition && "operator" in condition
    && typeof (condition as { value?: unknown }).value === "number";
}
const FIELD_TEXT: Readonly<Record<string, string>> = { liquidity_usd: "liquidity (USD)", market_cap_usd: "market cap (USD)", volume_1h_usd: "1h volume (USD)",
  volume_24h_usd: "24h volume (USD)", token_age_minutes: "token age (minutes)", holder_count: "holders", top_holders_pct: "top holders' share (%)" };
/** The compiled strategy fields that decide whether the runner holds every signal (private-outer-decision.ts). */
export interface SetupStrategyView { target?: unknown; sources?: readonly unknown[]; entry?: object }
/** The compiled artifacts the hold notes read (a compilation's or a confirmed revision's `compiled`). */
export interface SetupCompiledView { executionStrategy?: SetupStrategyView | null; amountInstruction?: DeterministicBehaviorRuleAmountInstruction }
/** What makes the runner hold EVERY buy in this version, in plain words (code-built; mirrors the static holds of
 * evaluatePrivateOuterPrefilter, private-outer-decision.ts: a strategy target, sources or entry numbers; an untyped condition; a required
 * signal count; and private-signal-plan.ts: an unsupported or non-SOL directive amount). Empty when none applies. */
export function setupRulesHoldNotes(rules: BehaviorRules, compiled?: SetupCompiledView): string[] {
  const strategy = compiled?.executionStrategy; const amount = compiled?.amountInstruction;
  const notes: string[] = [];
  if (strategy?.target || strategy?.sources?.length) {
    notes.push("Held: in this version a directive that names new pairs or a launchpad (such as pump.fun) holds every buy, because the runner has no "
      + "launch facts yet. Remove that part to let the agent buy; signal sources are chosen separately.");
  } else if (strategy?.entry && Object.keys(strategy.entry).length) {
    notes.push("Held: part of this directive asks for launch facts the runner cannot read yet, so it holds every buy.");
  }
  if (rules.entry.conditions.some((condition) => !isTypedEntryCondition(condition) && !["chain", "risk_verdict", "risk.verdict"].includes(condition.field))) {
    notes.push("Held: a buy condition in this directive has no fact the runner can read yet, so it holds every buy.");
  }
  if (rules.entry.signals.minRequired > 0) notes.push("Held: this directive waits for signal confirmations the runner cannot count yet, so it holds every buy.");
  if (amount?.state === "unsupported") notes.push("Held: the buy amount in this directive is ambiguous or not supported, so it holds every buy. Give one amount in SOL.");
  else if (amount?.state === "exact" && amount.unit !== "SOL") notes.push(`Held: this directive buys in ${amount.unit}; only SOL amounts can buy, so it holds every buy.`);
  return notes;
}
/** The exact SOL amount of one buy the directive states (`buy 0.05 SOL`), or undefined when it states none (or one that cannot buy). */
export function setupDirectiveAmount(compilation: BehaviorRuleCompilation): string | undefined {
  const amount = compilation.compiled.amountInstruction;
  return amount?.state === "exact" && amount.unit === "SOL" ? amount.decimal : undefined;
}
/** Plain lines of what compiled rules do, one per rule, for the summary and the review (code-built from the compiled rules, never model
 * text). `maxPositions` is the owner's stated max positions (privateCompilationMaxPositions / privateStatedMaxPositions): the compiled
 * default is never shown as a limit the owner did not state. `compiled` (the compiled artifacts) adds the plain warning when the
 * directive makes the runner hold every buy. */
export function setupRulesSummary(rules: BehaviorRules, maxPositions: PrivateMaxPositions | null, compiled?: SetupCompiledView): string[] {
  const lines = [`Stop-loss: sell when a position is down ${Math.abs(rules.risk.stopLossPct)}%`];
  for (const level of rules.exit.tpLevels) lines.push(`Take profit: sell ${level.sellPct}% of the position at +${level.targetPct}%`);
  if (rules.exit.trailing) lines.push(`Trailing stop: once up ${rules.exit.trailing.activateAtPct}%, sell if it falls ${rules.exit.trailing.stopAtPct}% from its high`);
  if (typeof maxPositions === "number") lines.push(`At most ${maxPositions} open position${maxPositions === 1 ? "" : "s"}`);
  else if (maxPositions === "none") lines.push("Open positions: no limit (your rules state none)");
  const filters = rules.entry.conditions.filter(typed);
  for (const filter of filters) lines.push(`Buy only if ${FIELD_TEXT[filter.field] ?? filter.field} ${filter.operator} ${filter.value}${filter.topHolderCount ? ` (top ${filter.topHolderCount})` : ""}`);
  if (rules.avoid) {
    const count = rules.avoid.mints.length + rules.avoid.symbols.length + rules.avoid.creators.length;
    if (count) lines.push(`Never buy: ${[...rules.avoid.symbols.map((symbol) => `$${symbol}`), ...rules.avoid.mints, ...rules.avoid.creators.map((creator) => `creator ${creator}`)].join(", ")}`);
    // No source of a token's creator exists yet, so the runner cannot tell whether a token is on a creator list: it holds every buy.
    if (rules.avoid.creators.length) lines.push("  Note: a token's creator cannot be checked yet, so a creator entry holds every buy and every DCA add");
  }
  if (rules.risk.maxBuysPerToken !== undefined) lines.push(`At most ${rules.risk.maxBuysPerToken} buy${rules.risk.maxBuysPerToken === 1 ? "" : "s"} per token`);
  if (rules.risk.maxTradesPerDay !== undefined) lines.push(`At most ${rules.risk.maxTradesPerDay} trades per day`);
  if (rules.dca) lines.push(`DCA: ${rules.dca.amount} ${rules.dca.unit} per add, up to ${rules.dca.maxTotal} ${rules.dca.unit} in total${PRIVATE_DCA_ENABLED ? "" : " (held: DCA buying is not available yet)"}`);
  if (compiled !== undefined) lines.push(...setupRulesHoldNotes(rules, compiled));
  return lines;
}
/** One part the runner did not understand, in the owner's own words (an unknown clause's compiler message says nothing more). */
function diagnosticText(item: BehaviorRuleCompilation["diagnostics"][number]): string {
  if (!item.statement) return item.message;
  return item.code === "UNKNOWN_CLAUSE" ? `"${item.statement}"` : `"${item.statement}": ${item.message}`;
}
/** The full plain review of one compiled directive: every rule line, the directive's own buy amount, each part the runner did not
 * understand (held, never executed) and every reason it would hold every buy. */
export function setupRulesReview(compilation: BehaviorRuleCompilation): string[] {
  const amount = setupDirectiveAmount(compilation);
  return [...setupRulesSummary(compilation.rules, privateCompilationMaxPositions(compilation)),
    ...(amount ? [`Buy: ${amount} SOL per buy (your directive)`] : []),
    ...compilation.diagnostics.map((item) => `Not understood (held, never executed): ${diagnosticText(item)}`),
    ...setupRulesHoldNotes(compilation.rules, compilation.compiled)];
}
/** Rule paths the review describes (setupRulesSummary, the approval line), or that carry no trading behaviour. Every other changed path
 * is named on a line of its own, so nothing the confirmation stores disappears from the review (and, owner decision of 23 Nov 2026, such a
 * line blocks the confirmation: private-rule-commands.ts PRIVATE_RULE_REVIEW_UNDESCRIBED). */
const DESCRIBED_PATHS = ["risk.stopLossPct", "risk.maxConcurrentPositions", "exit.tpLevels", "exit.trailing", "entry.conditions", "entry.signals", "avoid",
  "risk.maxBuysPerToken", "risk.maxTradesPerDay", "dca", "personality.confirmBeforeTrade", "risk.requireApprovalAboveUsd", "risk.requireApprovalForNewTokens",
  "version", "customRules", "examples", "personality.explainTrades", "personality.language", "personality.tone"];
const APPROVAL_WORDS = { automatic_within_limits: "automatic within your limits, no question per trade",
  approval_required: "asks before each trade (arming refuses while this applies)" } as const;
/** A1: the cockpit's review of one rule proposal, replacing the raw JSON preview and field diff (private-rule-commands.ts keeps those for
 * the CLI command; `--json` reads them). Built by code from the proposal the command validated (the typed confirmation stays bound to its
 * digest), never from a local recompile and never from model text. */
/** The one path list of the review line, the confirmation block and the setup card: every rule path that differs from the baseline and
 * that the plain review has no sentence for. */
export function setupUndescribedPaths(baseRules: BehaviorRules, rules: BehaviorRules): string[] {
  return privateRuleDiff(baseRules, rules).map((item) => item.path)
    .filter((path) => !DESCRIBED_PATHS.some((described) => path === described || path.startsWith(`${described}.`)));
}
export function setupProposalReview(proposal: RuleProposal, parent: BehaviorRuleRevision | null): string {
  const { compilation } = proposal;
  const before = parent ? privateRuleApproval(parent.compiled, parent.rules) : "approval_required";
  const after = privateRuleApproval(compilation.compiled, compilation.rules);
  const lines = ["What these rules do (built by the runner from the checked rules; not written by the AI model):"];
  const exact = "exactSource" in compilation.source && typeof compilation.source.exactSource === "string" ? compilation.source.exactSource : undefined;
  if (proposal.input.kind !== "approval" && exact !== undefined) lines.push(`  Your directive: ${exact.replace(/\s+/g, " ").trim()}`);
  lines.push(...setupRulesReview(compilation).map((line) => `  ${line}`),
    `  Trading: ${before === after ? APPROVAL_WORDS[after] : `${APPROVAL_WORDS[before]} -> ${APPROVAL_WORDS[after]}`}`);
  for (const path of setupUndescribedPaths(proposal.context.baseRules, compilation.rules)) lines.push(`  ${PRIVATE_RULE_REVIEW_UNDESCRIBED}${path}`);
  if (compilation.status !== "compiled") lines.push("  Saving keeps these rules held: the parts not understood never run, and nothing buys.");
  return `${lines.join("\n")}\n`;
}

/** A2a seal card: the plain review of the confirmed Solana rules revision `revisionId` (code-built from the validated revision, like
 * setupProposalReview; never a revision id, never model text). Undefined when it cannot be read or the head is another revision. */
export async function readSetupRulesReview(directory: string, agentId: string, revisionId: string,
  resolveTarget?: (agentId: string) => PrivateBrainTarget): Promise<string[] | undefined> {
  try {
    const result = await runPrivateRuleCommand({ args: [agentId, "solana", "show"], directory, interactive: false, write: () => {},
      flags: { json: false, ci: false, yes: false, force: false, dryRun: false, quiet: false },
      ...(resolveTarget ? { resolveTarget: (id: string, chain: "solana" | "base") => ({ ...resolveTarget(id), chain }) } : {}) });
    const revision = result.kind === "show" ? result.revision as BehaviorRuleRevision | null : null;
    if (!revision || revision.revisionId !== revisionId) return undefined;
    const exact = revision.source.kind === "natural_language" && typeof revision.source.exactSource === "string" ? revision.source.exactSource : undefined;
    return [...(exact !== undefined ? [`Your directive: ${exact.replace(/\s+/g, " ").trim()}`] : []),
      ...setupRulesSummary(revision.rules, privateStatedMaxPositions(revision), revision.compiled ?? {}),
      ...setupUndescribedPaths(privateRuleDefaultContext().baseRules, revision.rules).map((path) => `${PRIVATE_RULE_REVIEW_UNDESCRIBED}${path}`)];
  } catch { return undefined; }
}

/** The directive step of the setup card and of /directive change: the examples (inspiration only; a number copies one in), the owner's
 * own text, the stop-loss question only when the text names none, and each part the runner would hold. `left`: Esc (or Enter where it
 * leaves); `unfinished`: still not usable after eight rounds. */
type DirectiveStep = { kind: "ok"; text: string; review: SetupRuleReview } | { kind: "left" } | { kind: "unfinished" };
async function directiveStep(io: CockpitIo, ask: (question: string) => Promise<string | undefined>): Promise<DirectiveStep> {
  await io.write(["Tell your agent what to trade, in your own words, with clauses separated by ;. Some examples, for inspiration only:",
    ...SETUP_EXAMPLE_DIRECTIVES.flatMap((item, index) => [`  ${index + 1}  ${item.title}`, `     ${item.text}`]),
    "Type your own directive, or a number to start from an example. Leave out launchpad names and \"new pairs\": in this version they hold every buy.", ""].join("\n"));
  const typedText = async (question: string): Promise<string | undefined> => {
    for (;;) {
      const answer = await ask(question);
      if (answer === undefined) return undefined;
      const example = /^[1-9]$/.test(answer) ? SETUP_EXAMPLE_DIRECTIVES[Number(answer) - 1] : undefined;
      if (example && io.edit) {
        // A1 (owner decision of 23 Nov 2026): the example opens in the input to be edited; Enter keeps it as it is.
        await io.write(`Example ${answer} is in the input: change any part, then press Enter (Ctrl+U clears it).\n`);
        const edited = await io.edit(question, example.text);
        if (edited === null) return undefined;
        if (edited.trim()) return edited.trim();
        await io.write(`Type a directive, or a number from 1 to ${SETUP_EXAMPLE_DIRECTIVES.length} for an example.\n`);
        continue;
      }
      if (example) { await io.write(`Example ${answer} copied: ${example.text}\n`); return example.text; }
      if (answer) return answer;
      await io.write(`Type a directive, or a number from 1 to ${SETUP_EXAMPLE_DIRECTIVES.length} for an example.\n`);
    }
  };
  let text = await typedText("directive");
  for (let round = 0; round < 8; round++) {
    if (text === undefined) return { kind: "left" };
    const review = reviewSetupRules(text);
    if (!review) { await io.write("That text cannot be used (too long, or with control characters).\n"); text = await typedText("directive"); continue; }
    for (const item of review.compilation.diagnostics) await io.write(`Not understood (it would be held, never executed): ${diagnosticText(item)}\n`);
    for (const note of setupRulesHoldNotes(review.compilation.rules, review.compilation.compiled)) await io.write(`${note}\n`);
    // Owner decision of 23 Nov 2026: a rule the plain review cannot describe blocks the confirmation, so it is asked again here.
    const undescribed = setupUndescribedPaths(privateRuleDefaultContext().baseRules, review.compilation.rules);
    for (const path of undescribed) await io.write(`${PRIVATE_RULE_REVIEW_UNDESCRIBED}${path} (it cannot be confirmed here)\n`);
    if (!review.understood || undescribed.length) {
      await io.write("Type the whole directive again with those parts changed or left out (Enter leaves without saving).\n");
      const again = await ask("directive");
      if (!again) return { kind: "left" };
      text = again; continue;
    }
    if (!review.stopLossStated) {
      // A1: asked only when the directive names none (the runner refuses rules without one, stop_loss_missing).
      await io.write(`Your directive has no stop-loss, and in this version the runner buys only when your rules have one. At what loss should a position `
        + `be sold? Type a percent, or press Enter for ${STOP_LOSS_SUGGESTION}%.\n`);
      for (;;) {
        const answer = await ask("stop loss percent");
        if (answer === undefined) return { kind: "left" };
        const percent = answer === "" ? STOP_LOSS_SUGGESTION : answer.replace(/%$/, "");
        if (/^(?:[1-9]\d?)(?:\.\d{1,2})?$/.test(percent)) { text = `${text}; stop loss at ${percent}%`; break; }
        await io.write("Use a percent from 1 to 99, such as 15.\n");
      }
      continue;
    }
    return { kind: "ok", text, review };
  }
  return { kind: "unfinished" };
}
const UNFINISHED = "The directive was not finished. Nothing was saved.";

/** K5b, the rules card (/directive change): the same directive step as the setup card. Returns the reviewed text, or undefined when the
 * owner left; nothing is saved here (the rules command then shows its plain review and asks its typed CONFIRM). */
export async function runDirectiveCoach(io: CockpitIo): Promise<string | undefined> {
  const ask = async (question: string): Promise<string | undefined> => { const answer = await io.ask(question); return answer === null ? undefined : answer.trim(); };
  const step = await directiveStep(io, ask);
  if (step.kind === "unfinished") await io.write(`${UNFINISHED}\n`);
  return step.kind === "ok" ? step.text : undefined;
}

export type SetupApplyResult = { ok: true; text: string } | { ok: false; text: string };
/** The compiled rules the summary showed: the save refuses rules the runner compiles to anything else. */
export interface SetupCompiledRules { rulesDigest: string; compiledDigest: string }
/** Each save runs the existing owner command with its typed phrase answered for exactly this value (production: cockpit-runtime.ts). */
export interface SetupApply {
  rules(text: string, compiled: SetupCompiledRules): Promise<SetupApplyResult>;
  approvalOff(): Promise<SetupApplyResult>;
  /** `fixed`: the SOL amounts the summary showed (a percentage already fixed); any other amount at save time is refused. */
  limits(perTrade: string, daily: string, fixed: PrivateSpendCapQuote): Promise<SetupApplyResult>;
  sizing(amountSol: string, slippageBps: string): Promise<SetupApplyResult>;
  sources(launchpadIds: readonly string[]): Promise<SetupApplyResult>;
}
export interface SetupCardDeps {
  io: CockpitIo;
  agentId: string;
  /** The signed spend ceiling (lamports), when one is approved. */
  ceiling(): Promise<{ perTradeLamports: string; dailyLamports: string } | undefined>;
  /** The launchpad catalog with this agent's subscription; undefined when it cannot be read. */
  launchpads(): Promise<PrivateLaunchpadView | undefined>;
  /** The trading wallet address, only once an unlock in this daemon run verified it (a funding target is never unverified). */
  walletAddress(): Promise<string | undefined>;
  /** The wallet's balance in lamports; undefined when it cannot be read. */
  balance(): Promise<bigint | undefined>;
  /** The limits command's read-only quote: each percentage fixed into SOL from the wallet balance on the owner's RPC (nothing saved). */
  quoteLimits(perTrade: string, daily: string): Promise<{ ok: true; quote: PrivateSpendCapQuote } | { ok: false; text: string }>;
  /** Esc while waiting for funds: the signal aborts; `release` stops listening. */
  interrupt(): { signal: AbortSignal; release(): void };
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** One line each for the model and the daily AI budget (read-only), for the summary. */
  facts(): Promise<{ model?: string; budget?: string }>;
  apply: SetupApply;
  /** The existing arm command (its own review, typed ARM <agent> and passphrase). */
  arm(): Promise<void>;
}
export type SetupCardResult = { kind: "armed_step" } | { kind: "left"; reason: string } | { kind: "partial"; saved: string[]; failed: string };

class Leave extends Error { constructor(readonly reason: string) { super(reason); } }

export async function runSetupCard(deps: SetupCardDeps): Promise<SetupCardResult> {
  const { io, agentId } = deps;
  const ask = async (question: string): Promise<string> => {
    const answer = await io.ask(question);
    if (answer === null) throw new Leave("Setup left before the confirmation. Nothing was saved.");
    return answer.trim();
  };
  try {
    // 1. The owner's directive (examples only as inspiration; the stop-loss question only when the directive names none).
    await io.write("\nSetup: what the agent will do. Nothing is saved until the one confirmation at the end.\n\nStep: your directive.\n");
    const directive = await directiveStep(io, async (question) => (await io.ask(question))?.trim());
    if (directive.kind === "left") throw new Leave("Setup left before the confirmation. Nothing was saved.");
    if (directive.kind === "unfinished") throw new Leave(`${UNFINISHED} Open the setup card again.`);
    const { text, review } = directive;
    const directiveAmount = setupDirectiveAmount(review.compilation);

    // 2. Signal sources (Telegram and Discord sources stay on the Hub page: there is no runner path for them).
    await io.write("\nStep: signal sources. A signal is a public observation the agent researches; your rules decide, it never buys by itself.\n");
    let launchpadIds: string[] | undefined;
    const catalog = await deps.launchpads();
    if (!catalog) await io.write("The launchpad catalog could not be read right now; sources stay as they are (choose them later with /signals).\n");
    else {
      const live = catalog.launchpads.filter((item) => item.status === "live");
      // A1: launchpads that are not live yet are hidden (unfinished options are not shown).
      await io.write([...live.map((item, index) => `  ${index + 1}) [${item.subscribed ? "x" : " "}] ${item.name} (launchpad)`),
        "     -  Telegram and Discord sources: added and managed on your Hub page", ""].join("\n"));
      const current = live.flatMap((item, index) => (item.subscribed ? [index + 1] : []));
      const fallback = current.length ? current.join(",") : live.length ? "1" : "none";
      for (;;) {
        const answer = (await ask(`Launchpads by number, comma separated, or none [Enter = ${fallback}]: `)) || fallback;
        if (answer.toLowerCase() === "none") { launchpadIds = []; break; }
        const picks = answer.split(",").map((value) => Number(value.trim()));
        if (picks.length && picks.every((value) => Number.isInteger(value) && value >= 1 && value <= live.length)) {
          launchpadIds = [...new Set(picks.map((value) => live[value - 1]!.id))].sort(); break;
        }
        await io.write(`Type numbers from 1 to ${live.length} separated by commas, or none.\n`);
      }
    }

    // 3. Spend limits at or below the signed ceiling (the per-buy and per-day questions stay in A1).
    await io.write("\nStep: spend limits. The most one buy and all buys per UTC day may spend.\n");
    const ceiling = await deps.ceiling();
    if (ceiling) await io.write(`Your signed spend ceiling: up to ${lamportsToSol(ceiling.perTradeLamports)} per trade, ${lamportsToSol(ceiling.dailyLamports)} per day. `
      + "Limits at or below it need no new browser signature; a higher one (or none) asks for a new wallet signature when you arm.\n");
    const cap = async (question: string, fallback: string): Promise<string> => {
      for (;;) {
        const value = (await ask(`${question} (SOL, N% or none) [Enter = ${fallback}]: `)) || fallback;
        try {
          const parsed = parsePrivateCapArgument(value);
          if (parsed.kind !== "lamports" || BigInt(parsed.lamports) <= PRIVATE_SPEND_CAP_MAX_LAMPORTS) return value;
        } catch { /* Shown below. */ }
        await io.write("Use a SOL amount up to 10 with at most 9 decimals (0.1), a percentage from 1% to 100% (5%), or none.\n");
      }
    };
    // The buy size: the directive's own amount when it states one (no question), otherwise asked below. Slippage is never asked here.
    const slippageBps = SETUP_DEFAULTS.slippageBps;
    const directiveLamports = directiveAmount === undefined ? undefined : sizingLamports(agentId, directiveAmount, slippageBps);
    if (directiveAmount !== undefined && directiveLamports === undefined) {
      throw new Leave(`The buy amount in your directive (${directiveAmount} SOL) cannot be used as a buy size. Nothing was saved; change the amount and open the setup card again.`);
    }
    // The suggestions cover a directive amount above them (a limit is still asked; the ceiling still lowers the suggestion).
    const atLeast = (fallback: string): string => directiveAmount !== undefined && directiveLamports !== undefined
      && (solLamports(fallback) ?? 0n) < directiveLamports ? directiveAmount : fallback;
    let perTrade = ""; let daily = "";
    for (;;) {
      perTrade = await cap("Most one buy may spend", cockpitLimitDefault(atLeast(SETUP_DEFAULTS.perTrade), ceiling?.perTradeLamports));
      daily = await cap("Most all buys may spend per day", cockpitLimitDefault(atLeast(SETUP_DEFAULTS.daily), ceiling?.dailyLamports));
      const one = parsePrivateCapArgument(perTrade), day = parsePrivateCapArgument(daily);
      if (one.kind === "lamports" && day.kind === "lamports" && BigInt(one.lamports) > BigInt(day.lamports)) {
        await io.write("The per-buy limit cannot be above the daily limit. Enter both again.\n"); continue;
      }
      if (directiveLamports !== undefined && one.kind === "lamports" && directiveLamports > BigInt(one.lamports)) {
        await io.write(`Your directive buys ${directiveAmount} SOL, above a per-buy limit of ${lamportsToSol(one.lamports)}. Set a per-buy limit of at least `
          + `${directiveAmount} SOL, or leave and change the amount in your directive.\n`); continue;
      }
      break;
    }
    const perTradeCap = parsePrivateCapArgument(perTrade), dailyCap = parsePrivateCapArgument(daily);

    // 4. Buy size (checked against a per-buy limit in SOL now; a percentage is checked once it is fixed, before the summary).
    let amountSol = directiveAmount ?? ""; let amountLamports = directiveLamports ?? 0n;
    const defaultLamports = sizingLamports(agentId, SETUP_DEFAULTS.amountSol, slippageBps) ?? 0n;
    const askBuySize = async (limitLamports: bigint | undefined, limitText: string): Promise<void> => {
      const fallback = limitLamports !== undefined && limitLamports < defaultLamports ? lamportsToSol(limitLamports.toString()).replace(/ SOL$/, "") : SETUP_DEFAULTS.amountSol;
      for (;;) {
        amountSol = (await ask(`SOL per buy [Enter = ${fallback}]: `)) || fallback;
        const lamports = sizingLamports(agentId, amountSol, slippageBps);
        if (lamports === undefined) { await io.write("Use a SOL amount with at most 9 decimals, such as 0.05.\n"); continue; }
        amountLamports = lamports;
        if (limitLamports !== undefined && amountLamports > limitLamports) {
          await io.write(`A buy of ${amountSol} SOL is above your per-buy limit of ${limitText}. Choose a smaller size.\n`); continue;
        }
        return;
      }
    };
    if (directiveAmount !== undefined) {
      await io.write(`\nBuy size: ${directiveAmount} SOL per buy, from your directive. Slippage ${slippagePercent(slippageBps)} (change it later in Settings > Advanced).\n`);
    } else {
      await io.write(`\nStep: buy size. How much SOL the agent spends on one buy. Slippage is ${slippagePercent(slippageBps)} (change it later in Settings > Advanced).\n`);
      await askBuySize(perTradeCap.kind === "lamports" ? BigInt(perTradeCap.lamports) : undefined,
        perTradeCap.kind === "lamports" ? lamportsToSol(perTradeCap.lamports) : "");
    }

    // 5. Funding: the verified address, a QR code, a minimum, and a wait until the balance is visible (Esc skips).
    const minimum = setupFundingMinimum(amountLamports);
    let balance: bigint | undefined;
    const address = await deps.walletAddress();
    if (!address) await io.write("\nThe trading wallet address is not verified in this runner session yet (unlock it first), so no funding address is shown.\n");
    else {
      await io.write([``, "Step: fund the trading wallet. Send SOL to this address (Solana only):", `  ${address}`, ""].join("\n"));
      try { await io.write(renderTerminalQrPlain(address).join("\n") + "\n"); } catch { /* The text address above is complete. */ }
      await io.write(`Send at least ${solText(minimum)}: one buy of ${amountSol} SOL plus about ${solText(SETUP_FUNDING_MARGIN_LAMPORTS)} for fees. `
        + "Fund it only with what the agent may use. Waiting for the balance... (Esc skips)\n");
      const stop = deps.interrupt();
      try {
        let shown = "";
        while (!stop.signal.aborted) {
          balance = await deps.balance();
          const line = balance === undefined ? "The balance could not be read right now; trying again." : `Balance: ${solText(balance)}`;
          if (line !== shown) { shown = line; await io.write(`${line}\n`); }
          if (balance !== undefined && balance >= minimum) { await io.write("Funds received.\n"); break; }
          await deps.sleep(FUNDING_POLL_MS, stop.signal);
        }
        if (stop.signal.aborted) await io.write("Funding wait skipped. The agent cannot buy until the wallet holds enough SOL.\n");
      } finally { stop.release(); }
    }

    // 6. A percentage limit is fixed into SOL now, from the wallet balance after funding, so the summary shows the SOL amount the save
    // must reproduce exactly (the limits command fixes it again at save time and refuses any other amount).
    const choice = (cap: PrivateCapRequest): PrivateCapChoice => (cap.kind === "percent" ? { kind: "none" } : cap);
    let fixed: PrivateSpendCapQuote = { perTrade: choice(perTradeCap), daily: choice(dailyCap), perTradeBasis: null, dailyBasis: null };
    if (perTradeCap.kind === "percent" || dailyCap.kind === "percent") {
      const quoted = await deps.quoteLimits(perTrade, daily);
      if (!quoted.ok) {
        throw new Leave(`${quoted.text} A percentage limit is fixed into SOL from the wallet balance before the summary, and that was not possible now, `
          + "so nothing was saved. Open the setup card again with SOL amounts (or none), or once the funded wallet's balance can be read.");
      }
      fixed = quoted.quote;
      await io.write(`\nYour percentage limits, fixed into SOL from the wallet balance now: ${formatPrivateCap(fixed.perTrade, fixed.perTradeBasis)} per buy, `
        + `${formatPrivateCap(fixed.daily, fixed.dailyBasis)} per UTC day. They do not follow the balance later.\n`);
      if (fixed.perTrade.kind === "lamports" && amountLamports > BigInt(fixed.perTrade.lamports)) {
        if (directiveAmount !== undefined) {
          throw new Leave(`Your directive buys ${directiveAmount} SOL, above that per-buy limit. Nothing was saved; open the setup card again with a larger `
            + "per-buy limit, or change the amount in your directive.");
        }
        await io.write(`A buy of ${amountSol} SOL is above that per-buy limit. Choose a smaller size (a smaller buy needs no more funding).\n`);
        await askBuySize(BigInt(fixed.perTrade.lamports), lamportsToSol(fixed.perTrade.lamports));
      }
    }

    // 7. One plain review of everything, one typed confirmation (code-built from the compiled rules; no JSON).
    const facts = await deps.facts();
    const sources = launchpadIds === undefined ? "launchpads unchanged (the catalog could not be read)"
      : launchpadIds.length ? `launchpads ${launchpadIds.join(", ")}` : "no launchpad";
    const phrase = `CONFIRM ${agentId}`;
    await io.write(["", `Summary: everything ${agentId} will do once armed`,
      `  Your directive: ${text}`,
      "  What it does (built by the runner from the checked rules; not written by the AI model):",
      ...setupRulesSummary(review.compilation.rules, privateCompilationMaxPositions(review.compilation), review.compilation.compiled)
        .map((line) => `    ${line}`),
      "  Trading: automatic within your limits, with no approval per trade (this turns per-trade approval off). Every safety check still applies.",
      `  Signal sources: ${sources}; Telegram and Discord sources as set on your Hub page`,
      `  Buy size: ${amountSol} SOL per buy${directiveAmount !== undefined ? " (your directive)" : ""}; slippage ${slippagePercent(slippageBps)} (Settings > Advanced)`,
      `  Spend limits: at most ${limitSummary(fixed.perTrade, fixed.perTradeBasis)} per buy, ${limitSummary(fixed.daily, fixed.dailyBasis)} per UTC day`,
      ...(ceiling ? [`  Signed spend ceiling: ${lamportsToSol(ceiling.perTradeLamports)} per trade, ${lamportsToSol(ceiling.dailyLamports)} per day`] : []),
      ...(facts.model ? [`  AI model: ${facts.model}`] : []), ...(facts.budget ? [`  Daily AI budget: ${facts.budget} per UTC day`] : []),
      ...(address ? [`  Trading wallet: ${address}${balance === undefined ? "" : `, ${solText(balance)}`}`] : []),
      "  Arming comes next and stays separate: its own review, the typed ARM and your passphrase. Nothing trades before that.",
      `Type exactly ${phrase} to save all of this; any other answer saves nothing.`, ""].join("\n"));
    if (await ask("> ") !== phrase) { await io.write("Not confirmed. Nothing was saved.\n"); return { kind: "left", reason: "Not confirmed. Nothing was saved." }; }

    // 8. Save in dependency order (sizing records the rule revision it was set against).
    const saved: string[] = [];
    const compiled: SetupCompiledRules = { rulesDigest: review.compilation.rulesDigest, compiledDigest: review.compilation.compiledDigest };
    const steps: Array<[string, () => Promise<SetupApplyResult>]> = [
      ["rules", () => deps.apply.rules(text, compiled)], ["automatic trading", () => deps.apply.approvalOff()],
      ["spend limits", () => deps.apply.limits(perTrade, daily, fixed)], ["buy size", () => deps.apply.sizing(amountSol, slippageBps)],
      ...(launchpadIds === undefined ? [] : [["signal sources", () => deps.apply.sources(launchpadIds!)] as [string, () => Promise<SetupApplyResult>]]),
    ];
    for (const [name, run] of steps) {
      let result: SetupApplyResult;
      try { result = await run(); } catch { result = { ok: false, text: `The ${name} could not be saved.` }; }
      await io.write(`${result.ok ? "Saved" : "Not saved"}: ${name}. ${result.text}\n`);
      if (!result.ok) {
        await io.write(`Saved so far: ${saved.length ? saved.join(", ") : "nothing"}. The rest was not sent. The next card continues from the current state.\n`);
        return { kind: "partial", saved, failed: name };
      }
      saved.push(name);
    }
    // 9. Arm: the existing command, unchanged.
    await io.write("\nEverything is saved. Last step: arm live trading.\n");
    await deps.arm();
    return { kind: "armed_step" };
  } catch (error: unknown) {
    if (error instanceof Leave) { await io.write(`${error.reason}\n`); return { kind: "left", reason: error.reason }; }
    throw error;
  }
}
