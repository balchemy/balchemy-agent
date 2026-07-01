import { SseEventStream } from '../streaming/sse-event-stream';
import { randomUUID } from 'node:crypto';
import type { SseEvent } from '../streaming/sse-event-stream';
import { BalchemyMcpClient, connectMcp, parseToolJson } from '../mcp/mcp-client';
import { LlmCostTracker } from './llm-cost-tracker';
import { DecisionHandler } from './decision-handler';
import { WebhookReceiver } from './webhook-receiver';
import { OpenAiAdapter } from './llm-adapters/openai';
import { AnthropicAdapter } from './llm-adapters/anthropic';
import { ModelRouter } from './model-router';
import { TelemetryReporter } from './telemetry-reporter';
import { checkAllRules } from './rule-checker';
import type { BehaviorRuleLimits } from './rule-checker';
import type { McpCallToolResponse } from '../types';
import type {
  AgentLoopConfig,
  AgentStatus,
  AgentLoopStatus,
  AgentEvent,
  AgentDecision,
  LlmAdapter,
  AgentPortfolioSnapshot,
} from './types';

interface PortfolioCache {
  snapshot: AgentPortfolioSnapshot;
  fetchedAt: number;
}

interface RulesCache {
  compressed: string;
  fetchedAt: number;
}

const PORTFOLIO_TTL_MS = 30_000;         // 30 seconds
const RULES_TTL_MS    = 5 * 60_000;      // 5 minutes
const RULES_FAILURE_TTL_MS = 30_000;     // 30 seconds

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildRuntimeStatusSnapshot(parsed: Record<string, unknown>): AgentPortfolioSnapshot {
  const structured = asRecord(parsed.structured) ?? parsed;
  const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
    ? parsed.reply
    : undefined;
  return {
    ...(reply ? { summary: reply } : {}),
    runtimeStatus: structured,
  };
}

function getAutonomousRuntimeState(snapshot: AgentPortfolioSnapshot): Record<string, unknown> | null {
  const runtimeStatus = asRecord(snapshot.runtimeStatus);
  return asRecord(runtimeStatus?.autonomous_runtime)
    ?? asRecord(runtimeStatus?.autonomousRuntime)
    ?? asRecord(snapshot.autonomous_runtime)
    ?? asRecord(snapshot.autonomousRuntime);
}

function isRuntimeLiveArmed(snapshot: AgentPortfolioSnapshot): boolean {
  const runtime = getAutonomousRuntimeState(snapshot);
  if (!runtime) {
    return false;
  }
  return runtime.mode === 'live_armed'
    && runtime.armed === true
    && runtime.paused !== true;
}

function isRuntimePaused(snapshot: AgentPortfolioSnapshot): boolean {
  const runtime = getAutonomousRuntimeState(snapshot);
  return runtime?.paused === true || runtime?.mode === 'paused';
}

function hasRuntimeStatusSnapshot(snapshot: AgentPortfolioSnapshot): boolean {
  const runtimeStatus = asRecord(snapshot.runtimeStatus);
  return Boolean(runtimeStatus && Object.keys(runtimeStatus).length > 0);
}

type SupportedTradeChain = 'solana' | 'base' | 'ethereum';

type ExecutableDecisionValidation =
  | { allowed: true; chain: SupportedTradeChain; amountUnit: string }
  | { allowed: false; action: 'blocked' | 'degraded' | 'approval_required'; reason: string };

const VALID_AMOUNT_SOURCES = new Set(['rules', 'config', 'explicit_user']);
const GOOD_SOURCE_HEALTH_VALUES = new Set([
  'available',
  'fresh',
  'healthy',
  'ok',
]);
const BAD_SOURCE_HEALTH_VALUES = new Set([
  'blocked',
  'degraded',
  'error',
  'failed',
  'failing',
  'no_data',
  'quota_blocked',
  'rate_limited',
  'stale',
  'unavailable',
  'unknown',
]);

