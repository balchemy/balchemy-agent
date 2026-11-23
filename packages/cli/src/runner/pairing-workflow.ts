import { createHash } from "node:crypto";
import {
  AgentSdkError, RunnerPairingClient, type RunnerPairingChallenge, type RunnerPairingReceipt,
} from "@balchemyai/agent-sdk";
import { TerminalError } from "../errors.js";
import { inspectLocalRunner } from "./lifecycle.js";
import { readLocalProfile } from "./metadata.js";
import { isId } from "./protocol.js";
import { runnerKeyFingerprint } from "./runner-key-fingerprint.js";
import {
  beginPairingIdentity, readPairingIdentity, readPairingApproval, readPairingAdoption,
  signPairingReadProof, signPairingIntentReadProof, approvePairingIdentity, adoptPairingIdentity, checkPairingWalletSeparation,
  PairingIdentityError, type PairingIdentityOptions,
} from "./pairing-identity.js";

export interface PairingPreview {
  localAgentId: string;
  site: string;
  ownerId: string;
  agentId: string;
  walletChain: "solana" | "base";
  walletAddress: string;
  runnerFingerprint: string;
  challengeId: string;
  bindingDigest: string;
  expiresAt: string;
}
/** The typed owner approval of a pairing preview: exactly `PAIR` and the first 8 characters of the Challenge ID (or the
 * whole ID). A shorter, longer or different prefix, other casing or anything else cancels. */
export function pairingConfirmationPhrase(challengeId: string): string { return `PAIR ${challengeId.slice(0, 8)}`; }
export function isPairingConfirmation(answer: string, challengeId: string): boolean {
  const typed = answer.trim();
  return challengeId.length > 0 && (typed === pairingConfirmationPhrase(challengeId) || typed === `PAIR ${challengeId}`);
}
/** The approval screen of a pairing preview. Only validated public binding fields enter it; the exact wallet stays visible
 * because this is a deliberate ownership decision (the generic log redactor would hide it). */
export function pairingApprovalDetails(preview: PairingPreview): string {
  return ["Pair this local agent?", `Local agent: ${preview.localAgentId}`, `Site: ${preview.site}`,
    `Owner account: ${preview.ownerId}`, `Server agent: ${preview.agentId}`,
    `Wallet (${preview.walletChain}): ${preview.walletAddress}`, `Runner fingerprint: ${preview.runnerFingerprint.match(/.{1,8}/g)?.join(" ")}`,
    `Binding: ${preview.bindingDigest}`, `Expires: ${preview.expiresAt}`,
    `Challenge ID: ${preview.challengeId}`,
    "This verifies identity only; it grants no trading.",
    `Type ${pairingConfirmationPhrase(preview.challengeId)} (PAIR and the first 8 characters of the Challenge ID) to approve; anything else cancels.`].join("\n");
}
export type PairingCommandResult =
  | { state: "preview"; action: "begin" | "approve" | "confirm"; execution: "unavailable" }
  | { state: "awaiting_browser"; url: string; runnerFingerprint: string; execution: "unavailable" }
  | { state: "cancelled"; execution: "unavailable" }
  | { state: "awaiting_wallet"; proof: { version: 1; challengeId: string; bindingDigest: string; runnerSignature: string }; execution: "unavailable" }
  | { state: "paired"; agentId: string; pairedAt: string; execution: "unavailable" };
