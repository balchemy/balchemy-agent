/** `balchemy runner rpc <agent> status | set`: the runner's own Solana RPC endpoint. `set` reads the URL
 * (often carrying a provider key) at a hidden terminal prompt, never from argv, so it stays out of shell
 * history and the process list. It is shown back only as its host; a public endpoint is labelled
 * shadow-only. This never grants authority. */
import { randomUUID } from "node:crypto";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { operationConfirmation } from "./private-rule-commands.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { createWalletPrompt, guardTerminalSignals, type WalletPrompt } from "./private-trading-keystore-ui.js";
import { parsePrivateSolanaRpcEndpoint, type PrivateSolanaRpcEndpoint } from "./private-solana-rpc.js";
import type { PrivateSolanaRpcStatus } from "./private-solana-rpc-settings.js";
import type { PrivateBalchemyRpcStatus } from "./private-balchemy-rpc.js";
import { parsePrivateSolanaRpcRequest, privateSolanaRpcBinding, requestPrivateSolanaRpc, validatePrivateSolanaRpcReply,
  type PrivateSolanaRpcChannelError, type PrivateSolanaRpcData, type PrivateSolanaRpcRequest, type PrivateSolanaRpcResponse,
  type PrivateSolanaRpcTransport } from "./private-solana-rpc-protocol.js";
import { exchangeWithSocketProof, socketProofFailure, socketProofUnlock, type SocketProofOutcome, type SocketProofSecret } from "./private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";

export interface RpcPrompt extends Pick<WalletPrompt, "closed" | "secret" | "close"> {
  /** Visible line; true only for exactly `phrase`. */
  confirm(phrase: string, alternates?: readonly string[]): Promise<boolean>;
}
export interface PrivateSolanaRpcCommandOptions {
  args: string[]; directory: string; interactive: boolean;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  write(text: string): void | Promise<void>;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateSolanaRpcTransport;
  createPrompt?(): RpcPrompt;
  /** Restores the terminal (raw mode) on SIGINT/SIGTERM/SIGHUP; returns an unsubscribe. */
  guardSignals?(cleanup: () => void): () => void;
  /** A2a socket proof (an RPC set is always raising), asked only on `proof_required` after the typed CONFIRM. Undefined: the prompt's
   * own hidden field; null: no prompt here. */
  proofSecret?: SocketProofSecret | null;
  walletTransport?: PrivateTradingWalletTransport;
}
/** Display-safe command: the URL itself is held apart and never returned or printed. */
export type RpcCommand = { agentId: string; action: "status" | "set" };
export type PrivateSolanaRpcCommandResult = PrivateSolanaRpcData | { kind: "cancelled" }
  | { kind: "dry_run"; command: RpcCommand } | { kind: "outcome_unknown"; operationId: string };

function invalid(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid local RPC command",
    cause: "Use runner rpc <agent> status, or runner rpc <agent> set and paste the URL at the hidden prompt. A URL argument is refused.",
    fix: "Run set without a URL so it stays out of shell history and the process list. --yes, --force and --quiet are not supported. The URL is never echoed.",
    exitCode: 2 });
}
function invalidEndpoint(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid local RPC endpoint",
    cause: "Only https is accepted; plain http only for a numeric loopback address. user:password@ and #fragment are refused.",
    fix: "Run set again and paste a valid endpoint. No update was sent and the URL is never echoed.", exitCode: 2 });
}
export function parsePrivateSolanaRpcArguments(args: string[]): { command: RpcCommand } {
  const [agentId, action] = args; if (!isId(agentId)) invalid();
  if (args.length === 1 || (args.length === 2 && action === "status")) return { command: Object.freeze({ agentId, action: "status" }) };
  if (args.length !== 2 || action !== "set") invalid();
  return { command: Object.freeze({ agentId, action: "set" }) };
}
function createRpcPrompt(): RpcPrompt {
  const prompt = createWalletPrompt();
  return { get closed() { return prompt.closed; }, secret: (label) => prompt.secret(label),
    confirm: async (phrase, alternates = []) => { const typed = await prompt.line("approval> "); return typed === phrase || (typed !== null && alternates.includes(typed)); },
    close: () => prompt.close() };
}
function unavailable(): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Local RPC setting unavailable",
    cause: "The selected runner could not return a validated RPC setting.",
    fix: "Inspect runner status and read the RPC setting again. No update was sent.", exitCode: 1 });
}
/** Owner text of `positions_open` (owner decision of 17 Nov 2026). */
export const PRIVATE_SOLANA_RPC_POSITIONS_OPEN_TEXT = "This agent is armed and has an open or unsettled trade, so its RPC was not changed: "
  + "another endpoint could leave the position without its stop-loss. Nothing was changed and the agent stays armed.";
