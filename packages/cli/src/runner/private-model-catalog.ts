/** The model list for the owner's picker, read from the selected provider's public list endpoint with the key the owner just
 * entered. Read-only: it never configures, saves or sends anything to Balchemy. Each provider has one fixed URL; the request
 * never follows a redirect, its size and time are bounded, and errors carry a closed code only (never a body, URL or key).
 * The list read is also the immediate key check: OpenAI and Anthropic answer 401 to a bad key. OpenRouter's list is public, so its
 * key is checked first with GET /api/v1/key (Phase 2, owner decision of 19 Nov 2026); only a 401 there means "rejected". */
import { isPrivateBrainModelId, type PrivateBrainProvider } from "./private-brain-providers.js";

/** OpenRouter's published price of one model, as integer micro-USD per one million tokens (the budget table's unit). */
export interface ModelCatalogPrice { inputMicroUsdPerMillion: number; outputMicroUsdPerMillion: number }
export interface ModelChoice { id: string; label: string; hint?: string; price?: ModelCatalogPrice }
export type ModelCatalogErrorCode = "unauthorized" | "unavailable" | "invalid";
export class ModelCatalogError extends Error {
  constructor(readonly code: ModelCatalogErrorCode) { super(`Model list ${code}`); this.name = "ModelCatalogError"; }
}
export type ModelCatalogFetch = (provider: PrivateBrainProvider, apiKey: string, signal?: AbortSignal) => Promise<ModelChoice[]>;

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 5000;
const TIMEOUT_MS = 15_000;
const ENDPOINTS: Readonly<Record<PrivateBrainProvider, string>> = Object.freeze({
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models?limit=1000",
  // Text-output models only (the endpoint's default, stated explicitly).
  openrouter: "https://openrouter.ai/api/v1/models?output_modalities=text",
});
/** OpenRouter's key check: 200 for a valid key, 401 for a rejected one. It calls no model and costs nothing. */
const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
/** $10,000 per million tokens: anything above is not a believable published price and is ignored (the table price applies). */
export const MAX_CATALOG_PRICE_MICRO_USD_PER_MILLION = 10_000_000_000;
/** OpenAI's list also holds embedding, speech, image and moderation models that cannot answer a chat request. */
const OPENAI_NON_CHAT = /(embedding|whisper|tts|dall-e|gpt-image|image|audio|realtime|transcribe|moderation|search|davinci|babbage|computer-use|sora)/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Provider text is untrusted terminal output: no control, bidirectional or zero-width characters, bounded length. */
export function displayText(value: unknown, maximum = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const characters = Array.from(clean);
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join("")}…` : clean;
}
function perMillion(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?(?:[eE]-?\d+)?$/.test(value)) return undefined;
  const amount = Number(value) * 1_000_000;
  if (!Number.isFinite(amount)) return undefined;
  if (amount === 0) return "free";
  return `$${amount >= 10 ? amount.toFixed(0) : amount >= 1 ? amount.toFixed(2).replace(/\.?0+$/, "") : amount.toPrecision(2)}/M in`;
}

/** One OpenRouter price field (a decimal string of USD per token) as integer micro-USD per million tokens, rounded up; undefined
 * when it is missing, negative, not a plain decimal or out of bounds. Untrusted provider data: bounded before it is used. */
export function catalogMicroUsdPerMillion(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 40 || !/^\d+(?:\.\d+)?(?:[eE]-?\d+)?$/.test(value)) return undefined;
  const amount = Number(value) * 1_000_000_000_000;
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  // The epsilon absorbs binary representation (0.0000003 * 1e12 = 300000.00000000006).
  const micro = Math.max(0, Math.ceil(amount - 1e-3));
  return Number.isSafeInteger(micro) && micro <= MAX_CATALOG_PRICE_MICRO_USD_PER_MILLION ? micro : undefined;
}
/** Both OpenRouter prices of one model, or undefined when either is unusable. */
export function catalogPrice(pricing: unknown): ModelCatalogPrice | undefined {
  const input = catalogMicroUsdPerMillion(record(pricing)?.prompt), output = catalogMicroUsdPerMillion(record(pricing)?.completion);
  return input === undefined || output === undefined ? undefined : { inputMicroUsdPerMillion: input, outputMicroUsdPerMillion: output };
}

/** Pure: the provider's list body to picker choices. IDs the runner would refuse are dropped; order follows the provider
 * (OpenAI: newest first by `created`). */
export function parseModelCatalog(provider: PrivateBrainProvider, body: unknown): ModelChoice[] {
  const data = record(body)?.data;
  if (!Array.isArray(data)) throw new ModelCatalogError("invalid");
  const seen = new Set<string>();
  const items: Array<ModelChoice & { created: number }> = [];
  for (const raw of data.slice(0, MAX_MODELS)) {
    const item = record(raw);
    const id = item?.id;
    if (!item || !isPrivateBrainModelId(id) || seen.has(id)) continue;
    if (provider === "openai") {
      if (OPENAI_NON_CHAT.test(id)) continue;
      items.push({ id, label: id, created: typeof item.created === "number" && Number.isFinite(item.created) ? item.created : 0 });
    } else if (provider === "anthropic") {
      if (item.lifecycle === "retired") continue;
      const label = displayText(item.display_name) ?? id;
      items.push({ id, label, hint: item.lifecycle === "deprecated" ? `${id} · deprecated` : id, created: 0 });
    } else {
      const label = displayText(item.name) ?? id;
      const shown = perMillion(record(item.pricing)?.prompt);
      const price = catalogPrice(item.pricing);
      items.push({ id, label, hint: shown ? `${id} · ${shown}` : id, created: 0, ...(price ? { price } : {}) });
    }
    seen.add(id);
  }
  if (provider === "openai") items.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  return items.map(({ id, label, hint, price }) => ({ id, label, ...(hint ? { hint } : {}), ...(price ? { price } : {}) }));
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new ModelCatalogError("invalid");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { void reader.cancel().catch(() => undefined); throw new ModelCatalogError("invalid"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type CatalogOptions = { fetchFn?: typeof fetch; timeoutMs?: number; signal?: AbortSignal };
/** One bounded GET: fixed URL, no redirect, no credentials, a closed error code only. `read` false only checks the status. */
async function boundedGet(url: string, headers: Record<string, string>, options: CatalogOptions, read: boolean): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await (options.fetchFn ?? fetch)(url, { method: "GET", headers: { ...headers, "cache-control": "no-store" },
      redirect: "error", credentials: "omit", signal: controller.signal });
    if (response.status === 401) { void response.body?.cancel().catch(() => undefined); throw new ModelCatalogError("unauthorized"); }
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => undefined); throw new ModelCatalogError("unavailable"); }
    if (!read) { void response.body?.cancel().catch(() => undefined); return undefined; }
    const text = await readBounded(response);
    try { return JSON.parse(text) as unknown; } catch { throw new ModelCatalogError("invalid"); }
  } catch (error: unknown) {
    if (error instanceof ModelCatalogError) throw error;
    // Fetch errors may carry the URL or a provider payload; only a closed code leaves this function.
    throw new ModelCatalogError("unavailable");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** The models the key can use. A rejected key is `unauthorized` (for OpenRouter from its key check, before the public list). */
export async function fetchProviderModels(provider: PrivateBrainProvider, apiKey: string, options: CatalogOptions = {}): Promise<ModelChoice[]> {
  if (!/^[!-~]{1,4096}$/.test(apiKey)) throw new ModelCatalogError("unauthorized");
  const headers: Record<string, string> = provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" }
    : { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  if (provider === "openrouter") await boundedGet(OPENROUTER_KEY_ENDPOINT, headers, options, false);
  return parseModelCatalog(provider, await boundedGet(ENDPOINTS[provider], headers, options, true));
}

/** OpenRouter's public model list without a key: changing only the model of a saved OpenRouter key (the key stays in the runner). */
export async function fetchPublicOpenRouterModels(options: CatalogOptions = {}): Promise<ModelChoice[]> {
  return parseModelCatalog("openrouter", await boundedGet(ENDPOINTS.openrouter, { accept: "application/json" }, options, true));
}