interface PairingCommandOptions {
  directory: string;
  frontendOrigin: string;
  args: string[];
  dryRun: boolean;
  approve: (preview: PairingPreview) => Promise<boolean>;
  fetchFn?: typeof fetch;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function failure(kind: "arguments" | "state" | "network" | "verification" | "trading_wallet" | "refused"): TerminalError {
  if (kind === "refused") {
    return new TerminalError({ code: "RUNTIME_ERROR", title: "Pairing refused",
      cause: "Balchemy keeps refusing this runner's pairing requests (for example a wrong site, or an account the runner cannot pair with).",
      fix: "Nothing was approved or linked. Check the site address and your Hub account, then pair again; the step-by-step commands also work: balchemy runner pair <agent>.",
      commandSuggestion: "balchemy runner status --json", retryable: false, exitCode: 1 });
  }
  if (kind === "trading_wallet") {
    return new TerminalError({ code: "RUNTIME_ERROR", title: "Pairing wallet refused",
      cause: "This wallet is a local agent's trading wallet on this device. Pairing proves the owner wallet; it never uses a trading hot wallet.",
      fix: "Choose your owner wallet in Hub and start a new pairing request. Nothing was approved or signed by this runner.",
      commandSuggestion: "balchemy runner status --json", retryable: false, exitCode: 2 });
  }
  return new TerminalError({
    code: "RUNTIME_ERROR",
    title: kind === "arguments" ? "Invalid pairing command" : "Pairing is not confirmed",
    cause: kind === "arguments" ? "Use runner pair <local-agent-id> [challenge-id|confirm]."
      : kind === "state" ? "The local agent identity or its durable pairing record is unavailable."
      : kind === "network" ? "Could not reach Balchemy, or its pairing reply could not be verified."
      : "The pairing response does not match the locally approved owner, wallet, agent and site.",
    fix: kind === "arguments" ? "Start your local agent first, then use the pairing link from this CLI."
      : kind === "state" ? "Preserve local files. Start the named agent if it has not been created. Do not delete or regenerate an existing pairing identity."
      : kind === "network" ? "Check your internet connection and run the same command again; nothing was changed. An expired request needs a new browser "
        + "challenge; a pairing already confirmed in the browser is finished with: balchemy runner pair <agent> confirm."
      : "Check the browser pairing status. An expired request needs a new browser challenge; a committed pairing can be recovered with confirm. Never paste an owner token or private key.",
    commandSuggestion: "balchemy runner status --json", retryable: false, exitCode: kind === "arguments" ? 2 : 1,
  });
}
function origin(input: string): string {
  try {
    const value = new URL(input);
    if (value.username || value.password || value.hash || value.search || value.pathname !== "/"
      || (value.protocol !== "https:" && !(value.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname)))) throw failure("arguments");
    return value.origin;
  } catch { throw failure("arguments"); }
}
/** The same derivation the A2a seal card shows (runner-key-fingerprint.ts), so the owner compares one value everywhere. */
const fingerprint = runnerKeyFingerprint;
function preview(localAgentId: string, site: string, challenge: RunnerPairingChallenge): PairingPreview {
  return { localAgentId, site, ownerId: challenge.binding.ownerUserId, agentId: challenge.agentId,
    walletChain: challenge.walletChain, walletAddress: challenge.binding.walletAddress,
    runnerFingerprint: fingerprint(challenge.binding.runnerPublicKey), challengeId: challenge.challengeId,
    bindingDigest: challenge.bindingDigest, expiresAt: challenge.expiresAt };
}

