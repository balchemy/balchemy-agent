/** Explicit owner trading wallet commands. The secret is generated or entered only in
 * this terminal, shown at most once, sealed here, and never sent to the daemon.
 * Unlock sends only the passphrase over the owner-local socket. No trading or transaction signing.
 * Create and import run a read-only daemon preflight before any secret exists or is shown.
 * Bind asks the daemon to prove this wallet to Balchemy Hub (runner key + trading-key possession
 * signatures over fixed-purpose messages); it grants no trading or execution authority. */
import * as path from "node:path";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { readPairingWallet } from "./pairing-identity.js";
import { encodeTradingWalletSecret, generateTradingWalletSecret, parseTradingWalletSecret, sealTradingWallet,
  tradingWalletAddress } from "./private-trading-keystore.js";
import { privateTradingWalletBinding, requestPrivateTradingWallet, PrivateTradingWalletTransportError,
  type PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";
import { privateTradingBindingFrame, requestPrivateTradingBinding, type PrivateTradingBindingTransport } from "./private-trading-binding-client.js";
import { parsePrivateTradingBindingRequest, validatePrivateTradingBindingReply, type PrivateTradingBindingError,
  type PrivateTradingBindingResponse, type TradingWalletBindingView } from "./private-trading-binding-protocol.js";
import { isTradingWalletPassphrase, normalizeTradingWalletPassphrase, parsePrivateTradingWalletRequest, validatePrivateTradingWalletReply,
  type PrivateTradingWalletError, type PrivateTradingWalletRequest, type PrivateTradingWalletResponse,
  type TradingWalletEnvelope, type TradingWalletStatus } from "./private-trading-keystore-protocol.js";

export const TRADING_WALLET_ACTIONS = ["create", "import", "unlock", "lock", "status", "recover", "bind"] as const;
export type TradingWalletAction = typeof TRADING_WALLET_ACTIONS[number];
export interface WalletPrompt {
  readonly closed: boolean;
  /** Visible line for an exact typed confirmation; null on EOF or Ctrl+C/Ctrl+D. */
  line(label: string): Promise<string | null>;
  /** Hidden input: nothing is echoed; null on EOF or Ctrl+C/Ctrl+D. */
  secret(label: string): Promise<string | null>;
  close(): void;
}
export interface PrivateTradingWalletCommandOptions {
  args: string[]; directory: string; interactive: boolean;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  write(text: string): void | Promise<void>;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateTradingWalletTransport;
  /** Hub binding reads and bind. Defaults to the owner socket only when `transport` is also the default. */
  bindingTransport?: PrivateTradingBindingTransport;
  createPrompt?(): WalletPrompt;
  /** Early read-only refusal of the pairing wallet; the daemon re-checks every agent before saving. */
  readPairingWallet?(target: PrivateBrainTarget): { chain: "solana" | "base"; address: string } | undefined;
  generateSecret?(): Buffer;
  /** Runs `cleanup` (clear a shown secret, restore the terminal) on SIGINT/SIGTERM/SIGHUP; returns an unsubscribe. */
  guardSignals?(cleanup: () => void): () => void;
  /** Phase 2 one passphrase (owner decision of 19 Nov 2026), cockpit only: the passphrase the owner chose for the model key in this
   * cockpit run (typed twice) or that just unlocked it. create/import use it instead of asking for a new one; unlock tries it instead
   * of asking, and a wrong one returns `shared_passphrase_rejected` (nothing changed) so the caller asks for the wallet's own. */
  passphrase?: string;
}
export type PrivateTradingWalletCancel = "input_closed" | "backup_not_confirmed" | "import_not_confirmed" | "recovery_not_confirmed"
  | "passphrase_policy" | "passphrase_mismatch" | "shared_passphrase_rejected"
  /** A2a: the keystore refused the unlock after too many wrong passphrases in a row (proof_throttled); nothing was tried. */
  | "unlock_throttled";
/** `unavailable`: the binding could not be read; never shown as unbound. */
export type TradingWalletBindingStatus = TradingWalletBindingView | { state: "unavailable" };
export type PrivateTradingWalletCommandResult = { kind: "dry_run"; agentId: string; action: TradingWalletAction }
  | { kind: "status"; agentId: string; wallet: TradingWalletStatus; binding?: TradingWalletBindingStatus }
  | { kind: "locked" | "unlocked" | "recovered"; agentId: string; wallet: TradingWalletStatus }
  | { kind: "bound"; agentId: string; wallet: TradingWalletStatus; binding: Extract<TradingWalletBindingView, { state: "bound" }> }
  | { kind: "created"; agentId: string; origin: "generated" | "imported"; wallet: TradingWalletStatus }
  | { kind: "cancelled"; agentId: string; action: TradingWalletAction; reason: PrivateTradingWalletCancel }
  /** For create/import, `address` is the key that may or may not have been saved: never fund it until status confirms. */
  | { kind: "outcome_unknown"; agentId: string; action: TradingWalletAction; address?: string };

export const CLEAR_SCREEN = "\u001b[2J\u001b[3J\u001b[H";
/** Tries for a new passphrase before create or import gives up (nothing is generated or saved before it is chosen). */
export const PASSPHRASE_ATTEMPTS = 3;
const MESSAGES: Record<PrivateTradingWalletError, string> = {
  invalid_request: "The local runner rejected this wallet request.",
  profile_conflict: "The local profile changed. Inspect runner status before continuing.",
  instance_conflict: "The daemon changed. Nothing was sent to another instance.",
  unknown_agent: "This agent is not registered with the local runner.",
  wallet_missing: "No trading wallet exists for this agent.",
  wallet_exists: "This agent already has a trading wallet. Each agent has exactly one; it is never replaced here.",
  wallet_locked: "The trading wallet is locked.",
  unlock_failed: "Wrong passphrase: it did not unlock this wallet. Nothing was changed. A forgotten passphrase cannot be recovered; "
    + "only your backed-up secret key restores access to this wallet's funds (import it into Phantom or Solflare and move the funds out).",
  pairing_wallet: "This key is the wallet used for Hub pairing. Trading needs a separate hot wallet.",
  duplicate_wallet: "Another local agent already uses this wallet. Each agent needs its own trading wallet.",
  busy: "Another wallet operation is in progress. Nothing was changed.",
  cancelled: "The wallet operation was cancelled before completion.",
  state_unavailable: "Local wallet state could not be confirmed, or an encrypted or pairing record is held. Nothing was written; existing files were preserved.",
  write_outcome_unknown: "The daemon may or may not have saved this change.",
  recovery_refused: "Recovery applies only to an interrupted create: an initialization marker with no encrypted wallet record. Nothing was removed.",
  closing: "The daemon is closing.",
  proof_throttled: "Too many wrong passphrases in a row. Nothing was changed. Wait a few minutes, then try again.",
};
const BINDING_MESSAGES: Record<PrivateTradingBindingError, string> = {
  invalid_request: "The local runner rejected this binding request.",
  profile_conflict: "The local profile changed. Inspect runner status before continuing.",
  instance_conflict: "The daemon changed. Nothing was sent to another instance.",
  unknown_agent: "This agent is not registered with the local runner.",
  not_paired: "This agent is not paired with Balchemy Hub. Pair it first: balchemy runner pair.",
  lease_unavailable: "The runner has no active Hub lease for this agent right now. Start the runner and wait for it to report, then retry.",
  wallet_missing: "No trading wallet exists for this agent. Create or import one first.",
  wallet_locked: "The trading wallet is locked. Unlock it in this daemon run first; binding needs a possession signature.",
  wallet_held: "The local trading wallet record is held and cannot be used until reviewed.",
  pairing_wallet: "This is the wallet used for Hub pairing. Trading needs a separate hot wallet.",
  identity_wallet: "Balchemy refused: this address is a verified identity wallet (yours or another account's). Use a separate hot wallet.",
  runner_key: "Balchemy refused: this address is a runner identity key, never a trading wallet.",
  bound_elsewhere: "Balchemy refused: this wallet is already bound to another agent. Each agent needs its own trading wallet.",
  already_bound: "Balchemy refused: this agent already has a different trading wallet bound. Bindings are never replaced here.",
  revoked: "This agent's trading wallet binding was revoked in Hub. Revocation is final for this agent; it cannot be bound again.",
  conflict: "Balchemy refused the binding with a conflict (identity wallet, bound elsewhere, already bound or revoked).",
  proof_rejected: "Balchemy did not accept the binding proofs. Nothing was bound.",
  rate_limited: "Balchemy rate-limited the binding request. Nothing was bound; wait and retry.",
  server_rejected: "Balchemy rejected the binding request. Nothing was bound.",
  server_unavailable: "Balchemy could not be reached before any binding proof was sent. Nothing was bound.",
  outcome_unknown: "The binding may or may not have been accepted.",
  write_outcome_unknown: "Balchemy accepted the binding, but the local record may not have been saved.",
  busy: "Another binding operation for this agent is in progress. Nothing was changed.",
  state_unavailable: "Local binding state could not be confirmed. Existing files were preserved.",
  closing: "The daemon is closing.",
};
/** Owner-facing text of a binding refusal (the CLI bind and the cockpit's automatic link). */
export function tradingBindingRefusalText(code: PrivateTradingBindingError): string { return BINDING_MESSAGES[code]; }
function bindingRefused(code: PrivateTradingBindingError): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Trading wallet binding not completed", cause: BINDING_MESSAGES[code],
    fix: code === "wallet_locked" ? "Run runner wallet <agent> unlock, then bind again."
      : code === "rate_limited" || code === "lease_unavailable" || code === "server_unavailable" ? "Retry bind later; there is no automatic retry."
        : "Read runner wallet <agent> status before trying again. Do not delete or reset private files.",
    exitCode: ["invalid_request", "unknown_agent", "profile_conflict", "instance_conflict", "not_paired", "wallet_missing", "pairing_wallet",
      "identity_wallet", "runner_key", "bound_elsewhere", "already_bound", "revoked", "conflict"].includes(code) ? 2 : 1 });
}
function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid trading wallet command",
    cause: "Use runner wallet <agent> create | import | unlock | lock | status | recover | bind.",
    fix: "Secrets and passphrases are accepted only at the hidden terminal prompt. --yes, --force and --quiet are not supported.", exitCode: 2 });
}
function unavailable(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Trading wallet unavailable",
    cause: "The selected runner could not return a validated wallet state.",
    fix: "Inspect runner status and read the wallet status again. Nothing was changed.", exitCode: 1 });
}
function refused(code: PrivateTradingWalletError, agentId = "<agent>"): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: code === "unlock_failed" ? "Wrong passphrase" : "Trading wallet request not completed", cause: MESSAGES[code],
    fix: code === "unlock_failed" ? `Try again: balchemy runner wallet ${agentId} unlock (there is no automatic retry).`
      : "Read the wallet status before trying again. Do not delete or reset private files.",
    exitCode: ["invalid_request", "unknown_agent", "profile_conflict", "instance_conflict", "wallet_exists", "wallet_missing",
      "pairing_wallet", "duplicate_wallet", "recovery_refused"].includes(code) ? 2 : 1 });
}
function lockUnconfirmed(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Trading wallet lock not confirmed",
    cause: "The daemon cleared any key it held in memory for this agent, but could not confirm the wallet state.",
    fix: "Inspect runner status. Stopping the daemon also clears every key from memory. Do not delete or reset private files.", exitCode: 1 });
}

