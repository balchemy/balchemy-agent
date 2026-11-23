/** Production wiring of the cockpit: every step and card is the existing owner command function with its own prompts,
 * reviews and typed confirmations, exactly as `balchemy runner <command>` runs it. This module adds no mutation of its own.
 * Phase 2: the model step uses the runner's model operations (private-brain-ui.ts) and the setup card saves each value through its
 * existing command after the one summary confirmation (cockpit-setup.ts), answering that command's typed phrase for that value only.
 * A1 one screen: every command here writes into, and asks through, the one cockpit screen (cockpit-terminal.tsx): its `write`, its
 * `createPrompt` and its `guardSignals` are the in-screen card's (card-host.ts), and the waits stop on the card's Esc instead of SIGINT.
 * The commands, their checks and their typed phrases are unchanged; only where their text is drawn changed. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { requestRunner, RunnerTransportError } from "../runner/client.js";
import { SOCKET_FILE } from "../runner/daemon.js";
import type { RunnerAgentState } from "../runner/protocol.js";
import { stopLocalAgent } from "../runner/lifecycle.js";
import type { PrivatePositionView } from "../runner/private-position-protocol.js";
import type { BehaviorRuleRevision, BehaviorRules } from "@balchemyai/agent-rules";
import { renderTerminalQrPlain } from "../tui/terminal-qr.js";
import { aboveCeiling, lowerLimitsAnswer, lowerSlippageAccepts, type CockpitAgentRow, type CockpitCommandDeps } from "./cockpit-commands.js";
import { cockpitMode, runCockpitResume, type CockpitEntriesResumeOutcome } from "./cockpit-resume.js";
import { offerCockpitExitRebind, readCockpitExitBaseline, type CockpitExitRebindDeps } from "./cockpit-exit-rebind.js";
import { parsePrivateExitRebindRequest, privateExitRebindBinding, PrivateExitRebindTransportError,
  requestPrivateExitRebind } from "../runner/private-exit-rebind-protocol.js";
import { readSetupRulesReview, setupProposalReview, setupRulesSummary, type SetupCompiledView } from "./cockpit-setup.js";
import { exchangeWithSocketProof, socketProofUnlock, type SocketProofSecret } from "../runner/private-socket-proof-client.js";
import { formatPrivateOwnerPinResult, readPrivateOwnerPinNeed, runPrivateOwnerPinSeal } from "../runner/private-owner-pin-ui.js";
import type { CardScope } from "../tui/cockpit/card-host.js";
import { privateStatedMaxPositions } from "../runner/private-typed-rules.js";
import { cockpitExecutionNotes } from "./cockpit-panel.js";
import type { CockpitFeed } from "./cockpit-feed.js";
import { openBrowser } from "../browser.js";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import type { CockpitMemory, CockpitSide } from "../tui/cockpit/CockpitScreen.js";
import { createCockpitTerminal, type CockpitTerminal } from "../tui/cockpit/cockpit-terminal.js";
import { startLocalRunnerChat } from "../tui/LocalRunnerChat.js";
import { formatRunnerShutdownWarning, inspectLocalRunner, readRunnerShutdownExposure, readRunnerVersion, registerLocalAgent, runnerShutdownExposed,
  startLocalRunner, type RunnerStatus } from "../runner/lifecycle.js";
import { cockpitKeepAwakeLine, readRunnerKeepAwake } from "../runner/private-keep-awake.js";
import { runPrivatePositionCommand } from "../runner/private-position-ui.js";
import { PACKAGE_VERSION } from "../package-version.js";
import { knownRunnerAgents, runnerNotRunningError } from "../runner/not-running.js";
import { autoPairingCardDetails, isPairingConfirmation, pairingApprovalDetails, runAutoPairing, runPairingCommand,
  type AutoPairingEvent } from "../runner/pairing-workflow.js";
import { formatPrivateArmResult, formatPrivateSpendLimitsResult, lamportsToSol, parsePrivateCapArgument, privateSpendCapErrorText, runPrivateArmCommand,
  runPrivateSpendLimitsCommand } from "../runner/private-arming-ui.js";
import { parsePrivateArmingRequest, privateArmingBinding, PrivateArmingTransportError, requestPrivateArming } from "../runner/private-arming-protocol.js";
import { samePrivateCap } from "../runner/private-spend-cap.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "../runner/private-brain-client.js";
import { runPrivateRuleCommand, type RuleCommandResult, type RulePrompt } from "../runner/private-rule-commands.js";
import { formatPrivateSizingResult, parsePrivateSizingArguments, runPrivateSizingCommand } from "../runner/private-sizing-ui.js";
import { formatPrivateSolanaRpcResult, runPrivateSolanaRpcCommand } from "../runner/private-solana-rpc-ui.js";
import { formatPrivateTradingWalletResult, runPrivateTradingWalletCommand, tradingBindingRefusalText, type PrivateTradingWalletCommandResult,
  type WalletPrompt } from "../runner/private-trading-keystore-ui.js";
import { readPrivateSavedModel, readPrivateModelStatus, runPrivateModelOperation, type PrivateModelOperation } from "../runner/private-brain-ui.js";
import { fetchProviderModels, fetchPublicOpenRouterModels, ModelCatalogError } from "../runner/private-model-catalog.js";
import { formatPrivateModelBudgetResult, runPrivateModelBudgetCommand, savePrivateModelPrice } from "../runner/private-model-budget-ui.js";
import { formatPrivateModelUsd } from "../runner/private-model-prices.js";
import { PRIVATE_BRAIN_PROVIDER_LABELS } from "../runner/private-brain-providers.js";
import { runPrivateLaunchpadCommand } from "../runner/private-launchpad-ui.js";
import { privateRuleStopLossRefusal } from "../runner/private-rule-commands.js";
import { privateSetupRpcDone } from "../runner/private-setup-context.js";
import type { RuleCommitReceipt, RuleProposal } from "../runner/private-rule-store.js";
import { runDirectiveCoach, runSetupCard, type SetupApplyResult, type SetupCardDeps } from "./cockpit-setup.js";
import { privateSetupRequest, requestPrivateSetup, type PrivateCeilingRefusal, type PrivateSetupCeilingView, type PrivateSetupLinkView,
  type PrivateSetupView } from "../runner/private-setup-protocol.js";
import { readSetupChecklist, SETUP_CHAT_STEP, SETUP_DEFAULTS, type SetupStateReaders, type SetupStepState } from "../runner/setup-state.js";
import { createSetupStateReaders } from "../runner/setup-state-readers.js";
import { cardMeta, nextStepCard, type CockpitCard } from "./cockpit-cards.js";
import { createCockpitFeed } from "./cockpit-feed.js";
import { runPrivateSignalCommand } from "../runner/private-signal-ui.js";
import { runPrivateSubmissionCommand } from "../runner/private-submission-ui.js";
import type { CockpitDeps, CockpitModelResult } from "./cockpit-flow.js";
import { cockpitLimitDefault } from "./cockpit-setup.js";
export { cockpitLimitDefault } from "./cockpit-setup.js";

type Flags = Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
const FLAGS: Flags = Object.freeze({ json: false, ci: false, yes: false, force: false, dryRun: false, quiet: false });
const silent = (): void => {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPENING = "I finished the first setup steps here. Please guide me through the rest, one step at a time.";
/** K2 waits: the automatic link (each pass 2 s, up to 2 minutes, then the flow asks to retry) and the ceiling page (3 s, 30 minutes). */
const LINK_POLL_MS = 2_000;
const LINK_WAIT_MS = 2 * 60_000;
const CEILING_POLL_MS = 3_000;
const CEILING_WAIT_MS = 30 * 60_000;
const short = (address: string): string => `${address.slice(0, 4)}…${address.slice(-4)}`;
/** A lamport amount as a bare SOL number ("0.25"), the form the limit prompts accept. */
const sol = (value: string): string => lamportsToSol(value).replace(/ SOL$/, "");
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = (): void => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** K5b: the panel's mode word (defined with the /resume card, cockpit-resume.ts). */
export { cockpitMode };
/** K5b: the typed phrase of the /resume card. */
export function cockpitResumePhrase(agentId: string): string { return `RESUME ${agentId}`; }