/** The CLI's only handoff is public identity plus fixed-purpose proof, never an owner session. */
export async function runPairingCommand(input: PairingCommandOptions): Promise<PairingCommandResult> {
  const [agentId, argument] = input.args;
  if (!agentId || !isId(agentId) || input.args.length > 2 || (argument !== undefined && argument !== "confirm" && !UUID.test(argument))) throw failure("arguments");
  const site = origin(input.frontendOrigin);
  const action = argument === undefined ? "begin" : argument === "confirm" ? "confirm" : "approve";
  if (input.dryRun) return { state: "preview", action, execution: "unavailable" };
  try {
    const profile = readLocalProfile(input.directory);
    if (!profile) throw failure("state");
    const options: PairingIdentityOptions = { directory: input.directory, localProfileId: profile.localProfileId, agentId };
    const existing = readPairingAdoption(options);
    if (existing && existing.frontendOrigin !== site) throw failure("verification");
    if (existing) return { state: "paired", agentId: existing.agentId, pairedAt: existing.pairedAt, execution: "unavailable" };
    if (action === "begin") {
      const runner = await inspectLocalRunner(input.directory, agentId);
      if (runner.process !== "running" || !runner.agents.some((agent) => agent.agentId === agentId)) throw failure("state");
      const descriptor = beginPairingIdentity(options);
      const fragment = new URLSearchParams({ runnerPublicKey: descriptor.runnerPublicKey, localIntentNonce: descriptor.localIntentNonce });
      return { state: "awaiting_browser", url: `${site}/hub/agents/pair#${fragment.toString()}`,
        runnerFingerprint: fingerprint(descriptor.runnerPublicKey), execution: "unavailable" };
    }
    const descriptor = readPairingIdentity(options);
    if (!descriptor) throw failure("state");
    const client = new RunnerPairingClient({ frontendOrigin: site, apiBaseUrl: `${site}/api`,
      runnerPublicKey: descriptor.runnerPublicKey, localIntentNonce: descriptor.localIntentNonce, fetchFn: input.fetchFn });
    if (action === "confirm") {
      const approved = readPairingApproval(options);
      if (!approved || approved.frontendOrigin !== site) throw failure("state");
      const nonce = await client.requestReadNonce(approved.challengeId, "receipt");
      const signature = signPairingReadProof(options, { frontendOrigin: site, nonce });
      const receipt = await client.read(nonce, signature, approved.bindingDigest);
      if (receipt.resource !== "receipt") throw failure("verification");
      const adopted = adoptPairingIdentity(options, { frontendOrigin: site, receipt });
      return { state: "paired", agentId: adopted.agentId, pairedAt: adopted.pairedAt, execution: "unavailable" };
    }
    const nonce = await client.requestReadNonce(argument!, "challenge");
    const signature = signPairingReadProof(options, { frontendOrigin: site, nonce });
    const challenge = await client.read(nonce, signature);
    if (challenge.resource !== "challenge") throw failure("verification");
    // Refuse a local trading wallet before showing any approval prompt.
    checkPairingWalletSeparation(options, { chain: challenge.binding.walletChain, address: challenge.binding.walletAddress });
    if (!await input.approve(preview(agentId, site, challenge))) return { state: "cancelled", execution: "unavailable" };
    // The helper independently revalidates and durably pins this exact binding
    // before returning the single-purpose signature for browser confirmation.
    const proof = approvePairingIdentity(options, { frontendOrigin: site, challenge, approvedBindingDigest: challenge.bindingDigest });
    return { state: "awaiting_wallet", proof, execution: "unavailable" };
  } catch (error: unknown) {
    if (error instanceof TerminalError) throw error;
    if (error instanceof PairingIdentityError) throw failure(error.code === "trading_wallet" ? "trading_wallet" : "state");
    if (error instanceof AgentSdkError && error.code === "network_error") throw failure("network");
    throw failure("verification");
  }
}

/**
 * One-step pairing (cockpit phase 1). The owner never types a Challenge ID into the CLI or pastes JSON into Hub:
 * 1. the CLI opens the pairing page; the owner signs in and picks the identity wallet;
 * 2. the runner finds that page's challenge through its own signed intent read;
 * 3. the card shows owner, site, wallet and fingerprint, and the owner types `PAIR` plus the 8 characters shown on the
 *    page (never shown here): that is what ties the owner's own browser tab to this CLI;
 * 4. the runner's response goes to the page through the server. The CLI then shows a response code that the owner types
 *    on the page before signing: that ties the page back to this CLI, so a link that carries someone else's runner key
 *    cannot get that runner paired just by the owner signing on the page; the owner signs with the wallet there;
 * 5. the CLI reads the receipt and adopts it; no `confirm` command.
 * Server-side `confirm` verification is unchanged. The manual commands keep working as the fallback.
 */
export interface AutoPairingCard {
  localAgentId: string;
  site: string;
  ownerId: string;
  agentId: string;
  walletChain: "solana" | "base";
  walletAddress: string;
  runnerFingerprint: string;
  expiresAt: string;
}
export type AutoPairingEvent =
  | { type: "link"; url: string; runnerFingerprint: string }
  | { type: "browser_failed" }
  | { type: "waiting_for_page" }
  | { type: "code_mismatch"; attemptsLeft: number }
  | { type: "challenge_expired" }
  /** Show `responseCode`: the owner types it on the Hub page before signing. It is derived from the public runner response. */
  | { type: "response_sent"; responseCode: string }
  | { type: "waiting_for_wallet" }
  | { type: "retrying"; reason: "network" | "rate_limited" | "unavailable" };
