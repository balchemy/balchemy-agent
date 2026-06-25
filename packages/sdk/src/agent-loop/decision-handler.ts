import type { LlmAdapter, AgentEvent, AgentDecision, AgentDecisionAction, LlmResponse } from './types';
import { LlmCostTracker } from './llm-cost-tracker';

export interface DecisionContext {
  compressedRules: string;
  portfolioValue: number;
  portfolioValueUnit?: string;
  portfolioSummary?: string;
}

const VALID_DECISION_ACTIONS = new Set<AgentDecisionAction>([
  'buy',
  'sell',
  'hold',
  'blocked',
  'degraded',
  'approval_required',
]);

const VALID_AMOUNT_SOURCES = new Set(['rules', 'config', 'explicit_user']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNumericAmount(value: unknown): value is string {
  return isNonEmptyString(value) && /^\d+(?:\.\d+)?$/.test(value.trim());
}

function hasExitPolicy(value: unknown): boolean {
  if (isNonEmptyString(value)) {
    return true;
  }
  const record = asRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

function isSourceHealthEvidence(value: unknown): boolean {
  if (asRecord(value)) {
    return true;
  }
  return Array.isArray(value) && value.length > 0 && value.every((item) => asRecord(item) !== null);
}

function isExecutableDecision(record: Record<string, unknown>): boolean {
  const amountSource = record.amountSource;
  return isNonEmptyString(record.token)
    && isNumericAmount(record.amount)
    && isNonEmptyString(record.amountUnit)
    && isNonEmptyString(record.chain)
    && isNonEmptyString(record.evidenceId)
    && isNonEmptyString(amountSource)
    && VALID_AMOUNT_SOURCES.has(amountSource.trim())
    && isSourceHealthEvidence(record.sourceHealth)
    && isStringArray(record.missingFacts)
    && hasExitPolicy(record.exitPolicy)
    && (record.requiredApprovals === undefined || isStringArray(record.requiredApprovals));
}

function isAgentDecision(value: unknown): value is AgentDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.action !== 'string' || !VALID_DECISION_ACTIONS.has(record.action as AgentDecisionAction)) {
    return false;
  }
  return record.action === 'buy' || record.action === 'sell'
    ? isExecutableDecision(record)
    : true;
}

function buildInvalidActionableDecision(value: unknown): AgentDecision | null {
  const record = asRecord(value);
  if (!record || (record.action !== 'buy' && record.action !== 'sell')) {
    return null;
  }
  return {
    action: 'blocked',
    token: typeof record.token === 'string' ? record.token : undefined,
    amount: typeof record.amount === 'string' ? record.amount : undefined,
    reasoning: 'Blocked: LLM returned an actionable trade without the required evidence, chain, amount unit, source health, missingFacts, approvals, and exitPolicy fields.',
  };
}

export interface DecisionHandlerOptions {
  maxConsecutiveFailures?: number;
}

export interface LastCallStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class DecisionHandler {
  private readonly llm: LlmAdapter;
  private readonly costTracker: LlmCostTracker;
  private readonly maxConsecutiveFailures: number;
  private consecutiveFailures = 0;
  private paused = false;
  private lastCall: LastCallStats | null = null;

  constructor(
    llm: LlmAdapter,
    costTracker: LlmCostTracker,
    options?: DecisionHandlerOptions,
  ) {
    this.llm = llm;
    this.costTracker = costTracker;
    this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 3;
  }

  async handleEvent(
    event: AgentEvent,
    context: DecisionContext,
  ): Promise<AgentDecision | null> {
    if (this.paused) return null;

    if (!this.costTracker.canCallLlm()) {
      return null;
    }

    try {
      const response: LlmResponse = await this.llm.chat([
        {
          role: 'system',
          content:
            `You are a Balchemy autonomous Web3 operator. ${context.compressedRules}\n` +
            `Portfolio value: ${context.portfolioValue} ${context.portfolioValueUnit ?? 'unknown unit'}.\n` +
            `Use fresh evidence only. If runtime state, rules, source health, token, chain, amount, risk facts, or exit policy are missing, do not invent them.\n` +
            `For buy/sell, include exact token, chain, amount, amountUnit, amountSource, evidenceId, sourceHealth, missingFacts, requiredApprovals, and exitPolicy.\n` +
            `Use the refId from the latest agent_candidate_report/agent_risk_report workingSetSummary as evidenceId; do not invent evidence ids or source health.\n` +
            `Respond ONLY with JSON: {"action":"buy|sell|hold|blocked|degraded|approval_required","token":"...","chain":"solana|base|ethereum","amount":"...","amountUnit":"SOL|ETH|USDC|token_units","amountSource":"rules|config|explicit_user","confidence":0.0,"evidenceId":"asset:...","sourceHealth":[{"source":"...","status":"ok","fetchedAt":"..."}],"missingFacts":[],"requiredApprovals":[],"exitPolicy":"...","reasoning":"..."}`,
        },
        {
          role: 'user',
          content: `Event: ${event.type}\nData: ${JSON.stringify(event.data)}`,
        },
      ]);

      this.costTracker.trackCall(response.inputTokens, response.outputTokens, response.model);

      // Capture stats for AgentLoop telemetry reporter
      this.lastCall = {
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: this.costTracker.computeCallCost(response.inputTokens, response.outputTokens, response.model),
      };

      let parsedDecision: unknown;
      try {
        parsedDecision = JSON.parse(response.text) as unknown;
      } catch {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.paused = true;
        return null;
      }

      if (!isAgentDecision(parsedDecision)) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.paused = true;
        return buildInvalidActionableDecision(parsedDecision);
      }

      // Success — reset failure counter
      this.consecutiveFailures = 0;
      return parsedDecision;
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.paused = true;
      return null;
    }
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  isPaused(): boolean {
    return this.paused;
  }

  resume(): void {
    this.paused = false;
    this.consecutiveFailures = 0;
  }

  /** Override the active model on the underlying LLM adapter. Used by ModelRouter. */
  setModel(model: string): void {
    this.llm.setModel(model);
  }

  /**
   * Returns cost/token stats from the most recent LLM call, or null if no
   * call has been made yet. Consumed by AgentLoop for telemetry reporting.
   */
  getLastCallStats(): LastCallStats | null {
    return this.lastCall;
  }
}
