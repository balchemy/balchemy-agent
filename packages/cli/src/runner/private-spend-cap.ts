/** M3.2 S4: the optional owner spend cap as an explicit three-way value (design section 5, owner decisions 19, 20, 30, 31).
 * `unset` (never answered) refuses arming, intents and builds; `none` is the owner's explicit "no spend limit"; `lamports` is a
 * cap. A bare `null`, a missing key or an unknown kind is rejected by every parser, so no surface can confuse "not configured"
 * with "no limit". A percentage is never stored: it is fixed into lamports at confirmation (`basis` records how). Pure module:
 * it imports nothing from the runner protocol, so protocol.ts can use it. Grants no authority. */

/** The 10 SOL backstop. It applies only to `lamports` caps (owner item 20 declined any background limit for `none`). */
export const PRIVATE_SPEND_CAP_MAX_LAMPORTS = 10_000_000_000n;
/** A confirmation reads the wallet balance; a basis older than this is refused at save time (fixed at confirmation). */
export const PRIVATE_SPEND_CAP_BASIS_MAX_AGE_MS = 15 * 60_000;

export type PrivateCapSetting = { kind: "unset" } | { kind: "none" } | { kind: "lamports"; lamports: string };
/** A cap the owner may save: never `unset` (an answer cannot be withdrawn into "never answered"). */
export type PrivateCapChoice = Exclude<PrivateCapSetting, { kind: "unset" }>;
/** How a percentage was fixed: floor(balanceLamports * percentBps / 10000), read at `observedAt` on the owner's RPC. */
export interface PrivateCapBasis { percentBps: number; balanceLamports: string; observedAt: number }
/** Today's remaining spend: an amount, `unlimited` (daily cap `none`) or `unset` (no answer yet: nothing can be spent). */
export type PrivateSpendRemaining = { kind: "unset" } | { kind: "unlimited" } | { kind: "lamports"; lamports: string };
/** A requested cap before confirmation: a percentage is turned into lamports by the runner before anything is saved. */
export type PrivateCapRequest = PrivateCapChoice | { kind: "percent"; percentBps: number };

export class PrivateSpendCapError extends Error {
  constructor() { super("Invalid spend cap"); this.name = "PrivateSpendCapError"; }
}
function invalid(): never { throw new PrivateSpendCapError(); }
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
function plain(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(fields, key))
    && Object.values(fields).every((field) => "value" in field && field.enumerable);
}
function lamportsCap(value: unknown): string {
  if (typeof value !== "string" || !U64.test(value)) invalid();
  const amount = BigInt(value);
  if (amount < 1n || amount > PRIVATE_SPEND_CAP_MAX_LAMPORTS) invalid();
  return value;
}
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** Strict parser. `allowUnset: false` for anything an owner saves or a summary that already passed the limits check. */
export function parsePrivateCapSetting(value: unknown, options: { allowUnset: boolean }): PrivateCapSetting {
  if (plain(value, ["kind"])) {
    if (value.kind === "none") return Object.freeze({ kind: "none" });
    if (value.kind === "unset" && options.allowUnset) return Object.freeze({ kind: "unset" });
    return invalid();
  }
  if (plain(value, ["kind", "lamports"]) && value.kind === "lamports") return Object.freeze({ kind: "lamports", lamports: lamportsCap(value.lamports) });
  return invalid();
}
export function parsePrivateCapChoice(value: unknown): PrivateCapChoice {
  return parsePrivateCapSetting(value, { allowUnset: false }) as PrivateCapChoice;
}
export function parsePrivateCapRequest(value: unknown): PrivateCapRequest {
  if (plain(value, ["kind", "percentBps"]) && value.kind === "percent") {
    if (typeof value.percentBps !== "number" || !Number.isSafeInteger(value.percentBps) || value.percentBps < 1 || value.percentBps > 10_000) invalid();
    return Object.freeze({ kind: "percent", percentBps: value.percentBps });
  }
  return parsePrivateCapChoice(value);
}
export function parsePrivateCapBasis(value: unknown): PrivateCapBasis | null {
  if (value === null) return null;
  if (!plain(value, ["percentBps", "balanceLamports", "observedAt"]) || typeof value.percentBps !== "number" || !Number.isSafeInteger(value.percentBps)
    || value.percentBps < 1 || value.percentBps > 10_000 || typeof value.balanceLamports !== "string" || !U64.test(value.balanceLamports)
    || BigInt(value.balanceLamports) > (1n << 64n) - 1n || !timestamp(value.observedAt)) invalid();
  return Object.freeze({ percentBps: value.percentBps, balanceLamports: value.balanceLamports, observedAt: value.observedAt });
}
export function parsePrivateSpendRemaining(value: unknown): PrivateSpendRemaining {
  if (plain(value, ["kind"]) && (value.kind === "unset" || value.kind === "unlimited")) return Object.freeze({ kind: value.kind });
  if (plain(value, ["kind", "lamports"]) && value.kind === "lamports" && typeof value.lamports === "string" && U64.test(value.lamports)
    && BigInt(value.lamports) <= (1n << 64n) - 1n) return Object.freeze({ kind: "lamports", lamports: value.lamports });
  return invalid();
}

