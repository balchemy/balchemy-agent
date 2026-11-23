/** A2a seal step (plan section B3, amendments section C "first seal / re-seal is ONE explicit card"): `balchemy runner owner-pin <agent>`,
 * the cockpit's seal card (between pairing and the spend ceiling), and the same card inline in arm and /resume.
 *
 * The card shows, all code-built from the daemon's `private_owner_pin` status:
 * - the FULL owner address of the plaintext pairing record (the owner compares the whole address with the wallet they signed in to Hub
 *   with: six characters alone are attention, not authentication; plan finding 7);
 * - every other field the pin seals, in full: the Hub origin (with a line to check it against the Hub the owner signed in to), the Hub
 *   agent id and network id, the runner key fingerprint (the one Hub's pairing page showed) and the binding digest; on a re-seal the old
 *   and the new value of EVERY pinned field that differs (not only the address);
 * - a plain tamper line when the stored settings seal does not verify;
 * - the authority view: spend limits, buy size and slippage, the plain-language rules review (injected, setupProposalReview style, never a
 *   revision id), the trade approval setting, the RPC host only (never the URL), the model, the AI budget and price, the AI call allowance,
 *   the launchpad sources, and which of them are looser than the last seal (the tamper signal the owner re-authorises).
 * Then the owner types the last six characters of the address (checked here first: a wrong suffix sends nothing), then the trading-wallet
 * passphrase (hidden; the socket proof, never stored). The seal frame echoes what was shown (every pairing field, suffix and
 * `currentDigest` as `authorityDigest`); the daemon re-reads everything and refuses any difference. Migration is trust-on-first-use: a
 * record swapped before the first seal shows the attacker's address here (documented residual), hence the compare instruction. */
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { isId } from "./protocol.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { formatPrivateCap } from "./private-spend-cap.js";
import { formatPrivateModelUsd } from "./private-model-prices.js";
import { createWalletPrompt, guardTerminalSignals, type WalletPrompt } from "./private-trading-keystore-ui.js";
import type { PrivateTradingWalletTransport } from "./private-trading-keystore-client.js";
import type { PrivateAuthorityView } from "./private-authority-seal.js";
import type { PrivateAuthorityField } from "./private-socket-proof.js";
import { exchangeWithSocketProof, socketProofText, socketProofUnlock, type SocketProofOutcome } from "./private-socket-proof-client.js";
import { parsePrivateOwnerPinRequest, privateOwnerPairingDiff, privateOwnerPinBinding, privateOwnerSuffixMatches, PrivateOwnerPinTransportError,
  requestPrivateOwnerPin, validatePrivateOwnerPinReply, type PrivateOwnerPairingField, type PrivateOwnerPairingView, type PrivateOwnerPinChannelError,
  type PrivateOwnerPinData, type PrivateOwnerPinRequest, type PrivateOwnerPinResponse } from "./private-owner-pin-protocol.js";

export type PrivateOwnerPinTransport = (socketPath: string, request: PrivateOwnerPinRequest) => Promise<PrivateOwnerPinResponse>;
/** The plain-language lines of the confirmed rules revision `revisionId` (cockpit-setup.ts readSetupRulesReview), or undefined when it
 * cannot be read or the head is another revision. Injected: no runner module imports the cockpit. */
export type PrivateOwnerPinRulesReview = (agentId: string, revisionId: string) => Promise<string[] | undefined>;
/** One prompt for the card: the visible last-six answer and the hidden passphrase (a card's prompt or the raw-mode terminal prompt). */
export type PrivateOwnerPinPrompt = Pick<WalletPrompt, "closed" | "line" | "secret">;
export const PRIVATE_OWNER_PIN_SUFFIX_PROMPT = "last 6> ";
export const PRIVATE_OWNER_PIN_PASSPHRASE_PROMPT = "Trading wallet passphrase (seals your Hub wallet and these settings; not stored): ";

