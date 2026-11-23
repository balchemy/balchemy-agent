/** Cockpit cards: the only way a change starts from the cockpit. A card names one existing owner command; opening it runs
 * that command with its own review and its unchanged typed confirmation (SET LIMITS, CONFIRM, APPROVAL OFF, ARM, the
 * passphrases). A card never saves anything by itself, and its values are only defaults the command shows for review.
 * The next-step card comes from the setup state read by code; a chat-proposal card comes from a code-built reply line,
 * never from model text (see private-setup-card.ts).
 * Phase 2 (owner-approved order of 19 Nov 2026): the first setup's remaining steps are ONE card, `setup` (cockpit-setup.ts): strategy,
 * signal sources, limits, buy size and funding, then one summary with one typed CONFIRM, then the arm command. It is offered only
 * while no rules are confirmed; afterwards each change keeps its own card and typed confirmation. The own-RPC card is no longer
 * offered (Balchemy provides the connection; an own RPC is an advanced setting outside the default flow). */
import { parseSetupCard } from "../runner/private-setup-card.js";
import type { SetupStateReaders } from "../runner/setup-state.js";

export type CockpitCard =
  | { kind: "wallet_unlock" }
  | { kind: "setup" }
  | { kind: "rpc_set" }
  /** `perTrade`/`daily`: values typed with /limit or in the settings (a raise); the command reviews them and asks SET LIMITS. */
  | { kind: "limits_set"; perTrade?: string; daily?: string }
  | { kind: "limits_review"; proposalId: string }
  | { kind: "rules_edit" }
  | { kind: "rules_review"; proposalId: string }
  | { kind: "approval_off" }
  /** `owner`: values the owner typed in the cockpit (settings), not a chat suggestion. */
  | { kind: "sizing"; amountSol?: string; slippageBps?: number; owner?: true }
  | { kind: "arm" }
  /** K5b: a raise of the daily AI budget (the budget command asks BUDGET <agent>). */
  | { kind: "budget"; usd: string }
  /** K5b: resume (typed RESUME <agent>): new buys of an armed agent whose buys are paused (it stays armed), or a paused or stopped agent into
   * shadow mode (arming stays its own card). */
  | { kind: "resume" }
  /** K5b: keep or change the AI model (the cockpit's model step). */
  | { kind: "model" }
  /** K5b: the trading wallet address with its QR code and balance, shown outside the chat screen. */
  | { kind: "wallet" };

export function cardLabel(card: CockpitCard): string {
  switch (card.kind) {
    case "wallet_unlock": return "Unlock the trading wallet";
    case "setup": return "Finish setup: strategy, signal sources, limits, buy size and funding, then one confirmation and arm";
    case "rpc_set": return "Advanced: use your own Solana RPC (Balchemy's connection is unavailable; hidden field)";
    case "limits_set": return card.perTrade || card.daily
      ? `Review new spend limits: ${card.perTrade ?? "unchanged"} per buy, ${card.daily ?? "unchanged"} per day (typed SET LIMITS)`
      : "Set spend limits per buy and per day";
    case "limits_review": return `Review the proposed spend limits (${card.proposalId.slice(0, 8)})`;
    case "rules_edit": return "Write or pick the trading rules";
    case "rules_review": return `Review the proposed rules (${card.proposalId.replace(/^chat-rule-/, "").slice(0, 8)})`;
    case "approval_off": return "Allow automatic trading within your limits";
    case "sizing": return card.amountSol ? `Review the buy size: ${card.amountSol} SOL, ${card.slippageBps ?? 100} bps` : "Set the buy size";
    case "arm": return "Arm live trading (checks, wallet approval, ARM and passphrase)";
    case "budget": return `Raise the daily AI budget to $${card.usd} (typed BUDGET confirmation)`;
    case "resume": return "Resume new buys (armed) or return to shadow mode (typed RESUME confirmation)";
    case "model": return "Keep or change the AI model";
    case "wallet": return "Show the trading wallet address, QR code and balance";
  }
}