/** Default signal guard: cleanup runs once, then the signal is re-raised with its default action. */
export function guardTerminalSignals(cleanup: () => void): () => void {
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const release = (): void => { for (const signal of signals) process.off(signal, handler); };
  function handler(signal: NodeJS.Signals): void {
    release();
    try { cleanup(); } finally { process.kill(process.pid, signal); }
  }
  for (const signal of signals) process.on(signal, handler);
  return release;
}
export function parsePrivateTradingWalletArguments(args: string[]): { agentId: string; action: TradingWalletAction } {
  const [agentId, action] = args;
  if (args.length !== 2 || !isId(agentId) || !TRADING_WALLET_ACTIONS.includes(action as TradingWalletAction)) invalid();
  return Object.freeze({ agentId, action: action as TradingWalletAction });
}

/** Raw-mode terminal input. Hidden prompts echo nothing; nothing is kept in history. */
export function createWalletPrompt(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WritableStream = process.stdout): WalletPrompt {
  let closed = false; let escape = false;
  let pending: { hidden: boolean; value: string; resolve(value: string | null): void } | undefined;
  const settle = (value: string | null): void => { const current = pending; pending = undefined; current?.resolve(value); };
  function close(): void {
    if (closed) return;
    closed = true; input.off("data", onData); input.off("end", close);
    try { input.setRawMode(false); } catch { /* Terminal already restored. */ }
    input.pause(); settle(null);
  }
  function onData(chunk: Buffer | string): void {
    for (const character of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
      const current = pending;
      if (!current) return;
      if (escape) { if (/[A-Za-z~]/.test(character)) escape = false; continue; }
      if (character === "\u001b") { escape = true; continue; }
      if (character === "\r" || character === "\n") { output.write("\n"); settle(current.value); return; }
      if (character === "\u0003" || character === "\u0004") { output.write("\n"); close(); return; }
      if (character === "\u007f" || character === "\b") {
        if (current.value) { current.value = [...current.value].slice(0, -1).join(""); if (!current.hidden) output.write("\b \b"); }
        continue;
      }
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(character) || Buffer.byteLength(current.value + character, "utf8") > 1024) continue;
      current.value += character; if (!current.hidden) output.write(character);
    }
  }
  if (input.isTTY && typeof input.setRawMode === "function") {
    input.setRawMode(true); input.on("data", onData); input.once("end", close); input.resume();
  } else closed = true;
  const ask = (label: string, hidden: boolean): Promise<string | null> => new Promise((resolve) => {
    if (closed || pending) { resolve(null); return; }
    pending = { hidden, value: "", resolve }; output.write(label);
  });
  return { get closed() { return closed; }, line: (label) => ask(label, false), secret: (label) => ask(label, true), close };
}