export interface PrivateOwnerPinSealOptions {
  target: PrivateBrainTarget;
  write(text: string): void | Promise<void>;
  prompt: PrivateOwnerPinPrompt;
  describeRules: PrivateOwnerPinRulesReview;
  transport?: PrivateOwnerPinTransport;
  walletTransport?: PrivateTradingWalletTransport;
  /** The passphrase this card already holds (one-step resume: the arm card's), tried before the hidden prompt (decision 1). */
  known?: string;
  /** Inline in arm or /resume: one line on why the card opened. */
  reason?: string;
}
export type PrivateOwnerPinSealResult =
  | { kind: "sealed"; agentId: string; ownerAddress: string; replaced: boolean }
  | { kind: "cancelled"; agentId: string; reason: "input_closed" | "suffix_mismatch" }
  /** Nothing was sealed; `text` says why in plain words. */
  | { kind: "refused"; agentId: string; text: string }
  /** The pin may already be written (the watermark write's outcome is unknown); read the status again. */
  | { kind: "outcome_unknown"; agentId: string };
/** What the cockpit flow needs: `needed` (no pin, a broken one, another pairing, or no seal of the settings yet), `sealed`, `unpaired`,
 * `unavailable` (not readable now; the flow does not block on it). A seal that is only looser than the current settings is handled
 * inline where it matters (arm, /resume), not as a setup step. */
export type PrivateOwnerPinNeed = "needed" | "sealed" | "unpaired" | "unavailable";

const FIELD_TEXT: Readonly<Record<PrivateAuthorityField, string>> = Object.freeze({
  caps: "spend limits", sizing: "buy size or slippage", rules: "strategy or trade approval", rpc: "Solana RPC", model: "AI model",
  budget: "daily AI budget", modelPrice: "AI model price", autonomy: "AI calls per day", launchpads: "launchpad sources",
});
const CHAIN_TEXT = { solana: "Solana", base: "Base" } as const;
/** Shown above the settings when the stored settings seal does not verify (edited, foreign, or damaged). */
export const PRIVATE_OWNER_PIN_SEAL_TAMPER_TEXT = "The settings seal on disk is damaged or was changed outside Balchemy; review every value below before sealing.";
const PAIRING_FIELD_TEXT: Readonly<Record<PrivateOwnerPairingField, string>> = Object.freeze({
  owner: "Hub wallet", bindingDigest: "Pairing binding digest", frontendOrigin: "Hub address", serverAgentId: "Agent on Hub", chainId: "Network",
  runnerFingerprint: "Runner fingerprint",
});
function groupFingerprint(value: string): string { return value.match(/.{1,8}/g)?.join(" ") ?? value; }
function pairingFieldText(view: PrivateOwnerPairingView, field: PrivateOwnerPairingField): string {
  if (field === "owner") return `${view.owner.address} (${CHAIN_TEXT[view.owner.chain]})`;
  return field === "runnerFingerprint" ? groupFingerprint(view.runnerFingerprint) : view[field];
}

async function statusOf(target: PrivateBrainTarget, transport: PrivateOwnerPinTransport): Promise<PrivateOwnerPinData | undefined> {
  try {
    const request = parsePrivateOwnerPinRequest({ ...privateOwnerPinBinding(target), action: "status" });
    const response = validatePrivateOwnerPinReply(request, await transport(target.socketPath, request));
    return response.ok ? response.data : undefined;
  } catch { return undefined; }
}
/** Read-only: whether the seal card is a setup step now (cockpit-flow.ts). */
export async function readPrivateOwnerPinNeed(target: PrivateBrainTarget, transport: PrivateOwnerPinTransport = requestPrivateOwnerPin): Promise<PrivateOwnerPinNeed> {
  const data = await statusOf(target, transport);
  if (!data) return "unavailable";
  const pin = data.pin.state; const authority = data.authority.state;
  if (pin === "unpaired") return "unpaired";
  if (pin === "held" || authority === "held") return "unavailable";
  if (pin === "unpinned" || pin === "invalid" || pin === "mismatch" || authority === "unsealed" || authority === "invalid") return "needed";
  return "sealed";
}

