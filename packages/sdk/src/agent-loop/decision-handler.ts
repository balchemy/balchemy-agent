import type { LlmAdapter, AgentEvent, AgentDecision, LlmResponse } from './types';
import { LlmCostTracker } from './llm-cost-tracker';

export interface DecisionContext {
  compressedRules: string;
  portfolioValue: number;
  portfolioSummary?: string;
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
          content: `You are a trading agent. ${context.compressedRules}\nPortfolio value: ${context.portfolioValue} SOL.\nRespond ONLY with a JSON object: {"action":"buy|sell|hold","token":"...","amount":"...","reasoning":"..."}`,
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

      let decision: AgentDecision;
      try {
        decision = JSON.parse(response.text) as AgentDecision;
      } catch {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.paused = true;
        return null;
      }

      if (!decision.action) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.paused = true;
        return null;
      }

      // Success — reset failure counter
      this.consecutiveFailures = 0;
      return decision;
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
