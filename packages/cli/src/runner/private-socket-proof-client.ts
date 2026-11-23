/** A2a (plan section A5, amendments decision 1): the client side of the socket proof. One owner change goes through
 * `exchangeWithSocketProof`:
 * 1. the frame is sent WITHOUT the proof field (a frame that raises nothing, or a daemon that does not require it, applies as before);
 * 2. on a validated `proof_required` reply the owner's trading-wallet passphrase is asked through the caller's own hidden prompt (or the
 *    passphrase this card already holds, decision 1) and the frame is sent again with a FRESH frame id and the same operation id;
 * 3. on `wallet_locked` the wallet is unlocked with that passphrase first (keystore IPC), then the frame is sent again with it;
 * 4. `passphrase_rejected` and `proof_throttled` end with a plain message; a transport failure is never retried (the caller decides
 *    what an unknown outcome means); at most three frames are sent.
 * The typed confirmation phrase of every command stays BEFORE the first send (the callers ask it first, unchanged).
 * The passphrase is a local variable of one exchange only: it is never written, logged, stored, returned, placed in history, rows, model
 * memory, a result object or an error message, and a thrown error never carries it. */
import { TerminalError } from "../errors.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { privateTradingWalletBinding, PrivateTradingWalletTransportError, requestPrivateTradingWallet,
  type PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";
import { isTradingWalletPassphrase, parsePrivateTradingWalletRequest, validatePrivateTradingWalletReply,
  type PrivateTradingWalletRequest, type PrivateTradingWalletResponse } from "./private-trading-keystore-protocol.js";

/** The hidden prompt's label (plan section A5). */
export const SOCKET_PROOF_PROMPT = "Trading wallet passphrase (confirms this change; not stored): ";
/** Frames one exchange may send (the first one without the proof). */
export const SOCKET_PROOF_ATTEMPTS = 3;
/** A hidden prompt: null when the owner closed it (Esc, Ctrl+C, closed input). */
export type SocketProofSecret = (label: string) => Promise<string | null>;
/** The proof refusals a client ends with (everything else is the daemon's own answer, handled by the caller). */
export const SOCKET_PROOF_REFUSALS = ["proof_required", "passphrase_rejected", "proof_throttled", "wallet_locked"] as const;
export type SocketProofRefusal = typeof SOCKET_PROOF_REFUSALS[number];
/** One wallet unlock: `rejected` (wrong passphrase), `throttled` (too many wrong ones), `refused` (any other closed refusal, nothing
 * changed), `unknown` (the key may or may not be in memory now; never retried). */
export type SocketProofUnlock = "unlocked" | "rejected" | "throttled" | "refused" | "unknown";
export type SocketProofOutcome<Res> =
  /** The daemon's answer to the last frame: a success or a refusal that is not a proof refusal (the caller's own handling). */
  | { kind: "response"; response: Res }
  /** The owner closed the passphrase prompt: nothing was changed. */
  | { kind: "cancelled" }
  /** A proof refusal that ends the exchange: nothing was changed. */
  | { kind: "refused"; code: SocketProofRefusal }
  /** The wallet unlock's outcome is unknown; the change itself was not sent again. */
  | { kind: "unlock_unknown" };
export type SocketProofStop = Extract<SocketProofOutcome<unknown>, { kind: "refused" } | { kind: "unlock_unknown" }>;

export interface SocketProofExchange<Req, Res> {
  /** The frame, with the proof field only when `passphrase` is given (never `passphrase: undefined`). Each call builds a fresh frame
   * id; the operation id (where the frame has one) stays the caller's one. */
  build(passphrase: string | undefined): Req;
  /** The caller's existing exchange (transport plus reply validation against exactly this frame). A throw is passed through unchanged
   * and never retried. */
  send(request: Req): Promise<Res>;
  /** The closed error code of a refusal reply, undefined for a success. */
  error(response: Res): string | undefined;
  /** The caller's hidden prompt; null or absent: no prompt here (a lowered path), so `proof_required` ends the exchange. */
  secret?: SocketProofSecret | null;
  /** A passphrase this card already holds (one setup batch, one model or arm card): tried before any prompt; if it is rejected the owner
   * is asked once for the wallet's own. */
  known?: string;
  /** The first frame already carries the proof (`known`, or one prompt): the seal step always needs it. */
  proveFirst?: boolean;
  /** Unlocks the trading wallet (`socketProofUnlock`); absent: `wallet_locked` ends the exchange. */
  unlock?(passphrase: string): Promise<SocketProofUnlock>;
  label?: string;
  attempts?: number;
}