/** The authority view in owner words (the RPC host only; never a revision id or the URL). */
export function privateOwnerPinAuthorityLines(view: PrivateAuthorityView, rules: readonly string[]): string[] {
  const sizing = view.sizing ? `${view.sizing.amountSol} SOL per buy, slippage ${view.sizing.slippageBps} bps (${(view.sizing.slippageBps / 100).toFixed(2).replace(/\.?0+$/, "")}%)`
    : "not set";
  const approval = view.rules.approvalMode === "automatic_within_limits" ? "automatic within your limits, no question per trade"
    : view.rules.approvalMode === "approval_required" ? "asks before each trade (arming refuses while this applies)" : "no confirmed rules yet";
  const price = view.modelPrice ? `${view.modelPrice.model}: ${formatPrivateModelUsd(view.modelPrice.inputMicroUsdPerMillion)} per million input tokens, `
    + `${formatPrivateModelUsd(view.modelPrice.outputMicroUsdPerMillion)} per million output tokens` : "none captured (the budget counts at the highest listed price)";
  return [`  Spend limits: ${formatPrivateCap(view.caps.perTrade, view.caps.perTradeBasis)} per buy, ${formatPrivateCap(view.caps.daily, view.caps.dailyBasis)} per UTC day`,
    `  Buy size: ${sizing}`,
    ...(view.rules.revisionId === null ? ["  Strategy: no confirmed rules yet"]
      : ["  Strategy (built by the runner from the confirmed rules; not written by the AI model):", ...rules.map((line) => `    ${line}`)]),
    `  Trade approval: ${approval}`,
    `  Solana connection: ${view.rpc ? `your own RPC at ${view.rpc.host}` : "provided by Balchemy (two independent providers)"}`,
    `  AI model: ${view.model ? `${view.model.provider} / ${view.model.model}` : "none saved"}`,
    `  AI model price: ${price}`,
    `  Daily AI budget: ${formatPrivateModelUsd(view.budget.dailyLimitMicroUsd)} per UTC day`,
    `  AI calls per day: ${view.autonomy.dailyCallLimit}`,
    `  Launchpad sources: ${view.launchpads.ids.length ? view.launchpads.ids.join(", ") : "none"}`];
}

const REFUSAL_TEXT: Readonly<Partial<Record<PrivateOwnerPinChannelError, string>>> = Object.freeze({
  not_paired: "This agent is not paired with your Hub account yet, so there is no Hub wallet to seal. Pair it first.",
  wallet_missing: "This agent has no trading wallet yet; the seal uses its key. Create or import it first.",
  wallet_locked: "The trading wallet is locked; the seal needs it unlocked. Unlock it first.",
  shown_mismatch: "The Hub wallet, its binding or a setting changed while this card was open. Nothing was sealed; open the card again and compare it once more.",
  suffix_mismatch: "Those are not the last 6 characters of the address shown. Nothing was sealed.",
  state_unavailable: "The local pairing, wallet or settings state could not be confirmed. Nothing was sealed; check balchemy runner status.",
  closing: "The runner is closing. Nothing was sealed.",
  unknown_agent: "This agent is not registered with the running runner.",
});
function refusalText(code: PrivateOwnerPinChannelError, agentId: string): string {
  return (REFUSAL_TEXT[code] ?? `The runner refused the seal (${code.replace(/_/g, " ")}). Nothing was sealed.`).replace(/<agent>/g, agentId);
}

