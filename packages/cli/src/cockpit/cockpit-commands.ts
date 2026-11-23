/** K5b: the cockpit's slash commands. They are parsed ONLY from the line the owner typed into the input (CockpitScreen's Enter key),
 * never from a model reply, a signal, a token name or a feed line, so text containing "/stop" anywhere else does nothing.
 *
 * Risk rule: a command that lowers risk acts at once (pause, stop, a lower budget, lower limits, lower slippage, fewer signal
 * sources). A command that raises risk opens a code-built card and runs the owner command with its own typed confirmation (BUDGET,
 * SET LIMITS, CONFIRM, ARM and the passphrase, RESUME). Raising a limit above the signed spend ceiling says that arming then needs a
 * new wallet signature in the browser. Every line here is built by code from runner readbacks. Nothing here buys or sells. */
import type { PrivatePositionView } from "../runner/private-position-protocol.js";
import type { PrivateSpendLimitsView } from "../runner/private-arming-protocol.js";
import type { PrivateLaunchpadView } from "../runner/private-launchpads.js";
import type { PrivateCapSetting } from "../runner/private-spend-cap.js";
import { parsePrivateCapArgument } from "../runner/private-arming-ui.js";
import { parsePrivateModelBudgetUsd } from "../runner/private-model-budget-ui.js";
import { formatPrivateModelUsd } from "../runner/private-model-prices.js";
import { privateLamportsToSol, PRIVATE_SPEND_CAP_MAX_LAMPORTS } from "../runner/private-spend-cap.js";
import { formatPnl, positionRealizedPnl, totalRealizedPnl, type CockpitMode } from "./cockpit-panel.js";
import type { CockpitCard } from "./cockpit-cards.js";
import type { CockpitChatExit } from "./cockpit-flow.js";

export const COCKPIT_COMMANDS = Object.freeze([
  { name: "agents", usage: "/agents", help: "List your agents and switch (Ctrl+N); other agents keep running as they are" },
  { name: "new", usage: "/new", help: "Add a new agent to the runner and set it up" },
  { name: "pause", usage: "/pause", help: "Stop new buys now; stop-loss and take-profit exits keep running" },
  { name: "resume", usage: "/resume", help: "Turn paused new buys back on (stays armed), or resume a stopped agent (card, typed RESUME)" },
  { name: "stop", usage: "/stop", help: "Stop the agent now (exits stop too; warns first with open positions)" },
  { name: "arm", usage: "/arm", help: "Arm live trading (card: checks, ARM and passphrase)" },
  { name: "directive", usage: "/directive [change]", help: "Show the strategy; change opens the rules card (coach, typed CONFIRM)" },
  { name: "limit", usage: "/limit [per-buy daily | trade X | day X]", help: "Show or set spend limits in SOL (lower: at once; higher: card)" },
  { name: "budget", usage: "/budget [USD]", help: "Show or set the daily AI budget (lower: at once; higher: card)" },
  // A1 (owner decision of 22 Nov 2026): unfinished commands (/ask, /buy, /sell) are not listed or accepted until they work.
  { name: "model", usage: "/model", help: "Keep or change the AI model" },
  { name: "signals", usage: "/signals", help: "Choose launchpad signal sources (Telegram and Discord: on your Hub page)" },
  { name: "status", usage: "/status", help: "The runner and agent state" },
  { name: "positions", usage: "/positions", help: "Open positions with cost, proceeds and realized PnL in SOL" },
  { name: "wallet", usage: "/wallet", help: "Trading wallet address, QR code and balance" },
  { name: "settings", usage: "/settings", help: "Settings (Ctrl+S)" },
  { name: "lang", usage: "/lang [code]", help: "The language your agent replies in" },
  { name: "help", usage: "/help", help: "Commands and shortcuts (?)" },
  { name: "exit", usage: "/exit", help: "Leave the cockpit (the runner keeps running)" },
] as const);
export type CockpitCommandName = typeof COCKPIT_COMMANDS[number]["name"];
export interface CockpitSlash { name: CockpitCommandName; args: string[] }
/** Kept from before K5b: the open card and the same-job chat controls. */
export const COCKPIT_CHAT_CONTROLS = ["card", "check", "retry"] as const;
export const COCKPIT_SHORTCUTS = Object.freeze([
  "Enter: send · PgUp/PgDn: scroll the conversation",
  "Ctrl+E: open the card · Ctrl+S: settings · Ctrl+N: agents",
  "?: this help (on an empty line) · Esc: close an overlay · Ctrl+Q: leave",
]);