function normalizeTradeChain(chain: string | undefined): SupportedTradeChain | null {
  const normalized = chain?.trim().toLowerCase();
  if (normalized === 'solana' || normalized === 'sol') return 'solana';
  if (normalized === 'base') return 'base';
  if (normalized === 'ethereum' || normalized === 'eth') return 'ethereum';
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyObject(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function hasExitPolicy(value: unknown): boolean {
  return isNonEmptyString(value) || isNonEmptyObject(value);
}

function sourceHealthIsUsable(value: unknown): boolean {
  const initialRecords = Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [asRecord(value)].filter((item): item is Record<string, unknown> => item !== null);
  if (initialRecords.length === 0 || initialRecords.some((record) => Object.keys(record).length === 0)) {
    return false;
  }
  let sawPositiveHealthSignal = false;

  const stack: Record<string, unknown>[] = [...initialRecords];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (current.ok === false || current.degraded === true || current.unavailable === true) {
      return false;
    }
    if (current.ok === true) {
      sawPositiveHealthSignal = true;
    }
    for (const key of ['status', 'state', 'health', 'sourceStatus']) {
      const raw = current[key];
      if (typeof raw !== 'string') {
        continue;
      }
      const normalized = raw.trim().toLowerCase();
      if (BAD_SOURCE_HEALTH_VALUES.has(normalized)) {
        return false;
      }
      if (GOOD_SOURCE_HEALTH_VALUES.has(normalized)) {
        sawPositiveHealthSignal = true;
      }
    }
    for (const key of ['sources', 'sourceHealth', 'source_health', 'providers', 'sourceStatuses']) {
      const nested = current[key];
      if (Array.isArray(nested)) {
        stack.push(...nested.map(asRecord).filter((item): item is Record<string, unknown> => item !== null));
        continue;
      }
      const nestedRecord = asRecord(nested);
      if (nestedRecord) {
        stack.push(nestedRecord);
        stack.push(...Object.values(nestedRecord).map(asRecord).filter((item): item is Record<string, unknown> => item !== null));
      }
    }
  }

  return sawPositiveHealthSignal;
}

function validateExecutableTradeDecision(decision: AgentDecision): ExecutableDecisionValidation {
  if (!isNonEmptyString(decision.token)) {
    return { allowed: false, action: 'blocked', reason: 'decision is missing exact token' };
  }
  if (!isNonEmptyString(decision.amount)) {
    return { allowed: false, action: 'blocked', reason: 'decision is missing exact amount' };
  }
  if (!/^\d+(?:\.\d+)?$/.test(decision.amount.trim())) {
    return { allowed: false, action: 'blocked', reason: 'decision amount must be numeric without a unit suffix' };
  }
  if (!Number.isFinite(Number.parseFloat(decision.amount)) || Number.parseFloat(decision.amount) <= 0) {
    return { allowed: false, action: 'blocked', reason: 'decision amount is not a positive number' };
  }
  if (!isNonEmptyString(decision.amountUnit)) {
    return { allowed: false, action: 'blocked', reason: 'decision is missing amount unit' };
  }
  const chain = normalizeTradeChain(decision.chain);
  if (!chain) {
    return { allowed: false, action: 'blocked', reason: 'decision is missing an explicit supported chain' };
  }
  if (!isNonEmptyString(decision.amountSource) || !VALID_AMOUNT_SOURCES.has(decision.amountSource.trim())) {
    return { allowed: false, action: 'blocked', reason: 'decision amount source is missing or unsupported' };
  }
  if (!isNonEmptyString(decision.evidenceId)) {
    return { allowed: false, action: 'blocked', reason: 'decision is missing evidence id' };
  }
  if (!sourceHealthIsUsable(decision.sourceHealth)) {
    return { allowed: false, action: 'degraded', reason: 'source health is missing or degraded' };
  }
  if (!isStringArray(decision.missingFacts)) {
    return { allowed: false, action: 'blocked', reason: 'missingFacts must be an explicit array' };
  }
  if (decision.missingFacts.length > 0) {
    return { allowed: false, action: 'blocked', reason: `decision has missing facts: ${decision.missingFacts.join(', ')}` };
  }
  if (Array.isArray(decision.requiredApprovals) && decision.requiredApprovals.length > 0) {
    return { allowed: false, action: 'approval_required', reason: `required approvals: ${decision.requiredApprovals.join(', ')}` };
  }
  if (!hasExitPolicy(decision.exitPolicy)) {
    return { allowed: false, action: 'blocked', reason: 'decision is missing exit policy' };
  }
  if (decision.action === 'buy' && decision.token.trim().toLowerCase() === decision.amountUnit.trim().toLowerCase()) {
    return { allowed: false, action: 'blocked', reason: 'buy target token matches spend unit' };
  }

  return { allowed: true, chain, amountUnit: decision.amountUnit.trim() };
}

function buildTradeCommandMessage(
  decision: AgentDecision,
  chain: SupportedTradeChain,
  amountUnit: string,
): string {
  return `${decision.action} ${decision.amount} ${amountUnit} ${decision.token} on ${chain}`.trim();
}

function getToolResponseText(response: McpCallToolResponse): string {
  return response.content?.find((content) => content.type === 'text')?.text ?? '';
}

function getStringFromRecord(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getPlainResponseStatusText(responseText: string): string | undefined {
  const trimmed = responseText.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return undefined;
  }
  return trimmed;
}

function hasAnyKey(record: Record<string, unknown> | null, keys: string[]): boolean {
  if (!record) {
    return false;
  }
  return keys.some((key) => record[key] !== undefined && record[key] !== null);
}

function hasBroadcastReference(record: Record<string, unknown> | null, depth = 0): boolean {
  if (!record || depth > 3) {
    return false;
  }
  if (hasAnyKey(record, [
    'transactionHash',
    'transaction_hash',
    'txHash',
    'tx_hash',
    'signature',
  ])) {
    return true;
  }
  for (const key of ['order', 'data', 'result', 'execution', 'transaction']) {
    const nested = asRecord(record[key]);
    if (nested && hasBroadcastReference(nested, depth + 1)) {
      return true;
    }
  }
  return false;
}

function collectTradeStatusText(record: Record<string, unknown> | null, depth = 0): string[] {
  if (!record || depth > 3) {
    return [];
  }
  const values = [
    getStringFromRecord(record, 'status'),
    getStringFromRecord(record, 'state'),
    getStringFromRecord(record, 'orderStatus'),
    getStringFromRecord(record, 'message'),
  ].filter((value): value is string => Boolean(value));
  const requiresAction = asRecord(record.requiresAction);
  if (requiresAction) {
    values.push(...[
      getStringFromRecord(requiresAction, 'type'),
      getStringFromRecord(requiresAction, 'reason'),
      getStringFromRecord(requiresAction, 'message'),
    ].filter((value): value is string => Boolean(value)));
  }
  for (const key of ['order', 'data', 'result', 'execution', 'transaction']) {
    values.push(...collectTradeStatusText(asRecord(record[key]), depth + 1));
  }
  return values;
}

function getTradeCommandResult(response: McpCallToolResponse): Record<string, unknown> | null {
  const parsed = parseToolJson<Record<string, unknown>>(response);
  const structured = asRecord(parsed?.structured);
  return asRecord(structured?.result) ?? asRecord(parsed?.result);
}

function classifyTradeCommandOutcome(
  response: McpCallToolResponse,
  decision: AgentDecision,
): { submitted: true; responseText: string } | { submitted: false; action: 'blocked' | 'degraded' | 'approval_required'; responseText: string } {
  const responseText = getToolResponseText(response);
  const result = getTradeCommandResult(response);
  const statusText = [
    ...collectTradeStatusText(result),
    getPlainResponseStatusText(responseText),
  ].filter((value): value is string => Boolean(value)).join(' ').toLowerCase();

  if (/\b(?:not|never|no)\s+(?:accepted|broadcast|confirmed|executed|filled|submitted)\b/.test(statusText)
    || /\bdid\s+not\s+(?:accept|broadcast|confirm|execute|fill|submit)\b/.test(statusText)
    || /\bnot\s+confirmed\b/.test(statusText)) {
    return { submitted: false, action: 'blocked', responseText };
  }
  if (/\b(approval|approve|confirm|confirmation|pending_approval)\b/.test(statusText)) {
    return { submitted: false, action: 'approval_required', responseText };
  }
  if (result?.requiresAction === true || asRecord(result?.requiresAction) !== null) {
    return { submitted: false, action: 'approval_required', responseText };
  }
  if (/\b(degraded|unavailable|rate[_ -]?limited|quota)\b/.test(statusText)) {
    return { submitted: false, action: 'degraded', responseText };
  }
  if (response.isError === true || result?.success === false || /\b(blocked|denied|disabled|failed|failure|rejected|error)\b/.test(statusText)) {
    return { submitted: false, action: 'blocked', responseText };
  }

  const accepted = hasBroadcastReference(result)
    || /\b(accepted|executed|submitted|broadcast|filled|confirmed)\b/.test(statusText);
  if (accepted && decision.action !== 'hold') {
    return { submitted: true, responseText };
  }

  const fallbackText = responseText || 'trade_command did not confirm a submitted or executed order.';
  return {
    submitted: false,
    action: 'blocked',
    responseText: fallbackText,
  };
}

export class AgentLoop {
  private readonly config: AgentLoopConfig;
  private readonly sseEndpoint: string;
  private readonly costTracker: LlmCostTracker;
  private readonly llm: LlmAdapter;
  private readonly decisionHandler: DecisionHandler;
  private readonly mcp: BalchemyMcpClient;
  private readonly modelRouter: ModelRouter | null;
  private readonly telemetry: TelemetryReporter;
  private webhookReceiver: WebhookReceiver | null = null;
  private sseStream: SseEventStream | null = null;
  private unsubscribeSse: (() => void) | null = null;

  private status: AgentLoopStatus = 'stopped';
  private startedAt = 0;
  private eventsReceived = 0;
  private decisionsExecuted = 0;
  private tradesExecuted = 0;
  private lastEventAt: number | undefined;
  private lastTradeAt: number | undefined;
  private seenTraceIds = new Set<string>();

  private portfolioCache: PortfolioCache | null = null;
  private rulesCache: RulesCache | null = null;

  /** Client-side behavior rule limits for pre-check enforcement. */
  private readonly ruleLimits: BehaviorRuleLimits;

  /** Trades executed in the current clock-hour (reset each hour). */
  private tradesThisHour = 0;
  /** Timestamp (ms) of the hour boundary when tradesThisHour was last reset. */
  private currentHourStart = 0;

  /** publicId extracted from the MCP endpoint path (last path segment). */
  private readonly publicId: string;
  private readonly sessionId: string;

  constructor(config: AgentLoopConfig) {
    this.config = config;
    this.sseEndpoint = config.sseEndpoint ??
      `${config.mcpEndpoint}/events/sse`;

    // Extract publicId from endpoint (last path segment after filtering empty segments)
    this.publicId = config.mcpEndpoint.split('/').filter(Boolean).pop() ?? '';
    this.sessionId = config.sessionId ?? `sdk-${this.publicId || randomUUID()}`;

    this.costTracker = new LlmCostTracker({
      maxDailyUsd: config.maxDailyLlmCost ?? 5,
    });

    this.llm = this.createLlmAdapter();
    this.decisionHandler = new DecisionHandler(this.llm, this.costTracker, {
      maxConsecutiveFailures: config.maxConsecutiveFailures ?? 3,
    });

    this.mcp = connectMcp({
      endpoint: config.mcpEndpoint,
      apiKey: config.apiKey,
      fetchFn: config.mcpFetchFn,
    });

    // ModelRouter activates only when both cheapModel and fullModel are configured.
    if (config.cheapModel && config.fullModel) {
      this.modelRouter = new ModelRouter({
        cheapModel: config.cheapModel,
        fullModel: config.fullModel,
      });
    } else {
      this.modelRouter = null;
    }

    // Extract client-side rule limits from behaviorRules config
    this.ruleLimits = extractRuleLimits(config.behaviorRules);

    // Derive the telemetry endpoint from the MCP endpoint:
    //   https://api.balchemy.ai/mcp/abc123  →  https://api.balchemy.ai/api/agent-telemetry/abc123
    const telemetryEndpoint = config.mcpEndpoint.replace(/\/mcp\//, '/api/agent-telemetry/');
    this.telemetry = new TelemetryReporter(
      telemetryEndpoint,
      config.apiKey,
      30_000,
      undefined,
      { sdkVersion: config.sdkVersion, cliVersion: config.cliVersion },
    );
  }

  async start(): Promise<void> {
    this.status = 'starting';
    this.startedAt = Date.now();
    this.telemetry.start();

    // Start webhook receiver if configured
    if (this.config.webhookPort && this.config.webhookSecret) {
      this.webhookReceiver = new WebhookReceiver({
        secret: this.config.webhookSecret,
        port: this.config.webhookPort,
      });
      await this.webhookReceiver.start((event) => this.handleEvent(event));
    }

    // Start SSE stream
    this.sseStream = new SseEventStream(this.sseEndpoint, this.config.apiKey, {
      maxReconnects: 0, // unlimited
      reconnectDelayMs: 2000,
      maxReconnectDelayMs: 30_000,
      jitterFactor: 0.25,
    });

    this.unsubscribeSse = this.sseStream.subscribe(
      (sseEvent: SseEvent) => {
        const event: AgentEvent = {
          id: sseEvent.id,
          type: sseEvent.event,
          data: sseEvent.data,
          timestamp: Date.now(),
          source: 'sse',
        };
        this.handleEvent(event);
      },
      (err: unknown) => {
        this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
      },
    );

    this.status = 'running';
    this.config.onStatusChange?.(this.getStatus());
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    this.unsubscribeSse?.();
    this.sseStream?.close();
    await this.webhookReceiver?.stop();
    this.telemetry.stop();
    this.config.onStatusChange?.(this.getStatus());
  }

  getStatus(): AgentStatus {
    return {
      status: this.status,
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      eventsReceived: this.eventsReceived,
      decisionsExecuted: this.decisionsExecuted,
      tradesExecuted: this.tradesExecuted,
      llmCallsToday: this.costTracker.getCallCount(),
      llmCostToday: this.costTracker.getTodaySpend(),
      maxDailyLlmCost: this.config.maxDailyLlmCost ?? 5,
      consecutiveLlmFailures: this.decisionHandler.getConsecutiveFailures(),
      lastEventAt: this.lastEventAt,
      lastTradeAt: this.lastTradeAt,
      sseConnected: this.status === 'running',
      webhookActive: this.webhookReceiver !== null,
    };
  }

  /**
   * Send a user message to the bot via the ask_bot MCP tool.
   * Parses the JSON envelope returned by the server and extracts the `reply`
   * field if present; otherwise returns the raw text.
   * On network / tool error, calls `config.onError` and returns an error string.
   */
  async sendMessage(message: string): Promise<string> {
    try {
      const response = await this.mcp.callTool('ask_bot', {
        message,
        chat_id: this.sessionId,
      });
      const text = response.content?.find(
        (c: { type: string; text?: string }) => c.type === 'text',
      )?.text ?? '';
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const reply = parsed['reply'] ?? parsed['text'];
        return typeof reply === 'string' ? reply : text;
      } catch (_error: unknown) {
        return text;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.config.onError?.(new Error(`ask_bot failed: ${msg}`));
      return `Error: ${msg}`;
    }
  }

  private handleEvent(event: AgentEvent): void {
    // Deduplicate across SSE + webhook
    if (event.id && this.seenTraceIds.has(event.id)) return;
    if (event.id) {
      this.seenTraceIds.add(event.id);
      // Limit set size
      if (this.seenTraceIds.size > 10_000) {
        const first = this.seenTraceIds.values().next().value;
        if (first) this.seenTraceIds.delete(first);
      }
    }

    this.eventsReceived++;
    this.lastEventAt = Date.now();
    this.config.onEvent?.(event);

    // Check budget
    if (!this.costTracker.canCallLlm()) {
      if (this.status !== 'budget_exhausted') {
        this.status = 'budget_exhausted';
        this.config.onStatusChange?.(this.getStatus());
      }
      return;
    }

    // Check if decision handler is paused (too many failures)
    if (this.decisionHandler.isPaused()) {
      if (this.status !== 'llm_failing') {
        this.status = 'llm_failing';
        this.config.onStatusChange?.(this.getStatus());
      }
      return;
    }

    // Process asynchronously
    void this.processEvent(event);
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    try {
      const portfolio = await this.fetchPortfolio();
      if (!hasRuntimeStatusSnapshot(portfolio)) {
        this.config.onTradeResult?.({
          action: 'degraded',
          response: 'Degraded: agent_status is unavailable or missing runtime state; LLM decision skipped and trade_command was not called.',
        });
        return;
      }
      if (isRuntimePaused(portfolio)) {
        this.config.onTradeResult?.({
          action: 'hold',
          response: 'Runtime paused: event ignored before LLM decision.',
        });
        return;
      }
      const compressedRules = await this.fetchBehaviorRules();
      if (!compressedRules.trim()) {
        this.config.onTradeResult?.({
          action: 'blocked',
          response: 'Blocked: behavior rules are unavailable or empty; LLM decision skipped and trade_command was not called.',
        });
        return;
      }

      // Apply model routing if configured
      let selectedModel: string | null = null;
      let modelTier: 'cheap' | 'full' | null = null;
      if (this.modelRouter) {
        const score = this.modelRouter.score(event);
        selectedModel = this.modelRouter.selectModel(event);
        modelTier = score >= 60 ? 'full' : 'cheap';
        this.decisionHandler.setModel(selectedModel);
        this.telemetry.reportModelRoute({
          eventType: event.type,
          score,
          selectedModel,
          tier: modelTier,
        });
      }

      const llmCallStart = Date.now();
      const portfolioValue = portfolio.totalValueUsd ?? portfolio.totalValueSol ?? 0;
      const portfolioValueUnit = portfolio.totalValueUsd !== undefined
        ? 'USD'
        : portfolio.totalValueSol !== undefined ? 'SOL' : 'unknown unit';
      const decision = await this.decisionHandler.handleEvent(event, {
        compressedRules,
        portfolioValue,
        portfolioValueUnit,
        portfolioSummary: portfolio.summary,
      });
      const llmLatencyMs = Date.now() - llmCallStart;

      // Report LLM call metrics — DecisionHandler exposes last call stats via getCostTracker
      const lastCall = this.decisionHandler.getLastCallStats();
      if (lastCall) {
        this.telemetry.reportLlmCall({
          model: lastCall.model,
          inputTokens: lastCall.inputTokens,
          outputTokens: lastCall.outputTokens,
          latencyMs: llmLatencyMs,
          costUsd: lastCall.costUsd,
        });
      }

      if (!decision || decision.action === 'hold') return;

      this.decisionsExecuted++;
      this.config.onDecision?.(decision);

      this.telemetry.reportDecision({
        action: decision.action,
        token: decision.token,
        amount: decision.amount,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
      });

      if (
        decision.action === 'blocked'
        || decision.action === 'degraded'
        || decision.action === 'approval_required'
      ) {
        this.config.onTradeResult?.({
          action: decision.action,
          token: decision.token,
          amount: decision.amount,
          response: decision.reasoning ?? `Decision ${decision.action}: trade_command was not called.`,
        });
        return;
      }

      // Execute via MCP only when the caller explicitly opted out of shadow mode.
      if (decision.action === 'buy' || decision.action === 'sell') {
        const executableDecision = validateExecutableTradeDecision(decision);
        if (!executableDecision.allowed) {
          const prefix = executableDecision.action === 'degraded'
            ? 'Degraded'
            : executableDecision.action === 'approval_required'
              ? 'Approval required'
              : 'Blocked';
          this.config.onTradeResult?.({
            action: executableDecision.action,
            token: decision.token,
            amount: decision.amount,
            response: `${prefix}: ${executableDecision.reason}; trade_command was not called.`,
          });
          return;
        }
        if (this.config.shadowMode !== false) {
          this.config.onTradeResult?.({
            action: 'shadow',
            token: decision.token,
            amount: decision.amount,
            response: 'Shadow mode: trade_command was not called.',
          });
          return;
        }

        const executionSnapshot = await this.fetchPortfolio(true);
        if (!isRuntimeLiveArmed(executionSnapshot)) {
          this.config.onTradeResult?.({
            action: 'blocked',
            token: decision.token,
            amount: decision.amount,
            response: 'Runtime not armed: backend autonomous_runtime is not live_armed; trade_command was not called.',
          });
          return;
        }

        // --- Client-side BehaviorRule pre-check ---
        const tradeAmount = parseFloat(decision.amount ?? '0') || 0;
        this.resetHourlyCounterIfNeeded();

        const ruleCheck = checkAllRules(tradeAmount, this.tradesThisHour, this.ruleLimits);
        if (!ruleCheck.allowed) {
          // Block the trade: convert to "hold", notify via onError, skip MCP call
          this.config.onError?.(new Error(`[rule-checker] Trade blocked: ${ruleCheck.reason}`));
          decision.ruleCorrection = {
            original: decision.action,
            corrected: 'hold',
            reason: ruleCheck.reason ?? 'behavior rule violation',
          };
          decision.action = 'hold';
          this.config.onDecision?.(decision);
          return;
        }

        const tradeMessage = buildTradeCommandMessage(
          decision,
          executableDecision.chain,
          executableDecision.amountUnit,
        );
        const tradeResponse = await this.mcp.callTool('trade_command', {
          message: tradeMessage,
          chat_id: this.sessionId,
          idempotency_key: `sdk-${event.id ?? randomUUID()}`,
          autonomous: true,
          requiresEvidence: true,
          evidenceId: decision.evidenceId,
          sourceHealth: decision.sourceHealth,
          missingFacts: decision.missingFacts,
          requiredApprovals: decision.requiredApprovals ?? [],
          exitPolicy: decision.exitPolicy,
          amountUnit: executableDecision.amountUnit,
          amountSource: decision.amountSource,
        });
        const tradeOutcome = classifyTradeCommandOutcome(tradeResponse, decision);
        if (tradeOutcome.submitted) {
          this.tradesExecuted++;
          this.tradesThisHour++;
          this.lastTradeAt = Date.now();
          this.config.onTradeResult?.({
            action: decision.action,
            token: decision.token,
            amount: decision.amount,
            amountUnit: executableDecision.amountUnit,
            response: tradeOutcome.responseText,
          });
          return;
        }

        this.config.onTradeResult?.({
          action: tradeOutcome.action,
          token: decision.token,
          amount: decision.amount,
          amountUnit: executableDecision.amountUnit,
          response: tradeOutcome.responseText,
        });
      }
    } catch (err: unknown) {
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Fetch exposed runtime status via `agent_status`.
   * Result is cached for 30 seconds. On failure, returns an empty snapshot
   * so the decision loop continues with degraded context.
   */
  private async fetchPortfolio(forceRefresh = false): Promise<AgentPortfolioSnapshot> {
    const now = Date.now();
    if (!forceRefresh && this.portfolioCache && (now - this.portfolioCache.fetchedAt) < PORTFOLIO_TTL_MS) {
      return this.portfolioCache.snapshot;
    }

    try {
      const response = await this.mcp.agentStatus();
      const parsed = parseToolJson<Record<string, unknown>>(response);
      const snapshot: AgentPortfolioSnapshot = parsed
        ? buildRuntimeStatusSnapshot(parsed)
        : {};
      this.portfolioCache = { snapshot, fetchedAt: now };
      return snapshot;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Graceful degradation: continue with empty snapshot.
      this.config.onError?.(new Error(`agent_status fetch failed: ${msg}; continuing with empty snapshot`));
      const snapshot: AgentPortfolioSnapshot = {};
      this.portfolioCache = { snapshot, fetchedAt: now };
      return snapshot;
    }
  }

  /**
   * Fetch compressed behavior rules from the MCP resource
   * `balchemy://behavior-rules/{publicId}`.
   * Result is cached for 5 minutes. On failure, returns empty string
   * so decisions still proceed without rule context.
   */
  private async fetchBehaviorRules(): Promise<string> {
    const now = Date.now();
    if (this.rulesCache) {
      const ttl = this.rulesCache.compressed.length > 0 ? RULES_TTL_MS : RULES_FAILURE_TTL_MS;
      if ((now - this.rulesCache.fetchedAt) < ttl) {
        return this.rulesCache.compressed;
      }
    }

    const uri = `balchemy://behavior-rules/${this.publicId}`;
    try {
      const contents = await this.mcp.readResource(uri);
      const compressed = contents[0]?.text ?? '';
      this.rulesCache = { compressed, fetchedAt: now };
      return compressed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Graceful degradation: continue without rule context.
      this.config.onError?.(new Error(`behavior-rules resource fetch failed: ${msg}; continuing without rules`));
      this.rulesCache = { compressed: '', fetchedAt: now };
      return '';
    }
  }

  /**
   * Reset the hourly trade counter when the clock rolls to a new hour.
   * Uses truncated-hour comparison so the counter resets on exact hour boundaries.
   */
  private resetHourlyCounterIfNeeded(): void {
    const nowHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    if (nowHour !== this.currentHourStart) {
      this.tradesThisHour = 0;
      this.currentHourStart = nowHour;
    }
  }

  private createLlmAdapter(): LlmAdapter {
    switch (this.config.llmProvider) {
      case 'anthropic':
        return new AnthropicAdapter(
          this.config.llmApiKey,
          this.config.llmModel,
          this.config.llmTimeoutMs,
        );
      case 'openai':
        return new OpenAiAdapter(
          this.config.llmApiKey,
          this.config.llmModel,
          this.config.llmTimeoutMs,
          this.config.llmBaseUrl,
        );
      case 'custom':
        throw new Error('Custom LLM adapter must be provided via config.llmAdapter');
      default: {
        const exhaustive: never = this.config.llmProvider;
        throw new Error(`Unknown LLM provider: ${exhaustive}`);
      }
    }
  }
}

/**
 * Extract the two hard-limit fields from the untyped behaviorRules config bag.
 * Returns an empty object (no limits enforced) if the config is absent or malformed.
 */
function extractRuleLimits(rules?: Record<string, unknown>): BehaviorRuleLimits {
  if (!rules) return {};
  const limits: BehaviorRuleLimits = {};
  if (typeof rules['maxTradeSol'] === 'number' && rules['maxTradeSol'] > 0) {
    limits.maxTradeSol = rules['maxTradeSol'];
  }
  if (typeof rules['maxTradesPerHour'] === 'number' && rules['maxTradesPerHour'] > 0) {
    limits.maxTradesPerHour = rules['maxTradesPerHour'];
  }
  return limits;
}