/** The seal card: shows everything, asks the last six characters, then the passphrase, then seals (one frame, its proof first). */
export async function runPrivateOwnerPinSeal(options: PrivateOwnerPinSealOptions): Promise<PrivateOwnerPinSealResult> {
  const { target, prompt } = options;
  const agentId = target.agentId;
  const transport = options.transport ?? requestPrivateOwnerPin;
  const refused = (text: string): PrivateOwnerPinSealResult => ({ kind: "refused", agentId, text });
  const data = await statusOf(target, transport);
  if (!data) return refused("The seal state could not be read from the runner. Nothing was sealed; check balchemy runner status.");
  const { pin, authority } = data;
  if (pin.state === "unpaired" || !pin.pairing) return refused(REFUSAL_TEXT.not_paired!);
  if (pin.state === "held" || authority.state === "held") return refused(REFUSAL_TEXT.state_unavailable!);
  const pairing = pin.pairing;
  const view = authority.current;
  let rules: string[] = [];
  if (view.rules.revisionId !== null) {
    const described = await options.describeRules(agentId, view.rules.revisionId).catch(() => undefined);
    // The digest commits only to the revision id: a review of another revision is never shown under it.
    if (!described) return refused("The confirmed rules could not be read in plain words right now (or they changed while this card opened). Nothing was sealed; try again.");
    rules = described;
  }
  const address = pairing.owner.address;
  // Old and new whenever ANY pinned field differs from the pairing record (not only the address).
  const changed = pin.pinned ? privateOwnerPairingDiff(pin.pinned, pairing) : [];
  const old = pin.pinned && changed.length ? pin.pinned : undefined;
  const lines = [...(options.reason ? [options.reason, ""] : []),
    `Seal your Hub wallet and your settings for ${agentId} on this computer.`,
    `Your Hub wallet (the identity wallet you signed in to Hub with), ${CHAIN_TEXT[pairing.owner.chain]}:`, `  ${address}`,
    "Compare the WHOLE address, character by character, with the wallet you signed in to Hub with. If any character differs, stop here: "
      + "someone may have changed the pairing record on this computer.",
    "Hub address this agent is paired with:", `  ${pairing.frontendOrigin}`,
    "Check the Hub address too: it must be exactly the address of the Balchemy Hub you signed in to (your browser's address bar). "
      + "If it differs, stop here.",
    `Agent on Hub: ${pairing.serverAgentId} (network ${pairing.chainId})`,
    `Runner fingerprint: ${groupFingerprint(pairing.runnerFingerprint)} (the one Hub's pairing page showed)`,
    ...(old ? [`Sealed before (${new Date(old.pinnedAt).toISOString()}), and different now:`,
      ...changed.map((field) => `  ${PAIRING_FIELD_TEXT[field]}: was ${pairingFieldText(old, field)}, now ${pairingFieldText(pairing, field)}`),
      changed.includes("owner") ? "The address above is a DIFFERENT wallet. Seal it only if you paired this agent again yourself with that wallet."
        : "The pairing above differs from your last seal. Seal it only if you paired this agent again yourself."] : []),
    ...(pin.state === "pinned" && !old ? ["This wallet is already sealed; sealing again also records the settings below."] : []),
    ...(pin.state === "mismatch" && !old ? ["The earlier seal on this computer was made with another trading wallet; this replaces it."] : []),
    ...(pin.state === "invalid" ? ["The earlier seal on this computer does not verify any more (edited or from another wallet); this replaces it."] : []),
    `Pairing binding digest: ${pairing.bindingDigest}`,
    "", "Settings this seal records. A later change that loosens one of them keeps new buys paused until you seal again:",
    ...(authority.state === "invalid" ? [PRIVATE_OWNER_PIN_SEAL_TAMPER_TEXT] : []),
    ...privateOwnerPinAuthorityLines(view, rules),
    ...(authority.looser.length ? [`Looser now than your last seal: ${authority.looser.map((field) => FIELD_TEXT[field]).join(", ")}. `
      + "Seal only if you made these changes yourself."] : []),
    ...(authority.state === "unsealed" && authority.sealedAt === null && pin.state !== "unpinned" ? ["Your settings have no seal on this computer (never sealed, or the seal was removed)."] : []),
    "", "Type the last 6 characters of the address above to continue; anything else cancels. Then your trading wallet passphrase.", ""];
  await options.write(lines.join("\n"));
  if (prompt.closed) return { kind: "cancelled", agentId, reason: "input_closed" };
  const suffix = await prompt.line(PRIVATE_OWNER_PIN_SUFFIX_PROMPT);
  if (suffix === null || prompt.closed) return { kind: "cancelled", agentId, reason: "input_closed" };
  // Checked here first: a wrong suffix sends nothing and asks no passphrase.
  if (!privateOwnerSuffixMatches(address, suffix) || !/^[0-9A-Za-z]{6}$/.test(suffix)) return { kind: "cancelled", agentId, reason: "suffix_mismatch" };
  // Every pairing field shown above is echoed: the daemon refuses if any of them changed after this card showed it.
  const build = (passphrase?: string): PrivateOwnerPinRequest => parsePrivateOwnerPinRequest({ ...privateOwnerPinBinding(target), action: "seal",
    ownerAddress: address, bindingDigest: pairing.bindingDigest, frontendOrigin: pairing.frontendOrigin, serverAgentId: pairing.serverAgentId,
    chainId: pairing.chainId, runnerFingerprint: pairing.runnerFingerprint, suffix, authorityDigest: authority.currentDigest,
    ...(passphrase !== undefined ? { passphrase } : {}) });
  let outcome: SocketProofOutcome<PrivateOwnerPinResponse>;
  try {
    outcome = await exchangeWithSocketProof({ build, proveFirst: true, label: PRIVATE_OWNER_PIN_PASSPHRASE_PROMPT,
      send: async (request) => validatePrivateOwnerPinReply(request, await transport(target.socketPath, request)),
      error: (reply) => (reply.ok ? undefined : reply.error), secret: (label) => prompt.secret(label),
      ...(options.known !== undefined ? { known: options.known } : {}), unlock: socketProofUnlock(target, options.walletTransport) });
  } catch (error: unknown) {
    if (error instanceof PrivateOwnerPinTransportError && error.code === "connection_unavailable") return refused("The runner could not be reached. Nothing was sealed.");
    return { kind: "outcome_unknown", agentId };
  }
  if (outcome.kind === "cancelled") return { kind: "cancelled", agentId, reason: "input_closed" };
  if (outcome.kind !== "response") return refused(socketProofText(outcome, agentId).replace("this change", "the seal"));
  const response = outcome.response;
  if (!response.ok) {
    if (response.error === "write_outcome_unknown") return { kind: "outcome_unknown", agentId };
    return refused(refusalText(response.error, agentId));
  }
  return { kind: "sealed", agentId, ownerAddress: address, replaced: old !== undefined || pin.state === "pinned" || pin.state === "invalid"
    || pin.state === "mismatch" };
}

