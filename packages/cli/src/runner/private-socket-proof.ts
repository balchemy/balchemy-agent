/** A2a (runner redesign, runner-local security foundation): the socket-proof classifier. Pure module, no IO, no authority.
 *
 * Every frame the owner socket accepts is looked up in one closed `channel -> action` table. A frame whose class is `raising` needs
 * the trading-wallet passphrase as proof before the daemon applies it; `compare` entries are decided against the stored value by the
 * comparators below (the SAME comparators the authority watermark, private-authority-seal.ts, uses). Anything absent from the table
 * is `raising` (fail closed). The table is typed against every channel's parsed action union, so an action added to a parser without
 * a class here fails the typecheck.
 *
 * Classes: `read` (changes nothing), `neutral` (changes state but raises no risk limit: proposals, binds, registrations), `tightening`
 * (lowers risk), `self_proving` (the frame's own mandatory passphrase is checked by its handler: wallet unlock, arm, model vault
 * unlock), `raising` (needs the proof). Each raising or compare entry names the authority-watermark field(s) that seal the value it
 * changes, or an explicit exemption: `one_shot` (an action that changes no stored setting the watermark could cover) or `seal` (the
 * seal step itself).
 *
 * Slippage (amendment "Classification amendments", checked 23 Nov 2026): a sizing slippage change is RAISING IN BOTH DIRECTIONS.
 * The sizing policy's slippage becomes the buy plan's slippage (private-signal-plan.ts:191), the opened position stores it as its
 * entry slippage (private-exit-worker.ts:678,695; DCA adds inherit the parent's, private-dca-worker.ts:351), and every exit sell is
 * assessed with exactly that entry slippage (private-exit-worker.ts:704-706; private-exit-build.ts:156 refuses any other). There is
 * no separate exit slippage, so a LOWER slippage narrows the stop-loss and take-profit sells of every later position (an exit that
 * may no longer fill). Only a lower buy amount with the same slippage is tightening; the watermark compares slippage by equality. */
import type { LocalRunnerRequest } from "./protocol.js";
import type { PrivateArmingRequest } from "./private-arming-protocol.js";
import type { PrivateAutonomyRequest } from "./private-autonomy-protocol.js";
import type { PrivateBrainRequest } from "./private-brain-protocol.js";
import type { PrivateExitRebindRequest } from "./private-exit-rebind-protocol.js";
import type { PrivateIntentRequest } from "./private-intent-protocol.js";
import type { PrivateLaunchpadRequest } from "./private-launchpad-protocol.js";
import type { PrivateModelBudgetRequest } from "./private-model-budget-protocol.js";
import type { PrivateOwnerPinRequest } from "./private-owner-pin-protocol.js";
import type { PrivatePositionRequest } from "./private-position-protocol.js";
import type { PrivateRuleRequest } from "./private-rule-protocol.js";
import type { PrivateSetupRequest } from "./private-setup-protocol.js";
import type { PrivateSignalRequest } from "./private-signal-protocol.js";
import type { PrivateSizingRequest } from "./private-sizing-protocol.js";
import type { PrivateSolanaRpcRequest } from "./private-solana-rpc-protocol.js";
import type { PrivateSubmissionRequest } from "./private-submission-protocol.js";
import type { PrivateTradingBindingRequest } from "./private-trading-binding-protocol.js";
import type { PrivateTradingWalletRequest } from "./private-trading-keystore-protocol.js";
import type { PrivateCapSetting } from "./private-spend-cap.js";
import { parsePrivateSolAmount } from "./private-sizing.js";

/** The gate landed switched off (amendments, "Classification amendments"); A2a T4 switched it on: every raising frame needs the proof. */
export const PRIVATE_SOCKET_PROOF_ENFORCED = true;
/** Client-side wait for a frame that carries a proof: the daemon gives such a frame PRIVATE_ARMING_TIMEOUT_MS (25 s, one serialized
 * scrypt); the client waits a little longer so a slow proof is never reported as an unknown outcome. */