/** floor(balance * bps / 10000), in lamports. */
export function privateFixedPercentCap(balanceLamports: bigint, percentBps: number): bigint {
  if (balanceLamports < 0n || !Number.isSafeInteger(percentBps) || percentBps < 1 || percentBps > 10_000) invalid();
  return (balanceLamports * BigInt(percentBps)) / 10_000n;
}
/** A cap and its basis agree: a basis only on a `lamports` cap, whose amount is exactly the fixed percentage. */
export function privateCapBasisMatches(cap: PrivateCapSetting, basis: PrivateCapBasis | null): boolean {
  if (basis === null) return true;
  return cap.kind === "lamports" && privateFixedPercentCap(BigInt(basis.balanceLamports), basis.percentBps) === BigInt(cap.lamports);
}
/** Two caps that may be saved together: neither unset; lamports within 1..10 SOL; per-trade <= daily when both are amounts. */
export function validPrivateCapPair(perTrade: PrivateCapSetting, daily: PrivateCapSetting): boolean {
  try {
    parsePrivateCapChoice(perTrade); parsePrivateCapChoice(daily);
    return !(perTrade.kind === "lamports" && daily.kind === "lamports" && BigInt(perTrade.lamports) > BigInt(daily.lamports));
  } catch { return false; }
}
/** True only when both caps were answered (either may be `none`). */
export function privateCapsAnswered(perTrade: PrivateCapSetting, daily: PrivateCapSetting): boolean {
  return perTrade.kind !== "unset" && daily.kind !== "unset";
}
/** The remaining spend for today under a daily cap, given today's committed plus reserved use. */
export function privateSpendRemaining(daily: PrivateCapSetting, usedLamports: bigint): PrivateSpendRemaining {
  if (daily.kind === "unset") return { kind: "unset" };
  if (daily.kind === "none") return { kind: "unlimited" };
  const left = BigInt(daily.lamports) - usedLamports;
  return { kind: "lamports", lamports: (left > 0n ? left : 0n).toString() };
}
/** Canonical digest tuple: `unset`, `none` and an amount are three distinct encodings. */
export function privateCapTuple(cap: PrivateCapSetting): readonly string[] {
  return cap.kind === "lamports" ? ["lamports", cap.lamports] : [cap.kind];
}
export function samePrivateCap(left: PrivateCapSetting, right: PrivateCapSetting): boolean {
  return left.kind === right.kind && (left.kind !== "lamports" || left.lamports === (right as { lamports: string }).lamports);
}

