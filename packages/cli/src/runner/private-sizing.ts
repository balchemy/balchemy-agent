/** Owner-confirmed fixed SOL defaults. Configuration grants no execution authority. */
import { createHash } from "node:crypto";
import { isId, isTimestamp } from "./protocol.js";

/** The one bound on the slippage a buy may execute with: the SDK buy and sell assessments accept at most this, so it is also the
 * largest entry slippage an exit-protected position can open with. A NEW sizing policy above it is refused (an owner cannot configure
 * an unusable value) and arming refuses a stored one (`sizing_slippage_above_bound`); a policy stored before this bound still reads
 * (never clamped), and a buy plan above it is never assessed and is refused at intent admission (`slippage_above_bound`).
 * PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS and PRIVATE_POSITION_MAX_SLIPPAGE_BPS are this same value, so they cannot drift apart. */
export const PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS = 5000;
export const PRIVATE_SIZING_ERRORS = ["invalid_request", "revision_conflict", "rule_revision_conflict", "operation_conflict",
  "state_unavailable", "clock_rollback", "cancelled"] as const;
export class PrivateSizingError extends Error {
  constructor(readonly code: typeof PRIVATE_SIZING_ERRORS[number]) { super("Private sizing " + code); this.name = "PrivateSizingError"; }
}
export interface PrivateSizingScope { localProfileId: string; agentId: string }
export interface PrivateBuyAmountPolicyInput {
  operationId: string; expectedRevision: number; expectedRuleRevisionId: `brr_${string}` | null;
  amountSol: string; slippageBps: number;
}
export interface PrivateBuyAmountPolicy {
  revision: number; chain: "solana"; mode: "fixed_native"; amountSol: string; amountBaseUnits: string;
  slippageBps: number; configuredAgainstRuleRevisionId: `brr_${string}` | null; updatedAt: number; digest: `sha256:${string}`;
}
export interface PrivateSizingStatus { agentId: string; currentRuleRevisionId: `brr_${string}` | null; policy: PrivateBuyAmountPolicy | null }
export interface PrivateSizingCheckpoint { agentId: string; policy: PrivateBuyAmountPolicy; lastChange: PrivateBuyAmountPolicyInput }
const REVISION = /^brr_[a-f0-9]{64}$/;
function fail(): never { throw new PrivateSizingError("invalid_request"); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key)) || Reflect.ownKeys(value).length !== keys.length
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function rule(value: unknown): value is `brr_${string}` | null { return value === null || typeof value === "string" && REVISION.test(value); }
function revision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function slippage(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000; }
function scope(value: PrivateSizingScope): PrivateSizingScope {
  exact(value, ["localProfileId", "agentId"]); if (!isId(value.localProfileId) || !isId(value.agentId)) fail();
  return { localProfileId: value.localProfileId, agentId: value.agentId };
}
function hash(target: PrivateSizingScope, body: Omit<PrivateBuyAmountPolicy, "digest">): `sha256:${string}` {
  return ("sha256:" + createHash("sha256").update(JSON.stringify(["balchemy.private-buy-amount-policy.v1", target.localProfileId, target.agentId,
    body.revision, body.chain, body.mode, body.amountSol, body.amountBaseUnits, body.slippageBps,
    body.configuredAgainstRuleRevisionId, body.updatedAt])).digest("hex")) as `sha256:${string}`;
}
/** Reject exponents, signs, whitespace and sub-lamport values; normalize trailing zeros only. */
export function parsePrivateSolAmount(value: unknown): Readonly<{ amountSol: string; amountBaseUnits: string }> {
  if (typeof value !== "string" || value.length > 30 || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value)) fail();
  const [whole, fractional = ""] = value.split(".");
  const amount = BigInt(whole!) * 1_000_000_000n + BigInt(fractional.padEnd(9, "0"));
  if (amount <= 0n || amount > 18_446_744_073_709_551_615n) fail();
  const fraction = fractional.replace(/0+$/, "");
  return Object.freeze({ amountSol: whole! + (fraction ? "." + fraction : ""), amountBaseUnits: amount.toString() });
}
export function parsePrivateBuyAmountPolicyInput(value: unknown): PrivateBuyAmountPolicyInput {
  exact(value, ["operationId", "expectedRevision", "expectedRuleRevisionId", "amountSol", "slippageBps"]);
  if (!isId(value.operationId) || !revision(value.expectedRevision) || !Number.isSafeInteger(value.expectedRevision + 1)
    || !rule(value.expectedRuleRevisionId) || !slippage(value.slippageBps)) fail();
  return freeze({ operationId: value.operationId, expectedRevision: value.expectedRevision, expectedRuleRevisionId: value.expectedRuleRevisionId,
    amountSol: parsePrivateSolAmount(value.amountSol).amountSol, slippageBps: value.slippageBps });
}
/** True when a buy may execute with this sizing slippage (1..PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS). */
export function privateSizingSlippageUsable(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 1 && bps <= PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS;
}
/** The canonical policy body for one input (also the shape of policies stored before the execution bound). A NEW owner change
 * is refused above PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS by the store (setSizingPolicy) and the CLI, never here. */