/** A1 (one screen): the kind word in a card's title rule. The word carries the meaning without colour (KOKPIT-SPEC §6.5). */
export type CockpitCardKind = "SETUP" | "REVIEW" | "WAITING" | "STATUS" | "SETTINGS" | "HELP" | "CONFIRM" | "ARM" | "APPROVE" | "BACK UP"
  | "TRANSFER OUT" | "STOP";
export type CockpitCardTone = "control" | "caution" | "danger";
export const COCKPIT_CARD_TONE: Readonly<Record<CockpitCardKind, CockpitCardTone>> = Object.freeze({
  SETUP: "control", REVIEW: "control", WAITING: "control", STATUS: "control", SETTINGS: "control", HELP: "control",
  CONFIRM: "caution", ARM: "caution", APPROVE: "caution", "BACK UP": "caution", "TRANSFER OUT": "danger", STOP: "danger",
});
/** What an in-screen card shows in its title rule. `secret`: the card shows or takes a secret (a wallet key, a passphrase, an API key):
 * it is modal, never enters the conversation, model memory, copy mode or export, and its text is discarded when it closes. */
export interface CockpitCardMeta { kind: CockpitCardKind; title: string; progress?: string; secret?: boolean }

/** The in-screen card of each cockpit card (code-built; the typed confirmations inside are the commands' own, unchanged).
 * A2a: every card whose command may now ask the trading-wallet passphrase (the socket proof, asked only when the runner answers
 * proof_required, after the typed phrase) is a secret card from the start, so it is modal and nothing in it reaches the rows, model memory,
 * copy mode or export. The setup card asks it at most once for its one batch of saves; /resume may also open the seal step inline. */
export function cardMeta(card: CockpitCard): CockpitCardMeta {
  switch (card.kind) {
    case "wallet_unlock": return { kind: "SETUP", title: "Unlock the trading wallet", secret: true };
    case "setup": return { kind: "SETUP", title: "Finish setup", secret: true };
    case "rpc_set": return { kind: "SETTINGS", title: "Your own Solana RPC (advanced)", secret: true };
    case "limits_set": return card.perTrade || card.daily ? { kind: "CONFIRM", title: "Raise the spend limits", secret: true } : { kind: "SETUP", title: "Spend limits", secret: true };
    case "limits_review": return { kind: "REVIEW", title: "Proposed spend limits", secret: true };
    case "rules_edit": return { kind: "SETUP", title: "Your directive", secret: true };
    case "rules_review": return { kind: "REVIEW", title: "Proposed rules", secret: true };
    case "approval_off": return { kind: "CONFIRM", title: "Trade automatically within your limits", secret: true };
    case "sizing": return card.owner ? { kind: "CONFIRM", title: "Raise the slippage", secret: true } : { kind: "SETUP", title: "Buy size", secret: true };
    case "arm": return { kind: "ARM", title: "Arm live trading", secret: true };
    case "budget": return { kind: "CONFIRM", title: "Raise the daily AI budget", secret: true };
    case "resume": return { kind: "CONFIRM", title: "Resume", secret: true };
    case "model": return { kind: "SETTINGS", title: "AI model", secret: true };
    case "wallet": return { kind: "STATUS", title: "Trading wallet" };
  }
}

/** The card for the first unfinished step after the deterministic part, from code-read state only. Undefined while a
 * reader fails (nothing is guessed). When every setup step is done, the card is arm, unless the agent is already armed. */
export async function nextStepCard(agentId: string, readers: SetupStateReaders, armed: boolean): Promise<CockpitCard | undefined> {
  try {
    const wallet = await readers.wallet(agentId);
    if (wallet.wallet === "locked") return { kind: "wallet_unlock" };
    // The first setup: no confirmed rules yet, so the one setup card covers strategy through arming.
    if (await readers.rules(agentId) !== "present") return { kind: "setup" };
    if (await readers.rulesApproval(agentId) !== "automatic") return { kind: "approval_off" };
    if (await readers.limits(agentId) !== "set") return { kind: "limits_set" };
    if (await readers.sizing(agentId) !== "set") return { kind: "sizing" };
    return armed ? undefined : { kind: "arm" };
  } catch { return undefined; }
}

/** Closed validation of a card that arrived from a reply line; anything else is dropped. */
export function parseCockpitCard(value: unknown): CockpitCard | undefined { return parseSetupCard(value); }