export async function runPrivateTradingWalletCommand(options: PrivateTradingWalletCommandOptions): Promise<PrivateTradingWalletCommandResult> {
  const command = parsePrivateTradingWalletArguments(options.args);
  const { agentId, action } = command;
  if (options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.flags.dryRun) return { kind: "dry_run", agentId, action };
  if (["create", "import", "unlock", "recover", "bind"].includes(action) && (!options.interactive || options.flags.json || options.flags.ci)) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive wallet terminal required",
      cause: "Creating, importing, unlocking, recovering and binding a trading wallet require a real terminal (hidden input and typed confirmations; bind shows what it links).",
      fix: "Run without --json or --ci in a terminal. Wallet status and lock support JSON and non-interactive use.", exitCode: 2 });
  }
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== agentId) invalid();
  const transport = options.transport ?? requestPrivateTradingWallet;
  const bindingTransport = options.bindingTransport ?? (options.transport ? undefined : requestPrivateTradingBinding);
  /** A status read never mutates; a lost bind reply is unknown and never resent. */
  const bindingExchange = async (bindAction: "status" | "bind"): Promise<PrivateTradingBindingResponse | "unknown" | "unavailable"> => {
    if (!bindingTransport) return "unavailable";
    const bindingRequest = parsePrivateTradingBindingRequest({ ...privateTradingBindingFrame(target), action: bindAction });
    try { return validatePrivateTradingBindingReply(bindingRequest, await bindingTransport(target.socketPath, bindingRequest)); }
    catch (error: unknown) {
      return bindAction === "bind" && !(error instanceof Error && "code" in error && error.code === "connection_unavailable") ? "unknown" : "unavailable";
    }
  };
  /** Status and preflight never mutate; a lost or invalid mutation reply is unknown and never resent. */
  const exchange = async (request: PrivateTradingWalletRequest): Promise<PrivateTradingWalletResponse | "unknown"> => {
    try { return validatePrivateTradingWalletReply(request, await transport(target.socketPath, request)); }
    catch (error: unknown) {
      if (request.action === "status" || request.action === "preflight"
        || (error instanceof PrivateTradingWalletTransportError && error.code === "connection_unavailable")) return unavailable();
      return "unknown";
    }
  };
  const request = (body: { action: "status" } | { action: "lock" } | { action: "recover" } | { action: "unlock"; passphrase: string }
    | { action: "preflight" } | { action: "preflight"; address: string } | TradingWalletEnvelope): PrivateTradingWalletRequest =>
    parsePrivateTradingWalletRequest("action" in body ? { ...privateTradingWalletBinding(target), ...body }
      : { ...privateTradingWalletBinding(target), action: "create", envelope: body });
  /** Create, import and recover distinguish a refusal before any write from a write whose outcome is unknown. */
  const mutationResult = (response: PrivateTradingWalletResponse | "unknown"): TradingWalletStatus | "unknown" => {
    if (response === "unknown") return "unknown";
    if (!response.ok) {
      if (response.error === "write_outcome_unknown") return "unknown";
      if (action === "lock" && response.error === "state_unavailable") return lockUnconfirmed();
      if (action === "unlock" && (response.error === "state_unavailable" || response.error === "cancelled")) return "unknown";
      return refused(response.error, agentId);
    }
    return response.wallet;
  };
  /** Read-only; refusals here happen before any secret is generated, entered or shown. */
  const preflight = async (address?: string): Promise<void> => {
    const checked = await exchange(request(address === undefined ? { action: "preflight" } : { action: "preflight", address }));
    if (checked === "unknown") return unavailable();
    if (!checked.ok) return refused(checked.error);
  };
  if (action === "lock") {
    const wallet = mutationResult(await exchange(request({ action: "lock" })));
    return wallet === "unknown" ? { kind: "outcome_unknown", agentId, action } : { kind: "locked", agentId, wallet };
  }
  let current: TradingWalletStatus = { state: "absent" };
  if (action === "create" || action === "import") await preflight();
  else {
    const read = await exchange(request({ action: "status" }));
    if (read === "unknown") return unavailable();
    if (!read.ok) return refused(read.error);
    current = read.wallet;
    if (action === "status") {
      if (!bindingTransport) return { kind: "status", agentId, wallet: current };
      const bound = await bindingExchange("status");
      return { kind: "status", agentId, wallet: current,
        binding: bound === "unknown" || bound === "unavailable" || !bound.ok ? { state: "unavailable" } : bound.binding };
    }
    if (action === "bind") {
      if (current.state === "absent") refused("wallet_missing");
      if (current.state === "held") refused("state_unavailable");
      if (current.state !== "unlocked") refused("wallet_locked");
    }
    if (action === "recover" && current.state !== "held") refused("recovery_refused");
    if (action === "unlock") {
      if (current.state === "absent") refused("wallet_missing");
      if (current.state === "held") refused("state_unavailable");
      if (current.state === "unlocked") return { kind: "unlocked", agentId, wallet: current };
    }
  }

  if (action === "bind") {
    // K2 one-visit setup (owner decision of 19 Nov 2026): the runner links the wallet by itself after pairing; this command is the
    // manual fallback, and running it is the owner's consent (no typed phrase). The daemon re-checks every refusal before signing.
    const before = await bindingExchange("status");
    if (before === "unknown" || before === "unavailable") return unavailable();
    if (!before.ok) return bindingRefused(before.error);
    if (before.binding.state === "held") return bindingRefused("state_unavailable");
    if (before.binding.state === "revoked") return bindingRefused("revoked");
    if (before.binding.state === "bound") {
      if (!("address" in current) || before.binding.address !== current.address) return bindingRefused("already_bound");
      return { kind: "bound", agentId, wallet: current, binding: before.binding };
    }
    await options.write([`Linking the trading wallet of ${agentId} to Balchemy Hub`,
      `Address: ${"address" in current ? current.address : ""} (verified by unlock in this daemon run)`,
      "The runner key and this wallet's key each sign a fixed-purpose Balchemy message; no transaction is signed and no funds move.",
      "Balchemy refuses identity wallets and a wallet bound to another agent. One wallet per agent; it is never replaced here.",
      "The Hub owner can revoke the binding at any time, and a revoked agent cannot be bound again.",
      "Binding grants no trading authority: nothing trades until you arm.", ""].join("\n"));
    const result = await bindingExchange("bind");
    if (result === "unknown") return { kind: "outcome_unknown", agentId, action };
    if (result === "unavailable") return unavailable();
    if (!result.ok) {
      if (result.error === "outcome_unknown" || result.error === "write_outcome_unknown") return { kind: "outcome_unknown", agentId, action };
      return bindingRefused(result.error);
    }
    if (result.binding.state !== "bound") return unavailable();
    return { kind: "bound", agentId, wallet: current, binding: result.binding };
  }
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  let secret: Buffer | undefined; let shown = false; let address: string | undefined;
  // A signal while a secret or a raw-mode prompt is on screen clears it and restores the terminal.
  const releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => {
    if (shown) { try { void Promise.resolve(options.write(CLEAR_SCREEN)).catch(() => undefined); } catch { /* Exiting regardless. */ } }
    prompt.close();
  });
  const cancelled = (reason: PrivateTradingWalletCancel): PrivateTradingWalletCommandResult => ({ kind: "cancelled", agentId, action, reason });
  let passphrase: string | undefined;
  /** A new passphrase, typed twice: up to PASSPHRASE_ATTEMPTS tries with a plain reason after each failed one. */
  const choosePassphrase = async (): Promise<string | { reason: PrivateTradingWalletCancel }> => {
    await options.write(["Choose a new trading wallet passphrase: at least 12 characters and at most 1024 UTF-8 bytes.",
      "It may be the same as your model key's passphrase (one passphrase then unlocks both) or a separate one. A lost passphrase cannot be recovered; "
        + "only the backed-up secret key restores this wallet.", ""].join("\n"));
    let reason: PrivateTradingWalletCancel = "passphrase_policy";
    for (let attempt = 1; attempt <= PASSPHRASE_ATTEMPTS; attempt++) {
      const last = attempt === PASSPHRASE_ATTEMPTS;
      const first = await prompt.secret("New passphrase (hidden): ");
      if (first === null || prompt.closed) return { reason: "input_closed" };
      if (!isTradingWalletPassphrase(first)) {
        reason = "passphrase_policy";
        if (!last) await options.write("Passphrase too short (or longer than 1024 bytes): use at least 12 characters. Try again.\n");
        continue;
      }
      const second = await prompt.secret("Repeat passphrase (hidden): ");
      if (second === null || prompt.closed) return { reason: "input_closed" };
      if (normalizeTradingWalletPassphrase(second) === normalizeTradingWalletPassphrase(first)) return first;
      reason = "passphrase_mismatch";
      if (!last) await options.write("The two passphrases did not match. Try again.\n");
    }
    return { reason };
  };
  try {
    if (action === "recover") {
      const phrase = `RECOVER ${agentId}`;
      await options.write([`Recover an interrupted trading wallet create for ${agentId}`,
        "This removes only an initialization marker that has no encrypted wallet record. It never deletes an encrypted wallet.",
        "If any encrypted record or in-flight file exists, recovery is refused and nothing changes.",
        `Type exactly ${phrase} to continue; any other answer cancels.`, ""].join("\n"));
      const answer = await prompt.line("recover> ");
      if (answer === null || prompt.closed) return cancelled("input_closed");
      if (answer !== phrase) return cancelled("recovery_not_confirmed");
      const wallet = mutationResult(await exchange(request({ action: "recover" })));
      return wallet === "unknown" ? { kind: "outcome_unknown", agentId, action } : { kind: "recovered", agentId, wallet };
    }
    if (action === "unlock" && options.passphrase !== undefined) {
      // The cockpit's one passphrase: tried once, never stored; a wrong one changes nothing and the caller asks for this wallet's own.
      if (!isTradingWalletPassphrase(options.passphrase)) return cancelled("shared_passphrase_rejected");
      const response = await exchange(request({ action: "unlock", passphrase: options.passphrase }));
      if (response !== "unknown" && !response.ok && response.error === "unlock_failed") return cancelled("shared_passphrase_rejected");
      if (response !== "unknown" && !response.ok && response.error === "proof_throttled") return cancelled("unlock_throttled");
      const wallet = mutationResult(response);
      return wallet === "unknown" ? { kind: "outcome_unknown", agentId, action } : { kind: "unlocked", agentId, wallet };
    }
    if (action === "unlock") {
      await options.write([`Unlock the trading wallet for ${agentId}`,
        `Address: ${"address" in current ? current.address : ""} (unverified until this unlock succeeds)`,
        "The key stays only in daemon memory until runner wallet lock, daemon stop or restart. Every daemon start requires unlock again.",
        "Unlocking only loads the key into memory; it does not start trading.", ""].join("\n"));
      const passphrase = await prompt.secret("Trading wallet passphrase (hidden): ");
      if (passphrase === null || prompt.closed) return cancelled("input_closed");
      if (!isTradingWalletPassphrase(passphrase)) return cancelled("passphrase_policy");
      const response = await exchange(request({ action: "unlock", passphrase }));
      // A2a: the keystore's wrong-passphrase throttle refuses before any key is tried; a plain cancel, never an unknown outcome.
      if (response !== "unknown" && !response.ok && response.error === "proof_throttled") return cancelled("unlock_throttled");
      const wallet = mutationResult(response);
      return wallet === "unknown" ? { kind: "outcome_unknown", agentId, action } : { kind: "unlocked", agentId, wallet };
    }
    if (options.passphrase !== undefined && (action === "create" || action === "import")) {
      // Phase 2 one passphrase: the model key's passphrase, already typed twice or verified by its unlock in this cockpit run.
      if (!isTradingWalletPassphrase(options.passphrase)) return cancelled("passphrase_policy");
      passphrase = options.passphrase;
      await options.write("The trading wallet uses the same passphrase as your model key: one passphrase unlocks both after a restart.\n");
    }
    if (action === "create") {
      // The passphrase comes first, so a weak or mismatched one never throws away a key the owner has already backed up.
      if (passphrase === undefined) {
        const chosen = await choosePassphrase();
        if (typeof chosen !== "string") return cancelled(chosen.reason);
        passphrase = chosen;
      }
      secret = (options.generateSecret ?? generateTradingWalletSecret)();
      address = tradingWalletAddress(secret);
      const phrase = `BACKED UP ${agentId}`;
      shown = true;
      await options.write([`New Solana trading wallet for ${agentId}`, `Address: ${address}`, "",
        "Secret key (base58, shown once; the Phantom/Solflare import format):", encodeTradingWalletSecret(secret), "",
        "Anyone with this secret key can move every asset in this wallet. Write it down offline now.",
        "Balchemy never stores it unencrypted and cannot recover it. This is a new hot wallet, not your main or pairing wallet.",
        "Do not fund this address yet: it is saved only when this command finishes, and verified only by a later unlock.",
        `Type exactly ${phrase} after storing it; any other answer discards this key.`, ""].join("\n"));
      const answer = await prompt.line("backup> ");
      await options.write(CLEAR_SCREEN); shown = false;
      if (answer === null || prompt.closed) return cancelled("input_closed");
      if (answer !== phrase) return cancelled("backup_not_confirmed");
      await options.write(`Backup confirmed for ${agentId}. Address: ${address} (not saved yet)\n`);
    } else {
      await options.write([`Import an existing Solana key as the trading wallet for ${agentId}`,
        "Warning: an imported key may also exist in other wallets, apps or backups. Anyone holding a copy can move this wallet's funds; Balchemy cannot detect that.",
        "Never import your main wallet or the wallet used for Hub pairing; the pairing wallet is refused.",
        "Paste the base58 secret key or a solana-keygen JSON byte array. Input is hidden and is never sent to the daemon.", ""].join("\n"));
      const text = await prompt.secret("Secret key (hidden): ");
      if (text === null || prompt.closed) return cancelled("input_closed");
      try { secret = parseTradingWalletSecret(text); }
      catch {
        throw new TerminalError({ code: "RUNTIME_ERROR", title: "Secret key not accepted",
          cause: "The input is not a 64-byte Solana secret key whose public half matches its seed.",
          fix: "Run import again and paste the full base58 export or JSON byte array. Nothing was saved.", exitCode: 2 });
      }
      address = tradingWalletAddress(secret);
      let pairing: ReturnType<NonNullable<PrivateTradingWalletCommandOptions["readPairingWallet"]>>;
      try {
        pairing = options.readPairingWallet ? options.readPairingWallet(target)
          : readPairingWallet({ directory: path.dirname(target.socketPath), localProfileId: target.localProfileId, agentId });
      } catch { return refused("state_unavailable"); }
      if (pairing?.chain === "solana" && pairing.address === address) refused("pairing_wallet");
      // Every agent's pairing wallet and trading wallet, checked by the daemon before confirmation.
      await preflight(address);
      const phrase = `IMPORT ${agentId}`;
      await options.write([`Derived address: ${address}`, `Type exactly ${phrase} to use this key as ${agentId}'s trading wallet; any other answer cancels.`, ""].join("\n"));
      const answer = await prompt.line("import> ");
      if (answer === null || prompt.closed) return cancelled("input_closed");
      if (answer !== phrase) return cancelled("import_not_confirmed");
    }
    if (!secret || !address) return unavailable();
    if (passphrase === undefined) {
      const chosen = await choosePassphrase();
      if (typeof chosen !== "string") return cancelled(chosen.reason);
      passphrase = chosen;
    }
    await options.write("Encrypting locally…\n");
    const envelope = await sealTradingWallet({ localProfileId: target.localProfileId, agentId }, secret, passphrase);
    secret.fill(0);
    const wallet = mutationResult(await exchange(request(envelope)));
    return wallet === "unknown" ? { kind: "outcome_unknown", agentId, action, address }
      : { kind: "created", agentId, origin: action === "import" ? "imported" : "generated", wallet };
  } finally { secret?.fill(0); releaseSignals(); prompt.close(); }
}