function refused(code: PrivateSolanaRpcChannelError, operationId?: string, agentId = "<agent>"): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title: "Local RPC setting not saved",
    cause: code === "revision_conflict" ? "The RPC setting changed during this review."
      : code === "positions_open" ? PRIVATE_SOLANA_RPC_POSITIONS_OPEN_TEXT : `The local runner returned ${code}.`,
    fix: code === "positions_open" ? `Change the RPC after the positions are closed (balchemy runner positions ${agentId}), or disarm first `
      + `if you accept that exits stop until you arm again: balchemy runner disarm ${agentId}.`
      : "Read the current RPC setting before starting another review. Do not reset private state or resend an unknown update.",
    operationId, exitCode: ["invalid_request", "unknown_agent", "profile_conflict", "instance_conflict", "revision_conflict", "operation_conflict"].includes(code) ? 2 : 1 });
}
function classLine(value: PrivateSolanaRpcEndpoint["class"]): string {
  return value === "public_shadow_only" ? "Class: public endpoint - shadow observation only; Balchemy's connection is used instead when it is ready."
    : "Class: owner-configured endpoint (used instead of Balchemy's connection, single source).";
}
/** Owner text of `rpc_sources_disagree`: two Balchemy-provided sources answered differently. */
export const PRIVATE_RPC_SOURCES_DISAGREE_TEXT = "The two Balchemy-provided RPC sources disagreed (rpc_sources_disagree), so that step was stopped "
  + "and will be retried. New buys need both sources to agree; a sell goes ahead on one source only when the other does not answer.";