const PROOF_CODES: ReadonlySet<string> = new Set<string>(SOCKET_PROOF_REFUSALS);
type Obtained = { value: string; known: boolean } | "cancelled" | "none";

export async function exchangeWithSocketProof<Req, Res>(options: SocketProofExchange<Req, Res>): Promise<SocketProofOutcome<Res>> {
  const attempts = Math.max(1, Math.min(SOCKET_PROOF_ATTEMPTS, options.attempts ?? SOCKET_PROOF_ATTEMPTS));
  let knownLeft = options.known !== undefined && isTradingWalletPassphrase(options.known);
  let prompted = false;
  /** The next passphrase: the card's own first, then one prompt. A typed value is checked for shape before anything is sent. */
  const obtain = async (): Promise<Obtained> => {
    if (knownLeft) { knownLeft = false; return { value: options.known as string, known: true }; }
    if (!options.secret || prompted) return "none";
    prompted = true;
    const typed = await options.secret(options.label ?? SOCKET_PROOF_PROMPT);
    return typed === null ? "cancelled" : { value: typed, known: false };
  };
  const refused = (code: SocketProofRefusal): SocketProofOutcome<Res> => ({ kind: "refused", code });
  /** Ends on cancel or no prompt; a value that is not a passphrase at all is a rejection (nothing is sent with it). */
  const take = async (whenNone: SocketProofRefusal): Promise<{ value: string; known: boolean } | SocketProofOutcome<Res>> => {
    const next = await obtain();
    if (next === "cancelled") return { kind: "cancelled" };
    if (next === "none") return refused(whenNone);
    return isTradingWalletPassphrase(next.value) ? next : refused("passphrase_rejected");
  };
  let passphrase: string | undefined; let fromKnown = false;
  if (options.proveFirst) {
    const first = await take("proof_required");
    if ("kind" in first) return first;
    passphrase = first.value; fromKnown = first.known;
  }
  let unlocked = false; let last: SocketProofRefusal = "proof_required";
  for (let sent = 0; sent < attempts; sent++) {
    let request: Req;
    // A build failure never carries the frame (or its passphrase) into the error.
    try { request = options.build(passphrase); } catch { throw new Error("Invalid local owner request"); }
    const response = await options.send(request);
    const code = options.error(response);
    if (code === undefined || !PROOF_CODES.has(code)) return { kind: "response", response };
    last = code as SocketProofRefusal;
    if (code === "proof_throttled") return refused("proof_throttled");
    if (code === "proof_required") {
      // The daemon refused a frame that carried a proof: never loop on it.
      if (passphrase !== undefined) return refused("proof_required");
      const next = await take("proof_required");
      if ("kind" in next) return next;
      passphrase = next.value; fromKnown = next.known; continue;
    }
    if (code === "passphrase_rejected") {
      // The card's own passphrase (the model key's, by default the same) was not the wallet's: the owner types the wallet's once.
      if (!fromKnown) return refused("passphrase_rejected");
      const next = await take("passphrase_rejected");
      if ("kind" in next) return next;
      passphrase = next.value; fromKnown = false; continue;
    }
    // wallet_locked: unlock with this passphrase, then send again with it (once).
    if (unlocked || !options.unlock) return refused("wallet_locked");
    if (passphrase === undefined) {
      const next = await take("wallet_locked");
      if ("kind" in next) return next;
      passphrase = next.value; fromKnown = next.known;
    }
    for (;;) {
      const result = await options.unlock(passphrase);
      if (result === "unlocked") break;
      if (result === "unknown") return { kind: "unlock_unknown" };
      if (result === "throttled") return refused("proof_throttled");
      if (result === "refused") return refused("wallet_locked");
      if (!fromKnown) return refused("passphrase_rejected");
      const next = await take("passphrase_rejected");
      if ("kind" in next) return next;
      passphrase = next.value; fromKnown = false;
    }
    unlocked = true;
  }
  return refused(last);
}