function bindingLines(agentId: string, binding: TradingWalletBindingStatus | undefined): string[] {
  if (!binding) return [];
  if (binding.state === "unbound") return ["Hub binding: not bound. The runner links it by itself once the agent is paired and the wallet is unlocked.",
    `Manual fallback: balchemy runner wallet ${agentId} bind`];
  if (binding.state === "bound") return [`Hub binding: bound since ${binding.boundAt} (binding ${binding.walletBindingId}, address ${binding.address})`];
  if (binding.state === "revoked") return [`Hub binding: revoked (observed ${binding.observedAt}, address ${binding.address}). This agent cannot be bound again.`];
  if (binding.state === "held") return ["Hub binding: held. The local binding record could not be verified and was preserved unchanged."];
  return ["Hub binding: unavailable (could not be read; not shown as unbound)."];
}
function walletLines(agentId: string, wallet: TradingWalletStatus): string[] {
  if (wallet.state === "absent") return [`Trading wallet for ${agentId}: none`, `Create one: balchemy runner wallet ${agentId} create`];
  if (wallet.state === "held") return [`Trading wallet for ${agentId}: held`,
    "The local record could not be verified and was preserved unchanged. It cannot be unlocked or replaced until reviewed.",
    `If a create was interrupted before its encrypted record was written: balchemy runner wallet ${agentId} recover`];
  const address = wallet.addressVerified ? `Address: ${wallet.address} (verified by unlock in this daemon run)`
    : `Address: ${wallet.address} (unverified until unlock; do not fund it before unlock succeeds)`;
  return [`Trading wallet for ${agentId}: ${wallet.state === "unlocked" ? "unlocked in daemon memory" : "locked"}`, address,
    ...(wallet.state === "locked" ? [`Unlock after every daemon start: balchemy runner wallet ${agentId} unlock`] : [])];
}
const CANCEL_TEXT: Partial<Record<PrivateTradingWalletCancel, string>> = {
  passphrase_policy: `the passphrase was too short or too long ${PASSPHRASE_ATTEMPTS} times`,
  shared_passphrase_rejected: "the model key's passphrase does not unlock this wallet",
  passphrase_mismatch: "the two passphrases did not match",
  unlock_throttled: "too many wrong passphrases in a row; wait a few minutes, then unlock again",
};
export function formatPrivateTradingWalletResult(result: PrivateTradingWalletCommandResult): string {
  const boundary = "A trading wallet alone never trades; live trading needs a separate arm step.";
  if (result.kind === "dry_run") return `Trading wallet ${result.action} preview for ${result.agentId}. No connection, prompt or change made.\n`;
  if (result.kind === "outcome_unknown") return [`Trading wallet ${result.action} outcome unknown for ${result.agentId}.`,
    "Nothing was retried.",
    ...(result.action === "bind" ? ["Running bind again is safe: Balchemy treats an exact re-bind of the same wallet as the same binding."] : []),
    ...(result.action === "create" || result.action === "import" ? [
      `Do not fund ${result.address ? `address ${result.address}` : "this address"} until balchemy runner wallet ${result.agentId} status shows it locked or unlocked with this exact address, then unlock it to verify.`,
      "Keep the secret key backup. Do not run create or import again until status is confirmed."] : []),
    `Read the current state before anything else: balchemy runner wallet ${result.agentId} status`, ""].join("\n");
  if (result.kind === "cancelled") return [`Trading wallet ${result.action} cancelled (${CANCEL_TEXT[result.reason] ?? result.reason.replace(/_/g, " ")}). Nothing was saved or sent.`,
    ...(result.action === "create" ? ["Wallet not created. If a key was shown, it was NOT saved; do not fund it. Run create again for a new wallet."] : []), ""].join("\n");
  const heading = result.kind === "created" ? [`Trading wallet ${result.origin === "imported" ? "imported" : "created"} and saved encrypted on this device.`]
    : result.kind === "locked" ? ["Trading wallet key cleared from daemon memory."] : result.kind === "unlocked" ? ["Trading wallet unlocked."]
      : result.kind === "recovered" ? ["Interrupted create marker removed. No encrypted wallet record was touched."]
        : result.kind === "bound" ? ["Trading wallet bound to Balchemy Hub for this agent."] : [];
  const binding = result.kind === "status" || result.kind === "bound" ? bindingLines(result.agentId, result.binding) : [];
  return [...heading, ...walletLines(result.agentId, result.wallet), ...binding, boundary, ""].join("\n");
}

/** The lock warning in `runner status`: the passphrase is never stored, so every daemon start leaves a configured trading
 * wallet locked (the owner can also lock it by hand). The stop-loss clause and the re-arm hint appear only when this runner
 * can run automatic exits at all; arming refuses without that capability, and no line ever claims a trade or exit is running. */
export const RUNNER_KEYSTORE_LOCK_NOTICE = "Bot is locked. This happens after every restart. Enter your wallet passphrase to resume.";
export const RUNNER_KEYSTORE_LOCK_STOP_LOSS_NOTICE = "Stop-losses are paused until then.";
export function formatRunnerKeystoreLock(agentId: string, options: { armed: boolean; exitsAvailable: boolean }): string {
  return [`    LOCKED: ${RUNNER_KEYSTORE_LOCK_NOTICE}${options.exitsAvailable ? ` ${RUNNER_KEYSTORE_LOCK_STOP_LOSS_NOTICE}` : ""}`,
    `    Unlock: balchemy runner wallet ${agentId} unlock`,
    ...(options.exitsAvailable && !options.armed ? [`    Then arm again: balchemy runner arm ${agentId}`] : []), ""].join("\n");
}
