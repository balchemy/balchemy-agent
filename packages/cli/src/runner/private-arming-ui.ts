/** `balchemy runner wallet <agent> limits [--per-trade SOL|N%|none] [--daily SOL|N%|none]`, `... limits review <proposal>` and
 * `balchemy runner arm <agent>`.
 * Limits: status without flags; a change needs a real terminal, the exact typed confirmation and the ledger revision CAS. S4: a
 * cap is optional (owner items 19-20): `none` is an explicit "no limit", shown plainly and never confused with "not set". A
 * percentage is fixed into SOL from the wallet balance on the owner's RPC and shown before it is saved (item 31). A chat
 * proposal (`propose_spend_cap`) only pre-fills this same review; nothing but this typed confirmation saves caps.
 * Arm: real terminal only; the daemon's closed prechecks, a summary the owner reviews, the typed phrase `ARM <agent>` and the
 * re-entered trading-keystore passphrase (verified by the daemon and discarded, never stored), then one CAS'd transition
 * to live_armed. The server and Hub can never arm; `runner disarm <agent>` is immediate and needs no passphrase.
 * S6 moment 3: when the precheck refuses `owner_wallet_approval_missing`, the CLI asks the daemon to open (or recover) the owner's
 * one-time wallet approval, prints the Hub link and the LOCAL check code (recomputed by the runner from its own request, never
 * Balchemy's), polls every 3 s until the owner signed in Hub, then re-runs the precheck and continues to the unchanged typed
 * `ARM <agent>` and passphrase. Signing in Hub never arms anything by itself.
 * Phase 1 (17 Nov 2026): after a restart (wallet locked, agent disarmed) with open positions, the positions are shown first and the
 * passphrase is asked ONCE: it unlocks the wallet and is reused as the arm passphrase; the review and the typed `ARM <agent>` stay. A
 * trade still unresolved from before (no buy of it sendable) arms EXITS ONLY: entries stay paused until it is resolved. */
