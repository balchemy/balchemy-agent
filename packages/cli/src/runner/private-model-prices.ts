/** Embedded USD prices of the models the local runner may call with the owner's own API key, for the daily AI budget.
 * Prices are exact integers of micro-USD (1/1,000,000 USD) per one million tokens: $0.05 / 1M tokens is 50_000.
 * Each call's cost is rounded UP to a whole micro-USD. A model missing from this table is counted at the highest input and
 * the highest output price found here (owner decision of 17 Nov 2026), never at a cheaper fallback.
 *
 * Sources, read on 17 Nov 2026 (standard tier, base input and output; no batch, flex, priority or cache prices):
 * - OpenAI: https://developers.openai.com/api/docs/pricing (redirect target of platform.openai.com/docs/pricing;
 *   openai.com/api/pricing refused the fetch). Short context means at most 272K input tokens. One runner request is
 *   capped at 256 KiB of UTF-8 text by the SDK adapter, so it can never reach the long-context rates; they are omitted.
 *   Trusted-access models (cyber, rosalind) are omitted and count at the highest price.
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing and
 *   https://platform.claude.com/docs/en/about-claude/models/overview (API IDs). IDs from the 4.6 generation on are
 *   dateless (`claude-{name}-{major}[-{minor}]`, per .../models/model-ids-and-versions); earlier models are listed under
 *   their aliases, and a dated snapshot (`-YYYYMMDD`) is priced as its alias. Claude Haiku 5.5 has a higher rate for
 *   prompts over 100,000 tokens.
 * OpenAI dated snapshots are matched exactly only: some were priced differently from their alias.
 * Prices change; refresh this table and its date together. */
import type { LlmMessage } from "@balchemyai/agent-sdk";
import type { PrivateBrainProvider } from "./private-brain-providers.js";

export const PRIVATE_MODEL_PRICES_DATE = "2026-11-17";

interface Rate { readonly input: number; readonly output: number }
export interface PrivateModelPrice extends Rate {
  /** A higher rate once the prompt is longer than `aboveInputTokens` (both input and output change). */
  readonly long?: Rate & { readonly aboveInputTokens: number };
}
function rate(input: number, output: number): PrivateModelPrice { return Object.freeze({ input, output }); }

const OPENAI: Readonly<Record<string, PrivateModelPrice>> = Object.freeze({
  "gpt-6-astra": rate(10_000_000, 50_000_000),
  "gpt-6.1-sol": rate(2_000_000, 10_000_000),
  "gpt-6.1-terra": rate(1_000_000, 5_000_000),
  "gpt-6-luna": rate(100_000, 500_000),
  "gpt-6-sol": rate(2_000_000, 10_000_000),
  "gpt-5.6-sol": rate(4_000_000, 20_000_000),
  "gpt-5.6-terra": rate(2_000_000, 12_000_000),
  "gpt-5.6-luna": rate(200_000, 1_200_000),
  "gpt-5.5": rate(5_000_000, 30_000_000),
  "gpt-5.5-pro": rate(30_000_000, 180_000_000),
  "gpt-5.4": rate(2_500_000, 15_000_000),
  "gpt-5.4-pro": rate(30_000_000, 180_000_000),
  "gpt-5.4-mini": rate(750_000, 4_500_000),
  "gpt-5.4-nano": rate(200_000, 1_250_000),
  "gpt-5.3-codex": rate(1_750_000, 14_000_000),
  "gpt-5.2": rate(1_750_000, 14_000_000),
  "gpt-5.2-pro": rate(21_000_000, 168_000_000),
  "gpt-5.1": rate(1_250_000, 10_000_000),
  "gpt-5": rate(1_250_000, 10_000_000),
  "gpt-5-mini": rate(250_000, 2_000_000),
  "gpt-5-nano": rate(50_000, 400_000),
  "gpt-5-pro": rate(15_000_000, 120_000_000),
  "chat-latest": rate(5_000_000, 30_000_000),
  "gpt-4.1": rate(2_000_000, 8_000_000),
  "gpt-4.1-mini": rate(400_000, 1_600_000),
  "gpt-4o": rate(2_500_000, 10_000_000),
  "gpt-4o-mini": rate(150_000, 600_000),
  "o3-pro": rate(20_000_000, 80_000_000),
  "o3": rate(2_000_000, 8_000_000),
});

