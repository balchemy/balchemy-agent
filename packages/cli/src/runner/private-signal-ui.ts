/** Deliberate local readback of recommendations, never execution or resubmission. */
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { privateSignalBinding, requestPrivateSignal, type PrivateSignalTransport } from "./private-signal-client.js";
import { parsePrivateSignalRequest, validatePrivateSignalReply, type PrivateSignalData,
  type PrivateSignalResponse, type PrivateSignalReadError, type PrivateSignalSummary } from "./private-signal-protocol.js";
import type { PrivateSignalPlan, PrivateSignalPlanReason } from "./private-signal-plan.js";
import type { PrivateSignalAssessment, PrivateAssessmentPretradeReason, PrivateAssessmentNotRequestedReason,
  PrivateAssessmentFailureReason, PrivateAssessmentUnavailableReason } from "./private-signal-job.js";
import type { PrivateExecutionIntentState, PrivateExecutionOutcomeView } from "./private-execution-intents.js";

interface Options {
  action: "list" | "read"; args: string[]; directory: string;
  flags: Pick<CliFlags, "yes" | "force" | "dryRun" | "quiet">;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateSignalTransport;
}
export type SignalCommandResult = (PrivateSignalData & { execution: "not_executed" }) | { kind: "dry_run" };
function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid signal decision command",
    cause: "Use runner decisions <agent> [--before <positive ordinal>] or runner decision <agent> <job-id>.",
    fix: "Copy the next-page command or job ID from the local decision list. These commands only read saved results.", exitCode: 2 });
}
function unavailable(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Signal decision read unavailable",
    cause: "The selected local runner could not return a validated response.",
    fix: "Check runner status and retry the same read when it is available. No work was submitted.", exitCode: 1 });
}
function refused(code: PrivateSignalReadError): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Signal decision read refused",
    cause: `The local runner returned ${code}.`,
    fix: code === "job_not_found" ? "List decisions for the same local agent and use an exact job ID."
      : "Check the selected agent and runner status, then retry this read. No work was submitted.",
    exitCode: ["job_not_found", "unknown_agent", "invalid_request", "profile_conflict", "instance_conflict"].includes(code) ? 2 : 1 });
}
export async function runPrivateSignalCommand(options: Options): Promise<SignalCommandResult> {
  const [agentId, second, third] = options.args;
  let beforeOrdinal: number | undefined;
  if (!isId(agentId) || options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.action === "list") {
    if (options.args.length !== 1) {
      if (options.args.length !== 3 || second !== "--before" || !third || !/^[1-9][0-9]*$/.test(third)
        || !Number.isSafeInteger(Number(third))) invalid();
      beforeOrdinal = Number(third);
    }
  } else if (options.args.length !== 2 || !second || !/^signal_[0-9a-f]{64}$/.test(second)) invalid();
  if (options.flags.dryRun) return { kind: "dry_run" };
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== agentId) invalid();
  const request = parsePrivateSignalRequest({ ...privateSignalBinding(target), ...(options.action === "list"
    ? { action: "list", ...(beforeOrdinal === undefined ? {} : { beforeOrdinal }) } : { action: "read", jobId: second }) });
  let response: PrivateSignalResponse;
  try { response = validatePrivateSignalReply(request, await (options.transport ?? requestPrivateSignal)(target.socketPath, request)); }
  catch { return unavailable(); }
  if (!response.ok) return refused(response.error);
  return { ...response.data, execution: "not_executed" };
}
function time(value: number): string {
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : "time unavailable";
}
function state(value: Pick<PrivateSignalSummary, "state" | "action" | "reason">): string {
  if (value.state === "completed") return `${value.action} recommendation`;
  if (value.state === "received") return "received; awaiting evaluation";
  if (value.state === "running") return "evaluating";
  if (value.state === "held") return `held (${value.reason})`;
  if (value.state === "failed") return `evaluation failed (${value.reason})`;
  return value.state;
}
const PLAN_REASONS: Record<PrivateSignalPlanReason, string> = {
  snapshot_unrepresentable: "The complete policy snapshot exceeds the supported plan size; execution remains unavailable.",
  decision_hold: "The decision was to hold.", decision_skip: "The decision was to skip.",
  position_authority_missing: "Sell sizing requires verified position authority.", runtime_disallowed: "The recorded runtime did not permit this plan.",
  rules_unavailable: "Confirmed rules were unavailable.", compiler_unsupported: "The recorded rule compiler did not support amount selection.",
  amount_instruction_unsupported: "The rule's amount instruction could not be resolved safely.",
  amount_unit_unsupported: "The rule amount was not an exact SOL amount.", amount_invalid: "No valid exact buy amount could be selected.",
  setup_policy_missing: "Owner sizing was not configured.",
  native_cap_exceeded: "The selected amount exceeded the recorded native trade cap.", evidence_stale: "Required research evidence was stale or missing.",
};
const PLAN_GATES: Record<PrivateSignalPlan["unavailableGates"][number], string> = {
  price: "price", balance: "balance", spending_ceiling: "spending ceiling", global_fee: "fee policy", pretrade: "pre-trade checks",
  slippage_policy: "slippage policy", positions: "positions", trade_rate: "trade rate", approval: "approval",
  live_permission: "live permission", signer: "signer", submission: "submission", reconciliation: "reconciliation",
};
/** Historical parameters remain separate from every outstanding execution gate. */
export function formatPrivateSignalPlan(plan: Pick<PrivateSignalPlan,
  "state" | "reason" | "amount" | "slippageBps" | "policy" | "rule" | "risks" | "unavailableGates">): string {
  const lines = ["Decision plan", plan.state === "resolved" ? "Parameters resolved; execution unavailable."
    : plan.state === "held" ? "Parameters held; execution unavailable." : "No buy plan for this decision; execution unavailable."];
  if (plan.reason) lines.push(`Reason: ${PLAN_REASONS[plan.reason]}`);
  if (plan.amount) {
    lines.push(`Amount: ${plan.amount.amountSol} SOL`, `Lamports: ${plan.amount.amountBaseUnits}`,
      plan.amount.source === "rule" ? `Amount source: confirmed rule${plan.amount.statementIndex === null ? "" : ` statement ${plan.amount.statementIndex + 1}`}.`
        : `Amount source: owner sizing policy revision ${plan.policy?.revision ?? "unavailable"}.`);
  } else lines.push(plan.state === "not_applicable" ? "Amount: not applicable to this decision." : "Amount: unresolved; no fallback amount selected.");
  lines.push(`Slippage: ${plan.slippageBps === null ? "unavailable" : `${plan.slippageBps} bps`}`,
    `Sizing policy revision: ${plan.policy?.revision ?? "not configured"}`,
    `Sizing configured against rules: ${plan.policy?.configuredAgainstRuleRevisionId ?? "none confirmed"}`,
    `Plan rule revision: ${plan.rule?.revisionId ?? "unavailable"}`);
  if (plan.risks) lines.push(`Recorded native trade cap: ${plan.risks.maxTradeNativeBaseUnits === null ? "not set" : `${plan.risks.maxTradeNativeBaseUnits} lamports`}`);
  lines.push("Execution checks still unavailable:", ...plan.unavailableGates.map((gate) => `  - ${PLAN_GATES[gate]}`),
    "This saved plan grants no approval, signature or live permission.");
  return lines.join("\n");
}
const ASSESSMENT_REASONS: Record<PrivateAssessmentNotRequestedReason | PrivateAssessmentFailureReason | PrivateAssessmentUnavailableReason, string> = {
  slippage_above_assessment_bound: "The plan's slippage exceeds the 5000 bps assessment limit, so no assessment was requested. Slippage was not reduced.",
  output_is_input_mint: "The plan's asset is wrapped SOL, the assessment input itself, so no assessment was requested.",
  request_unrepresentable: "The plan could not be expressed as an assessment request, so none was requested.",
  transport_unavailable: "The assessment could not be fetched from Balchemy.",
  invalid_response: "The assessment response did not match this exact plan and was discarded.",
  record_unrepresentable: "The assessment was too large to save beside this plan and was discarded.",
  deadline_insufficient: "Too little of the signal's freshness window remained, so no assessment was requested.",
  deadline_exceeded: "The assessment did not finish within its deadline.",
  quote_unavailable: "No route quote was available.",
  pretrade_unavailable: "Pre-trade safety data was incomplete.",
};
const PRETRADE_REASONS: Record<PrivateAssessmentPretradeReason, string> = {
  "signal_unavailable:rugcheck": "Rugcheck data unavailable", "signal_unavailable:helius": "Mint account data unavailable",
  rugcheck_risks_present: "Rugcheck reported risks", mint_authority_present: "Mint authority is still set",
  freeze_authority_present: "Freeze authority is still set", high_risk_combined: "Combined high risk (Rugcheck risks and mint authority)",
};
function millis(value: string): string { return time(Number(value)); }
/** Historical, expiring read evidence beside an unchanged plan; never an approval or execution state. */
export function formatPrivateSignalAssessment(assessment: PrivateSignalAssessment | undefined): string {
  const lines = ["Pre-trade assessment"];
  if (!assessment) lines.push("Outcome: not recorded for this saved plan.");
  else if (assessment.outcome === "not_requested" || assessment.outcome === "failed") {
    lines.push(`Outcome: ${assessment.outcome === "failed" ? "failed" : "not requested"}`, `Reason: ${ASSESSMENT_REASONS[assessment.reason]}`);
    if (assessment.outcome === "failed") lines.push(`Recorded: ${assessment.failedAt}`);
  } else {
    lines.push(`Outcome: ${assessment.outcome}`);
    if (assessment.reason) lines.push(`Reason: ${ASSESSMENT_REASONS[assessment.reason]}`);
    if (assessment.pretrade) {
      const verdict = { allow: "allow", require_approval: "approval required", block: "block" }[assessment.pretrade.verdict];
      lines.push(`Pre-trade verdict: ${verdict}`, assessment.pretrade.reasons.length === 0 ? "Pre-trade reasons: none"
        : "Pre-trade reasons:", ...assessment.pretrade.reasons.map((reason) => `  - ${PRETRADE_REASONS[reason]}`));
    } else lines.push("Pre-trade verdict: unavailable");
    const fee = assessment.fee;
    lines.push(`Fee: ${fee.rateBps} bps (${fee.feeLamports} lamports); net input ${fee.netInputLamports} lamports`);
    if (assessment.quote) {
      lines.push(`Expected out: ${assessment.quote.outAmount} base units`, `Minimum out: ${assessment.quote.minOut} base units`,
        `Quote slot: ${assessment.quote.contextSlot}`, `Quote observed: ${millis(assessment.quote.observedAtMs)}`);
    } else lines.push("Quote: unavailable");
    lines.push(`Assessed: ${millis(assessment.completedAtMs)}`, `Expires: ${millis(assessment.expiresAtMs)}`);
  }
  lines.push("This assessment is time-limited evidence only; it grants no approval and execution remains unavailable.");
  return lines.join("\n");
}
const OUTCOMES: Record<PrivateExecutionIntentState, string> = { queued: "queued for execution", running: "executing now",
  submitted: "signed locally and relayed through Balchemy", refused: "refused, not executed", not_executed: "not executed",
  expired: "expired before execution, not executed", held: "outcome unknown; the wallet stays held only while its spend is still reserved (runner wallet <agent> limits) or its trade is still open (runner trades)" };
