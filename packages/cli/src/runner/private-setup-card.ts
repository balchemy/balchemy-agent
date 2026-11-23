/** Proposal cards inside a stored chat reply. Only code appends a card line, after it saved an unconfirmed proposal or
 * validated a buy size. Every model-written reply passes through `withoutSetupCardLines`, so a model (or text it repeats
 * from research or a user message) can never forge one. The cockpit reads only the last line, through a closed parser.
 * A card is an offer to open the owner's own review command; it confirms or saves nothing. Older CLIs show it as text. */
import { parsePrivateSolAmount, privateSizingSlippageUsable } from "./private-sizing.js";

export const SETUP_CARD_PREFIX = "[balchemy-card] ";
export type SetupReplyCard =
  | { kind: "limits_review"; proposalId: string }
  | { kind: "rules_review"; proposalId: string }
  | { kind: "sizing"; amountSol: string; slippageBps: number };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
function solAmount(value: unknown): value is string {
  try { return typeof value === "string" && parsePrivateSolAmount(value).amountSol === value; } catch { return false; }
}
/** A suggested buy size above the 10 SOL backstop of a spend cap is never a card, whoever produced the line. */
function withinBackstop(amountSol: string): boolean {
  try { return BigInt(parsePrivateSolAmount(amountSol).amountBaseUnits) <= 10_000_000_000n; } catch { return false; }
}
export function parseSetupCard(value: unknown): SetupReplyCard | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(",");
  if ((item.kind === "limits_review" || item.kind === "rules_review") && keys === "kind,proposalId"
    && typeof item.proposalId === "string" && ID.test(item.proposalId)) return { kind: item.kind, proposalId: item.proposalId };
  if (item.kind === "sizing" && keys === "amountSol,kind,slippageBps" && solAmount(item.amountSol) && withinBackstop(item.amountSol)
    && Number.isSafeInteger(item.slippageBps) && privateSizingSlippageUsable(item.slippageBps as number)) {
    return { kind: "sizing", amountSol: item.amountSol, slippageBps: item.slippageBps as number };
  }
  return undefined;
}
export function setupCardLine(card: SetupReplyCard): string {
  const parsed = parseSetupCard(card);
  if (!parsed) throw new Error("Invalid setup card");
  return `${SETUP_CARD_PREFIX}${JSON.stringify(parsed)}`;
}
/** Removes every card-looking line (leading spaces included) from model-written text. */
export function withoutSetupCardLines(text: string): string {
  const kept = text.split("\n").filter((line) => !line.trimStart().startsWith(SETUP_CARD_PREFIX.trim()));
  const joined = kept.join("\n").trim();
  return joined || "(The reply contained nothing to show.)";
}
/** The reply text without its card line, and the card when the last line is a valid one. */
export function splitSetupCard(reply: string): { text: string; card?: SetupReplyCard } {
  const lines = reply.split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (!last.startsWith(SETUP_CARD_PREFIX)) return { text: reply };
  let card: SetupReplyCard | undefined;
  try { card = parseSetupCard(JSON.parse(last.slice(SETUP_CARD_PREFIX.length)) as unknown); } catch { card = undefined; }
  const text = lines.slice(0, -1).join("\n").trimEnd();
  return card ? { text, card } : { text };
}