export function privateLamportsToSol(value: string): string {
  const text = value.padStart(10, "0"); const whole = text.slice(0, -9).replace(/^0+(?=\d)/, ""); const fraction = text.slice(-9).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} SOL`;
}
function percentText(bps: number): string { return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`; }
/** Owner-facing text. `unset` and `none` never read alike. */
export function formatPrivateCap(cap: PrivateCapSetting, basis: PrivateCapBasis | null = null): string {
  if (cap.kind === "unset") return "not set";
  if (cap.kind === "none") return "no limit (your choice)";
  const amount = privateLamportsToSol(cap.lamports);
  return basis ? `${amount} (${percentText(basis.percentBps)} of ${privateLamportsToSol(basis.balanceLamports)}, fixed ${new Date(basis.observedAt).toISOString()})` : amount;
}
export function formatPrivateCapRequest(cap: PrivateCapRequest): string {
  return cap.kind === "percent" ? `${percentText(cap.percentBps)} of the trading wallet (fixed into SOL at confirmation)` : formatPrivateCap(cap);
}
export function formatPrivateSpendRemaining(remaining: PrivateSpendRemaining): string {
  return remaining.kind === "unset" ? "nothing (caps not set)" : remaining.kind === "unlimited" ? "no daily limit (your choice)"
    : privateLamportsToSol(remaining.lamports);
}