/** M3.2 S5: plain owner text for Balchemy's signed-cap refusals of a buy (`build:server:<code>`) and (M3.6) the runner's
 * Balchemy-sync refusals; null for every other reason.
 * The one-time wallet approval cannot be requested by this version yet (slice S6), so the text never offers it. */
const OWNER_APPROVAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  owner_approval_missing: "Balchemy refused this buy: automatic buys need your one-time approval, signed with your paired wallet, "
    + "for this agent and trading wallet. This version cannot request that approval yet, so the agent cannot buy automatically. "
    + "Nothing was spent; stop-loss and other exits are not affected.",
  owner_cap_exceeded: "Balchemy refused this buy: it is above the spend limits you approved with your wallet (per trade or per day; "
    + "\"no daily limit\" counts as above a signed daily limit). This version cannot request a new approval yet. Lower the limits with "
    + "balchemy runner wallet <agent> limits so they are within the approved ones. Nothing was spent; exits are not affected.",
});
/** M3.6: the runner's own refusals after waiting for Balchemy (private-execution-intents.ts PRIVATE_EXECUTION_SYNC_WAIT_MS). */
const SYNC_WAIT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  arm_unconfirmed: "Not bought: Balchemy did not confirm this agent's armed state within 30 seconds, so no buy was requested. "
    + "Nothing was spent. Check the connection with balchemy runner status <agent>.",
  signal_ack_unconfirmed: "Not bought: Balchemy did not confirm receiving this signal within 30 seconds, so no buy was requested. "
    + "Nothing was spent.",
});
/** S4 fee policy (private-fee-policy.ts): the runner's own refusals of a buy whose fee is outside its compiled-in policy
 * (`build:local:<code>` before any build request, `build:preflight:<code>` for the built bytes). */