export const SOCKET_PROOF_CLIENT_TIMEOUT_MS = 27_000;
/** Closed refusals of the socket gate itself. */
export const PRIVATE_SOCKET_PROOF_ERRORS = ["proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled", "busy", "cancelled"] as const;
export type PrivateSocketProofError = typeof PRIVATE_SOCKET_PROOF_ERRORS[number];
/** Closed refusals of the owner pin and the authority watermark (arm, approval request/poll, entries resume, the seal step). */
export const PRIVATE_AUTHORITY_ERRORS = ["owner_pin_missing", "owner_pin_invalid", "owner_pin_mismatch", "authority_unsealed"] as const;
export type PrivateAuthorityError = typeof PRIVATE_AUTHORITY_ERRORS[number];

/** The authority-watermark fields (private-authority-seal.ts seals exactly these; its record's `values` keys equal this list). */
export const PRIVATE_AUTHORITY_FIELDS = ["caps", "sizing", "rules", "rpc", "model", "budget", "modelPrice", "autonomy", "launchpads"] as const;
export type PrivateAuthorityField = typeof PRIVATE_AUTHORITY_FIELDS[number];

export type SocketFrameClass = "read" | "neutral" | "tightening" | "self_proving" | "raising";
export type SocketProofExemption = "one_shot" | "seal";
export type SocketProofEntry =
  | { readonly kind: "read" | "neutral" | "tightening" | "self_proving" }
  /** `compare`: tightening or raising, decided against the stored value by a comparator (absent comparator: raising). */
  | { readonly kind: "raising" | "compare"; readonly authority: readonly PrivateAuthorityField[] | SocketProofExemption };

/** Channel names as the daemon dispatches them. `runner` is the generic control frame (no `channel` key, daemon.ts:1297);
 * `private_keep_awake` has no action and is looked up as `status`. */
export interface SocketProofChannelActions {
  runner: LocalRunnerRequest["action"];
  private_keep_awake: "status";
  private_trading_wallet: PrivateTradingWalletRequest["action"];
  private_trading_binding: PrivateTradingBindingRequest["action"];
  private_setup: PrivateSetupRequest["action"];
  private_launchpads: PrivateLaunchpadRequest["action"];
  private_arming: PrivateArmingRequest["action"];
  private_submissions: PrivateSubmissionRequest["action"];
  private_positions: PrivatePositionRequest["action"];
  private_exit_rebind: PrivateExitRebindRequest["action"];
  private_solana_rpc: PrivateSolanaRpcRequest["action"];
  private_sizing: PrivateSizingRequest["action"];
  private_model_budget: PrivateModelBudgetRequest["action"];
  private_autonomy: PrivateAutonomyRequest["action"];
  private_signals: PrivateSignalRequest["action"];
  private_intents: PrivateIntentRequest["action"];
  private_rules: PrivateRuleRequest["action"];
  private_brain: PrivateBrainRequest["action"];
  private_owner_pin: PrivateOwnerPinRequest["action"];
}
export type SocketProofChannel = keyof SocketProofChannelActions;
type SocketProofTable = { readonly [C in SocketProofChannel]: { readonly [A in SocketProofChannelActions[C]]: SocketProofEntry } };

const READ = { kind: "read" } as const;
const NEUTRAL = { kind: "neutral" } as const;
const TIGHTENING = { kind: "tightening" } as const;
const SELF_PROVING = { kind: "self_proving" } as const;
const ONE_SHOT = { kind: "raising", authority: "one_shot" } as const;