const PROVIDED_REASON_TEXT: Readonly<Record<string, string>> = {
  lease_unavailable: "waiting for this agent's Hub connection (start the runner and link the agent).",
  grant_pending: "being set up.",
  access_unavailable: "not offered by Balchemy right now; it is retried automatically every few minutes.",
  rate_limited: "temporarily rate limited; retrying.",
  request_failed: "could not be fetched; retrying.",
  grant_refused: "refused by this runner (a provider outside its fixed allow-list); retried automatically.",
  source_unavailable: "connected, but one provider is not answering right now (new buys wait; sells may go ahead on the other).",
  rpc_sources_disagree: PRIVATE_RPC_SOURCES_DISAGREE_TEXT,
  wrong_network: "refused by this runner: a provider endpoint is not on Solana mainnet (wrong_network); retried automatically.",
  rpc_source_lag_accepted: "one provider showed a finalized trade that landed while the other still had no record of it after repeated checks, "
    + "so the runner opened that position's stop-loss and take-profit on the one that showed it (rpc_source_lag_accepted; position openings only, never a sell or a new buy).",
};
/** The Balchemy-provided connection, display-safe: provider names and closed reasons only. */
export function privateBalchemyRpcLines(provided: PrivateBalchemyRpcStatus | undefined): string[] {
  if (!provided) return [];
  const head = provided.state === "ready" ? `Balchemy-provided connection: ready (${provided.providers.join(" and ")}, checked against each other).`
    : provided.state === "waiting" ? "Balchemy-provided connection: being set up." : "Balchemy-provided connection: unavailable.";
  const reason = provided.reason ? PROVIDED_REASON_TEXT[provided.reason] : undefined;
  return [head, ...(reason && provided.reason !== "grant_pending" ? [`  Note: ${reason}`] : [])];
}
export async function runPrivateSolanaRpcCommand(options: PrivateSolanaRpcCommandOptions): Promise<PrivateSolanaRpcCommandResult> {
  const { command } = parsePrivateSolanaRpcArguments(options.args);
  if (options.flags.yes || options.flags.force || options.flags.quiet) invalid();
  if (options.flags.dryRun) return { kind: "dry_run", command };
  if (command.action === "set" && (!options.interactive || options.flags.json || options.flags.ci)) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive RPC confirmation required",
      cause: "A visible terminal and exact owner confirmation are required to save a local RPC endpoint.",
      fix: "Run without --json or --ci in a terminal. Read-only runner rpc status supports JSON and non-interactive use.", exitCode: 2 });
  }
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(command.agentId)
    : readPrivateBrainTarget(options.directory, command.agentId)) }); }
  catch { throw runnerNotRunningError(command.agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== command.agentId) invalid();
  const transport = options.transport ?? requestPrivateSolanaRpc;
  let prompt: RpcPrompt | undefined; let releaseSignals: (() => void) | undefined;
  try {
    if (command.action === "set") {
      const opened = (options.createPrompt ?? createRpcPrompt)(); prompt = opened;
      releaseSignals = (options.guardSignals ?? guardTerminalSignals)(() => opened.close());
    }
    const read = parsePrivateSolanaRpcRequest({ ...privateSolanaRpcBinding(target), action: "status" });
    let response: PrivateSolanaRpcResponse;
    try { response = validatePrivateSolanaRpcReply(read, await transport(target.socketPath, read)); } catch { return unavailable(); }
    if (!response.ok) return refused(response.error);
    if (response.data.kind !== "status") return unavailable();
    if (command.action === "status") return response.data;
    if (!prompt || prompt.closed) return { kind: "cancelled" };
    await options.write([`Local Solana RPC endpoint for ${command.agentId}`,
      "Optional, advanced: Balchemy already provides the Solana connection (two independent providers). Your own endpoint replaces it for this agent (one source).",
      "Paste the endpoint URL. Input is hidden; it is never displayed, logged or sent to Balchemy. Ctrl+C cancels.", ""].join("\n"));
    if (prompt.closed) return { kind: "cancelled" };
    const entered = await prompt.secret("RPC URL (hidden): ");
    if (entered === null || prompt.closed) return { kind: "cancelled" };
    let endpoint: PrivateSolanaRpcEndpoint;
    // The hidden prompt stops accepting input at 1024 bytes; a value at that cap may be truncated, so it is refused.
    if (Buffer.byteLength(entered, "utf8") >= 1024) invalidEndpoint();
    try { endpoint = parsePrivateSolanaRpcEndpoint(entered.trim()); } catch { return invalidEndpoint(); }
    const current = response.data.status.endpoint; const operationId = randomUUID(); const expectedRevision = current?.revision ?? 0;
    // A2a: one operation id for every frame; the proof is added only on proof_required (a fresh frame id each time). The URL never
    // enters a result or an error.
    const build = (passphrase?: string): PrivateSolanaRpcRequest => parsePrivateSolanaRpcRequest({ ...privateSolanaRpcBinding(target), action: "set",
      operationId, expectedRevision, url: endpoint.url, ...(passphrase !== undefined ? { passphrase } : {}) });
    const update = build();
    const { phrase, alternates } = operationConfirmation(operationId);
    await options.write([`Review local Solana RPC endpoint for ${command.agentId}`, `Host: ${endpoint.host}`,
      `Transport: ${endpoint.transport === "https" ? "https" : "http (numeric loopback only)"}`, classLine(endpoint.class),
      `Endpoint revision: ${expectedRevision} -> ${expectedRevision + 1}`, `Current host: ${current?.host ?? "none configured"}`,
      "The full URL stays in this runner's private directory; it is never displayed or sent to Balchemy.",
      "Configuration only. No execution, signing or live permission is granted.", `RPC operation: ${operationId}`,
      `Read the current setting after interruption: balchemy runner rpc ${command.agentId} status`,
      `Type exactly ${phrase} to save; any other answer cancels.`, ""].join("\n"));
    if (prompt.closed || !await prompt.confirm(phrase, alternates) || prompt.closed) return { kind: "cancelled" };
    const opened = prompt;
    let outcome: SocketProofOutcome<PrivateSolanaRpcResponse>;
    try {
      outcome = await exchangeWithSocketProof({ build: (passphrase) => (passphrase === undefined ? update : build(passphrase)),
        send: async (request) => validatePrivateSolanaRpcReply(request, await transport(target.socketPath, request)),
        error: (reply) => (reply.ok ? undefined : reply.error),
        secret: options.proofSecret !== undefined ? options.proofSecret : (label) => opened.secret(label), unlock: socketProofUnlock(target, options.walletTransport) });
    } catch { return { kind: "outcome_unknown", operationId }; }
    if (outcome.kind === "cancelled") return { kind: "cancelled" };
    if (outcome.kind !== "response") return socketProofFailure(outcome, command.agentId, "Local RPC setting not saved");
    response = outcome.response;
    if (!response.ok) {
      if (["state_unavailable", "closing", "busy"].includes(response.error)) return { kind: "outcome_unknown", operationId };
      return refused(response.error, operationId, command.agentId);
    }
    return response.data;
  } finally { prompt?.close(); releaseSignals?.(); }
}
function statusLines(status: PrivateSolanaRpcStatus, provided?: PrivateBalchemyRpcStatus): string[] {
  const endpoint = status.endpoint;
  const balchemy = privateBalchemyRpcLines(provided);
  const intro = "Balchemy provides the Solana connection (two independent providers); your own RPC is an optional advanced setting.";
  if (!endpoint) return [intro, ...balchemy, "Own RPC: not configured (optional: balchemy runner rpc <agent> set)."];
  if (endpoint.class !== "owner_configured") return [intro, ...balchemy, `Own RPC host: ${endpoint.host}`, classLine(endpoint.class), `Endpoint revision: ${endpoint.revision}`];
  return [`Host: ${endpoint.host}`, `Transport: ${endpoint.transport === "https" ? "https" : "http (numeric loopback only)"}`,
    classLine(endpoint.class), `Endpoint revision: ${endpoint.revision}`];
}
export function formatPrivateSolanaRpcResult(result: PrivateSolanaRpcCommandResult, agentId: string): string {
  if (result.kind === "cancelled") return "RPC setting cancelled. No update was sent; the daemon remains running.\n";
  if (result.kind === "dry_run") return result.command.action === "status" ? "Read-only RPC preview; no connection or changes made.\n"
    : "RPC set preview: the endpoint URL would be read at a hidden prompt.\nNo connection, prompt, confirmation or change made.\n";
  if (result.kind === "outcome_unknown") return ["RPC setting outcome unknown.", `Operation: ${result.operationId}`,
    "No update was retried.", `Read the current setting: balchemy runner rpc ${agentId} status`, ""].join("\n");
  return [`Local Solana RPC for ${agentId}`, ...(result.kind === "set" ? ["RPC endpoint saved.", `Operation: ${result.operationId}`,
    `If this agent was armed, this change disarmed it first (it had no open trade); review and re-arm with balchemy runner arm ${agentId}.`] : []),
    ...statusLines(result.status, result.kind === "status" ? result.provided : undefined),
    "An RPC setting does not grant execution, signing or live permission.", ""].join("\n");
}
