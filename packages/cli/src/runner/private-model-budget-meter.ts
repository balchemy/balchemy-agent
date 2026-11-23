/** The metering decorator around the owner's model adapter. It is applied at the PrivateBrainModels seam, so it covers
 * every model call of the runner: owner chat (private-conversation) and autonomous signal decisions (private-signal-decision).
 * Before the call it reserves a conservative estimate and refuses with `model_budget_exhausted` WITHOUT calling the provider
 * when the estimate does not fit today's budget. After the call it settles exactly once: at the charge OpenRouter reports,
 * else at the reported tokens times the table price, else (failure, abort, timeout) at the full estimate. */
import type { LlmAdapter, LlmMessage, LlmRequestOptions, LlmResponse } from "@balchemyai/agent-sdk";
import type { PrivateBrainProvider } from "./private-brain-providers.js";
import { PrivateModelBudgetError, type PrivateModelBudget } from "./private-model-budget.js";
import { privateModelCallEstimateMicroUsd, privateModelCallMicroUsd, privateModelPrice, type PrivateModelPrice } from "./private-model-prices.js";

/** The SDK adapters' own default when a caller passes no maximum. */
const ADAPTER_DEFAULT_MAX_TOKENS = 500;

/** `captured`: the OpenRouter catalog price stored for exactly this model (Phase 2, private-model-budget.ts), else the table. */
export function privateModelCallEstimate(provider: PrivateBrainProvider, model: string, messages: readonly LlmMessage[], maxTokens: number,
  captured?: PrivateModelPrice): number {
  return privateModelCallEstimateMicroUsd(captured ?? privateModelPrice(provider, model).price, messages, maxTokens);
}

/** Integer micro-USD of one completed call; the estimate when the response carries no usable usage. */
export function privateModelResponseMicroUsd(provider: PrivateBrainProvider, model: string, response: LlmResponse, estimateMicroUsd: number,
  captured?: PrivateModelPrice): number {
  try {
    if (provider === "openrouter" && typeof response.costUsd === "number" && Number.isFinite(response.costUsd) && response.costUsd >= 0
      && response.costUsd <= 1_000_000) {
      // Floating dollars to whole micro-USD, rounded up; the epsilon absorbs binary representation (0.000123 * 1e6).
      return Math.max(0, Math.ceil(response.costUsd * 1_000_000 - 1e-6));
    }
    return privateModelCallMicroUsd(captured ?? privateModelPrice(provider, model).price, response.inputTokens, response.outputTokens);
  } catch { return estimateMicroUsd; }
}

export interface PrivateModelMeterScope { agentId: string; provider: PrivateBrainProvider; model: string }

export function meterPrivateModelAdapter(adapter: LlmAdapter, scope: PrivateModelMeterScope, budget: () => PrivateModelBudget): LlmAdapter {
  let model = scope.model;
  return Object.freeze({
    setModel(next: string): void { adapter.setModel(next); model = next; },
    async chat(messages: LlmMessage[], maxTokens?: number, options?: LlmRequestOptions): Promise<LlmResponse> {
      const priced = model;
      const store = budget();
      const captured = store.modelPrice(scope.agentId, scope.provider, priced);
      let estimate: number;
      try { estimate = privateModelCallEstimate(scope.provider, priced, messages, maxTokens ?? ADAPTER_DEFAULT_MAX_TOKENS, captured); }
      catch { throw new PrivateModelBudgetError("invalid_request"); }
      // Throws model_budget_exhausted, clock_rollback or state_unavailable: the provider is never called then.
      const reservationId = store.reserve(scope.agentId, estimate);
      let actual = estimate;
      try {
        const response = await adapter.chat(messages, maxTokens, options);
        actual = privateModelResponseMicroUsd(scope.provider, priced, response, estimate, captured);
        return response;
      } finally {
        // A failed settle leaves the store held, so every later call is refused; the call itself already happened.
        try { store.settle(scope.agentId, reservationId, actual); } catch { /* Fail closed through the held store. */ }
      }
    },
  });
}