/** One typed line: a known command, an unknown one (shown as a notice, never sent to the model), or not a command (chat). */
export function parseSlashCommand(line: string): CockpitSlash | { unknown: string } | undefined {
  const text = line.trim();
  if (!text.startsWith("/")) return undefined;
  const match = /^\/([a-z]{1,16})(?:\s+([\s\S]*))?$/.exec(text);
  const name = match?.[1];
  if (!match || !name) return { unknown: text.slice(0, 24) };
  if ((COCKPIT_CHAT_CONTROLS as readonly string[]).includes(name)) return undefined;
  const known = COCKPIT_COMMANDS.find((item) => item.name === name);
  if (!known) return { unknown: `/${name}` };
  const args = (match[2] ?? "").split(/\s+/).filter(Boolean).slice(0, 4).map((value) => value.slice(0, 64));
  return { name: known.name, args };
}

export const COCKPIT_LANGUAGES = Object.freeze({ auto: "the language of my latest message", en: "English", tr: "Turkish", es: "Spanish",
  de: "German", fr: "French", pt: "Portuguese", it: "Italian", ru: "Russian", zh: "Chinese", ja: "Japanese", ko: "Korean" } as const);
export type CockpitLanguage = keyof typeof COCKPIT_LANGUAGES;
export function isCockpitLanguage(value: string): value is CockpitLanguage { return Object.hasOwn(COCKPIT_LANGUAGES, value); }
/** The reply-language note sent with each of the owner's messages (closed list, code-built), or "" for auto. */
export function cockpitLanguageNote(language: CockpitLanguage): string {
  return language === "auto" ? "" : `(Please reply in ${COCKPIT_LANGUAGES[language]}.)\n`;
}

export function cockpitHelpLines(): string[] {
  return ["Shortcuts", ...COCKPIT_SHORTCUTS.map((line) => `  ${line}`), "", "Commands (type them in the input line)",
    ...COCKPIT_COMMANDS.map((item) => `  ${item.usage}  ${item.help}`)];
}

// ---- lower or raise ---------------------------------------------------------------------------------------------------