/** The keystore unlock of one exchange (the precedent of private-arming-ui.ts resumeUnlock): a lost or invalid reply, `state_unavailable`,
 * `cancelled` or `write_outcome_unknown` is unknown and never retried; a connection that never opened is a plain refusal. */
export function socketProofUnlock(target: PrivateBrainTarget, transport: PrivateTradingWalletTransport = requestPrivateTradingWallet): (passphrase: string) => Promise<SocketProofUnlock> {
  return async (passphrase) => {
    let request: PrivateTradingWalletRequest;
    try { request = parsePrivateTradingWalletRequest({ ...privateTradingWalletBinding(target), action: "unlock", passphrase }); }
    catch { return "rejected"; }
    let response: PrivateTradingWalletResponse;
    try { response = validatePrivateTradingWalletReply(request, await transport(target.socketPath, request)); }
    catch (error: unknown) { return error instanceof PrivateTradingWalletTransportError && error.code === "connection_unavailable" ? "refused" : "unknown"; }
    if (response.ok) return response.wallet.state === "unlocked" ? "unlocked" : "unknown";
    if (response.error === "unlock_failed") return "rejected";
    if (response.error === "proof_throttled") return "throttled";
    if (response.error === "state_unavailable" || response.error === "cancelled" || response.error === "write_outcome_unknown") return "unknown";
    return "refused";
  };
}

/** Plain owner text of an exchange that ended on a proof refusal (`<agent>` replaced by the caller's agent). */
export function socketProofText(stop: SocketProofStop, agentId = "<agent>"): string {
  if (stop.kind === "unlock_unknown") return `The trading wallet unlock could not be confirmed, so this change was not sent. Nothing was changed. Check: balchemy runner wallet ${agentId} status, then try again.`;
  switch (stop.code) {
    case "proof_required": return "This change needs your trading wallet passphrase, and it was not asked here. Nothing was changed. Make the change from its own card or command: it asks for the passphrase.";
    case "passphrase_rejected": return "Wrong trading wallet passphrase. Nothing was changed.";
    case "proof_throttled": return "Too many wrong passphrases in a row. Nothing was changed. Wait a few minutes, then try again.";
    case "wallet_locked": return `The trading wallet is locked and was not unlocked here, so this change cannot be confirmed. Nothing was changed. Unlock it (balchemy runner wallet ${agentId} unlock), then try again.`;
  }
}
/** The CLI commands' refusal of a proof that ended the exchange (nothing was changed; never an unknown outcome). */
export function socketProofFailure(stop: SocketProofStop, agentId: string, title: string): never {
  throw new TerminalError({ code: "RUNTIME_ERROR", title, cause: socketProofText(stop, agentId),
    fix: stop.kind === "refused" && stop.code === "proof_throttled" ? "Nothing was retried. Try again in a few minutes."
      : "Nothing was retried. Read the current state before another change.", exitCode: 1 });
}

/** A hidden prompt on the real terminal for a command that has none of its own (runner limits, runner signals, and the readline-based
 * rule and sizing commands once their typed confirmation is answered). Raw mode, nothing echoed or kept in history. Null when the
 * command does not run in an interactive terminal: `proof_required` then ends with its plain text. */
export function terminalSocketProofSecret(interactive: boolean, before?: () => void): SocketProofSecret | null {
  if (!interactive) return null;
  return async (label) => {
    // The command's own readline owner (if any) is closed first: exactly one input owner at a time.
    before?.();
    const { createWalletPrompt, guardTerminalSignals } = await import("./private-trading-keystore-ui.js");
    const prompt = createWalletPrompt();
    const release = guardTerminalSignals(() => prompt.close());
    try { return await prompt.secret(label); } finally { release(); prompt.close(); }
  };
}