import { setTimeout as delay } from "node:timers/promises";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { privateChangeEntriesLines, PRIVATE_CHANGE_UNSAVED_TEXT, type PrivateChangeEntries } from "./private-change-entries.js";
import { parsePrivateSolAmount } from "./private-sizing.js";
import { createWalletPrompt, guardTerminalSignals, type WalletPrompt } from "./private-trading-keystore-ui.js";
import { privateTradingWalletBinding, PrivateTradingWalletTransportError, requestPrivateTradingWallet,
  type PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";
import { isTradingWalletPassphrase, parsePrivateTradingWalletRequest, validatePrivateTradingWalletReply,
  type PrivateTradingWalletResponse } from "./private-trading-keystore-protocol.js";
import { parsePrivatePositionRequest, privatePositionBinding, requestPrivatePositions, validatePrivatePositionReply,
  type PrivatePositionTransport } from "./private-position-protocol.js";
import type { PrivatePositionView } from "./private-position-recovery.js";
import { parsePrivateArmingRequest, privateArmingBinding, requestPrivateArming, validatePrivateArmingReply,
  PrivateArmingTransportError, PRIVATE_SPEND_CAP_PROPOSAL_ID, type PrivateArmingChannelError, type PrivateArmingRequest, type PrivateArmingResponse, type PrivateArmingSummary,
  type PrivateArmingTransport, type PrivateSpendLimitsView } from "./private-arming-protocol.js";
import type { RunnerAgentState } from "./protocol.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, type SocketProofOutcome, type SocketProofSecret } from "./private-socket-proof-client.js";
import { formatPrivateCap, formatPrivateCapRequest, formatPrivateSpendRemaining, privateLamportsToSol, samePrivateCap, PRIVATE_SPEND_CAP_MAX_LAMPORTS,
  type PrivateCapBasis, type PrivateCapRequest, type PrivateCapSetting } from "./private-spend-cap.js";

export interface PrivateArmingCommandOptions {
  args: string[]; directory: string; interactive: boolean;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  write(text: string): void | Promise<void>;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateArmingTransport;
  createPrompt?(): WalletPrompt;
  guardSignals?(cleanup: () => void): () => void;
  /** Test seams for the owner-approval poll (3 s waits, the link's expiry). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
  /** Phase 1 one-step resume (arm only): the trading wallet unlock and the position readback. Default: the real owner sockets, but
   * only when `transport` is not injected; with an injected `transport` and no seam here, there is no one-step resume. */
  walletTransport?: PrivateTradingWalletTransport;
  positionTransport?: PrivatePositionTransport;
  /** Limits only (the cockpit's setup card): the amounts the owner already confirmed. A quote that fixes either cap to anything else (a
   * percentage of a balance that changed since) is refused before the review: nothing is asked or saved (`quote_changed`). */
  acceptQuote?(quote: { perTrade: PrivateCapSetting; daily: PrivateCapSetting }): boolean;
  /** A2a socket proof of a raising limits save (asked only on `proof_required`, after the typed SET LIMITS). Undefined: the command's own
   * hidden prompt; null: no prompt here (the cockpit's lowered path), so a raise the daemon sees ends with its plain text. */
  proofSecret?: SocketProofSecret | null;
  /** A2a seal step, inline in arm (runner owner-pin): run when the precheck refuses `owner_pin_missing`, `owner_pin_invalid` or
   * `owner_pin_mismatch`, or arms for exits only because the settings are not sealed (`authority_unsealed`). `known`: the passphrase this
   * arm card already holds (one-step resume). True when the seal was stored; the precheck then runs again (a second refusal is final). */
  sealAuthority?(known?: string): Promise<boolean>;
}

export const LIMITS_ACTION = "limits";
export function lamportsToSol(value: string): string { return privateLamportsToSol(value); }
function bpsPercent(bps: number): string { return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`; }

// ---- limits ----------------------------------------------------------------------------------------------------------
type LimitsCommand = { agentId: string; action: "status" }
  | { agentId: string; action: "set"; perTrade?: PrivateCapRequest; daily?: PrivateCapRequest }
  | { agentId: string; action: "review"; proposalId: string };
export type PrivateSpendLimitsResult = { kind: "dry_run"; command: LimitsCommand } | { kind: "status"; limits: PrivateSpendLimitsView }
  /** `entries` only when the agent was armed when the save began (new entries paused while it was saved). */
  | { kind: "updated"; limits: PrivateSpendLimitsView; entries?: PrivateChangeEntries } | { kind: "cancelled"; agentId: string; reason: "input_closed" | "limits_not_confirmed" | "unchanged" | "quote_changed" }
  | { kind: "outcome_unknown"; agentId: string };
function limitsInvalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid spend limits command",
    cause: "Use runner wallet <agent> limits, add --per-trade <SOL|N%|none> and/or --daily <SOL|N%|none>, or review a chat proposal with runner wallet <agent> limits review <proposal>.",
    fix: "Enter a positive SOL amount with at most 9 decimal places, a percentage of the trading wallet (1% to 100%, fixed into SOL when you confirm) "
      + "or none for no limit. Per-trade must not exceed daily, and an amount is at most 10 SOL. --yes, --force and --quiet are not supported.", exitCode: 2 });
}
/** One cap argument: `none`, `N%` (1..100, up to 2 decimals) or a SOL amount. */
export function parsePrivateCapArgument(value: string): PrivateCapRequest {
  if (value === "none") return { kind: "none" };
  const percent = /^(100|[1-9][0-9]?)(?:\.([0-9]{1,2}))?%$/.exec(value);
  if (percent) {
    const bps = Number(percent[1]) * 100 + Number((percent[2] ?? "").padEnd(2, "0"));
    if (bps < 1 || bps > 10_000) limitsInvalid();
    return { kind: "percent", percentBps: bps };
  }
  try { return { kind: "lamports", lamports: parsePrivateSolAmount(value).amountBaseUnits }; } catch { return limitsInvalid(); }
}
export function parsePrivateSpendLimitsArguments(args: string[]): LimitsCommand {
  const [agentId, action, ...rest] = args;
  if (!isId(agentId) || action !== LIMITS_ACTION) limitsInvalid();
  if (rest[0] === "review") {
    if (rest.length !== 2 || !PRIVATE_SPEND_CAP_PROPOSAL_ID.test(rest[1]!)) limitsInvalid();
    return Object.freeze({ agentId, action: "review", proposalId: rest[1]! });
  }
  if (rest.length % 2 !== 0 || rest.length > 4) limitsInvalid();
  if (rest.length === 0) return Object.freeze({ agentId, action: "status" });
  const values = new Map<string, PrivateCapRequest>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!; const value = rest[index + 1]!;
    if (!["--per-trade", "--daily"].includes(key) || values.has(key)) limitsInvalid();
    const parsed = parsePrivateCapArgument(value);
    if (parsed.kind === "lamports" && BigInt(parsed.lamports) > PRIVATE_SPEND_CAP_MAX_LAMPORTS) limitsInvalid();
    values.set(key, parsed);
  }
  return Object.freeze({ agentId, action: "set", ...(values.has("--per-trade") ? { perTrade: values.get("--per-trade")! } : {}),
    ...(values.has("--daily") ? { daily: values.get("--daily")! } : {}) });
}
function target(options: Pick<PrivateArmingCommandOptions, "resolveTarget" | "directory">, agentId: string): PrivateBrainTarget {
  try { return Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
}
const CAP_ERROR_TEXT: Partial<Record<PrivateArmingChannelError, string>> = {
  revision_conflict: "The spend limits changed during this review.",
  proposal_missing: "That spend cap proposal is unknown or expired (proposals live in the running daemon for 24 hours). Ask again in chat or set the caps directly.",
  basis_stale: "The wallet balance used to fix a percentage is too old. Review again: the percentage is fixed from a fresh balance.",
  balance_unavailable: "The trading wallet balance could not be read (with Balchemy's connection both providers must answer the same balance), so a percentage cannot be fixed. Use a SOL amount or try again.",
  cap_out_of_bounds: "The fixed amount is zero, above the 10 SOL limit for an amount cap, or the per-trade cap would exceed the daily cap.",
  rpc_missing: "A percentage is fixed from your wallet balance, and Balchemy's Solana connection is not ready yet. Check balchemy runner rpc <agent> status and try again, or use a SOL amount.",
  rpc_public: "A percentage is fixed from your wallet balance, and Balchemy's Solana connection is unavailable (a public endpoint is shadow-only). Check balchemy runner rpc <agent> status, or use a SOL amount.",
  wallet_missing: "This agent has no trading wallet, so a percentage of it cannot be fixed.",
};
/** Owner text of a refused limits read, quote or save (the cockpit's setup card shows it). */
export function privateSpendCapErrorText(code: PrivateArmingChannelError): string { return CAP_ERROR_TEXT[code] ?? `The local runner returned ${code}.`; }
function channelFailure(title: string, code: PrivateArmingChannelError | "unavailable", note?: string): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title, cause: code === "unavailable" ? "The selected runner could not return a validated answer."
    : CAP_ERROR_TEXT[code] ?? `The local runner returned ${code}.`,
    fix: `Read the current state again before retrying. Do not reset private files.${note ? ` ${note}` : ""}`, exitCode: ["invalid_request", "revision_conflict"].includes(code) ? 2 : 1 });
}
async function exchange(transport: PrivateArmingTransport, socketPath: string, request: PrivateArmingRequest): Promise<PrivateArmingResponse> {
  return validatePrivateArmingReply(request, await transport(socketPath, request));
}

/** The current answer as a request (an unanswered cap has none). */
function currentRequest(cap: PrivateCapSetting): PrivateCapRequest | undefined { return cap.kind === "unset" ? undefined : cap; }
function capLine(cap: PrivateCapSetting, basis: PrivateCapBasis | null): string {
  if (!basis || cap.kind !== "lamports") return formatPrivateCap(cap);
  return `${bpsPercent(basis.percentBps)} of ${privateLamportsToSol(basis.balanceLamports)} = ${privateLamportsToSol(cap.lamports)} (fixed now; it does not follow the balance)`;
}

export async function runPrivateSpendLimitsCommand(options: PrivateArmingCommandOptions): Promise<PrivateSpendLimitsResult> {
  const command = parsePrivateSpendLimitsArguments(options.args);
  if (options.flags.yes || options.flags.force || options.flags.quiet) limitsInvalid();
  if (options.flags.dryRun) return { kind: "dry_run", command };
  if (command.action !== "status" && (!options.interactive || options.flags.json || options.flags.ci)) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive limits confirmation required",
      cause: "Changing the spend limits of a trading wallet requires a real terminal and an exact typed confirmation.",
      fix: "Run without --json or --ci in a terminal. Reading limits supports JSON and non-interactive use.", exitCode: 2 });
  }
  const pinned = target(options, command.agentId);
  if (pinned.agentId !== command.agentId) limitsInvalid();
  const transport = options.transport ?? requestPrivateArming;
  const read = parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "limits_status" });
  let current: PrivateArmingResponse;
  try { current = await exchange(transport, pinned.socketPath, read); } catch { return channelFailure("Spend limits unavailable", "unavailable"); }
  if (!current.ok) return channelFailure("Spend limits unavailable", current.error);
  if (current.data.kind !== "limits") return channelFailure("Spend limits unavailable", "unavailable");
  const limits = current.data.limits;
  if (command.action === "status") return { kind: "status", limits };
  // A chat proposal is only a suggestion: it is read here and goes through exactly the same review and typed confirmation.
  let requested: { perTrade?: PrivateCapRequest; daily?: PrivateCapRequest } = command.action === "set" ? command : {};
  let source = "";
  if (command.action === "review") {
    let proposal: PrivateArmingResponse;
    try { proposal = await exchange(transport, pinned.socketPath, parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "limits_proposal",
      proposalId: command.proposalId })); } catch { return channelFailure("Spend cap proposal unavailable", "unavailable"); }
    if (!proposal.ok) return channelFailure("Spend cap proposal unavailable", proposal.error);
    if (proposal.data.kind !== "limits_proposal") return channelFailure("Spend cap proposal unavailable", "unavailable");
    requested = { perTrade: proposal.data.proposal.perTrade, daily: proposal.data.proposal.daily };
    source = `Proposed in chat (${command.proposalId}): per-trade ${formatPrivateCapRequest(proposal.data.proposal.perTrade)}, daily ${formatPrivateCapRequest(proposal.data.proposal.daily)}`;
  }
  const perTradeRequest = requested.perTrade ?? currentRequest(limits.perTrade), dailyRequest = requested.daily ?? currentRequest(limits.daily);
  if (!perTradeRequest || !dailyRequest) {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Both limits are required", cause: "This agent's spend limits were never answered.",
      fix: `Answer both (an amount, a percentage or none): balchemy runner wallet ${command.agentId} limits --per-trade <SOL|N%|none> --daily <SOL|N%|none>`, exitCode: 2 });
  }
  // A percentage is fixed into lamports now, from the wallet balance on the owner's RPC, and shown before anything is saved.
  let quoteRequest: PrivateArmingRequest;
  try { quoteRequest = parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "limits_quote", perTrade: perTradeRequest, daily: dailyRequest }); }
  catch { return limitsInvalid(); }
  let fixed: PrivateArmingResponse;
  try { fixed = await exchange(transport, pinned.socketPath, quoteRequest); } catch { return channelFailure("Spend limits not saved", "unavailable"); }
  if (!fixed.ok) return channelFailure("Spend limits not saved", fixed.error);
  if (fixed.data.kind !== "limits_quote") return channelFailure("Spend limits not saved", "unavailable");
  // A cap kept from the current answer keeps its stored percentage basis (same amount, same reading); a new one uses the quote's.
  const keep = (asked: PrivateCapRequest | undefined, cap: PrivateCapSetting, basis: PrivateCapBasis | null, quoted: PrivateCapSetting): boolean =>
    asked === undefined && basis !== null && samePrivateCap(cap, quoted);
  const quote = { ...fixed.data.quote,
    perTradeBasis: keep(requested.perTrade, limits.perTrade, limits.perTradeBasis, fixed.data.quote.perTrade) ? limits.perTradeBasis : fixed.data.quote.perTradeBasis,
    dailyBasis: keep(requested.daily, limits.daily, limits.dailyBasis, fixed.data.quote.daily) ? limits.dailyBasis : fixed.data.quote.dailyBasis };
  if (options.acceptQuote && !options.acceptQuote({ perTrade: quote.perTrade, daily: quote.daily })) return { kind: "cancelled", agentId: command.agentId, reason: "quote_changed" };
  if (samePrivateCap(quote.perTrade, limits.perTrade) && samePrivateCap(quote.daily, limits.daily)
    && JSON.stringify([quote.perTradeBasis, quote.dailyBasis]) === JSON.stringify([limits.perTradeBasis, limits.dailyBasis])) {
    return { kind: "cancelled", agentId: command.agentId, reason: "unchanged" };
  }
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  const releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => prompt.close());
  try {
    const phrase = `SET LIMITS ${command.agentId}`;
    const unlimited = quote.perTrade.kind === "none" || quote.daily.kind === "none";
    await options.write([`Review spend limits for ${command.agentId} (Solana trading wallet)`, ...(source ? [source] : []),
      `  Per-trade cap: ${formatPrivateCap(limits.perTrade, limits.perTradeBasis)} -> ${capLine(quote.perTrade, quote.perTradeBasis)}`,
      `  Daily cap (UTC day): ${formatPrivateCap(limits.daily, limits.dailyBasis)} -> ${capLine(quote.daily, quote.dailyBasis)}`,
      `  Limits revision: ${limits.revision} -> ${limits.revision + 1}`,
      `  Today (${limits.utcDay}): ${lamportsToSol(limits.spentLamports)} spent, ${lamportsToSol(limits.reservedLamports)} reserved`,
      ...(unlimited ? ["No limit is your choice: Balchemy adds no hidden spend limit. One trade at a time per wallet still applies."] : []),
      "Every build is checked against these caps locally. Lowering a cap below today's use only refuses new trades.",
      "Limits alone never arm the agent or grant trading.",
      `Type exactly ${phrase} to save; any other answer cancels.`, ""].join("\n"));
    const answer = await prompt.line("limits> ");
    if (answer === null || prompt.closed) return { kind: "cancelled", agentId: command.agentId, reason: "input_closed" };
    if (answer !== phrase) return { kind: "cancelled", agentId: command.agentId, reason: "limits_not_confirmed" };
    // A2a: the save is sent without the proof first; a raise the daemon refuses with proof_required asks the passphrase (fresh frame id).
    const update = (passphrase?: string): PrivateArmingRequest => parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "limits_set",
      expectedRevision: limits.revision, perTrade: quote.perTrade, daily: quote.daily, perTradeBasis: quote.perTradeBasis, dailyBasis: quote.dailyBasis,
      ...(passphrase !== undefined ? { passphrase } : {}) });
    const first = update();
    let outcome: SocketProofOutcome<PrivateArmingResponse>;
    try {
      outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? first : update(passphrase)),
        send: (request) => exchange(transport, pinned.socketPath, request), error: (reply) => (reply.ok ? undefined : reply.error),
        secret: options.proofSecret === undefined ? (label) => prompt.secret(label) : options.proofSecret,
        unlock: socketProofUnlock(pinned, options.walletTransport) });
    } catch (error: unknown) {
      if (error instanceof PrivateArmingTransportError && error.code === "connection_unavailable") return channelFailure("Spend limits not saved", "unavailable");
      return { kind: "outcome_unknown", agentId: command.agentId };
    }
    if (outcome.kind === "cancelled") return { kind: "cancelled", agentId: command.agentId, reason: "input_closed" };
    if (outcome.kind !== "response") return socketProofFailure(outcome, command.agentId, "Spend limits not saved");
    const response = outcome.response;
    if (!response.ok) {
      if (response.error === "state_unavailable") return { kind: "outcome_unknown", agentId: command.agentId };
      return channelFailure("Spend limits not saved", response.error, PRIVATE_CHANGE_UNSAVED_TEXT);
    }
    if (response.data.kind !== "limits_set") return { kind: "outcome_unknown", agentId: command.agentId };
    return { kind: "updated", limits: response.data.limits, ...(response.data.entries ? { entries: response.data.entries } : {}) };
  } finally { releaseSignals(); prompt.close(); }
}
function limitLines(limits: PrivateSpendLimitsView): string[] {
  // Never reads like "no limit": an unanswered agent can spend nothing.
  if (limits.revision === 0) return ["Spend limits: not set. Arming and every build are refused until you answer both caps "
    + "(an amount, a percentage of the wallet fixed when you confirm, or the word none)."];
  return [`Per-trade cap: ${formatPrivateCap(limits.perTrade, limits.perTradeBasis)}`, `Daily cap (UTC day): ${formatPrivateCap(limits.daily, limits.dailyBasis)}`,
    `Limits revision: ${limits.revision}`, `Today (${limits.utcDay}): ${lamportsToSol(limits.spentLamports)} spent, ${lamportsToSol(limits.reservedLamports)} reserved, `
    + `${formatPrivateSpendRemaining(limits.remaining)} remaining`];
}
export function formatPrivateSpendLimitsResult(result: PrivateSpendLimitsResult): string {
  if (result.kind === "dry_run") return "Spend limits preview; no connection, prompt or change made.\n";
  if (result.kind === "cancelled" && result.reason === "quote_changed") {
    return "Spend limits not saved: a percentage now fixes a different SOL amount than the one you confirmed (the wallet balance changed). Nothing was sent.\n";
  }
  if (result.kind === "cancelled") return result.reason === "unchanged" ? "Spend limits unchanged. Nothing was sent.\n"
    : `Spend limits change cancelled (${result.reason.replace(/_/g, " ")}). Nothing was sent.\n`;
  if (result.kind === "outcome_unknown") return [`Spend limits update outcome unknown for ${result.agentId}. Nothing was retried.`,
    `Read the current limits: balchemy runner wallet ${result.agentId} limits`, PRIVATE_CHANGE_UNSAVED_TEXT, ""].join("\n");
  return [`Spend limits for ${result.limits.agentId}${result.kind === "updated" ? " saved." : ""}`, ...limitLines(result.limits),
    ...(result.kind === "updated" ? privateChangeEntriesLines(result.entries, result.limits.agentId) : []),
    "Limits never arm the agent or grant trading by themselves.", ""].join("\n");
}

// ---- arm -------------------------------------------------------------------------------------------------------------
export type PrivateArmResult = { kind: "dry_run"; agentId: string }
  | { kind: "refused"; agentId: string; code: PrivateArmingChannelError }
  | { kind: "cancelled"; agentId: string; reason: "input_closed" | "arm_not_confirmed" | "approval_expired" | "approval_stopped" }
  /** `exitsOnly`: armed with new entries paused until no unresolved trade remains (Phase 1). */
  | { kind: "armed"; agentId: string; state: RunnerAgentState; summary: PrivateArmingSummary; exitsOnly?: true }
  /** The arm request may or may not have applied; read `runner status` before anything else. */
  | { kind: "outcome_unknown"; agentId: string };

/** Owner-facing explanation and next step for every closed arming refusal. */
export const PRIVATE_ARMING_REFUSAL_TEXT: Readonly<Record<PrivateArmingChannelError, string>> = Object.freeze({
  agent_stopped: "The agent is stopped. Resume it in Hub (Resume shadow) before arming.",
  agent_paused: "The agent is paused. Resume it in Hub (Resume shadow) before arming.",
  already_armed: "The agent is already armed. Disarm with balchemy runner disarm <agent> if that was not intended.",
  not_paired: "The agent is not paired with Balchemy Hub. Run balchemy runner pair <agent> first.",
  lease_unavailable: "The runner has no active Hub connection for this agent. Check runner status and your network, then try again.",
  wallet_missing: "This agent has no trading wallet. Create one with balchemy runner wallet <agent> create.",
  wallet_locked: "The trading wallet is locked. Unlock it with balchemy runner wallet <agent> unlock.",
  wallet_unbound: "The trading wallet is not bound in Hub. Bind it with balchemy runner wallet <agent> bind.",
  wallet_binding_inactive: "The trading wallet's Hub binding is not active for this wallet and pairing. Check runner wallet <agent> status.",
  rpc_missing: "Balchemy's Solana connection (two providers) is not ready for this agent yet. It is set up automatically once the runner is linked and online; check balchemy runner rpc <agent> status. Your own RPC is optional (advanced: balchemy runner rpc <agent> set).",
  rpc_public: "Balchemy's Solana connection is unavailable and the configured RPC is a public endpoint, which is shadow-only. Check balchemy runner rpc <agent> status; your own RPC is optional (advanced: balchemy runner rpc <agent> set).",
  rules_missing: "No confirmed Solana rules exist. Write and confirm them with balchemy runner rules <agent> solana edit.",
  rules_not_executable: "The confirmed Solana rules are not executable (held for review, unsupported or with emergency rules). Review them with balchemy runner rules <agent> solana show.",
  rules_shadow_mode: "The confirmed rules set shadow mode. Remove shadow mode from the rules and confirm them before arming.",
  stop_loss_missing: "The confirmed rules have no stop-loss. A stop-loss is mandatory for live trading; add one and confirm the rules.",
  owner_approval_required: "Your confirmed rules still require your approval before trades. In-app trade approval is not available yet, so an armed agent "
    + "could not trade. To let it buy automatically within your per-trade and daily caps, turn approval off explicitly with "
    + "balchemy runner rules <agent> solana approval off (it shows the change and asks you to type APPROVAL OFF <agent>), then run runner arm again.",
  exits_unavailable: "Arming is not available in this version: it has no automatic stop-loss exits. Arm checks this first, so your "
    + "other setup was not checked; nothing trades.",
  limits_missing: "Your spend limits are not set yet. Answer both with balchemy runner wallet <agent> limits --per-trade <SOL|N%|none> --daily <SOL|N%|none> "
    + "(none means no limit, your choice).",
  owner_wallet_approval_missing: "Your wallet approval for automatic trading on this computer is missing. It is needed once per computer, and again "
    + "after a new trading wallet or a raised or removed spend limit. Run balchemy runner arm <agent> in a terminal: it shows a Hub link where you "
    + "sign once with your paired wallet. Signing never arms the agent by itself.",
  owner_approval_unverifiable: "This runner cannot check your wallet approval, so arming stays refused and nothing trades. Either the agent is "
    + "paired with a Base (EVM) wallet (support for Base-paired owners comes in a later version), or Balchemy asked you to sign for a different "
    + "Solana network than the one you paired on (contact Balchemy support).",
  approval_unavailable: "Balchemy could not be reached to open or read your wallet approval. Check your network and runner status, then run "
    + "balchemy runner arm <agent> again. Nothing was armed.",
  approval_superseded: "A newer wallet approval for this trading wallet is already stored on this computer, so this one was not used. "
    + "Nothing was armed. Run balchemy runner arm <agent> again.",
  approval_mismatch: "Balchemy's answer did not match what this runner asked you to approve (the terms, the check code or the wallet signature). "
    + "Nothing was saved and nothing was armed. Do not sign that link. Run balchemy runner arm <agent> again; if it repeats, contact Balchemy support.",
  sizing_missing: "No buy size is set. Set it with balchemy runner sizing <agent> --amount-sol <SOL> --slippage-bps <bps>.",
  sizing_slippage_above_bound: "The buy size's slippage is above 5000 bps, so no buy could execute. Lower it with balchemy runner sizing <agent> --amount-sol <SOL> --slippage-bps <bps>.",
  submission_unresolved: "A previous trade is still unresolved (see balchemy runner trades <agent>). A trade in flight, or one Balchemy disputes "
    + "(last: engine:...), settles on its own; arm again once it shows settled. A trade this runner disputes (last: runner:..., also one shown as "
    + "Can no longer land) never settles on its own: close it out with balchemy runner trades <agent> close <attempt> (it proves on your RPC that "
    + "the trade can no longer land first). Arming is refused only while a buy from before could still be sent; otherwise it offers to arm for "
    + "exits only.",
  submission_unrelayed: "A trade signed before a restart or an outage was never sent: Balchemy holds no signed copy of it. The bot ends it by "
    + "itself once your own Solana RPC proves it can no longer land and did not land (a buy's spend is released; a sell's coins stay in the "
    + "position and its exit is planned again); that check runs while the bot is not armed. See balchemy runner trades <agent> for what the "
    + "check is waiting for, then arm again.",
  copy_unacknowledged: "A transaction with this wallet's key was signed outside Balchemy. Review balchemy runner trades <agent>, then runner wallet <agent> acknowledge-copy.",
  passphrase_rejected: "Wrong passphrase. Nothing was armed. Run balchemy runner arm <agent> again.",
  version_conflict: "The agent's state changed during the review. Nothing was armed; run runner arm again.",
  summary_changed: "A reviewed fact (wallet, caps, rules, RPC or buy size) changed during the review. Nothing was armed; run runner arm again.",
  invalid_request: "The local runner rejected the request.", profile_conflict: "The local profile changed. Inspect runner status.",
  instance_conflict: "The daemon changed. Nothing was sent to another instance.", unknown_agent: "This agent is not registered with the local runner.",
  revision_conflict: "The state changed during the review.", clock_rollback: "The system clock moved backwards. Fix the clock before arming.",
  busy: "Another arming check is in progress for this agent.", cancelled: "The arming check was cancelled.",
  proposal_missing: "That spend cap proposal is unknown or expired.", basis_stale: "A percentage basis is too old; review the caps again.",
  balance_unavailable: "The trading wallet balance could not be read.", cap_out_of_bounds: "A cap is out of bounds.",
  state_unavailable: "Local state could not be confirmed. Nothing was armed.", closing: "The daemon is closing.",
  // Owner resume of new entries (cockpit /resume of an armed agent whose new buys are paused).
  not_armed: "The agent is not armed, so there are no paused new buys to turn back on. Nothing was changed.",
  entries_not_paused: "New buys of this agent are not paused. Nothing was changed.",
  change_pending: "The runner paused new buys itself while a change to this agent's rules, spend limits or buy size is being saved, or because "
    + "that change was not saved. Nothing was changed: save the change again, and new buys turn on by themselves once it is saved and every "
    + "check passes. Stop-loss and take-profit exits keep running.",
  // A2a socket proof, owner pin and authority watermark.
  proof_required: "This change needs your trading wallet passphrase. Nothing was changed.",
  proof_throttled: "Too many wrong passphrases in a row. Nothing was changed. Wait a few minutes, then try again.",
  owner_pin_missing: "Your Hub wallet is not sealed on this computer yet. Seal it first with balchemy runner owner-pin <agent>: it shows the whole "
    + "address (compare all of it with the wallet you signed in to Hub with), asks its last 6 characters and your passphrase.",
  owner_pin_invalid: "The sealed record of your Hub wallet does not verify on this computer (it was edited, or belongs to another wallet). "
    + "Seal it again with balchemy runner owner-pin <agent> and compare the whole address with the wallet you signed in to Hub with.",
  owner_pin_mismatch: "The pairing record on this computer no longer matches the Hub wallet you sealed. If you did not pair this agent again "
    + "yourself, do not seal: someone may have changed it. If you did, run balchemy runner owner-pin <agent>: it shows the old and the new address.",
  authority_unsealed: "Your settings are not sealed on this computer, or one of them is now looser than what you sealed, so new buys stay paused. "
    + "Review and seal them with balchemy runner owner-pin <agent>, then turn new buys on again. Stop-loss and take-profit exits keep running.",
});

function summaryLines(summary: PrivateArmingSummary): string[] {
  const fee = summary.fee.state === "shown"
    ? `Global fee: ${bpsPercent(summary.fee.rateBps)} (${lamportsToSol(summary.fee.feeLamports)} on a ${lamportsToSol(summary.fee.grossInputLamports)} buy)`
    : "Global fee: shown at each trade (the fee check was unavailable now)";
  return [`  Trading wallet: ${summary.walletAddress} (Hub binding ${summary.walletBindingId})`,
    `  Per-trade cap: ${capLine(summary.perTrade, summary.perTradeBasis)}`,
    `  Daily cap (UTC): ${capLine(summary.daily, summary.dailyBasis)}  (limits revision ${summary.limitsRevision})`,
    `  Confirmed rules: ${summary.rulesRevisionId}  Stop-loss: ${bpsPercent(summary.stopLossBps)}  Take-profit levels: ${summary.takeProfitLevels}`,
    `  Buy size: ${summary.sizingAmountSol} SOL, slippage ${summary.sizingSlippageBps} bps`,
    `  Solana RPC: ${privateRpcHostLabel(summary.rpcHost)}`, `  ${fee}`];
}

/** The arming summary's RPC: an owner endpoint's host, or (owner decision of 17 Nov 2026) the two Balchemy-provided providers.
 * Phase 1 audit L8: says what is checked where (buys need both to agree; an exit may go ahead on one provider). */
export function privateRpcHostLabel(host: string): string {
  const provided = /^balchemy:([a-z]+):([a-z]+)$/.exec(host);
  return provided ? `provided by Balchemy (${provided[1]} and ${provided[2]}; new buys need both to agree, `
    + "a stop-loss or take-profit sell may go ahead on one of them)" : host;
}

export async function runPrivateArmCommand(options: PrivateArmingCommandOptions): Promise<PrivateArmResult> {
  const [agentId] = options.args;
  if (options.args.length !== 1 || !isId(agentId) || options.flags.yes || options.flags.force || options.flags.quiet) {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid arm command", cause: "Use runner arm <agent>.",
      fix: "Pass one local agent label. --yes, --force and --quiet are not supported: arming needs a typed confirmation and your passphrase.", exitCode: 2 });
  }
  if (options.flags.dryRun) return { kind: "dry_run", agentId };
  if (!options.interactive || options.flags.json || options.flags.ci) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive arming terminal required",
      cause: "Arming live trading requires a real terminal, an exact typed confirmation and your trading wallet passphrase.",
      fix: "Run without --json or --ci in a terminal on the runner's device. Hub and the server can never arm.", exitCode: 2 });
  }
  const pinned = target(options, agentId);
  if (pinned.agentId !== agentId) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid arm command", cause: "Agent mismatch.", fix: "Try again.", exitCode: 2 });
  const transport = options.transport ?? requestPrivateArming;
  const runPrecheck = async (): Promise<PrivateArmingResponse> => {
    const precheck = parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "precheck" });
    try { return await exchange(transport, pinned.socketPath, precheck); } catch { return channelFailure("Arming check unavailable", "unavailable"); }
  };
  let checked = await runPrecheck();
  // Phase 1 one-step resume: after a restart the wallet is locked and the agent disarmed. With open positions, the owner sees them
  // first, types the passphrase once, and it unlocks the wallet and (after the same review and typed ARM <agent>) arms.
  let passphrase: string | undefined;
  if (!checked.ok && checked.error === "wallet_locked") {
    const resumed = await resumeUnlock(options, pinned, agentId);
    if (resumed && "kind" in resumed) return resumed;
    if (resumed) { passphrase = resumed.passphrase; checked = await runPrecheck(); }
  }
  // A2a: no sealed owner pin (or one that no longer verifies), or settings that cannot arm exits-only while unsealed: the seal step runs
  // inline, then the precheck again (a second refusal is final).
  if (!checked.ok && (checked.error === "owner_pin_missing" || checked.error === "owner_pin_invalid" || checked.error === "owner_pin_mismatch"
    || checked.error === "authority_unsealed") && options.sealAuthority && await options.sealAuthority(passphrase)) checked = await runPrecheck();
  if (!checked.ok && checked.error === "owner_wallet_approval_missing") {
    const approval = await ownerApproval(options, transport, pinned, agentId);
    if (approval) return approval;
    // The new approval must cover exactly what arm will check: the full precheck runs again (a second refusal is final).
    checked = await runPrecheck();
  }
  // A2a: settings that are not sealed (or looser than the seal) arm for exits only; the owner can seal them here first.
  if (checked.ok && checked.data.kind === "precheck" && checked.data.summary.entriesHold === "authority_unsealed" && options.sealAuthority
    && await options.sealAuthority(passphrase)) checked = await runPrecheck();
  if (!checked.ok) return { kind: "refused", agentId, code: checked.error };
  if (checked.data.kind !== "precheck") return channelFailure("Arming check unavailable", "unavailable");
  const summary = checked.data.summary;
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  const releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => prompt.close());
  try {
    const phrase = `ARM ${agentId}`;
    await options.write([`Arm live trading for ${agentId} (Solana, currently ${summary.mode === "shadow" ? "shadow" : "live, not armed"})`,
      ...summaryLines(summary),
      ...(summary.entriesHold === "authority_unsealed" ? authorityHoldReviewLines(agentId) : summary.entriesHold ? exitsOnlyReviewLines(agentId) : []),
      "Once armed, this agent buys automatically within these caps, without asking you per trade.",
      "Halts are enforced at every build and submit: Balchemy's global, chain and agent halts, and your pause, disarm or stop.",
      // Reached only when this build has exits (the precheck refuses first otherwise): owner decision 14 wording.
      "Stop-loss and take-profit exits run only while this computer is on, the runner is running and your wallet is unlocked.",
      "If any of these stop, nothing sells for you. Pause in Hub stops new entries; disarm or stop ends all execution.",
      // Phase 1 (17 Nov 2026): keep-awake, the shutdown warning and the one-step resume.
      "While an agent is armed or holds open positions, the runner keeps this computer from idle sleep (caffeinate on macOS, systemd-inhibit on Linux); "
        + "a closed laptop lid on battery can still sleep it.",
      "Arming lasts until disarm, stop or a runner restart. balchemy runner shutdown warns first and asks you to type SHUTDOWN while positions are open; "
        + `after a restart, balchemy runner arm ${agentId} (or balchemy) shows your open positions and asks your passphrase once to unlock the wallet and arm again.`,
      `Type exactly ${phrase} to continue; any other answer cancels.`, ""].join("\n"));
    const answer = await prompt.line("arm> ");
    if (answer === null || prompt.closed) return { kind: "cancelled", agentId, reason: "input_closed" };
    if (answer !== phrase) return { kind: "cancelled", agentId, reason: "arm_not_confirmed" };
    // One-step resume: the passphrase that just unlocked the wallet is the arm passphrase (the daemon verifies it again); not asked twice.
    passphrase ??= await prompt.secret("Trading wallet passphrase (re-enter to arm; not stored): ") ?? undefined;
    if (passphrase === undefined || prompt.closed) return { kind: "cancelled", agentId, reason: "input_closed" };
    let request: PrivateArmingRequest;
    try { request = parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "arm", expectedVersion: summary.runtimeVersion,
      summaryDigest: summary.summaryDigest, passphrase }); }
    catch { return { kind: "refused", agentId, code: "passphrase_rejected" }; }
    let response: PrivateArmingResponse;
    try { response = await exchange(transport, pinned.socketPath, request); }
    catch (error: unknown) {
      if (error instanceof PrivateArmingTransportError && error.code === "connection_unavailable") return channelFailure("Arming not sent", "unavailable");
      return { kind: "outcome_unknown", agentId };
    }
    if (!response.ok) return response.error === "state_unavailable" ? { kind: "outcome_unknown", agentId } : { kind: "refused", agentId, code: response.error };
    if (response.data.kind !== "armed") return { kind: "outcome_unknown", agentId };
    // An exits-only arm is reported only when the owner reviewed it (the digest binds it, so the daemon cannot add it unreviewed).
    if (response.data.exitsOnly === true && !summary.entriesHold) return { kind: "outcome_unknown", agentId };
    return { kind: "armed", agentId, state: response.data.state, summary, ...(response.data.exitsOnly ? { exitsOnly: true as const } : {}) };
  } finally { releaseSignals(); prompt.close(); }
}

/** Phase 1 review lines of an exits-only arm (shown before the typed ARM <agent>). */
function exitsOnlyReviewLines(agentId: string): string[] {
  return [`  EXITS ONLY: a trade from before is still unresolved (see balchemy runner trades ${agentId}). Stop-loss and take-profit are armed for your`,
    "  open positions; while that trade still holds the wallet, they run once the runner's own proof on your RPC frees it (retried with back-off;",
    "  runner trades shows why it waits). A position whose sell is disputed stays held for your review.",
    "  New entries stay paused until no unresolved trade remains, then turn on by themselves (same checks as after a settings change).",
    `  A trade this runner disputes ends only with balchemy runner trades ${agentId} close <attempt>.`];
}

/** A2a review lines of an arm held for unsealed settings (shown before the typed ARM <agent>). Unlike an unresolved trade, this hold never
 * lifts by itself: only the owner's seal step and then /resume (entries_resume) turn new buys on. */
function authorityHoldReviewLines(agentId: string): string[] {
  return ["  EXITS ONLY: your settings are not sealed on this computer, one of them is now looser than what you sealed, or the seal or a setting",
    "  could not be read right now. Stop-loss and",
    "  take-profit are armed for your open positions; new buys stay paused. They do not turn on by themselves: seal your settings",
    `  (balchemy runner owner-pin ${agentId}), then resume new buys (/resume in the cockpit).`];
}

/** Non-closed positions of the readback (held first, at most PRIVATE_POSITION_READBACK_LIMIT shown), or null when unreadable. */
async function readOpenPositions(transport: PrivatePositionTransport, pinned: PrivateBrainTarget): Promise<{ open: PrivatePositionView[]; more: boolean } | null> {
  try {
    const request = parsePrivatePositionRequest({ ...privatePositionBinding(pinned), action: "list" });
    const response = validatePrivatePositionReply(request, await transport(pinned.socketPath, request));
    if (!response.ok || response.data.kind !== "list" || response.data.readback.exits !== "available") return null;
    const readback = response.data.readback;
    const open = readback.positions.filter((item) => item.state !== "closed");
    return { open, more: readback.total > readback.positions.length && open.length === readback.positions.length };
  } catch { return null; }
}

/** One owner-facing line per open, exit-pending or held position. */
export function privateOpenPositionLines(positions: readonly PrivatePositionView[]): string[] {
  return positions.map((item) => {
    const state = item.state === "held" ? `held for review (${item.holdReason ?? "unknown"})`
      : item.pendingExit ? `open, exit pending (${item.pendingExit.trigger.replace(/_/g, " ")})` : "open";
    return `  - ${item.positionId} mint ${item.tokenMint}: ${state}; ${item.remainingUnits} of ${item.originalUnits} units left; cost ${lamportsToSol(item.costLamports)}`;
  });
}

/** Phase 1 one-step resume, before the precheck can pass: with open positions and a locked wallet, the positions are shown, the
 * passphrase is asked once and unlocks the wallet (keystore IPC). Undefined: no one-step resume applies (no seam, no open position or
 * an unreadable readback), so the `wallet_locked` refusal stands. `{ passphrase }`: unlocked; the arm reuses it. Otherwise the result. */
async function resumeUnlock(options: PrivateArmingCommandOptions, pinned: PrivateBrainTarget, agentId: string): Promise<{ passphrase: string } | PrivateArmResult | undefined> {
  const positionTransport = options.positionTransport ?? (options.transport ? undefined : requestPrivatePositions);
  const walletTransport = options.walletTransport ?? (options.transport ? undefined : requestPrivateTradingWallet);
  if (!positionTransport || !walletTransport) return undefined;
  const read = await readOpenPositions(positionTransport, pinned);
  if (!read || read.open.length === 0) return undefined;
  const count = `${read.more ? "at least " : ""}${read.open.length}`;
  await options.write([`${agentId} has ${count} open position${read.open.length === 1 ? "" : "s"}. Their stop-loss and take-profit are not running now:`,
    "after a runner restart the agent is not armed and the trading wallet is locked.", ...privateOpenPositionLines(read.open),
    ...(read.more ? [`  More: balchemy runner positions ${agentId}`] : []),
    "Your passphrase unlocks the trading wallet and is used again to arm, after the review and the typed confirmation. Nothing trades before that.", ""].join("\n"));
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  const releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => prompt.close());
  let passphrase: string | null;
  try { passphrase = await prompt.secret("Trading wallet passphrase (unlocks the wallet, then arms; not stored): "); }
  finally { releaseSignals(); prompt.close(); }
  if (passphrase === null) return { kind: "cancelled", agentId, reason: "input_closed" };
  if (!isTradingWalletPassphrase(passphrase)) return { kind: "refused", agentId, code: "passphrase_rejected" };
  // As `runner wallet <agent> unlock` (private-trading-keystore-ui.ts): a lost or invalid reply, `state_unavailable` or `cancelled` is
  // an unknown outcome (the key may be in memory now); only a connection that never opened is a plain refusal. Never retried.
  const unknown = (): never => { throw new TerminalError({ code: "RUNTIME_OUTCOME_UNKNOWN", title: "Wallet unlock outcome unknown",
    cause: "The runner did not confirm whether the trading wallet was unlocked. Nothing was armed and nothing was retried.",
    fix: `Check: balchemy runner wallet ${agentId} status, then run balchemy runner arm ${agentId} again.`, exitCode: 1 }); };
  const request = parsePrivateTradingWalletRequest({ ...privateTradingWalletBinding(pinned), action: "unlock", passphrase });
  let response: PrivateTradingWalletResponse;
  try { response = validatePrivateTradingWalletReply(request, await walletTransport(pinned.socketPath, request)); }
  catch (error: unknown) {
    if (error instanceof PrivateTradingWalletTransportError && error.code === "connection_unavailable") return { kind: "refused", agentId, code: "wallet_locked" };
    return unknown();
  }
  if (response.ok) {
    await options.write(`Trading wallet unlocked. If you stop before arming, it stays unlocked until you lock it: balchemy runner wallet ${agentId} lock\n`);
    return { passphrase };
  }
  if (response.error === "state_unavailable" || response.error === "cancelled" || response.error === "write_outcome_unknown") return unknown();
  return { kind: "refused", agentId, code: response.error === "unlock_failed" ? "passphrase_rejected" : response.error === "wallet_missing" ? "wallet_missing"
    : response.error === "busy" ? "busy" : response.error === "closing" ? "closing" : response.error === "proof_throttled" ? "proof_throttled" : "wallet_locked" };
}

const APPROVAL_POLL_MS = 3_000;
/** The limits in the same words as the signed text ("no spend limit", or "per trade X SOL, per day Y SOL"). */
function approvedTerms(perTrade: PrivateCapSetting, daily: PrivateCapSetting): string {
  const one = (cap: PrivateCapSetting): string => cap.kind === "lamports" ? lamportsToSol(cap.lamports) : "no limit";
  return perTrade.kind === "none" && daily.kind === "none" ? "no spend limit" : `per trade ${one(perTrade)}, per day ${one(daily)}`;
}
const APPROVAL_POLL_FAILURES = 5;
/** Opens (or recovers) the owner's wallet approval and waits for it. Undefined: approved (stored and verified by the daemon);
 * otherwise the arm result to return. Nothing here arms, and no secret is printed. */
async function ownerApproval(options: PrivateArmingCommandOptions, transport: PrivateArmingTransport, pinned: PrivateBrainTarget,
  agentId: string): Promise<PrivateArmResult | undefined> {
  let opened: PrivateArmingResponse;
  try { opened = await exchange(transport, pinned.socketPath, parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "approval_request" })); }
  catch { return channelFailure("Owner approval unavailable", "unavailable"); }
  if (!opened.ok) return { kind: "refused", agentId, code: opened.error };
  // A stored approval for exactly this wallet and these caps was recovered and verified: nothing to sign.
  if (opened.data.kind === "approval_status" && opened.data.state === "approved") return undefined;
  if (opened.data.kind !== "approval_link") return channelFailure("Owner approval unavailable", "unavailable");
  const link = opened.data.link;
  const now = options.now ?? Date.now;
  await options.write([`Wallet approval needed for ${agentId} on this computer (once for this trading wallet and these spend limits).`,
    "Open this link while signed in to Hub as the agent's owner, and sign with your paired wallet:",
    `  ${link.frontendOrigin}${link.path}`,
    `Check code: ${link.checkCode}. This code approves: ${approvedTerms(link.perTrade, link.daily)}.`,
    "Hub must show the same code and the same limits. If either differs, do not sign.",
    "Signing approves this wallet and these caps only; it does not arm the agent and moves no funds.",
    `The link expires at ${link.expiresAt}. Waiting for your signature (Ctrl-C stops waiting)...`, ""].join("\n"));
  const stop = new AbortController();
  const release = (options.guardSignals ?? guardTerminalSignals)(() => stop.abort());
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  let failures = 0;
  try {
    for (;;) {
      try { await sleep(APPROVAL_POLL_MS, stop.signal); } catch { return { kind: "cancelled", agentId, reason: "approval_stopped" }; }
      if (stop.signal.aborted) return { kind: "cancelled", agentId, reason: "approval_stopped" };
      let polled: PrivateArmingResponse | undefined;
      try {
        polled = await exchange(transport, pinned.socketPath, parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "approval_poll",
          challengeId: link.challengeId }));
      } catch { polled = undefined; }
      if (!polled || (!polled.ok && (polled.error === "approval_unavailable" || polled.error === "lease_unavailable"))) {
        // A transient read failure: keep waiting while the link lives, but never forever.
        if (++failures >= APPROVAL_POLL_FAILURES) return { kind: "refused", agentId, code: "approval_unavailable" };
      } else if (!polled.ok) return { kind: "refused", agentId, code: polled.error };
      else if (polled.data.kind !== "approval_status") return channelFailure("Owner approval unavailable", "unavailable");
      else if (polled.data.state === "approved") {
        await options.write("Wallet approval verified on this computer against your paired wallet. Continuing to the arming review.\n");
        return undefined;
      } else if (polled.data.state === "expired") return { kind: "cancelled", agentId, reason: "approval_expired" };
      else failures = 0;
      if (now() > Date.parse(link.expiresAt) + 30_000) return { kind: "cancelled", agentId, reason: "approval_expired" };
    }
  } finally { release(); }
}

export function formatPrivateArmResult(result: PrivateArmResult): string {
  if (result.kind === "dry_run") return `Arming preview for ${result.agentId}. No connection, prompt or change made.\n`;
  if (result.kind === "cancelled" && result.reason === "approval_expired") return [`The wallet approval link for ${result.agentId} expired before it was signed.`,
    `Nothing was armed. Run balchemy runner arm ${result.agentId} again for a new link.`, ""].join("\n");
  if (result.kind === "cancelled" && result.reason === "approval_stopped") return [`Stopped waiting for the wallet approval of ${result.agentId}. Nothing was armed.`,
    `If you sign the link later, run balchemy runner arm ${result.agentId} again: it picks up the approval.`, ""].join("\n");
  if (result.kind === "refused") return [`Arming refused for ${result.agentId}: ${result.code}.`,
    PRIVATE_ARMING_REFUSAL_TEXT[result.code].replace(/<agent>/g, result.agentId), "Nothing was armed.", ""].join("\n");
  if (result.kind === "cancelled") return `Arming cancelled (${result.reason.replace(/_/g, " ")}). Nothing was armed.\n`;
  if (result.kind === "outcome_unknown") return [`Arming outcome unknown for ${result.agentId}. Nothing was retried.`,
    `Check now: balchemy runner status ${result.agentId}. To be sure it is not armed: balchemy runner disarm ${result.agentId}`, ""].join("\n");
  const within = (cap: PrivateCapSetting, unit: string): string => cap.kind === "lamports" ? `${lamportsToSol(cap.lamports)} per ${unit}` : `no ${unit} limit (your choice)`;
  if (result.exitsOnly && result.summary.entriesHold === "authority_unsealed") return [`${result.agentId} is armed for exits only: stop-loss and take-profit are armed for its open positions.`,
    "New buys stay paused because your settings are not sealed on this computer (or one is looser than what you sealed, or they could not be read right now). "
      + "They do not turn on by themselves.",
    `Seal your settings: balchemy runner owner-pin ${result.agentId} (compare the whole Hub wallet address; type its last 6 characters; your passphrase).`,
    `Then turn new buys on with /resume in the cockpit. Runtime revision ${result.state.version}; Hub shows "Live — armed" with entries paused.`,
    `Disarm at any time: balchemy runner disarm ${result.agentId} (no passphrase; exits stop too), or Disarm / Stop in Hub.`, ""].join("\n");
  if (result.exitsOnly) return [`${result.agentId} is armed for exits only: stop-loss and take-profit are armed for its open positions `
      + "(while the unresolved trade still holds the wallet, they run once the runner's own proof frees it; a disputed sell's position stays held for review).",
    `New entries stay paused while a trade from before is unresolved (see balchemy runner trades ${result.agentId}); once none remains they turn on by themselves, `
      + `within ${within(result.summary.perTrade, "trade")} and ${within(result.summary.daily, "day")}.`,
    `A trade this runner disputes ends only with balchemy runner trades ${result.agentId} close <attempt>. Runtime revision ${result.state.version}; Hub shows "Live — armed" with entries paused.`,
    `Disarm at any time: balchemy runner disarm ${result.agentId} (no passphrase; exits stop too), or Disarm / Stop in Hub.`, ""].join("\n");
  return [`${result.agentId} is armed: live trading within ${within(result.summary.perTrade, "trade")} and ${within(result.summary.daily, "day")}.`,
    `Runtime revision ${result.state.version}; new entries enabled. Hub shows "Live — armed".`,
    `Disarm at any time: balchemy runner disarm ${result.agentId} (no passphrase), or Disarm / Stop in Hub.`, ""].join("\n");
}