export type CockpitChange = "lower" | "same" | "raise" | "invalid";
/** A cap value as typed into /limit: lamports, none, or a percentage (fixed from the balance when confirmed). */
function capRequest(value: string): ReturnType<typeof parsePrivateCapArgument> | undefined {
  try {
    const parsed = parsePrivateCapArgument(value);
    return parsed.kind === "lamports" && BigInt(parsed.lamports) > PRIVATE_SPEND_CAP_MAX_LAMPORTS ? undefined : parsed;
  } catch { return undefined; }
}
/** The current cap as /limit text ("0.1", "none"), or undefined when it was never answered. */
export function capText(cap: PrivateCapSetting): string | undefined {
  return cap.kind === "lamports" ? privateLamportsToSol(cap.lamports).replace(/ SOL$/, "") : cap.kind === "none" ? "none" : undefined;
}
function capChange(current: PrivateCapSetting, next: NonNullable<ReturnType<typeof capRequest>>): CockpitChange {
  if (current.kind === "unset") return "raise";
  if (next.kind === "percent") return "raise";
  if (next.kind === "none") return current.kind === "none" ? "same" : "raise";
  if (current.kind === "none") return "lower";
  const a = BigInt(next.lamports), b = BigInt(current.lamports);
  return a < b ? "lower" : a === b ? "same" : "raise";
}
/** Lower only when both caps are SOL amounts at or below the current ones (no percentage, no "none" over an amount, none unset). */
export function classifyLimits(current: Pick<PrivateSpendLimitsView, "perTrade" | "daily">, perTrade: string, daily: string): CockpitChange {
  const one = capRequest(perTrade), day = capRequest(daily);
  if (!one || !day) return "invalid";
  if (one.kind === "lamports" && day.kind === "lamports" && BigInt(one.lamports) > BigInt(day.lamports)) return "invalid";
  const changes = [capChange(current.perTrade, one), capChange(current.daily, day)];
  if (changes.includes("raise")) return "raise";
  return changes.every((change) => change === "same") ? "same" : "lower";
}
/** The caps above the signed ceiling (lamports), for the browser-signature note. */
export function aboveCeiling(ceiling: { perTradeLamports: string; dailyLamports: string } | undefined, perTrade: string, daily: string): string[] {
  if (!ceiling) return [];
  const over = (value: string, limit: string): boolean => {
    const parsed = capRequest(value);
    return !parsed || parsed.kind !== "lamports" || BigInt(parsed.lamports) > BigInt(limit);
  };
  return [...(over(perTrade, ceiling.perTradeLamports) ? [`per buy (signed: ${privateLamportsToSol(ceiling.perTradeLamports)})`] : []),
    ...(over(daily, ceiling.dailyLamports) ? [`per day (signed: ${privateLamportsToSol(ceiling.dailyLamports)})`] : [])];
}
export function classifyBudget(currentMicroUsd: number, usd: string): CockpitChange {
  const next = parsePrivateModelBudgetUsd(usd);
  if (next === undefined) return "invalid";
  return next < currentMicroUsd ? "lower" : next === currentMicroUsd ? "same" : "raise";
}
export function classifySlippage(currentBps: number, bps: number): CockpitChange {
  if (!Number.isSafeInteger(bps) || bps < 1) return "invalid";
  return bps < currentBps ? "lower" : bps === currentBps ? "same" : "raise";
}
/** Removing launchpads lowers what the agent researches; adding one is shown as a review in the overlay before it is saved. */
export function classifySources(current: readonly string[], next: readonly string[]): CockpitChange {
  const added = next.filter((id) => !current.includes(id)), removed = current.filter((id) => !next.includes(id));
  return added.length ? "raise" : removed.length ? "lower" : "same";
}

// ---- the command runner -----------------------------------------------------------------------------------------------

export interface CockpitRuntimeView { mode: CockpitMode; openPositions: number | null }
export interface CockpitAgentRow { agentId: string; mode: CockpitMode | "not in the runner"; current: boolean }
/** Everything a command reads or does (production: cockpit-runtime.ts). Each mutation is an existing owner command or control. */
export interface CockpitCommandDeps {
  agentId: string;
  now?(): number;
  status(): Promise<string[]>;
  runtime(): Promise<CockpitRuntimeView | undefined>;
  positions(): Promise<readonly PrivatePositionView[] | undefined>;
  budget(): Promise<{ limitMicroUsd: number; spentMicroUsd: number } | undefined>;
  /** The budget command for a lower limit (it applies without a typed phrase); returns its result line. */
  lowerBudget(usd: string): Promise<string>;
  limits(): Promise<PrivateSpendLimitsView | undefined>;
  ceiling(): Promise<{ perTradeLamports: string; dailyLamports: string } | undefined>;
  /** The limits command for caps `classifyLimits` called lower against `revision`; its SET LIMITS is answered only for that revision. */
  lowerLimits(perTrade: string, daily: string, revision: number): Promise<string>;
  sizing(): Promise<{ amountSol: string; slippageBps: number; revision: number } | undefined>;
  /** The sizing command for a lower slippage at the same amount; its CONFIRM is answered only for `revision`. A2a: the runner treats any
   * slippage change as raising (exit sells reuse it), so this asks the trading-wallet passphrase in a secret card when the runner asks. */
  lowerSlippage(amountSol: string, slippageBps: number, revision: number): Promise<string>;
  /** The daemon's pause control (an armed agent stays armed: new buys pause, exits keep running). */
  pause(): Promise<string>;
  /** The runner's stop (exits stop too). */
  stop(): Promise<string>;
  directive(): Promise<string[]>;
  launchpads(): Promise<PrivateLaunchpadView | undefined>;
  setLaunchpads(ids: readonly string[]): Promise<string>;
  agents(): Promise<CockpitAgentRow[]>;
}
export type CockpitCommandOutcome =
  | { kind: "lines"; lines: string[] }
  | { kind: "exit"; exit: CockpitChatExit }
  | { kind: "overlay"; overlay: "help" | "settings" | "agents" | "signals" }
  | { kind: "language"; language: CockpitLanguage; lines: string[] };