export type AutoPairingResult =
  | { state: "paired"; agentId: string; pairedAt: string; execution: "unavailable" }
  | { state: "cancelled"; execution: "unavailable" }
  | { state: "timed_out"; execution: "unavailable" }
  /**
   * The site does not offer the one-step relay (404, 405, 410 or 501 on its routes): use `runner pair <agent>` and
   * `<challenge-id>`. Partial deploys:
   * - backend without the new Hub page: the runner still finds the challenge, and the owner can type `PAIR` plus the
   *   first 8 characters of the Challenge ID that the old page shows. But the old page neither loads the relayed response
   *   nor asks for the CLI code; it asks for a pasted runner JSON that this flow does not print, so the owner must finish
   *   with the step-by-step commands. Backend and Hub page therefore ship together.
   * - Hub page without the backend: the page keeps its paste field (its relay read just keeps waiting) and this flow
   *   answers `unsupported` at once.
   */
  | { state: "unsupported"; execution: "unavailable" };
export interface AutoPairingOptions {
  directory: string;
  frontendOrigin: string;
  agentId: string;
  /** Open the pairing link in the browser. A failure is reported as `browser_failed`; the `link` event carries the URL. */
  openUrl: (url: string) => void | Promise<void>;
  /** Show the card and return exactly what the owner typed, or null to stop. The workflow checks the phrase. */
  confirm: (card: AutoPairingCard) => Promise<string | null>;
  onProgress?: (event: AutoPairingEvent) => void | Promise<void>;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** Each poll is a nonce and a read against a 30-per-minute route limit; never below 3 s. Default 4 s. */
  pollIntervalMs?: number;
  /** Default 15 minutes: enough for sign-in, a renewed 5-minute challenge and the wallet signature. */
  timeoutMs?: number;
  /** Test seam; defaults to an abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const MAX_CODE_ATTEMPTS = 3;
/** Consecutive 401s (an account operation in flight is transient) before a refusal is treated as final: about 2 minutes. */
const MAX_CONSECUTIVE_REFUSALS = 30;
/** Statuses that mean the relay routes do not exist on this site. */
const UNSUPPORTED_STATUSES = new Set([404, 405, 410, 501]);

/**
 * The one-step card's approval: `PAIR` and the page's 8-character code (or the whole Challenge ID). Letter case and spacing
 * do not matter: the code is lowercase hex, the page shows it that way, and a casing slip must not cost one of the three
 * attempts. The step-by-step card keeps its exact phrase (`isPairingConfirmation`).
 */
export function isAutoPairingConfirmation(answer: string, challengeId: string): boolean {
  const match = /^pair\s+([0-9a-f-]+)$/i.exec(answer.trim());
  if (!match || !UUID.test(challengeId)) return false;
  const code = match[1]!.toLowerCase();
  return code === challengeId.slice(0, 8) || code === challengeId;
}
const RESPONSE_CODE_PURPOSE = "balchemy.local-agent.pairing-response-code.v1";

/** The 8 characters the owner types on the Hub page (the page derives the same from the relayed response). */
export function pairingResponseCode(runnerSignature: string): string {
  return createHash("sha256").update(`${RESPONSE_CODE_PURPOSE}:${runnerSignature}`, "utf8").digest("hex").slice(0, 8);
}

/** The card the cockpit renders. The code is deliberately absent: the owner reads it from their own Hub page. */
export function autoPairingCardDetails(card: AutoPairingCard): string {
  return ["Pair this local agent?", `Local agent: ${card.localAgentId}`, `Site: ${card.site}`,
    `Owner account: ${card.ownerId}`, `Server agent: ${card.agentId}`,
    `Wallet (${card.walletChain}): ${card.walletAddress}`, `Runner fingerprint: ${card.runnerFingerprint.match(/.{1,8}/g)?.join(" ")}`,
    `Expires: ${card.expiresAt}`,
    "Check that this wallet is yours and that your own Hub pairing page shows the same wallet and fingerprint.",
    "If your page shows an error instead of a code, another sign-in opened your link first: type nothing. This local agent cannot be paired while that sign-in holds the link; pair a new local agent instead.",
    "This verifies identity only; it grants no trading.",
    "Type PAIR and the 8-character code shown on your Hub pairing page to approve; anything else cancels."].join("\n");
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
function sdkStatus(error: unknown): number | undefined {
  return error instanceof AgentSdkError && typeof error.status === "number" ? error.status : undefined;
}
/** A runner read of a receipt or challenge that does not exist (yet, or any more) is a plain 401. */
function notThere(error: unknown): boolean { return error instanceof AgentSdkError && error.code === "provider_auth_error"; }

export async function runAutoPairing(input: AutoPairingOptions): Promise<AutoPairingResult> {
  if (!input || !isId(input.agentId) || typeof input.openUrl !== "function" || typeof input.confirm !== "function") throw failure("arguments");
  const site = origin(input.frontendOrigin);
  const interval = Math.max(3_000, input.pollIntervalMs ?? 4_000);
  const deadline = Date.now() + Math.max(interval, input.timeoutMs ?? 15 * 60_000);
  const sleep = input.sleep ?? abortableSleep;
  const emit = async (event: AutoPairingEvent) => { await input.onProgress?.(event); };
  const unavailable = { execution: "unavailable" as const };
  try {
    const profile = readLocalProfile(input.directory);
    if (!profile) throw failure("state");
    const options: PairingIdentityOptions = { directory: input.directory, localProfileId: profile.localProfileId, agentId: input.agentId };
    const existing = readPairingAdoption(options);
    if (existing && existing.frontendOrigin !== site) throw failure("verification");
    if (existing) return { state: "paired", agentId: existing.agentId, pairedAt: existing.pairedAt, ...unavailable };
    const runner = await inspectLocalRunner(input.directory, input.agentId);
    if (runner.process !== "running" || !runner.agents.some((agent) => agent.agentId === input.agentId)) throw failure("state");
    const descriptor = beginPairingIdentity(options);
    const client = new RunnerPairingClient({ frontendOrigin: site, apiBaseUrl: `${site}/api`,
      runnerPublicKey: descriptor.runnerPublicKey, localIntentNonce: descriptor.localIntentNonce, fetchFn: input.fetchFn });
    const fragment = new URLSearchParams({ runnerPublicKey: descriptor.runnerPublicKey, localIntentNonce: descriptor.localIntentNonce });
    const url = `${site}/hub/agents/pair#${fragment.toString()}`;
    const runnerFingerprint = fingerprint(descriptor.runnerPublicKey);
    await emit({ type: "link", url, runnerFingerprint });
    try { await input.openUrl(url); } catch { await emit({ type: "browser_failed" }); }

    let posted: string | undefined;
    const adopt = (receipt: RunnerPairingReceipt): AutoPairingResult => {
      const adopted = adoptPairingIdentity(options, { frontendOrigin: site, receipt });
      return { state: "paired", agentId: adopted.agentId, pairedAt: adopted.pairedAt, ...unavailable };
    };
    /** Sign the pinned approval's pairing message again (same binding, no new approval) and relay it to the page. */
    const relay = async (challenge: RunnerPairingChallenge) => {
      const proof = approvePairingIdentity(options, { frontendOrigin: site, challenge, approvedBindingDigest: challenge.bindingDigest });
      await client.submitResponse({ challengeId: proof.challengeId, bindingDigest: proof.bindingDigest, runnerSignature: proof.runnerSignature });
      posted = proof.challengeId;
      await emit({ type: "response_sent", responseCode: pairingResponseCode(proof.runnerSignature) });
      await emit({ type: "waiting_for_wallet" });
    };
    let waitingShown = false;
    let mismatches = 0;
    let refusals = 0;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) return { state: "cancelled", ...unavailable };
      let pause = interval;
      try {
        const approval = readPairingApproval(options);
        if (approval && approval.frontendOrigin !== site) throw failure("verification");
        if (approval) {
          // The owner already approved here: wait for the receipt of exactly that binding.
          try {
            const nonce = await client.requestReadNonce(approval.challengeId, "receipt");
            const receipt = await client.read(nonce, signPairingReadProof(options, { frontendOrigin: site, nonce }), approval.bindingDigest);
            if (receipt.resource !== "receipt") throw failure("verification");
            return adopt(receipt);
          } catch (error: unknown) { if (!notThere(error)) throw error; }
        }
        if (approval && Date.parse(approval.expiresAt) > Date.now()) {
          if (posted !== approval.challengeId) {
            // A restart after approval: the page may still be waiting for the relayed response.
            try {
              const nonce = await client.requestReadNonce(approval.challengeId, "challenge");
              const challenge = await client.read(nonce, signPairingReadProof(options, { frontendOrigin: site, nonce }));
              if (challenge.resource !== "challenge" || challenge.bindingDigest !== approval.bindingDigest) throw failure("verification");
              await relay(challenge);
            } catch (error: unknown) { if (!notThere(error)) throw error; }
          }
        } else {
          // No approval yet, or it expired unconfirmed: find the page's current challenge for this runner's intent.
          const nonce = await client.requestIntentNonce();
          // A local clock ahead of the server: the approval looks expired here but not yet at the server. Wait for it.
          if (approval && Date.parse(nonce.issuedAt) < Date.parse(approval.expiresAt)) {
            await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), input.signal);
            continue;
          }
          const found = await client.readIntent(nonce, signPairingIntentReadProof(options, { frontendOrigin: site, nonce }), approval?.bindingDigest);
          if (found.resource === "receipt") return adopt(found);
          if (found.resource === "none") {
            if (approval && posted === approval.challengeId) { posted = undefined; await emit({ type: "challenge_expired" }); }
            if (!waitingShown) { waitingShown = true; await emit({ type: "waiting_for_page" }); }
          } else {
            // Refuse a local trading wallet before showing any approval card.
            checkPairingWalletSeparation(options, { chain: found.binding.walletChain, address: found.binding.walletAddress });
            const answer = await input.confirm({ localAgentId: input.agentId, site, ownerId: found.binding.ownerUserId,
              agentId: found.agentId, walletChain: found.walletChain, walletAddress: found.binding.walletAddress,
              runnerFingerprint: fingerprint(found.binding.runnerPublicKey), expiresAt: found.expiresAt });
            if (answer === null || input.signal?.aborted) return { state: "cancelled", ...unavailable };
            if (!isAutoPairingConfirmation(answer, found.challengeId)) {
              mismatches += 1;
              if (mismatches >= MAX_CODE_ATTEMPTS) return { state: "cancelled", ...unavailable };
              await emit({ type: "code_mismatch", attemptsLeft: MAX_CODE_ATTEMPTS - mismatches });
              continue;
            }
            if (Date.parse(found.expiresAt) <= Date.now()) { await emit({ type: "challenge_expired" }); continue; }
            await relay(found);
            pause = 0;
          }
        }
        refusals = 0;
      } catch (error: unknown) {
        if (error instanceof TerminalError || error instanceof PairingIdentityError) throw error;
        const status = sdkStatus(error);
        if (status !== undefined && UNSUPPORTED_STATUSES.has(status)) return { state: "unsupported", ...unavailable };
        // A 403 is never produced by the pairing routes for a valid runner: a proxy or the site refuses it for good.
        if (status === 403) throw failure("refused");
        if (error instanceof AgentSdkError && error.code === "rate_limit_error") {
          await emit({ type: "retrying", reason: "rate_limited" });
          pause = Math.max(interval * 3, ((error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 0) * 1_000);
        } else if (error instanceof AgentSdkError && error.code === "network_error") {
          await emit({ type: "retrying", reason: "network" });
        } else if (error instanceof AgentSdkError && (status === 401 || (status ?? 0) >= 500)) {
          // A dependency outage (5xx) is transient until the deadline. A 401 (an account operation in flight, or a challenge
          // that just expired) is transient too, but a run of them is a refusal. A response that fails verification
          // (invalid_response) still ends the wait at once.
          if (status === 401 && (refusals += 1) >= MAX_CONSECUTIVE_REFUSALS) throw failure("refused");
          await emit({ type: "retrying", reason: "unavailable" });
        } else throw error;
      }
      if (pause > 0) await sleep(Math.min(pause, Math.max(0, deadline - Date.now())), input.signal);
    }
    return { state: "timed_out", ...unavailable };
  } catch (error: unknown) {
    if (error instanceof TerminalError) throw error;
    if (error instanceof PairingIdentityError) throw failure(error.code === "trading_wallet" ? "trading_wallet" : "state");
    if (error instanceof AgentSdkError && error.code === "network_error") throw failure("network");
    throw failure("verification");
  }
}