/** Owner-facing line of one automatic-link state (undefined: the flow's own wallet step takes over). */
export function cockpitLinkText(view: PrivateSetupLinkView): string | undefined {
  switch (view.state) {
    case "linked": return `Trading wallet linked to your Hub account: ${short(view.address)}.\n`;
    case "waiting_lease": return "Linking your trading wallet... waiting for the runner to report to Balchemy (Esc stops waiting).\n";
    case "linking": return "Linking your trading wallet...\n";
    case "retrying": return `Linking your trading wallet... trying again: ${tradingBindingRefusalText(view.reason)}\n`;
    case "unavailable": return "The link state could not be read right now; trying again...\n";
    case "refused": return `The trading wallet was not linked: ${tradingBindingRefusalText(view.reason)}\n`;
    case "off": case "unpaired": case "no_wallet": case "locked": return undefined;
  }
}
const CEILING_REFUSAL_TEXT: Record<PrivateCeilingRefusal, string> = {
  stale: "The trading wallet link changed since this request (re-pair this agent, then approve the ceiling again).",
  unverifiable: "This runner cannot check a wallet approval for this pairing (only a Solana pairing can approve a ceiling). Nothing trades until you arm; arming explains what is needed.",
  unsupported: "This Balchemy site does not offer the spend ceiling step yet. Arming asks for your wallet approval instead.",
  mismatch: "Balchemy's answer did not match what this runner asked for, so nothing was opened or stored. Arming asks for your wallet approval instead.",
  timed_out: "No spend ceiling arrived from the page in 30 minutes. You can approve it later when you arm.",
  too_many_open: "Balchemy refused a new request: too many requests are still open (or it is busy). Wait for older requests to expire (10 minutes), then choose Ask for a new request on the page.",
  request_failed: "Balchemy did not open the request. Choose Ask for a new request on the page to try again.",
  state_unavailable: "The local approval state could not be read. Nothing was changed; check balchemy runner status.",
};
/** Owner-facing text of one ceiling state. The check code is the runner's LOCAL one; the page shows Balchemy's and they must match. */
export function cockpitCeilingText(view: PrivateSetupCeilingView): string {
  switch (view.state) {
    case "idle": case "not_ready": return "Waiting for the trading wallet link...\n";
    case "waiting": return "Approve your spend ceiling in the browser: on the Hub page, enter the most one trade and one day may spend (SOL). Waiting for the page...\n";
    case "retrying": return `Balchemy is ${view.reason === "rate_limited" ? "busy" : "not reachable right now"}; trying again...\n`;
    case "requesting": return `Opening the request for up to ${sol(view.perTradeLamports)} SOL per trade, ${sol(view.dailyLamports)} SOL per day...\n`;
    case "challenge": return [`Approve your spend ceiling in the browser: up to ${sol(view.perTradeLamports)} SOL per trade, ${sol(view.dailyLamports)} SOL per day.`,
      `Check code ${view.checkCode}: it must match the browser. Sign only if it does. The request expires at ${new Date(view.expiresAt).toLocaleTimeString()}.`, ""].join("\n");
    case "expired": return "The request expired before it was signed. Choose Ask for a new request on the page; waiting...\n";
    case "approved": return view.perTradeLamports && view.dailyLamports
      ? `Ceiling signed: up to ${sol(view.perTradeLamports)} SOL per trade, ${sol(view.dailyLamports)} SOL per day. Nothing trades until you arm.\n`
      : "A wallet approval is already stored for this trading wallet. Nothing trades until you arm.\n";
    case "refused": return `${CEILING_REFUSAL_TEXT[view.reason]}\n`;
  }
}

/** Ink unrefs stdin when its screen ends (raw mode off). After another full-screen program (the model fallback) stdin is
 * referenced again, or the process could exit while the cockpit waits for the owner. */
export function restoreStdin(): void { if (typeof process.stdin.ref === "function") process.stdin.ref(); }

/** A prompt that answers only the exact typed phrase a command shows for the value the setup summary covered (cockpit-setup.ts). Its hidden
 * field answers nothing: the socket proof of these saves comes from the command's `proofSecret` (the setup batch's one prompt, or none). */
function answeringPrompt(answer: (label: string) => string | null): WalletPrompt {
  let closed = false;
  return { get closed() { return closed; }, line: async (label) => (closed ? null : answer(label)), secret: async () => null, close: () => { closed = true; } };
}
function answeringRulePrompt(source: string | null, accept: (phrase: string) => boolean): RulePrompt {
  let closed = false;
  return { get closed() { return closed; }, source: async () => (closed ? null : source), confirm: async (phrase) => !closed && accept(phrase),
    close: () => { closed = true; } };
}
const OPERATION_PHRASE = /^CONFIRM [0-9a-f]{8}$/;

/** The public single-purpose pairing proof onto the clipboard (stdin of the platform tool, never an argument; no shell). */
async function copyToClipboard(text: string): Promise<boolean> {
  const tools: Array<[string, string[]]> = process.platform === "darwin" ? [["pbcopy", []]] : process.platform === "win32" ? [["clip", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [command, args] of tools) {
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const child = spawn(command, args, { shell: false, stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => { child.kill(); finish(false); }, 3000);
      child.on("error", () => finish(false)); child.on("exit", (code) => finish(code === 0));
      child.stdin.on("error", () => finish(false)); child.stdin.end(text);
    });
    if (ok) return true;
  }
  return false;
}

/** Owner-facing text of one one-step pairing event. The response code is public (derived from the runner's response) and
 * is what the owner types on the Hub page before signing. */
export function autoPairingProgressText(event: AutoPairingEvent): string {
  switch (event.type) {
    case "link": return `The pairing page should open in your browser. If it did not, open:\n${event.url}\n`
      + `Runner fingerprint: ${event.runnerFingerprint.match(/.{1,8}/g)?.join(" ")} (the page shows the same).\n`;
    case "browser_failed": return "The browser did not open. Open the link above yourself.\n";
    case "waiting_for_page": return "On the page, sign in and choose your identity wallet. Waiting for the page... (Esc stops)\n";
    case "code_mismatch": return `That code does not match your Hub page. ${event.attemptsLeft} ${event.attemptsLeft === 1 ? "try" : "tries"} left.\n`;
    case "challenge_expired": return "The pairing request on the page expired. Open the link again to start over.\n";
    case "response_sent": return `On the Hub page, type this code into "Code from your CLI": ${event.responseCode}\nThen sign with your wallet there.\n`;
    case "waiting_for_wallet": return "Waiting for your wallet signature on the page...\n";
    case "retrying": return `Balchemy is ${event.reason === "rate_limited" ? "busy" : "not reachable right now"}; trying again...\n`;
  }
}