// ---- proposals (the conversation brain may only propose; only the owner's CLI confirmation saves) ----------------------
/** `{"sol":"<decimal>"} | {"percent":<1..100>} | "none"` from the model; both fields of a proposal are required. */
export function parsePrivateCapProposalValue(value: unknown): PrivateCapRequest {
  if (value === "none") return Object.freeze({ kind: "none" });
  if (plain(value, ["sol"]) && typeof value.sol === "string" && value.sol.length <= 30 && /^(0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value.sol)) {
    const [whole, fraction = ""] = value.sol.split(".");
    return Object.freeze({ kind: "lamports", lamports: lamportsCap((BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"))).toString()) });
  }
  if (plain(value, ["percent"]) && typeof value.percent === "number" && Number.isSafeInteger(value.percent) && value.percent >= 1 && value.percent <= 100) {
    return Object.freeze({ kind: "percent", percentBps: value.percent * 100 });
  }
  return invalid();
}
export interface PrivateCapProposalInput { perTrade: PrivateCapRequest; daily: PrivateCapRequest }
/** Both fields are required and a missing one is invalid, never "none". Two amounts keep per-trade <= daily. */
export function parsePrivateCapProposal(value: unknown): PrivateCapProposalInput {
  if (!plain(value, ["kind", "perTrade", "daily"]) || value.kind !== "propose_spend_cap") invalid();
  const perTrade = parsePrivateCapProposalValue(value.perTrade), daily = parsePrivateCapProposalValue(value.daily);
  if (perTrade.kind === "lamports" && daily.kind === "lamports" && BigInt(perTrade.lamports) > BigInt(daily.lamports)) invalid();
  return Object.freeze({ perTrade, daily });
}

/** The setup question the conversation asks (SPEND_CAP_INSTRUCTIONS); a reply after it is in the explicit spend-cap question state. */
export const PRIVATE_SPEND_CAP_QUESTION = "Harcama tavanı ister misin? İstersen yaz.";
const QUESTION = /harcama tavan[ıi] ister misin|do you want (?:a )?spend(?:ing)? (?:cap|limit)/;
/** True when `reply` (the previous assistant reply) asked the spend cap question: the next message is read as its answer. */
export function privateSpendCapQuestionAsked(reply: string): boolean {
  return typeof reply === "string" && QUESTION.test(reply.toLocaleLowerCase("tr-TR"));
}
const NO_LIMIT = /(hi[cç] s[ıi]n[ıi]r olmas[ıi]n|s[ıi]n[ıi]r olmas[ıi]n|s[ıi]n[ıi]r[ıi]? yok|s[ıi]n[ıi]rs[ıi]z|limitsiz|limit yok|tavan yok|tavan olmas[ıi]n|no spend(?:ing)? (?:limit|cap)s?\b|no (?:spending )?limits?\b|no caps?\b)/;
/** Outside the question state, a no-limit phrase is a cap answer only next to an explicit spend cap word ("sınırsız" alone may be
 * about a token's supply). */
const CAP_TOPIC = /harcama|tavan|spend(?:ing)? (?:cap|limit)|spend cap|spending/;
const VALUE = /(?:(\d+(?:[.,]\d{1,9})?)\s*sol\b|%\s*(\d{1,3})\b|(\d{1,3})\s*%)/g;
const DAILY_LABEL = /g[uü]nde|g[uü]nl[uü]k|g[uü]n ba[sş][ıi]na|daily|per day|a day/;
const PER_TRADE_LABEL = /i[sş]lem ba[sş][ıi]|her i[sş]lem|al[ıi]m ba[sş][ıi]|per[- ]trade|each trade|a trade|per buy/;
/** Clause boundaries: `;`, a comma or a period that is not a decimal separator, and the words ve/and/ama/but. */
const CLAUSE = /;|,(?!\d)|(?<!\d)\.|\.(?!\d)|\s(?:ve|and|ama|but)\s/;
function plainValue(match: RegExpMatchArray): unknown {
  if (match[1] !== undefined) return { sol: match[1].replace(",", ".") };
  return { percent: Number(match[2] ?? match[3]) };
}
/** Each cap from its own clause (anchored, C3): a clause holding exactly one amount is per-trade when it names a trade (also
 * "günlük işlem başına": the trade wins) and daily when it names only a day. An unlabeled amount, a second amount in one clause or a
 * second clause of the same kind is ambiguous: not a plain answer. */
function labeledCaps(lower: string): { perTrade: unknown; daily: unknown } | "ambiguous" {
  let perTrade: unknown, daily: unknown;
  for (const clause of lower.split(CLAUSE)) {
    const values = [...clause.matchAll(VALUE)];
    if (values.length === 0) continue;
    if (values.length > 1) return "ambiguous";
    const value = plainValue(values[0]!);
    if (PER_TRADE_LABEL.test(clause)) { if (perTrade !== undefined) return "ambiguous"; perTrade = value; }
    else if (DAILY_LABEL.test(clause)) { if (daily !== undefined) return "ambiguous"; daily = value; }
    else return "ambiguous";
  }
  return { perTrade, daily };
}
/** Deterministic parse of the plain forms ("günde en fazla 2 SOL, işlem başına 0.5 SOL", "günde %10 ...", "hiç sınır olmasın").
 * `undefined`: not a plain cap answer (the model is the fallback). `"invalid"`: a cap answer outside the bounds. A message that
 * names only one of the two caps is not a plain answer: a missing field is never read as "none". C3: it parses only a clear cap
 * answer: both caps as labeled amounts, each from its own clause; or a no-limit phrase without any amount or question mark, either
 * in the explicit question state (`asked`: the previous reply asked PRIVATE_SPEND_CAP_QUESTION) or next to a spend cap word. */
export function parsePrivateSpendCapText(text: string, context: { asked: boolean } = { asked: false }): PrivateCapProposalInput | "invalid" | undefined {
  if (typeof text !== "string" || text.length > 240) return undefined;
  const lower = text.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  const caps = labeledCaps(lower);
  if (caps === "ambiguous") return undefined;
  const amounts = caps.perTrade !== undefined || caps.daily !== undefined;
  if (NO_LIMIT.test(lower)) {
    if (amounts || lower.includes("?") || (!context.asked && !CAP_TOPIC.test(lower))) return undefined;
    return Object.freeze({ perTrade: Object.freeze({ kind: "none" as const }), daily: Object.freeze({ kind: "none" as const }) });
  }
  if (caps.daily === undefined || caps.perTrade === undefined) return undefined;
  try { return parsePrivateCapProposal({ kind: "propose_spend_cap", perTrade: caps.perTrade, daily: caps.daily }); } catch { return "invalid"; }
}