/** Every action every owner-socket parser accepts (daemon.ts:900-1347 walked, plus the new private_owner_pin channel). */
const TABLE: SocketProofTable = {
  // Generic frames. pause/stop/disarm/shutdown only lower risk; resume always lands shadow and unarmed (state.ts:229-233, Hub does it
  // too via control-bridge.ts:47); register_agent adds a shadow agent with no wallet; a generic `arm` is always refused (state.ts:218).
  runner: { status: READ, daemon_status: READ, daemon_version: READ, agent_list: READ, pause: TIGHTENING, stop: TIGHTENING,
    disarm: TIGHTENING, shutdown: TIGHTENING, resume: NEUTRAL, arm: NEUTRAL, register_agent: NEUTRAL },
  private_keep_awake: { status: READ },
  // create/recover: the wallet is absent by definition (and the sealed envelope is the proof); unlock carries its own passphrase.
  private_trading_wallet: { status: READ, preflight: READ, lock: TIGHTENING, create: NEUTRAL, recover: NEUTRAL, unlock: SELF_PROVING },
  // bind takes no caller-chosen value; autoBind does the same by itself (daemon.ts:419-425).
  private_trading_binding: { status: READ, bind: NEUTRAL },
  private_setup: { status: READ, watch: NEUTRAL },
  private_launchpads: { status: READ, set: { kind: "compare", authority: ["launchpads"] } },
  private_arming: { limits_status: READ, limits_quote: READ, limits_proposal: READ, wallet_balance: READ, precheck: READ,
    approval_request: NEUTRAL, approval_poll: READ, limits_set: { kind: "compare", authority: ["caps"] }, arm: SELF_PROVING,
    // Turns new entries back on; it changes no stored setting (the watermark itself is checked at entries_resume by the daemon).
    entries_resume: ONE_SHOT },
  // acknowledge_copy lifts a security hold; close's phrase is derivable from the attempt key (daemon.ts:1046).
  private_submissions: { list: READ, acknowledge_copy: ONE_SHOT, close: ONE_SHOT },
  // resolve rewrites a held position's outcome; unmanage drops a position's exit protection.
  private_positions: { list: READ, verify: READ, unmanage_check: READ, resolve: ONE_SHOT, unmanage: ONE_SHOT },
  private_exit_rebind: { preview: READ, apply: ONE_SHOT },
  // No order exists between two endpoints: every set is raising.
  private_solana_rpc: { status: READ, set: { kind: "raising", authority: ["rpc"] } },
  private_sizing: { status: READ, update: { kind: "compare", authority: ["sizing"] } },
  private_model_budget: { status: READ, update: { kind: "compare", authority: ["budget"] }, price: { kind: "compare", authority: ["modelPrice"] } },
  private_autonomy: { status: READ, update: { kind: "compare", authority: ["autonomy"] } },
  private_signals: { list: READ, read: READ },
  // preview builds an unsigned, non-executing intent preview (private-intent-protocol.ts:1).
  private_intents: { preview: NEUTRAL, read: READ },
  // propose/rollback/approval only create proposals (private-rule-service.ts:108-112); confirm is decided from the STORED proposal kind.
  private_rules: { head: READ, proposal_read: READ, revision_read: READ, receipt: READ, history: READ, propose: NEUTRAL, rollback: NEUTRAL,
    approval: NEUTRAL, confirm: { kind: "compare", authority: ["rules"] } },
  // chat_create: the brain's only writes are proposals (daemon.ts:761-764); model_unlock proves the vault passphrase itself.
  private_brain: { model_status: READ, chat_read: READ, chat_create: NEUTRAL, chat_cancel: NEUTRAL, model_lock: TIGHTENING,
    model_unlock: SELF_PROVING, model_configure: { kind: "raising", authority: ["model"] }, model_save: { kind: "raising", authority: ["model"] },
    model_reselect: { kind: "raising", authority: ["model"] } },
  private_owner_pin: { status: READ, seal: { kind: "raising", authority: "seal" } },
};
export const SOCKET_PROOF_TABLE: SocketProofTable = Object.freeze(TABLE);

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
/** The table entry, or undefined when the channel or action is not classified (the gate then treats the frame as raising). */
export function socketProofEntry(channel: string, action: string): SocketProofEntry | undefined {
  const actions = own(SOCKET_PROOF_TABLE as unknown as Readonly<Record<string, Readonly<Record<string, SocketProofEntry>>>>, channel);
  return actions ? own(actions, action) : undefined;
}
export function isSocketProofClassified(channel: string, action: string): boolean { return socketProofEntry(channel, action) !== undefined; }
/** The class of one parsed frame. `raises` answers a `compare` entry against the stored value (undefined or a throw: raising). An
 * unclassified channel or action is raising. */