const ANTHROPIC: Readonly<Record<string, PrivateModelPrice>> = Object.freeze({
  "claude-fable-5-2": rate(8_000_000, 40_000_000),
  "claude-mythos-5-2": rate(8_000_000, 40_000_000),
  "claude-fable-5-1": rate(10_000_000, 50_000_000),
  "claude-mythos-5-1": rate(10_000_000, 50_000_000),
  "claude-fable-5": rate(10_000_000, 50_000_000),
  "claude-mythos-5": rate(10_000_000, 50_000_000),
  "claude-opus-5-5": rate(4_000_000, 20_000_000),
  "claude-opus-5": rate(5_000_000, 25_000_000),
  "claude-opus-4-8": rate(5_000_000, 25_000_000),
  "claude-opus-4-7": rate(5_000_000, 25_000_000),
  "claude-opus-4-6": rate(5_000_000, 25_000_000),
  "claude-opus-4-5": rate(5_000_000, 25_000_000),
  "claude-opus-4-1": rate(15_000_000, 75_000_000),
  "claude-opus-4-0": rate(15_000_000, 75_000_000),
  "claude-opus-4": rate(15_000_000, 75_000_000),
  "claude-sonnet-5-5": rate(2_000_000, 10_000_000),
  "claude-sonnet-5": rate(2_000_000, 10_000_000),
  "claude-sonnet-4-6": rate(3_000_000, 15_000_000),
  "claude-sonnet-4-5": rate(3_000_000, 15_000_000),
  "claude-sonnet-4-0": rate(3_000_000, 15_000_000),
  "claude-sonnet-4": rate(3_000_000, 15_000_000),
  "claude-haiku-5-5": Object.freeze({ input: 100_000, output: 500_000,
    long: Object.freeze({ aboveInputTokens: 100_000, input: 500_000, output: 2_500_000 }) }),
  "claude-haiku-4-5": rate(1_000_000, 5_000_000),
});

function maximum(select: (rate: Rate) => number): number {
  let result = 0;
  for (const price of [...Object.values(OPENAI), ...Object.values(ANTHROPIC)]) {
    result = Math.max(result, select(price), price.long ? select(price.long) : 0);
  }
  return result;
}
/** Highest input and highest output price, taken separately. */
export const PRIVATE_MODEL_HIGHEST_PRICE: PrivateModelPrice = rate(maximum((r) => r.input), maximum((r) => r.output));

function own(table: Readonly<Record<string, PrivateModelPrice>>, key: string): PrivateModelPrice | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
function anthropic(model: string): PrivateModelPrice | undefined {
  return own(ANTHROPIC, model) ?? own(ANTHROPIC, model.replace(/-\d{8}$/, ""));
}

/** The table price of one configured model, or the highest known price when it is not in the table. Exact IDs only: a
 * prefix never matches (`gpt-5.4` must not price `gpt-5.4-pro`). OpenRouter IDs are `vendor/model`; an `openai/` or
 * `anthropic/` model is looked up in that vendor's table (OpenRouter writes Anthropic versions with dots). This is the
 * admission estimate; an OpenRouter call settles at the charge OpenRouter itself reports whenever it reports one. */
export function privateModelPrice(provider: PrivateBrainProvider, model: string): { price: PrivateModelPrice; known: boolean } {
  let price: PrivateModelPrice | undefined;
  if (provider === "openai") price = own(OPENAI, model);
  else if (provider === "anthropic") price = anthropic(model);
  else if (model.startsWith("openai/")) price = own(OPENAI, model.slice("openai/".length));
  else if (model.startsWith("anthropic/")) price = anthropic(model.slice("anthropic/".length).replace(/\./g, "-"));
  return price ? { price, known: true } : { price: PRIVATE_MODEL_HIGHEST_PRICE, known: false };
}

function tokens(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000; }
/** Integer micro-USD of one call, rounded up. */
export function privateModelCallMicroUsd(price: PrivateModelPrice, inputTokens: number, outputTokens: number): number {
  if (!tokens(inputTokens) || !tokens(outputTokens)) throw new RangeError("Invalid token count");
  const tier: Rate = price.long && inputTokens > price.long.aboveInputTokens ? price.long : price;
  // At most 1e8 tokens x 1.8e8 per million: well inside the safe integer range.
  const total = inputTokens * tier.input + outputTokens * tier.output;
  if (!Number.isSafeInteger(total)) throw new RangeError("Invalid model cost");
  return Math.ceil(total / 1_000_000);
}

/** Per-message framing allowance on top of the text estimate. */
const MESSAGE_OVERHEAD_TOKENS = 8;
/** Conservative admission estimate of one call before it is made: input as ceil(UTF-8 bytes / 3) plus framing, at the
 * long-prompt rate whenever the byte count (an upper bound of the token count) could pass it, and every allowed output
 * token at the output price. */
export function privateModelCallEstimateMicroUsd(price: PrivateModelPrice, messages: readonly LlmMessage[], maxTokens: number): number {
  if (!Array.isArray(messages) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 100_000) throw new RangeError("Invalid estimate");
  let bytes = 0;
  for (const message of messages) bytes += Buffer.byteLength(typeof message?.content === "string" ? message.content : "", "utf8");
  const framing = messages.length * MESSAGE_OVERHEAD_TOKENS;
  const inputTokens = Math.ceil(bytes / 3) + framing;
  const tier: Rate = price.long && bytes + framing > price.long.aboveInputTokens ? price.long : price;
  return privateModelCallMicroUsd({ input: tier.input, output: tier.output }, inputTokens, maxTokens);
}

/** `$5.00`, `$0.0031`: at least two decimals, at most six, from integer micro-USD. */
export function formatPrivateModelUsd(microUsd: number): string {
  if (!Number.isSafeInteger(microUsd) || microUsd < 0) return "unknown";
  const whole = Math.floor(microUsd / 1_000_000);
  const fraction = String(microUsd % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${fraction}`;
}