/** Per-screen state of the commands: the reply language and a pending /stop warning. */
export interface CockpitCommandState { language: CockpitLanguage; stopWarnedAt?: number }
export const COCKPIT_STOP_REPEAT_MS = 60_000;

const lines = (...text: string[]): CockpitCommandOutcome => ({ kind: "lines", lines: text });
const card = (value: CockpitCard): CockpitCommandOutcome => ({ kind: "exit", exit: { kind: "card", card: value } });

export function positionsLines(views: readonly PrivatePositionView[] | undefined): string[] {
  if (!views) return ["Positions could not be read right now."];
  const open = views.filter((view) => view.state !== "closed");
  if (!open.length) return ["No open positions.", `Realized PnL of closed positions: ${formatPnl(totalRealizedPnl(views))}`];
  return [`Open positions (${open.length}):`, ...open.map((view) => {
    const token = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(view.tokenMint) ? `${view.tokenMint.slice(0, 4)}…${view.tokenMint.slice(-4)}` : "(token)";
    return `  ${token}${view.state === "held" ? " (held for review)" : view.pendingExit ? " (exit in progress)" : ""}: cost ${privateLamportsToSol(view.costLamports)}, `
      + `proceeds ${privateLamportsToSol(view.proceedsLamports)}, realized ${formatPnl(positionRealizedPnl(view))}`;
  }), `Realized PnL in total: ${formatPnl(totalRealizedPnl(views))}. Unrealized PnL: not available yet.`];
}

async function limitCommand(deps: CockpitCommandDeps, args: string[]): Promise<CockpitCommandOutcome> {
  const current = await deps.limits();
  if (!current) return lines("The spend limits could not be read right now. Nothing was changed.");
  const perTradeNow = capText(current.perTrade), dailyNow = capText(current.daily);
  if (!args.length) {
    return lines(`Spend limits: ${perTradeNow ?? "not set"} per buy, ${dailyNow ?? "not set"} per UTC day (SOL).`,
      "Change: /limit <per-buy> <daily>, /limit trade <SOL> or /limit day <SOL>. Lower applies at once; higher opens a card.");
  }
  let perTrade: string | undefined, daily: string | undefined;
  if (args[0] === "trade" && args.length === 2) { perTrade = args[1]; daily = dailyNow; }
  else if (args[0] === "day" && args.length === 2) { perTrade = perTradeNow; daily = args[1]; }
  else if (args.length === 2) { perTrade = args[0]; daily = args[1]; }
  if (perTrade === undefined || daily === undefined) {
    return lines(args.length === 2 && (args[0] === "trade" || args[0] === "day")
      ? "Both limits must be set once first: /limit <per-buy> <daily>." : "Use /limit <per-buy> <daily>, /limit trade <SOL> or /limit day <SOL>.");
  }
  const change = classifyLimits(current, perTrade, daily);
  if (change === "invalid") return lines("Use SOL amounts up to 10 with at most 9 decimals (0.1), N% or none; the per-buy limit cannot be above the daily one.");
  if (change === "same") return lines("Those are the current limits. Nothing was changed.");
  if (change === "lower") return lines(await deps.lowerLimits(perTrade, daily, current.revision));
  return card({ kind: "limits_set", perTrade, daily });
}
async function budgetCommand(deps: CockpitCommandDeps, args: string[]): Promise<CockpitCommandOutcome> {
  const current = await deps.budget();
  if (!current) return lines("The daily AI budget could not be read right now. Nothing was changed.");
  if (!args.length) {
    return lines(`Daily AI budget: ${formatPrivateModelUsd(current.limitMicroUsd)} per UTC day, ${formatPrivateModelUsd(current.spentMicroUsd)} spent today.`,
      "Change: /budget <USD>. Lower applies at once; higher opens a card with the typed BUDGET confirmation.");
  }
  const usd = args[0]!.replace(/^\$/, "");
  const change = args.length === 1 ? classifyBudget(current.limitMicroUsd, usd) : "invalid";
  if (change === "invalid") return lines("Use a dollar amount from 0.10 to 1000 with at most two decimals, such as /budget 5.");
  if (change === "same") return lines("That is the current daily AI budget. Nothing was changed.");
  if (change === "lower") return lines(await deps.lowerBudget(usd));
  return card({ kind: "budget", usd });
}
async function stopCommand(deps: CockpitCommandDeps, state: CockpitCommandState): Promise<CockpitCommandOutcome> {
  const now = (deps.now ?? Date.now)();
  const runtime = await deps.runtime();
  const open = runtime?.openPositions ?? null;
  const repeated = state.stopWarnedAt !== undefined && now - state.stopWarnedAt <= COCKPIT_STOP_REPEAT_MS;
  if ((open === null || open > 0) && !repeated) {
    state.stopWarnedAt = now;
    return lines(open === null ? "The open positions could not be read. Stopping also stops stop-loss and take-profit exits."
      : `${deps.agentId} has ${open} open position${open === 1 ? "" : "s"}: stopping also stops their stop-loss and take-profit exits.`,
      "/pause stops new buys and keeps the exits running. Type /stop again within a minute to stop anyway.");
  }
  delete state.stopWarnedAt;
  return lines(await deps.stop());
}