export function classifySocketFrame(channel: string, action: string, raises?: () => boolean): SocketFrameClass {
  const entry = socketProofEntry(channel, action);
  if (!entry) return "raising";
  if (entry.kind !== "compare") return entry.kind;
  if (!raises) return "raising";
  try { return raises() ? "raising" : "tightening"; } catch { return "raising"; }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Comparators: true when `next` is looser than `stored`. Shared by the socket gate and the authority watermark.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Cap order: unset (arming refuses limits_missing) < lamports (by amount) < none (no limit). */
export function capRaise(stored: PrivateCapSetting, next: PrivateCapSetting): boolean {
  const rank = (cap: PrivateCapSetting): number => cap.kind === "unset" ? 0 : cap.kind === "lamports" ? 1 : 2;
  if (rank(next) !== rank(stored)) return rank(next) > rank(stored);
  return next.kind === "lamports" && stored.kind === "lamports" && BigInt(next.lamports) > BigInt(stored.lamports);
}
/** limits_set: raising when either cap is higher, `none` over an amount, or anything over `unset`. */
export function capsRaise(stored: { perTrade: PrivateCapSetting; daily: PrivateCapSetting },
  next: { perTrade: PrivateCapSetting; daily: PrivateCapSetting }): boolean {
  return capRaise(stored.perTrade, next.perTrade) || capRaise(stored.daily, next.daily);
}
export interface SocketProofSizing { amountSol: string; slippageBps: number }
/** Sizing update: the first set is raising, a higher amount is raising, and ANY slippage change is raising (see the module comment:
 * the entry slippage is also every later exit's sell slippage). Amounts compare as base units; an unparsable amount is raising. */
export function sizingRaise(stored: SocketProofSizing | null, next: SocketProofSizing): boolean {
  if (!stored) return true;
  try {
    if (BigInt(parsePrivateSolAmount(next.amountSol).amountBaseUnits) > BigInt(parsePrivateSolAmount(stored.amountSol).amountBaseUnits)) return true;
  } catch { return true; }
  return next.slippageBps !== stored.slippageBps;
}
/** AI daily budget: raising when the new limit is above the EFFECTIVE stored limit (the default when never set). */
export function budgetRaise(storedLimitMicroUsd: number, nextLimitMicroUsd: number): boolean { return nextLimitMicroUsd > storedLimitMicroUsd; }
export interface SocketProofModelPrice { provider: string; model: string; inputMicroUsdPerMillion: number; outputMicroUsdPerMillion: number }
/** Captured model price (the budget meter's estimate): a first capture, another provider or model, or a LOWER input or output price
 * (more calls fit under the same budget) is raising. */
export function priceRaise(stored: SocketProofModelPrice | null, next: SocketProofModelPrice): boolean {
  if (!stored) return true;
  return stored.provider !== next.provider || stored.model !== next.model
    || next.inputMicroUsdPerMillion < stored.inputMicroUsdPerMillion || next.outputMicroUsdPerMillion < stored.outputMicroUsdPerMillion;
}
/** Autonomous call allowance: raising when the daily call limit is higher. */
export function autonomyRaise(storedDailyCallLimit: number, nextDailyCallLimit: number): boolean { return nextDailyCallLimit > storedDailyCallLimit; }
/** Launchpad sources: raising when any id is added; a subset is tightening. Revision 0 or another binding is an empty baseline. */
export function launchpadRaise(stored: readonly string[], next: readonly string[]): boolean { return next.some((id) => !stored.includes(id)); }
/** Rule confirm, decided from the STORED proposal kind (private-rule-store.ts:30,380): only "approval on" (approval required again) is
 * tightening; an edit, a rollback or "approval off" is raising. */
export type SocketProofRuleProposal = { kind: "edit" | "rollback" } | { kind: "approval"; setting: "off" | "on" };
export function ruleConfirmRaise(proposal: SocketProofRuleProposal): boolean { return !(proposal.kind === "approval" && proposal.setting === "on"); }