/** The Balchemy row / CLI text of one seal result (code-built; never a passphrase). */
export function formatPrivateOwnerPinResult(result: PrivateOwnerPinSealResult | { kind: "dry_run"; agentId: string }): string {
  switch (result.kind) {
    case "dry_run": return `Seal preview for ${result.agentId}. No connection, prompt or change made.\n`;
    case "sealed": return [`Sealed on this computer: your Hub wallet ${result.ownerAddress} and the settings shown for ${result.agentId}.`,
      "Arming and new buys now trust only this wallet and settings at or below these; a looser change pauses new buys until you seal again.", ""].join("\n");
    case "cancelled": return result.reason === "suffix_mismatch" ? "Those are not the last 6 characters of the address shown. Nothing was sealed.\n"
      : "Seal cancelled. Nothing was sealed.\n";
    case "refused": return `${result.text}\n`;
    case "outcome_unknown": return [`The seal outcome is unknown for ${result.agentId}. Nothing was retried.`,
      `Read it again: balchemy runner owner-pin ${result.agentId} shows the current seal before anything is sealed.`, ""].join("\n");
  }
}

export interface PrivateOwnerPinCommandOptions {
  args: string[]; directory: string; interactive: boolean;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  write(text: string): void | Promise<void>;
  describeRules: PrivateOwnerPinRulesReview;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateOwnerPinTransport;
  walletTransport?: PrivateTradingWalletTransport;
  createPrompt?(): WalletPrompt;
  guardSignals?(cleanup: () => void): () => void;
}
/** `balchemy runner owner-pin <agent>`: the seal card in a real terminal (the typed last six characters and the passphrase need one). */
export async function runPrivateOwnerPinCommand(options: PrivateOwnerPinCommandOptions): Promise<PrivateOwnerPinSealResult | { kind: "dry_run"; agentId: string }> {
  const [agentId] = options.args;
  if (options.args.length !== 1 || !isId(agentId) || options.flags.yes || options.flags.force || options.flags.quiet) {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid owner-pin command", cause: "Use runner owner-pin <agent>.",
      fix: "Pass one local agent label. --yes, --force and --quiet are not supported: the seal needs the typed last 6 characters and your passphrase.", exitCode: 2 });
  }
  if (options.flags.dryRun) return { kind: "dry_run", agentId };
  if (!options.interactive || options.flags.json || options.flags.ci) {
    throw new TerminalError({ code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive seal terminal required",
      cause: "Sealing your Hub wallet and settings needs a real terminal: you compare the whole address, type its last 6 characters and your passphrase.",
      fix: "Run without --json or --ci in a terminal on the runner's device.", exitCode: 2 });
  }
  let target: PrivateBrainTarget;
  try { target = Object.freeze({ ...(options.resolveTarget ? options.resolveTarget(agentId) : readPrivateBrainTarget(options.directory, agentId)) }); }
  catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  if (target.agentId !== agentId) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid owner-pin command", cause: "Agent mismatch.", fix: "Try again.", exitCode: 2 });
  const prompt = (options.createPrompt ?? createWalletPrompt)();
  const release = (options.guardSignals ?? guardTerminalSignals)(() => prompt.close());
  try {
    return await runPrivateOwnerPinSeal({ target, write: options.write, prompt, describeRules: options.describeRules,
      ...(options.transport ? { transport: options.transport } : {}), ...(options.walletTransport ? { walletTransport: options.walletTransport } : {}) });
  } finally { release(); prompt.close(); }
}