async function slippageCommand(deps: CockpitCommandDeps, value: string): Promise<CockpitCommandOutcome> {
  const sizing = await deps.sizing();
  if (!sizing) return lines("No buy size is set yet (the setup card sets it), so there is no slippage to change.");
  if (!/^[1-9][0-9]{0,4}$/.test(value)) return lines("Use a whole number of bps, such as 100 (= 1%).");
  const bps = Number(value);
  const change = classifySlippage(sizing.slippageBps, bps);
  if (change === "invalid") return lines("Use a whole number of bps, such as 100 (= 1%).");
  if (change === "same") return lines("That is the current slippage. Nothing was changed.");
  if (change === "lower") return lines(await deps.lowerSlippage(sizing.amountSol, bps, sizing.revision));
  return card({ kind: "sizing", amountSol: sizing.amountSol, slippageBps: bps, owner: true });
}

/** The Ctrl+S settings: each field follows the same rule (lower at once, higher through its card and typed confirmation; A2a: a lower
 * slippage also asks the trading-wallet passphrase, since exit sells reuse it). A1 rows and order
 * (KOKPIT-SPEC §6 rule 9) for the settings that exist today: AI model · Daily AI budget · Directive · Reply language · Advanced (slippage,
 * own RPC). Rows of features not built yet (guardrails, notifications, transfers out) are not shown. The `field` keys are unchanged. */
export const COCKPIT_SETTINGS = Object.freeze([
  { field: "model", label: "AI model", hint: "Enter: keep or change (card)" },
  { field: "budget", label: "Daily AI budget (USD)", hint: "Enter: type a new amount" },
  { field: "strategy", label: "Directive", hint: "Enter: write a new one (card, typed CONFIRM)" },
  { field: "language", label: "Reply language", hint: "Enter: next language" },
  { field: "slippage", label: "Advanced: slippage (bps, 100 = 1%)", hint: "Enter: type a new value" },
  { field: "rpc", label: "Advanced: own Solana RPC", hint: "Enter: hidden field (card)" },
] as const);
export type CockpitSettingField = typeof COCKPIT_SETTINGS[number]["field"];
/** The next language in the closed list (the settings row cycles through it). */
export function nextCockpitLanguage(language: CockpitLanguage): CockpitLanguage {
  const codes = Object.keys(COCKPIT_LANGUAGES) as CockpitLanguage[];
  return codes[(codes.indexOf(language) + 1) % codes.length]!;
}
export async function applyCockpitSetting(field: CockpitSettingField, value: string, deps: CockpitCommandDeps, state: CockpitCommandState): Promise<CockpitCommandOutcome> {
  switch (field) {
    case "model": return card({ kind: "model" });
    case "strategy": return card({ kind: "rules_edit" });
    case "rpc": return card({ kind: "rpc_set" });
    case "budget": return budgetCommand(deps, [value]);
    case "slippage": return slippageCommand(deps, value);
    case "language": return runCockpitCommand({ name: "lang", args: [value] }, deps, state);
  }
}