export function createCockpitDeps(directory: string, frontendOrigin: string, terminal: CockpitTerminal = createCockpitTerminal()): CockpitDeps {
  const readers: SetupStateReaders = createSetupStateReaders(directory);
  const target = (agentId: string): PrivateBrainTarget => {
    try { return readPrivateBrainTarget(directory, agentId); }
    catch { throw runnerNotRunningError(agentId, knownRunnerAgents(directory), "Local assistant unavailable"); }
  };
  // A1: one screen. Text goes into the open card (or becomes a Balchemy row); prompts are the open card's input line; a command's
  // signal cleanup runs on the card's Esc (Ink holds raw mode, so Ctrl+C never arrives as SIGINT here).
  const io = terminal.io, host = terminal.host;
  const write = (text: string): Promise<void> => io.write(text);
  const command = { flags: FLAGS, directory, interactive: true, write, createPrompt: () => host.prompt(), guardSignals: host.guardSignals };
  /** Esc was pressed on the open card (its command is finishing). */
  const escaped = (): boolean => host.snapshot().card?.closing === true;
  /** The row of a command that stopped before its change: Esc, or a typed phrase that was not the command's own. */
  const notConfirmed = (): string => (escaped() ? "Closed. Nothing was changed." : "Not confirmed. Nothing was changed.");
  const opened = new Set<string>();
  // The conversation survives leaving the screen for a card and coming back.
  const memories = new Map<string, CockpitMemory>();
  const memory = (agentId: string): CockpitMemory => { let value = memories.get(agentId); if (!value) { value = { entries: [], seen: new Set() }; memories.set(agentId, value); } return value; };
  const feeds = new Map<string, CockpitFeed>();
  const feed = (agentId: string): CockpitFeed => {
    let read = feeds.get(agentId);
    if (!read) {
      let total: number | undefined;
      read = createCockpitFeed({
        decisions: async () => { const result = await runPrivateSignalCommand({ action: "list", args: [agentId], directory, flags: FLAGS });
          return result.kind === "list" ? result.page.items : []; },
        trades: async () => { const result = await runPrivateSubmissionCommand({ args: [agentId], directory, flags: FLAGS });
          total = result.kind === "list" ? result.total : undefined;
          return result.kind === "list" ? result.attempts : []; },
        positions: async () => (await positionsOf(agentId)) ?? [],
        sources: async () => {
          const result = await runPrivateLaunchpadCommand({ args: [agentId], directory, flags: FLAGS });
          return result.kind === "status" ? new Map(result.view.launchpads.map((item) => [item.id, item.name])) : undefined;
        },
        tradeTotal: () => total,
      });
      feeds.set(agentId, read);
    }
    return read;
  };
  /** Positions (open and recently closed) when the exit worker's readback is available; undefined otherwise. */
  const positionsOf = async (agentId: string): Promise<readonly PrivatePositionView[] | undefined> => {
    try {
      const result = await runPrivatePositionCommand({ args: [agentId], directory, flags: FLAGS });
      return result.kind === "list" && result.exits === "available" ? result.positions : undefined;
    } catch { return undefined; }
  };
  const budgetOf = async (agentId: string): Promise<{ limitMicroUsd: number; spentMicroUsd: number } | undefined> => {
    try {
      const result = await runPrivateModelBudgetCommand({ ...command, interactive: false, write: silent, args: [agentId] });
      return result.kind === "status" ? { limitMicroUsd: result.status.policy.dailyLimitMicroUsd, spentMicroUsd: result.status.spentMicroUsd } : undefined;
    } catch { return undefined; }
  };
  const agentState = async (agentId: string): Promise<RunnerStatus["agents"][number] | undefined> => {
    try { return (await inspectLocalRunner(directory, agentId)).agents.find((agent) => agent.agentId === agentId); } catch { return undefined; }
  };
  const side = async (agentId: string): Promise<CockpitSide> => {
    const [checklist, state, wallet, keepAwake, positions, budget] = await Promise.all([readSetupChecklist(agentId, readers),
      agentState(agentId),
      runPrivateTradingWalletCommand({ ...command, interactive: false, write: silent, args: [agentId, "status"] }).catch(() => undefined),
      readRunnerKeepAwake(directory).catch(() => null), positionsOf(agentId), budgetOf(agentId)]);
    const armed = state?.armed === true;
    const notes = cockpitExecutionNotes(state?.executionStatus);
    const counters = feed(agentId).counters();
    const address = wallet?.kind === "status" && (wallet.wallet.state === "locked" || wallet.wallet.state === "unlocked") ? wallet.wallet.address : undefined;
    const card = await nextStepCard(agentId, readers, armed);
    // Balance: one read-only read, only once Balchemy's connection (or the owner's own) is ready (a public endpoint is refused).
    let balanceSol: string | undefined;
    const connected = address ? await readers.rpc(agentId).then(privateSetupRpcDone, () => false) : false;
    if (address && connected) {
      try {
        const request = parsePrivateArmingRequest({ ...privateArmingBinding(target(agentId)), action: "wallet_balance" });
        const response = await requestPrivateArming(target(agentId).socketPath, request);
        if (response.ok && response.data.kind === "wallet_balance" && response.data.walletAddress === address) balanceSol = lamportsToSol(response.data.lamports);
      } catch { balanceSol = undefined; }
    }
    return { checklist, armed, ...(card ? { nextCard: card } : {}), ...(address ? { walletAddress: address } : {}), ...(balanceSol !== undefined ? { balanceSol } : {}),
      keepAwake: cockpitKeepAwakeLine(keepAwake), ...(state ? { mode: cockpitMode(state) } : {}), ...(positions ? { positions } : {}),
      ...(budget ? { budget } : {}), ...(counters ? { counters } : {}), ...(notes.length ? { notes } : {}) };
  };
  /** K5b: one owner control on the daemon's socket (pause or resume), with its reply checked like the Hub bridge checks it. */
  const control = async (agentId: string, action: "pause" | "resume", before: RunnerAgentState): Promise<"applied" | "unknown" | "refused"> => {
    const id = randomUUID();
    try {
      const result = await requestRunner(path.join(directory, SOCKET_FILE), { version: 1, id, action, agentId, expectedVersion: before.version });
      if (result.error === "state_unavailable") return "unknown";
      if (!result.ok || !result.state) return "refused";
      const state = result.state;
      if (state.agentId !== agentId) return "unknown";
      if (action === "pause") {
        return (before.mode === "live_armed" ? state.mode === "live_armed" && state.armed && state.entries === "paused" : state.mode === "paused")
          ? "applied" : "unknown";
      }
      return state.mode === "shadow" && state.lifecycle === "idle" && !state.armed ? "applied" : "unknown";
    } catch (error: unknown) { return error instanceof RunnerTransportError && error.code === "connection_unavailable" ? "refused" : "unknown"; }
  };
  /** The owner-local entries resume of an armed agent at the version the card read (private-arming.ts). A lost reply is unknown and never
   * resent (requestPrivateArming); a validated reply is exactly the released state. */
  const resumeEntries = async (agentId: string, before: RunnerAgentState): Promise<CockpitEntriesResumeOutcome> => {
    let resolved: PrivateBrainTarget;
    try { resolved = target(agentId); } catch { return { kind: "refused", code: "state_unavailable" }; }
    const pinned = resolved;
    // A2a: sent without the proof first; on proof_required the card asks the trading wallet passphrase (after the typed RESUME) and the
    // same resume is sent again with a fresh frame id. A lost reply is never resent.
    const build = (passphrase?: string) => parsePrivateArmingRequest({ ...privateArmingBinding(pinned), action: "entries_resume",
      expectedVersion: before.version, ...(passphrase !== undefined ? { passphrase } : {}) });
    const first = build();
    try {
      const outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? first : build(passphrase)),
        send: (request) => requestPrivateArming(pinned.socketPath, request), error: (reply) => (reply.ok ? undefined : reply.error),
        secret: (label) => io.secret(label), unlock: socketProofUnlock(pinned) });
      if (outcome.kind === "cancelled") return { kind: "refused", code: "proof_required" };
      if (outcome.kind === "unlock_unknown") return { kind: "refused", code: "wallet_locked" };
      if (outcome.kind === "refused") return { kind: "refused", code: outcome.code };
      const response = outcome.response;
      if (!response.ok) return { kind: "refused", code: response.error };
      return response.data.kind === "entries_resumed" ? { kind: "resumed", state: response.data.state } : { kind: "unknown" };
    } catch (error: unknown) {
      return error instanceof PrivateArmingTransportError && error.code === "connection_unavailable" ? { kind: "refused", code: "state_unavailable" } : { kind: "unknown" };
    }
  };
  /** Owner decision of 21 Nov 2026: the "apply the new exit rules to open positions too?" card after a confirmed rule save
   * (cockpit-exit-rebind.ts). Preview is read-only; the apply runs only after the typed APPLY <agent>, and a lost reply is never resent. */
  const exitRebindDeps = (agentId: string): CockpitExitRebindDeps => ({ io, agentId,
    async preview() {
      try {
        const pinned = target(agentId);
        const response = await requestPrivateExitRebind(pinned.socketPath, parsePrivateExitRebindRequest({ ...privateExitRebindBinding(pinned), action: "preview" }));
        if (!response.ok) return { kind: "refused", code: response.error };
        return response.data.kind === "preview" ? { kind: "ok", preview: response.data.preview } : { kind: "unavailable" };
      } catch { return { kind: "unavailable" }; }
    },
    async apply(input) {
      let resolved: PrivateBrainTarget;
      try { resolved = target(agentId); } catch { return { kind: "refused", code: "state_unavailable" }; }
      const pinned = resolved;
      // A2a: applying new exits to open positions is raising: the passphrase is asked only on proof_required, after the typed APPLY.
      const build = (passphrase?: string) => parsePrivateExitRebindRequest({ ...privateExitRebindBinding(pinned), action: "apply", ...input,
        ...(passphrase !== undefined ? { passphrase } : {}) });
      const first = build();
      try {
        const outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? first : build(passphrase)),
          send: (request) => requestPrivateExitRebind(pinned.socketPath, request), error: (reply) => (reply.ok ? undefined : reply.error),
          secret: (label) => io.secret(label), unlock: socketProofUnlock(pinned) });
        if (outcome.kind === "cancelled") return { kind: "refused", code: "proof_required" };
        if (outcome.kind === "unlock_unknown") return { kind: "refused", code: "wallet_locked" };
        if (outcome.kind === "refused") return { kind: "refused", code: outcome.code };
        const response = outcome.response;
        if (!response.ok) return { kind: "refused", code: response.error };
        return response.data.kind === "apply" ? { kind: "ok", result: response.data.result } : { kind: "unknown" };
      } catch (error: unknown) {
        return error instanceof PrivateExitRebindTransportError && error.code === "connection_unavailable" ? { kind: "refused", code: "state_unavailable" } : { kind: "unknown" };
      }
    } });
  /** After a rule command: the exit re-bind card only when it confirmed a revision that changed the head's exit rules (`baseline`: read before). */
  const afterRules = async (agentId: string, result: { kind: string }, baseline: string | null): Promise<void> => {
    if (result.kind !== "confirmed") return;
    await offerCockpitExitRebind(exitRebindDeps(agentId), baseline);
  };
  const exitBaseline = (agentId: string): Promise<string | null> => readCockpitExitBaseline(exitRebindDeps(agentId));
  /** A command run inside the chat screen with its prompt answered by code only for a value the cockpit classified as lower. */
  const lowered = async (run: () => Promise<string>): Promise<string> => {
    try { return await run(); }
    catch (error: unknown) { if (error instanceof TerminalError) return `${error.title}: ${error.cause} ${error.fix}`; return "That change could not be confirmed. Read it again before another change."; }
  };
  const commands = (agentId: string): CockpitCommandDeps => ({
    agentId,
    async status() {
      const [state, open, budget] = await Promise.all([agentState(agentId), positionsOf(agentId), budgetOf(agentId)]);
      const checklist = await readSetupChecklist(agentId, readers).catch((): SetupStepState[] => []);
      return [`Runner: ${state ? "running" : "not readable"}. ${agentId}: ${state ? cockpitMode(state) : "unknown"}.`,
        `Setup: ${checklist.filter((item) => item === "done").length} of ${checklist.length || "?"} steps done.`,
        `Open positions: ${open ? open.filter((item) => item.state !== "closed").length : "not readable"}.`,
        ...cockpitExecutionNotes(state?.executionStatus).map((line) => `${line}.`),
        ...(budget ? [`AI spend today: ${formatPrivateModelUsd(budget.spentMicroUsd)} of ${formatPrivateModelUsd(budget.limitMicroUsd)}.`] : [])];
    },
    async runtime() {
      const state = await agentState(agentId);
      if (!state) return undefined;
      const open = await positionsOf(agentId);
      return { mode: cockpitMode(state), openPositions: open ? open.filter((item) => item.state !== "closed").length : null };
    },
    positions: () => positionsOf(agentId),
    budget: () => budgetOf(agentId),
    lowerBudget: (usd) => lowered(async () => {
      // Non-interactive: the command applies a lower limit and refuses a raise (a limit that changed since the read stays safe).
      // A2a: a lowered path asks no passphrase; if the runner sees a raise, the plain proof text says the card is needed.
      const result = await runPrivateModelBudgetCommand({ ...command, interactive: false, write: silent, args: [agentId, "--daily-usd", usd], proofSecret: null });
      return formatPrivateModelBudgetResult(result, agentId).trim();
    }),
    async limits() {
      try { const result = await runPrivateSpendLimitsCommand({ ...command, interactive: false, write: silent, args: [agentId, "limits"] }); return result.kind === "status" ? result.limits : undefined; }
      catch { return undefined; }
    },
    async ceiling() { return setupCard(agentId).ceiling(); },
    lowerLimits: (perTrade, daily, revision) => lowered(async () => {
      let review = "";
      const result = await runPrivateSpendLimitsCommand({ ...command, write: (text) => { review += text; }, args: [agentId, "limits", "--per-trade", perTrade, "--daily", daily],
        // SET LIMITS is answered only for the revision the cockpit compared against; anything else cancels. The chat screen owns the
        // terminal, so the command installs no signal handlers of its own here.
        guardSignals: () => () => {}, proofSecret: null,
        createPrompt: () => answeringPrompt((label) => lowerLimitsAnswer(agentId, revision, review, label)) });
      return formatPrivateSpendLimitsResult(result).trim();
    }),
    async sizing() {
      try {
        const result = await runPrivateSizingCommand({ ...command, interactive: false, write: silent, args: [agentId] });
        return result.kind === "status" && result.status.policy
          ? { amountSol: result.status.policy.amountSol, slippageBps: result.status.policy.slippageBps, revision: result.status.policy.revision } : undefined;
      } catch { return undefined; }
    },
    lowerSlippage: (amountSol, slippageBps, revision) => lowered(async () => {
      let review = "";
      // A2a: every slippage change is raising for the runner, a lower one too: the stop-loss and take-profit sells reuse the entry
      // slippage, so a lower value can leave an exit unfilled. The typed CONFIRM is still answered only for the compared revision and
      // value; the trading-wallet passphrase is asked like a raise, in a secret card opened only when the runner asks for the proof.
      let scope: CardScope | undefined;
      const secret: SocketProofSecret = async (label) => {
        scope ??= host.open({ kind: "CONFIRM", title: "Change the slippage", secret: true });
        await write("Stop-loss and take-profit sells use this slippage too, so changing it needs your trading wallet passphrase (it is not stored).\n");
        const prompt = host.prompt();
        try { return await prompt.secret(label); } finally { prompt.close(); }
      };
      try {
        const result = await runPrivateSizingCommand({ ...command, write: (text) => { review += text; }, args: [agentId, "--amount-sol", amountSol, "--slippage-bps", String(slippageBps)],
          proofSecret: secret, createPrompt: () => answeringRulePrompt(null, (phrase) => lowerSlippageAccepts(revision, slippageBps, review, phrase)) });
        return formatPrivateSizingResult(result, agentId).trim();
      } finally { scope?.close(""); }
    }),
    async pause() {
      const state = await agentState(agentId);
      if (!state) return "The agent's state could not be read. Nothing was changed.";
      if (state.lifecycle === "stopped") return `${agentId} is stopped; nothing to pause. /resume returns it to shadow mode.`;
      if (state.mode === "paused" || state.entries === "paused") return `${agentId} is already paused. Exits keep running while it is armed.`;
      const outcome = await control(agentId, "pause", state);
      if (outcome === "unknown") return "The pause outcome is unknown. Check /status before another change; nothing was retried.";
      if (outcome === "refused") return "The runner refused the pause (the state changed). Check /status and try again.";
      return state.mode === "live_armed" ? `Paused ${agentId}: no new buys. It stays armed, so stop-loss and take-profit exits keep running. /resume turns new buys back on.`
        : `Paused ${agentId}. It was not armed, so it could not trade anyway.`;
    },
    async stop() {
      try {
        await stopLocalAgent(directory, agentId);
        return `Stopped ${agentId}: no new buys and no exits. /resume returns it to shadow mode; arming again needs /arm.`;
      } catch (error: unknown) {
        if (error instanceof RunnerTransportError && error.code === "outcome_unknown") return "The stop outcome is unknown. Check /status before another change; nothing was retried.";
        return "The runner did not confirm the stop. Check /status.";
      }
    },
    async directive() {
      try {
        const result = await runPrivateRuleCommand({ ...quiet, interactive: false, args: [agentId, "solana", "show"] });
        const revision = result.kind === "show" ? result.revision as { source?: { kind?: string; exactSource?: unknown }; rules?: BehaviorRules;
          compiled?: SetupCompiledView } | null : undefined;
        if (!revision) return ["No confirmed strategy yet. The setup card or /directive change sets one."];
        const source = revision.source?.kind === "natural_language" && typeof revision.source.exactSource === "string" ? revision.source.exactSource : undefined;
        // The owner's stated max positions of the validated revision (unknown: no line about it).
        const maxPositions = privateStatedMaxPositions(revision as BehaviorRuleRevision);
        // A1: the plain warning when the confirmed directive holds every buy in this version (it names new pairs or a launchpad).
        return [...(source ? [`Directive: ${source}`] : ["Confirmed rules (structured):"]),
          ...(revision.rules ? setupRulesSummary(revision.rules, maxPositions, revision.compiled ?? {}).map((line) => `  ${line}`) : [])];
      } catch { return ["The strategy could not be read right now."]; }
    },
    async launchpads() {
      try { const result = await runPrivateLaunchpadCommand({ args: [agentId], directory, flags: FLAGS }); return result.kind === "status" ? result.view : undefined; }
      catch { return undefined; }
    },
    async setLaunchpads(ids) {
      // A2a: adding a source is raising. Only when the runner asks for the proof does a secret card open for the passphrase (removing
      // sources asks nothing); the card is closed with no row of its own (the overlay shows the result).
      let scope: CardScope | undefined;
      const secret: SocketProofSecret = async (label) => {
        scope ??= host.open({ kind: "CONFIRM", title: "Add signal sources", secret: true });
        await write("Adding a signal source needs your trading wallet passphrase (it is not stored).\n");
        const prompt = host.prompt();
        try { return await prompt.secret(label); } finally { prompt.close(); }
      };
      try {
        const result = await runPrivateLaunchpadCommand({ args: [agentId, "--launchpads", ids.length ? ids.join(",") : "none"], directory, flags: FLAGS, proofSecret: secret });
        return result.kind === "set" ? `Signal sources saved: ${result.view.subscribedIds.length ? result.view.subscribedIds.join(", ") : "no launchpad"}.`
          : "The launchpad sources were not saved.";
      } catch (error: unknown) { return error instanceof TerminalError ? `${error.title}: ${error.cause}` : "The launchpad sources were not saved."; }
      finally { scope?.close(""); }
    },
    async agents() {
      let running: RunnerAgentState[] = [];
      try { running = (await inspectLocalRunner(directory)).agents; } catch { running = []; }
      const rows: CockpitAgentRow[] = running.map((agent) => ({ agentId: agent.agentId, mode: cockpitMode(agent), current: agent.agentId === agentId }));
      for (const known of knownRunnerAgents(directory)) if (!rows.some((row) => row.agentId === known)) rows.push({ agentId: known, mode: "not in the runner", current: known === agentId });
      return rows;
    },
  });
  /** One read of the daemon's setup workers (`watch` also keeps the ceiling worker polling); undefined when it cannot be read. */
  const setupView = async (agentId: string, action: "status" | "watch"): Promise<PrivateSetupView | undefined> => {
    try {
      const pinned = target(agentId);
      const response = await requestPrivateSetup(pinned.socketPath, privateSetupRequest(pinned, action));
      if (response.ok) return response.setup;
      // A runner without the setup workers: the link falls back to the manual bind and the ceiling step does not apply.
      return response.error === "setup_unavailable" ? { link: { state: "off" }, ceiling: { state: "idle" } } : undefined;
    } catch { return undefined; }
  };
  const answerWithDefault = async (question: string, fallback: string, check: (value: string) => boolean, help: string): Promise<string | null> => {
    for (;;) {
      const answer = await io.ask(`${question} [Enter = ${fallback}]: `);
      if (answer === null) return null;
      const value = answer.trim() || fallback;
      if (check(value)) return value;
      await io.write(`${help}\n`);
    }
  };
  const stopLossCheck = (proposal: RuleProposal): string | undefined => privateRuleStopLossRefusal(proposal.compilation);
  const failure = (text: string): SetupApplyResult => ({ ok: false, text });
  /** One save of the setup card: the command's own output is kept off the screen (the summary showed the values); errors are shown. */
  const saving = async (run: () => Promise<SetupApplyResult>): Promise<SetupApplyResult> => {
    try { return await run(); }
    catch (error: unknown) { if (error instanceof TerminalError) return failure(`${error.cause} ${error.fix}`); throw error; }
  };
  const quiet = { ...command, write: silent };
  /** A2a seal step (runner/private-owner-pin-ui.ts) inside the open card: the whole Hub wallet address, the settings, the typed last 6
   * characters and the passphrase. `known`: the passphrase this arm card already holds (decision 1). True when sealed. */
  const sealWith = async (agentId: string, options: { known?: string; reason?: string } = {}): Promise<boolean> => {
    let pinned: PrivateBrainTarget;
    try { pinned = target(agentId); } catch { await write("The runner could not be reached for the seal. Nothing was sealed.\n"); return false; }
    const sealTarget = pinned;
    const prompt = host.prompt();
    try {
      const result = await runPrivateOwnerPinSeal({ target: sealTarget, write, prompt, describeRules: (id, revisionId) => readSetupRulesReview(directory, id, revisionId),
        ...(options.known !== undefined ? { known: options.known } : {}), ...(options.reason ? { reason: options.reason } : {}) });
      await write(formatPrivateOwnerPinResult(result));
      return result.kind === "sealed";
    } finally { prompt.close(); }
  };
  const ARM_SEAL_REASON = "Before arming: your Hub wallet or your settings are not sealed on this computer (or a setting is now looser than your seal).";
  const armSeal = (agentId: string) => (known?: string): Promise<boolean> => sealWith(agentId, { ...(known !== undefined ? { known } : {}), reason: ARM_SEAL_REASON });
  /** `batch` (decision 1): the setup card's ONE hidden prompt for its batch of saves after the typed CONFIRM <agent>, asked only when the
   * runner first answers proof_required and reused for the rest of that batch; cleared before arming and when the card ends. */
  const setupCard = (agentId: string, saved?: { confirmed?: boolean; row?: string }, batch?: { value?: string }): SetupCardDeps => {
    const proofSecret: SocketProofSecret | null = batch ? async (label) => {
      if (batch.value !== undefined) return batch.value;
      const typed = await io.secret(label);
      if (typed !== null) batch.value = typed;
      return typed;
    } : null;
    return {
    io, agentId,
    async ceiling() {
      const ceiling = (await setupView(agentId, "status"))?.ceiling;
      return ceiling?.state === "approved" && ceiling.perTradeLamports && ceiling.dailyLamports
        ? { perTradeLamports: ceiling.perTradeLamports, dailyLamports: ceiling.dailyLamports } : undefined;
    },
    async launchpads() {
      try { const result = await runPrivateLaunchpadCommand({ args: [agentId], directory, flags: FLAGS }); return result.kind === "status" ? result.view : undefined; }
      catch { return undefined; }
    },
    async walletAddress() {
      try {
        const result = await runPrivateTradingWalletCommand({ ...quiet, interactive: false, args: [agentId, "status"] });
        return result.kind === "status" && result.wallet.state === "unlocked" && result.wallet.addressVerified ? result.wallet.address : undefined;
      } catch { return undefined; }
    },
    async balance() {
      try {
        const request = parsePrivateArmingRequest({ ...privateArmingBinding(target(agentId)), action: "wallet_balance" });
        const response = await requestPrivateArming(target(agentId).socketPath, request);
        return response.ok && response.data.kind === "wallet_balance" ? BigInt(response.data.lamports) : undefined;
      } catch { return undefined; }
    },
    async quoteLimits(perTrade, daily) {
      const unread = { ok: false as const, text: "The percentage could not be fixed into SOL right now (the runner gave no validated answer)." };
      try {
        const request = parsePrivateArmingRequest({ ...privateArmingBinding(target(agentId)), action: "limits_quote",
          perTrade: parsePrivateCapArgument(perTrade), daily: parsePrivateCapArgument(daily) });
        const response = await requestPrivateArming(target(agentId).socketPath, request);
        if (!response.ok) return { ok: false, text: privateSpendCapErrorText(response.error) };
        return response.data.kind === "limits_quote" ? { ok: true, quote: response.data.quote } : unread;
      } catch { return unread; }
    },
    // The funding wait stops on the card's Esc (in the one screen; not SIGINT); the setup card then continues to its summary.
    interrupt() { return host.interruptible(); },
    sleep: (ms, signal) => pause(ms, signal),
    async facts() {
      const facts: { model?: string; budget?: string } = {};
      try {
        const status = await readPrivateModelStatus(target(agentId));
        if (status.ok && status.model?.state === "ready") facts.model = `${PRIVATE_BRAIN_PROVIDER_LABELS[status.model.provider]} / ${status.model.model}`;
      } catch { /* Not shown. */ }
      try {
        const budget = await runPrivateModelBudgetCommand({ ...quiet, interactive: false, args: [agentId] });
        if (budget.kind === "status") facts.budget = formatPrivateModelUsd(budget.status.policy.dailyLimitMicroUsd);
      } catch { /* Not shown. */ }
      return facts;
    },
    apply: {
      rules: (text, compiled) => saving(async () => {
        // The typed CONFIRM is answered only for exactly the compiled rules the summary showed (same rules and compiled digests).
        const result = await runPrivateRuleCommand({ ...quiet, args: [agentId, "solana", "edit"], proofSecret, beforeConfirm: (proposal) => stopLossCheck(proposal)
          ?? (proposal.compilation.status === "compiled" && proposal.compilation.diagnostics.length === 0 ? undefined
            : "Some clauses would be held for review, so these rules were not confirmed.")
          ?? (proposal.compilation.rulesDigest === compiled.rulesDigest && proposal.compilation.compiledDigest === compiled.compiledDigest ? undefined
            : "The runner compiled these rules differently from the ones shown in the summary, so they were not confirmed. Open the setup card again."),
          createPrompt: () => answeringRulePrompt(text, (phrase) => OPERATION_PHRASE.test(phrase)) });
        const receipt = result.receipt as RuleCommitReceipt | undefined;
        if (result.kind === "confirmed" && saved) saved.confirmed = true;
        return result.kind === "confirmed" && receipt?.state === "compiled" ? { ok: true, text: "The rules are confirmed." }
          : failure(typeof result.reason === "string" ? result.reason : `Rules: ${result.kind.replace(/_/g, " ")}.`);
      }),
      approvalOff: () => saving(async () => {
        const result = await runPrivateRuleCommand({ ...quiet, args: [agentId, "solana", "approval", "off"], proofSecret,
          createPrompt: () => answeringRulePrompt(null, (phrase) => phrase === `APPROVAL OFF ${agentId}`) });
        return result.kind === "confirmed" || result.kind === "approval_unchanged" ? { ok: true, text: "The agent trades automatically within your limits once armed." }
          : failure(`Automatic trading: ${result.kind.replace(/_/g, " ")}.`);
      }),
      limits: (perTrade, daily, fixed) => saving(async () => {
        // SET LIMITS is answered only when the command fixes both caps to exactly the SOL amounts the summary showed.
        const result = await runPrivateSpendLimitsCommand({ ...quiet, args: [agentId, "limits", "--per-trade", perTrade, "--daily", daily], proofSecret,
          acceptQuote: (quote) => samePrivateCap(quote.perTrade, fixed.perTrade) && samePrivateCap(quote.daily, fixed.daily),
          createPrompt: () => answeringPrompt((label) => (label === "limits> " ? `SET LIMITS ${agentId}` : null)) });
        return result.kind === "updated" || (result.kind === "cancelled" && result.reason === "unchanged") ? { ok: true, text: "Spend limits saved." }
          : failure(formatPrivateSpendLimitsResult(result).trim());
      }),
      sizing: (amountSol, slippageBps) => saving(async () => {
        const result = await runPrivateSizingCommand({ ...quiet, args: [agentId, "--amount-sol", amountSol, "--slippage-bps", slippageBps], proofSecret,
          createPrompt: () => answeringRulePrompt(null, (phrase) => OPERATION_PHRASE.test(phrase)) });
        return result.kind === "update" ? { ok: true, text: "Buy size saved." } : failure(formatPrivateSizingResult(result, agentId).trim());
      }),
      sources: (launchpadIds) => saving(async () => {
        const result = await runPrivateLaunchpadCommand({ args: [agentId, "--launchpads", launchpadIds.length ? launchpadIds.join(",") : "none"], directory, flags: FLAGS,
          proofSecret });
        return result.kind === "set" ? { ok: true, text: "Launchpad sources saved." } : failure("The launchpad sources were not saved.");
      }),
    },
    async arm() {
      // The batch passphrase answers the saves only; arming keeps its own review, typed ARM and passphrase.
      if (batch) batch.value = undefined;
      const result = await runPrivateArmCommand({ ...command, args: [agentId], sealAuthority: armSeal(agentId) });
      const row = armRow(result);
      if (saved) saved.row = row;
      await write(row);
    },
    };
  };
  const modelOperation = async (agentId: string, operation: PrivateModelOperation): Promise<CockpitModelResult> => {
    // A2a: a model change may need the trading-wallet proof: this model card's passphrase first (one passphrase by default), then one
    // hidden prompt for the wallet's own (decision 1: reuse inside one model card).
    try { return await runPrivateModelOperation(target(agentId), operation, undefined, { known: operation.passphrase, secret: (label) => io.secret(label) }); }
    catch (error: unknown) { if (error instanceof TerminalError) return { kind: "failed", text: `${error.cause} ${error.fix}` }; throw error; }
  };
  /** A1: the Balchemy row of each command result (code-built). A typed phrase that was not the command's own closes the card with
   * "Not confirmed. Nothing was changed."; Esc closes it with "Closed. Nothing was changed."; other outcomes keep the command's text. */
  const walletRow = (result: PrivateTradingWalletCommandResult): string => result.kind === "cancelled"
    && ["input_closed", "backup_not_confirmed", "import_not_confirmed", "recovery_not_confirmed"].includes(result.reason) ? notConfirmed()
    : formatPrivateTradingWalletResult(result).trim();
  const limitsRow = (result: Awaited<ReturnType<typeof runPrivateSpendLimitsCommand>>): string => result.kind === "cancelled"
    && (result.reason === "input_closed" || result.reason === "limits_not_confirmed") ? notConfirmed() : formatPrivateSpendLimitsResult(result).trim();
  function armRow(result: Awaited<ReturnType<typeof runPrivateArmCommand>>): string {
    return result.kind === "cancelled" && (result.reason === "input_closed" || result.reason === "arm_not_confirmed") ? notConfirmed()
      : formatPrivateArmResult(result).trim();
  }
  /** Rule results without the raw JSON the CLI command prints (the cockpit shows code-built sentences only). */
  const ruleRow = (result: RuleCommandResult): string => {
    if (result.kind === "confirmed") return "Rules confirmed.";
    if (result.kind === "cancelled") return notConfirmed();
    if (result.kind === "approval_unchanged") return result.setting === "off" ? "Trade approval is already off for the confirmed rules. Nothing was proposed."
      : "Trade approval already applies to the confirmed rules. Nothing was proposed.";
    if (result.kind === "outcome_unknown") return "The confirmation outcome is unknown. It was not resent; check /directive before another change.";
    return typeof result.reason === "string" ? result.reason : "The rules were not confirmed. Nothing was changed.";
  };
  /** A display-only card stays open until the owner closes it (Enter or Esc). */
  const hold = async (): Promise<void> => { await io.ask("done"); };
  /** One card from the chat: opened on the one screen at once (no gap where keys reach the chat), closed with its result row. */
  const runCard = async (agentId: string, card: CockpitCard): Promise<void> => {
    const scope = host.open(cardMeta(card));
    let result: string | undefined = "";
    try { result = await cardBody(agentId, card); }
    finally { scope.close(result); }
  };
  const cardBody = async (agentId: string, card: CockpitCard): Promise<string | undefined> => {
    switch (card.kind) {
      case "wallet_unlock": return walletRow(await runPrivateTradingWalletCommand({ ...command, args: [agentId, "unlock"] }));
      case "rpc_set": {
        await write("Advanced setting: Balchemy normally provides the Solana connection (two independent providers). "
          + "Optionally, paste your own Solana RPC URL at the hidden prompt. Only its host is ever shown. An armed agent with an open trade keeps its RPC.\n");
        const result = await runPrivateSolanaRpcCommand({ ...command, args: [agentId, "set"] });
        return result.kind === "cancelled" ? notConfirmed() : formatPrivateSolanaRpcResult(result, agentId).trim();
      }
      case "limits_set": {
        const cap = (value: string) => { try { parsePrivateCapArgument(value); return true; } catch { return false; } };
        const help = "Use a SOL amount up to 10 with at most 9 decimals (0.1), a percentage from 1% to 100% (5%), or none.";
        // K2: defaults at or below the signed spend ceiling, so arming needs no second browser visit.
        const ceiling = (await setupView(agentId, "status"))?.ceiling;
        const signed = ceiling?.state === "approved" && ceiling.perTradeLamports && ceiling.dailyLamports ? ceiling : undefined;
        // K5b: values typed with /limit or in the settings (a raise): the command reviews them and the owner types SET LIMITS.
        if (card.perTrade !== undefined && card.daily !== undefined) {
          const over = signed?.perTradeLamports && signed.dailyLamports
            ? aboveCeiling({ perTradeLamports: signed.perTradeLamports, dailyLamports: signed.dailyLamports }, card.perTrade, card.daily) : [];
          if (over.length) await write(`Above your signed spend ceiling (${over.join(", ")}): arming then needs a new wallet signature in the browser. `
            + "Until you arm again, the agent keeps trading only within the ceiling you signed.\n");
          return limitsRow(await runPrivateSpendLimitsCommand({ ...command, args: [agentId, "limits", "--per-trade", card.perTrade, "--daily", card.daily] }));
        }
        if (signed?.perTradeLamports && signed.dailyLamports) {
          await write(`Your signed spend ceiling: up to ${sol(signed.perTradeLamports)} SOL per trade, ${sol(signed.dailyLamports)} SOL per day. `
            + "Limits at or below it need no new browser signature. A higher limit (or none) needs a new wallet signature in the browser when you arm.\n");
        }
        // The per-trade and per-day questions stay (owner decision for A1).
        const perTrade = await answerWithDefault("Most one buy may spend (SOL, N% or none)", cockpitLimitDefault(SETUP_DEFAULTS.perTrade, signed?.perTradeLamports), cap, help);
        if (perTrade === null) return notConfirmed();
        const daily = await answerWithDefault("Most all buys may spend per day (SOL, N% or none)", cockpitLimitDefault(SETUP_DEFAULTS.daily, signed?.dailyLamports), cap, help);
        if (daily === null) return notConfirmed();
        return limitsRow(await runPrivateSpendLimitsCommand({ ...command, args: [agentId, "limits", "--per-trade", perTrade, "--daily", daily] }));
      }
      case "limits_review": return limitsRow(await runPrivateSpendLimitsCommand({ ...command, args: [agentId, "limits", "review", card.proposalId] }));
      case "rules_edit": {
        // A1: no starter preset (the old one named "new pairs", which holds every buy); the owner writes the directive with the coach.
        // Cockpit only: a rule text without its own stop-loss is refused before the CONFIRM (PRIVATE_RULE_STOP_LOSS_REQUIRED).
        const own = await runDirectiveCoach(io);
        if (own === undefined) return undefined;
        // The coach's text replaces only the typed rule lines; compilation, review and the typed CONFIRM are unchanged.
        const createPrompt = (): RulePrompt => {
          const real = host.prompt();
          return { get closed() { return real.closed; }, source: async () => (real.closed ? null : own),
            confirm: (phrase, alternates) => real.confirm(phrase, alternates), close: () => real.close() };
        };
        const baseline = await exitBaseline(agentId);
        // A1: the plain review replaces the command's raw JSON preview (review: setupProposalReview); the typed CONFIRM is unchanged.
        const result = await runPrivateRuleCommand({ ...command, args: [agentId, "solana", "edit"], createPrompt, beforeConfirm: stopLossCheck,
          review: setupProposalReview });
        const row = ruleRow(result);
        await afterRules(agentId, result, baseline); return row;
      }
      case "rules_review": {
        // Owner decision of 19 Nov 2026: a chat-drafted rule text without its own stop-loss is refused before the CONFIRM.
        const baseline = await exitBaseline(agentId);
        const result = await runPrivateRuleCommand({ ...command, args: [agentId, "solana", "review", card.proposalId], beforeConfirm: stopLossCheck,
          review: setupProposalReview });
        const row = ruleRow(result);
        await afterRules(agentId, result, baseline); return row;
      }
      case "setup": {
        // The setup card may confirm rules; the exit re-bind card follows it then (silent without an open position that would change).
        const baseline = await exitBaseline(agentId);
        const saved: { confirmed?: boolean; row?: string } = {};
        const batch: { value?: string } = {};
        let outcome: Awaited<ReturnType<typeof runSetupCard>>;
        try { outcome = await runSetupCard(setupCard(agentId, saved, batch)); }
        finally { batch.value = undefined; }
        if (saved.confirmed) await offerCockpitExitRebind(exitRebindDeps(agentId), baseline);
        // A secret card records no line by itself: its result row is explicit.
        return outcome.kind === "left" ? outcome.reason : outcome.kind === "partial"
          ? `Setup partly saved (${outcome.saved.length ? outcome.saved.join(", ") : "nothing"}); ${outcome.failed} was not saved.`
          : saved.row ?? "Setup saved.";
      }
      case "approval_off": {
        await write("Your rules still ask for your approval before each trade. In-app trade approval is not available yet, so arming refuses while it applies.\n");
        const baseline = await exitBaseline(agentId);
        const result = await runPrivateRuleCommand({ ...command, args: [agentId, "solana", "approval", "off"], review: setupProposalReview });
        const row = ruleRow(result);
        await afterRules(agentId, result, baseline); return row;
      }
      case "sizing": {
        const sizing = (amount: string, bps: string) => { try { parsePrivateSizingArguments([agentId, "--amount-sol", amount, "--slippage-bps", bps]); return true; } catch { return false; } };
        if (card.amountSol) await write(card.owner ? `Your new value: ${card.amountSol} SOL per buy, ${card.slippageBps ?? 100} bps (a higher slippage). Press Enter to keep each, then type the confirmation.\n`
          : `Suggested by your agent in the chat: ${card.amountSol} SOL per buy, ${card.slippageBps ?? 100} bps. Check it before you confirm.\n`);
        const amount = await answerWithDefault("SOL per buy", card.amountSol ?? SETUP_DEFAULTS.amountSol, (value) => sizing(value, "100"),
          "Use a SOL amount with at most 9 decimals, such as 0.05.");
        if (amount === null) return notConfirmed();
        // A1 (owner decision): slippage defaults to 1% and is asked only when a value was proposed (Settings keeps the change).
        let bps: string | null = SETUP_DEFAULTS.slippageBps;
        if (card.owner || card.slippageBps !== undefined) {
          bps = await answerWithDefault("Slippage in bps (100 = 1%)", String(card.slippageBps ?? SETUP_DEFAULTS.slippageBps), (value) => sizing(amount, value),
            "Use a whole number of bps within the allowed range, such as 100.");
        } else await write("Slippage: 1% (change it later in Settings).\n");
        if (bps === null) return notConfirmed();
        const result = await runPrivateSizingCommand({ ...command, args: [agentId, "--amount-sol", amount, "--slippage-bps", bps] });
        return result.kind === "cancelled" ? notConfirmed() : formatPrivateSizingResult(result, agentId).trim();
      }
      case "arm": return armRow(await runPrivateArmCommand({ ...command, args: [agentId], sealAuthority: armSeal(agentId) }));
      case "budget": {
        await write("Raising the daily AI budget lets the agent spend more of your AI provider credit per UTC day. It grants no trading permission.\n");
        const result = await runPrivateModelBudgetCommand({ ...command, args: [agentId, "--daily-usd", card.usd] });
        return result.kind === "cancelled" ? notConfirmed() : formatPrivateModelBudgetResult(result, agentId).trim();
      }
      case "model": {
        // The flow runs the model step itself (cockpit-flow.ts); this card never reaches here from the chat.
        await write("Use /model in the chat to keep or change the AI model.\n"); await hold(); return "Nothing was changed.";
      }
      case "wallet": {
        const address = await setupCard(agentId).walletAddress();
        if (!address) {
          await write("The trading wallet address is not verified in this runner session yet (unlock the wallet first), so it is not shown.\n");
          await hold(); return "The trading wallet address is not verified yet, so it was not shown.";
        }
        await write(`Trading wallet (Solana only):\n  ${address}\n`);
        try { await write(renderTerminalQrPlain(address).join("\n") + "\n"); } catch { /* The text address above is complete. */ }
        const lamports = await setupCard(agentId).balance();
        await write(lamports === undefined ? "Balance: not readable right now.\n" : `Balance: ${lamportsToSol(lamports.toString())}\n`);
        await write("Fund it only with what the agent may use.\n");
        await hold(); return `Trading wallet (Solana only): ${address}`;
      }
      case "resume": {
        // K5b: a stopped or paused agent returns to shadow mode (the runner's resume control); an armed agent whose new buys are paused
        // gets them back through the owner-local entries resume, which never disarms it and never stops its exits (cockpit-resume.ts).
        // A2a: an unsealed Hub wallet or settings opens the seal step in this card; the resume is then sent once more.
        return runCockpitResume({ io, agentId, phrase: cockpitResumePhrase(agentId), readState: () => agentState(agentId),
          resumeShadow: (before) => control(agentId, "resume", before), resumeEntries: (before) => resumeEntries(agentId, before),
          seal: () => sealWith(agentId, { reason: "New buys stay paused until your Hub wallet and your settings are sealed on this computer." }) });
      }
    }
  };
  return {
    io, readers,
    known: () => knownRunnerAgents(directory),
    async versions() { return { cli: PACKAGE_VERSION, runner: await readRunnerVersion(directory) }; },
    async start(agentId) {
      try {
        const state = await startLocalRunner(directory, [agentId]);
        const started = state.agents.find((agent) => agent.agentId === agentId);
        return state.process === "running" && !!started && started.mode === "shadow" && !started.armed && started.execution === "unavailable";
      } catch { return false; }
    },
    // Owner decision of 19 Nov 2026: the agent is added to the running runner; nothing else is restarted or disarmed.
    async register(agentId) {
      try {
        const state = await registerLocalAgent(directory, agentId);
        const added = state.agents.find((agent) => agent.agentId === agentId);
        return state.process === "running" && !!added && added.execution === "unavailable";
      } catch { return false; }
    },
    // The one exception to the one screen (kept as the owner decided): a runner without encrypted storage uses LocalRunnerChat's own
    // screen, so the cockpit screen is unmounted for it and comes back afterwards.
    async runModel(agentId, mode) { await terminal.suspend(async () => { try { await startLocalRunnerChat(target(agentId), mode); } finally { restoreStdin(); } }); },
    models: {
      async check(provider, apiKey) {
        try { return { kind: "ok", models: await fetchProviderModels(provider, apiKey) }; }
        catch (error: unknown) { return error instanceof ModelCatalogError && error.code === "unauthorized" ? { kind: "rejected" } : { kind: "unavailable" }; }
      },
      async publicModels() { try { return await fetchPublicOpenRouterModels(); } catch { return undefined; } },
      async saved(agentId) { try { return await readPrivateSavedModel(target(agentId)); } catch { return undefined; } },
      save: (agentId, input) => modelOperation(agentId, { action: "save", ...input }),
      reselect: (agentId, model, passphrase) => modelOperation(agentId, { action: "reselect", model, passphrase }),
      unlock: (agentId, passphrase) => modelOperation(agentId, { action: "unlock", passphrase }),
      async price(agentId, choice, passphrase) {
        if (!choice.price) return false;
        try {
          return !!await savePrivateModelPrice(target(agentId), { provider: "openrouter", model: choice.id, ...choice.price }, undefined,
            { ...(passphrase !== undefined ? { known: passphrase } : {}), secret: (label) => io.secret(label) });
        } catch { return false; }
      },
    },
    budget: {
      async read(agentId) {
        try {
          const result = await runPrivateModelBudgetCommand({ ...command, interactive: false, write: silent, args: [agentId] });
          return result.kind === "status" ? { limit: formatPrivateModelUsd(result.status.policy.dailyLimitMicroUsd), set: result.status.policy.revision > 0 } : undefined;
        } catch { return undefined; }
      },
      async set(agentId, usd) {
        const result = await runPrivateModelBudgetCommand({ ...command, args: [agentId, "--daily-usd", usd] });
        await write(result.kind === "cancelled" ? `${notConfirmed()}\n` : formatPrivateModelBudgetResult(result, agentId));
      },
    },
    async runPairing(agentId) {
      if (await readers.pairing(agentId) === "paired") return;
      {
        // One-step pairing: the runner finds the page's request itself; the owner types the page's code here (PAIR + 8) and
        // this side's code on the page. It also resumes an earlier approval: it relays again and renews an expired request.
        // Esc on the card stops waiting; nothing is approved without the typed phrase.
        const stop = host.interruptible();
        let result;
        try {
          result = await runAutoPairing({ directory, frontendOrigin, agentId, openUrl: openBrowser, signal: stop.signal,
            confirm: async (card) => { await io.write(`${autoPairingCardDetails(card)}\n`); return io.ask("> "); },
            onProgress: async (event) => { await io.write(autoPairingProgressText(event)); } });
        } finally { stop.release(); }
        if (result.state === "paired") { await io.write("Linked to your Hub account (identity only; no trading).\n"); return; }
        if (result.state === "cancelled") { await io.write("Pairing stopped. Nothing was linked.\n"); return; }
        if (result.state === "timed_out") { await io.write("The page did not finish in time. Nothing was linked.\n"); return; }
        await io.write("This Balchemy site does not offer one-step pairing yet, so the step-by-step flow follows.\n");
      }
      // The step-by-step Hub flow (Challenge ID and runner answer), chained in one session.
      const pair = (args: string[], approve: Parameters<typeof runPairingCommand>[0]["approve"] = async () => false) =>
        runPairingCommand({ directory, frontendOrigin, args, dryRun: false, approve });
      const confirm = async (): Promise<boolean> => {
        for (;;) {
          const answer = await io.ask("Press Enter after you confirmed on the pairing page (or type later to stop): ");
          if (answer === null || answer.trim().toLowerCase() === "later") return false;
          try { if ((await pair([agentId, "confirm"])).state === "paired") return true; }
          catch (error: unknown) { if (!(error instanceof TerminalError)) throw error; }
          await io.write("Balchemy has not confirmed it yet. Finish on the page, then press Enter again.\n");
        }
      };
      // Only a site without the one-step relay reaches the step-by-step flow.
      if (await readers.pairing(agentId) === "awaiting_confirmation") {
        await io.write("You already approved a pairing here. Finish it on the pairing page in your browser (paste the runner's answer and confirm).\n"
          + `If that request expired, start a new one: balchemy runner pair ${agentId}\n`);
        await confirm(); return;
      }
      const start = await pair([agentId]);
      if (start.state === "paired") return;
      if (start.state !== "awaiting_browser") return;
      openBrowser(start.url);
      await io.write(`The pairing page should open in your browser. If it did not, open:\n${start.url}\n`
        + `Runner fingerprint: ${start.runnerFingerprint.match(/.{1,8}/g)?.join(" ")} (the page shows the same).\n`
        + "Sign in, choose your verified wallet and continue; the page then shows a Challenge ID.\n");
      let challengeId = "";
      for (;;) {
        const answer = await io.ask("Paste the Challenge ID here: ");
        if (answer === null) return;
        challengeId = answer.trim().toLowerCase();
        if (UUID.test(challengeId)) break;
        await io.write("That does not look like a Challenge ID (1b2c3d4e-....). Paste it again.\n");
      }
      const approved = await pair([agentId, challengeId], async (preview) => {
        await io.write(`${pairingApprovalDetails(preview)}\n`);
        const answer = await io.ask("> ");
        return answer !== null && isPairingConfirmation(answer, preview.challengeId);
      });
      if (approved.state !== "awaiting_wallet") { await io.write("Pairing not approved. Nothing was linked.\n"); return; }
      const proof = JSON.stringify(approved.proof);
      await io.write(await copyToClipboard(proof)
        ? `The runner's answer is copied to your clipboard: paste it into "Runner response" on the page (Cmd+V or Ctrl+V), load it and confirm there.\n`
        : `Copy this runner answer into "Runner response" on the page, load it and confirm there:\n${proof}\n`);
      await confirm();
    },
    // Runs inside the secret "Trading wallet" step card: a new key is shown in it and cleared by the command; the card's text is discarded.
    async runWallet(agentId, action, passphrase) {
      const result = await runPrivateTradingWalletCommand({ ...command, args: [agentId, action], ...(passphrase !== undefined ? { passphrase } : {}) });
      await write(`${walletRow(result)}\n`);
    },
    async unlockWallet(agentId, passphrase) {
      try {
        const result = await runPrivateTradingWalletCommand({ ...command, write: silent, args: [agentId, "unlock"], passphrase });
        return result.kind === "unlocked" ? "unlocked" : result.kind === "cancelled" && result.reason === "shared_passphrase_rejected" ? "rejected"
          : result.kind === "cancelled" && result.reason === "unlock_throttled" ? "throttled" : "unknown";
      } catch { return "unknown"; }
    },
    // K2: the runner links the unlocked wallet by itself after pairing; this only shows the progress. A runner without the setup
    // worker (never the same version) falls back to the manual bind command, which no longer asks for a typed phrase.
    async waitForLink(agentId) {
      const stop = host.interruptible();
      try {
        const deadline = Date.now() + LINK_WAIT_MS;
        let shown = "";
        while (Date.now() < deadline && !stop.signal.aborted) {
          const setup = await setupView(agentId, "status");
          if (setup?.link.state === "off") {
            const result = await runPrivateTradingWalletCommand({ ...command, args: [agentId, "bind"] }); await write(`${walletRow(result)}\n`); return;
          }
          const link = setup?.link ?? { state: "unavailable" as const };
          const text = cockpitLinkText(link);
          if (text === undefined) return;
          if (link.state === "refused") {
            throw new TerminalError({ code: "RUNTIME_ERROR", title: "Trading wallet not linked", cause: tradingBindingRefusalText(link.reason),
              fix: `Read balchemy runner wallet ${agentId} status. The manual fallback is balchemy runner wallet ${agentId} bind.`, exitCode: 1 });
          }
          if (text !== shown) { shown = text; await io.write(text); }
          if (link.state === "linked") return;
          await pause(LINK_POLL_MS, stop.signal);
        }
      } finally { stop.release(); }
    },
    // K2: the spend ceiling on the same Hub page. Esc skips it (arming then asks for a wallet approval as before).
    async ceiling(agentId, fresh) {
      const first = await setupView(agentId, "status");
      if (!first || first.link.state === "off") return;
      const initial = first.ceiling;
      if (initial.state === "approved") { if (fresh) await io.write(cockpitCeilingText(initial)); return; }
      if (!fresh && initial.state !== "challenge" && initial.state !== "requesting" && initial.state !== "waiting" && initial.state !== "expired") return;
      // A WAITING card while the page is open; its result row says what was signed or skipped.
      const card = host.open({ kind: "WAITING", title: "Spend ceiling" });
      await io.write("\nStep: your spend ceiling. On the same Hub page, enter the most one trade and one day may spend (SOL), then sign it with your "
        + "wallet. It is a maximum: limits you set later at or below it need no second signature. Esc skips this step (arming asks for it then).\n");
      const stop = host.interruptible();
      try {
        const deadline = Date.now() + CEILING_WAIT_MS;
        let shown = "";
        while (Date.now() < deadline && !stop.signal.aborted) {
          const view = (await setupView(agentId, "watch"))?.ceiling ?? { state: "retrying" as const, reason: "network" as const };
          const text = cockpitCeilingText(view);
          if (text !== shown) { shown = text; await io.write(text); }
          if (view.state === "approved") return;
          if (view.state === "refused" && view.reason !== "too_many_open" && view.reason !== "request_failed") return;
          await pause(CEILING_POLL_MS, stop.signal);
        }
        await io.write(stop.signal.aborted ? "Spend ceiling skipped. Nothing was signed; arming asks for your wallet approval.\n"
          : `${CEILING_REFUSAL_TEXT.timed_out}\n`);
      } finally { stop.release(); card.close(); }
    },
    async openChat(agentId, checklist) {
      // The chat opens on the same screen at once (kept mounted while it is already shown); wallet, balance and the next card arrive
      // with its first refresh.
      const initial: CockpitSide = { checklist };
      const unfinished = checklist.slice(SETUP_CHAT_STEP).some((state) => state !== "done");
      const opening = !opened.has(agentId) && unfinished ? OPENING : undefined;
      opened.add(agentId);
      return terminal.chat({ target: target(agentId), initial, readSide: () => side(agentId), readFeed: feed(agentId), memory: memory(agentId),
        commands: commands(agentId), ...(opening ? { opening } : {}) });
    },
    runCard,
    close: (message) => terminal.close(message),
    // Phase 1: the shutdown warning and the one-step resume (read-only reads; the arm command keeps its own review and confirmation).
    async shutdownWarning() {
      // Audit M4: unreadable runner metadata never hides the warning here (the read throws what shutdown itself would).
      let exposure: Awaited<ReturnType<typeof readRunnerShutdownExposure>>;
      try { exposure = await readRunnerShutdownExposure(directory); }
      catch { exposure = { armed: [], positions: [], unreadable: [], runner: "unreadable" }; }
      return runnerShutdownExposed(exposure) ? formatRunnerShutdownWarning(exposure) : null;
    },
    async openPositions(agentId) {
      try {
        const result = await runPrivatePositionCommand({ args: [agentId], directory, flags: FLAGS });
        if (result.kind !== "list" || result.exits !== "available") return null;
        return result.positions.filter((item) => item.state !== "closed").length;
      } catch { return null; }
    },
    async resume(agentId, passphrase) {
      // Phase 2: the one passphrase already typed in this run answers the arm command's first hidden prompt (the unlock, reused for the
      // arm as in Phase 1). The review and the typed ARM <agent> stay in the open card.
      let given = passphrase;
      const createPrompt = (): WalletPrompt => {
        let real: WalletPrompt | undefined; let closed = false;
        const open = (): WalletPrompt => (real ??= host.prompt());
        return { get closed() { return closed || (real?.closed ?? false); }, line: (label) => open().line(label),
          secret: async (label) => { if (given !== undefined) { const value = given; given = undefined; return value; } return open().secret(label); },
          close: () => { closed = true; real?.close(); } };
      };
      const result = await runPrivateArmCommand({ ...command, args: [agentId], createPrompt, sealAuthority: armSeal(agentId) });
      await write(`${armRow(result)}\n`);
    },
    // A2a seal step of the flow (between pairing and the wallet link and the ceiling).
    ownerPin: {
      async need(agentId) { try { return await readPrivateOwnerPinNeed(target(agentId)); } catch { return "unavailable"; } },
      async seal(agentId) { await sealWith(agentId); },
    },
  };
}