export function buildPrivateBuyAmountPolicy(target: PrivateSizingScope, input: PrivateBuyAmountPolicyInput, nowMs: number): PrivateBuyAmountPolicy {
  target = scope(target); const request = parsePrivateBuyAmountPolicyInput(input); if (!isTimestamp(nowMs)) fail();
  const body: Omit<PrivateBuyAmountPolicy, "digest"> = { revision: request.expectedRevision + 1, chain: "solana", mode: "fixed_native",
    ...parsePrivateSolAmount(request.amountSol), slippageBps: request.slippageBps,
    configuredAgainstRuleRevisionId: request.expectedRuleRevisionId, updatedAt: nowMs };
  return freeze({ ...body, digest: hash(target, body) });
}
export function parsePrivateBuyAmountPolicy(value: unknown, target: PrivateSizingScope): PrivateBuyAmountPolicy {
  target = scope(target);
  exact(value, ["revision", "chain", "mode", "amountSol", "amountBaseUnits", "slippageBps", "configuredAgainstRuleRevisionId", "updatedAt", "digest"]);
  if (!revision(value.revision) || value.revision < 1 || value.chain !== "solana" || value.mode !== "fixed_native"
    || !slippage(value.slippageBps) || !rule(value.configuredAgainstRuleRevisionId) || !isTimestamp(value.updatedAt)) fail();
  const amount = parsePrivateSolAmount(value.amountSol);
  if (amount.amountSol !== value.amountSol || amount.amountBaseUnits !== value.amountBaseUnits) fail();
  const body: Omit<PrivateBuyAmountPolicy, "digest"> = { revision: value.revision, chain: "solana", mode: "fixed_native", ...amount,
    slippageBps: value.slippageBps, configuredAgainstRuleRevisionId: value.configuredAgainstRuleRevisionId, updatedAt: value.updatedAt };
  if (value.digest !== hash(target, body)) fail();
  return freeze({ ...body, digest: value.digest as `sha256:${string}` });
}
export function parsePrivateSizingStatus(value: unknown, target: PrivateSizingScope): PrivateSizingStatus {
  target = scope(target); exact(value, ["agentId", "currentRuleRevisionId", "policy"]);
  if (value.agentId !== target.agentId || !rule(value.currentRuleRevisionId)) fail();
  return freeze({ agentId: target.agentId, currentRuleRevisionId: value.currentRuleRevisionId,
    policy: value.policy === null ? null : parsePrivateBuyAmountPolicy(value.policy, target) });
}
export function parsePrivateSizingCheckpoint(value: unknown, target: PrivateSizingScope): PrivateSizingCheckpoint {
  target = scope(target); exact(value, ["agentId", "policy", "lastChange"]); if (value.agentId !== target.agentId) fail();
  const policy = parsePrivateBuyAmountPolicy(value.policy, target); const lastChange = parsePrivateBuyAmountPolicyInput(value.lastChange);
  if (policy.revision !== lastChange.expectedRevision + 1 || policy.configuredAgainstRuleRevisionId !== lastChange.expectedRuleRevisionId
    || policy.amountSol !== lastChange.amountSol || policy.slippageBps !== lastChange.slippageBps) fail();
  return freeze({ agentId: target.agentId, policy, lastChange });
}