const FEE_POLICY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  fee_policy_rate_above_ceiling: "Not bought: Balchemy's fee for this trade is above the 1.5 % (150 bps) this runner accepts. "
    + "Nothing was signed or spent.",
  fee_policy_recipient_unknown: "Not bought: the fee would go to an address that is not one of Balchemy's fee wallets built into this runner. "
    + "Nothing was signed or spent.",
});
/** The owner's "max N positions at a time" (private-typed-rules.ts privateMaxPositionsRefusal). */
function maxPositionsText(reason: string | null): string | null {
  const limit = /^max_positions:([1-9][0-9]{0,3})$/.exec(reason ?? "");
  if (limit) return `Not bought: max ${limit[1]} positions reached. Your rules allow at most ${limit[1]} tokens at a time, and that many are already held `
    + "or being bought. Nothing was spent. A buy into a token already held (a DCA add) is not limited by this.";
  return reason === "max_positions_unknown"
    ? "Not bought: the runner could not count the positions this agent holds, so the max positions rule holds the buy. Nothing was spent." : null;
}
export function privateExecutionReasonText(reason: string | null): string | null {
  if (reason !== null && Object.hasOwn(SYNC_WAIT_TEXT, reason)) return SYNC_WAIT_TEXT[reason]!;
  const positions = maxPositionsText(reason);
  if (positions) return positions;
  const policy = reason?.match(/^build:(?:local|preflight):(fee_policy_[a-z_]+)$/)?.[1];
  if (policy !== undefined && Object.hasOwn(FEE_POLICY_TEXT, policy)) return FEE_POLICY_TEXT[policy]!;
  const code = reason?.startsWith("build:server:") ? reason.slice("build:server:".length) : null;
  return code !== null && Object.hasOwn(OWNER_APPROVAL_TEXT, code) ? OWNER_APPROVAL_TEXT[code]! : null;
}
/** One line per recorded execution outcome; the trade's own state comes from the local journal (runner trades). */
export function formatPrivateExecutionOutcome(outcome: PrivateExecutionOutcomeView): string {
  const explained = privateExecutionReasonText(outcome.reason);
  const head = `${OUTCOMES[outcome.state]}${outcome.reason ? ` (${outcome.reason})` : ""}${explained ? `. ${explained}` : ""}`;
  return outcome.attemptKey ? `${head}; trade ${outcome.attemptKey}: ${outcome.trade ?? "not in the local journal"}` : head;
}
export function formatPrivateSignalResult(result: SignalCommandResult, agentId: string): string {
  if (result.kind === "dry_run") return "Read-only signal decision command; no connection or work submitted.\n";
  const recorded = result.kind === "list" ? result.page.items.some((item) => item.executionOutcome) : result.executionOutcome !== undefined;
  const boundary = recorded ? "A saved recommendation never approves a trade by itself; an armed agent's execution outcome is shown per decision.\n"
    : "Not executed. Saved recommendations do not approve, sign or submit trades.\n";
  if (result.kind === "list") {
    const lines = [`Signal decisions for ${agentId}`, boundary.trimEnd()];
    if (result.page.items.length === 0) lines.push("No saved signal decisions on this page.");
    for (const item of result.page.items) lines.push("", `#${item.ordinal} · ${state(item)} · ${time(item.updatedAt)}`,
      `  ${item.refId}`, `  Source: ${item.platform} ${item.sourceId}`, `  Job: ${item.jobId}`,
      ...(item.executionOutcome ? [`  Execution: ${formatPrivateExecutionOutcome(item.executionOutcome)}`] : []));
    if (recorded) lines.push("", `Trades: balchemy runner trades ${agentId}`);
    if (result.page.nextBeforeOrdinal !== null) lines.push("", `Older: balchemy runner decisions ${agentId} --before ${result.page.nextBeforeOrdinal}`);
    if (result.page.items.length > 0) lines.push("", `Details: balchemy runner decision ${agentId} <job-id>`);
    return `${lines.join("\n")}\n`;
  }
  const job = result.job; const signal = job.receipt.signal;
  return [`Signal decision for ${agentId}`, boundary.trimEnd(), "Historical record; current conditions were not rechecked.", "",
    `Result: ${state({ state: job.state, action: job.result?.decision.action, reason: job.reason ?? job.error })}`,
    `Asset: asset:${signal.chain}:${signal.assetId}`, `Source: ${signal.platform} ${signal.sourceId}`,
    `Received: ${job.receipt.receivedAt}`, `Updated: ${time(job.updatedAt)}`, `Job: ${job.jobId}`,
    ...(result.executionOutcome ? [`Execution: ${formatPrivateExecutionOutcome(result.executionOutcome)}`] : []),
    ...(job.start ? [`Rules: ${job.start.ruleRevisionId}`] : []),
    ...(job.result?.plan ? ["", formatPrivateSignalPlan(job.result.plan),
      ...(job.result.plan.state === "resolved" ? ["", formatPrivateSignalAssessment(job.result.assessment)] : [])]
      : job.result ? ["", "No decision plan was recorded for this historical result. No amount or authority is inferred."] : []), ""].join("\n");
}