/** The in-screen answer to the limits command's `limits> ` prompt for a classified lowering: SET LIMITS only while its review shows
 * the revision the cockpit compared against (a change in between cancels: nothing is sent). */
export function lowerLimitsAnswer(agentId: string, revision: number, review: string, label: string): string | null {
  return label === "limits> " && review.includes(`Limits revision: ${revision} -> ${revision + 1}`) ? `SET LIMITS ${agentId}` : null;
}
/** The in-screen acceptance of the sizing command's CONFIRM for a classified lower slippage: only the compared revision and value. */
export function lowerSlippageAccepts(revision: number, slippageBps: number, review: string, phrase: string): boolean {
  return /^CONFIRM [0-9a-f]{8}$/.test(phrase) && review.includes(`Sizing revision: ${revision} -> ${revision + 1}`) && review.includes(`Slippage: ${slippageBps} bps`);
}

/** A screen without runner access (tests, an older wiring): reads say so and nothing is changed. */
export function unavailableCommandDeps(agentId: string): CockpitCommandDeps {
  const text = async (): Promise<string> => "Not available on this screen. Nothing was changed.";
  const none = async (): Promise<undefined> => undefined;
  return { agentId, status: async () => ["The runner state is not available on this screen."], runtime: none, positions: none, budget: none, lowerBudget: text,
    limits: none, ceiling: none, lowerLimits: text, sizing: none, lowerSlippage: text, pause: text, stop: text,
    directive: async () => ["The strategy is not available on this screen."], launchpads: none, setLaunchpads: text, agents: async () => [] };
}

/** Runs one command typed by the owner. Mutations are only the risk-lowering ones; every raise returns a card. */
export async function runCockpitCommand(command: CockpitSlash, deps: CockpitCommandDeps, state: CockpitCommandState): Promise<CockpitCommandOutcome> {
  const { args } = command;
  if (command.name !== "stop") delete state.stopWarnedAt;
  switch (command.name) {
    case "help": return { kind: "overlay", overlay: "help" };
    case "settings": return { kind: "overlay", overlay: "settings" };
    case "agents": return { kind: "overlay", overlay: "agents" };
    case "signals": return { kind: "overlay", overlay: "signals" };
    case "exit": return { kind: "exit", exit: { kind: "quit" } };
    case "new": return { kind: "exit", exit: { kind: "new" } };
    case "arm": return card({ kind: "arm" });
    case "model": return card({ kind: "model" });
    case "wallet": return card({ kind: "wallet" });
    case "resume": return card({ kind: "resume" });
    case "pause": return lines(await deps.pause());
    case "stop": return stopCommand(deps, state);
    case "status": return lines(...await deps.status());
    case "positions": return lines(...positionsLines(await deps.positions()));
    case "limit": return limitCommand(deps, args);
    case "budget": return budgetCommand(deps, args);
    case "directive":
      if (args[0] === "change" || args[0] === "edit") return card({ kind: "rules_edit" });
      return lines(...await deps.directive(), "Change it: /directive change (the rules card: coach, stop-loss check and typed CONFIRM).");
    case "lang": {
      const code = args[0]?.toLowerCase();
      if (!code) return lines(`Reply language: ${COCKPIT_LANGUAGES[state.language]}.`, `Choose: /lang ${Object.keys(COCKPIT_LANGUAGES).join(" | ")}`);
      if (!isCockpitLanguage(code)) return lines(`Unknown language. Choose: ${Object.keys(COCKPIT_LANGUAGES).join(", ")}.`);
      state.language = code;
      return { kind: "language", language: code, lines: [`Your agent now replies in ${COCKPIT_LANGUAGES[code]}. Commands and cards stay in English.`] };
    }
  }
}
