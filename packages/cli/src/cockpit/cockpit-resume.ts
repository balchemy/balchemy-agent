/** K5b `/resume` card. Raising risk needs the typed phrase (RESUME <agent>, cockpit-runtime.ts `cockpitResumePhrase`).
 * - A stopped or paused agent that is not armed returns to shadow mode through the runner's `resume` control, as before. Arming stays
 *   separate (/arm).
 * - An ARMED agent whose new buys the owner paused gets its new buys back through the owner-local `entries_resume` arming action
 *   (private-arming.ts). It only turns new entries back on: it never arms, never changes caps, rules or exits. The shadow `resume`
 *   control is never sent for an armed agent, because it disarms the agent and stops its stop-loss and take-profit exits.
 * The state is read once before the card; that version is the one the runner's release must still find (a change in between refuses). */
import type { PrivateArmingChannelError } from "../runner/private-arming-protocol.js";
import { PRIVATE_ARMING_REFUSAL_TEXT } from "../runner/private-arming-ui.js";
import type { RunnerAgentState } from "../runner/protocol.js";
import type { CockpitMode } from "./cockpit-panel.js";

/** K5b: the panel's mode word from the runner's own agent state (re-exported by cockpit-runtime.ts). */
export function cockpitMode(state: Pick<RunnerAgentState, "mode" | "lifecycle" | "entries">): CockpitMode {
  if (state.lifecycle === "stopped") return "stopped";
  if (state.mode === "live_armed") return state.entries === "paused" ? "armed, new buys paused" : "armed";
  return state.mode === "paused" ? "paused" : state.mode === "live_unarmed" ? "live, not armed" : "shadow";
}

export type CockpitEntriesResumeOutcome = { kind: "resumed"; state: RunnerAgentState } | { kind: "refused"; code: PrivateArmingChannelError }
  | { kind: "unknown" };
export interface CockpitResumeDeps {
  io: { write(text: string): Promise<void>; ask(question: string): Promise<string | null> };
  agentId: string;
  /** RESUME <agent> (cockpit-runtime.ts `cockpitResumePhrase`). */
  phrase: string;
  readState(): Promise<RunnerAgentState | undefined>;
  /** The runner's `resume` control (back to shadow mode); only for an agent that is not armed. */
  resumeShadow(before: RunnerAgentState): Promise<"applied" | "unknown" | "refused">;
  /** The owner-local `entries_resume` at `before.version`; only for an armed agent whose entries are paused. A2a: it may ask the trading
   * wallet passphrase (socket proof) after the typed RESUME. */
  resumeEntries(before: RunnerAgentState): Promise<CockpitEntriesResumeOutcome>;
  /** A2a: the seal step, run inline when the resume is refused for an unsealed Hub wallet or settings (`owner_pin_*`,
   * `authority_unsealed`); true when it sealed (the resume is then sent once more). Absent: the refusal text stands. */
  seal?(code: PrivateArmingChannelError): Promise<boolean>;
}
const SEAL_CODES: ReadonlySet<PrivateArmingChannelError> = new Set(["owner_pin_missing", "owner_pin_invalid", "owner_pin_mismatch", "authority_unsealed"]);

/** Owner text of a refused entries resume: the arming refusal text with the agent named, plus that nothing about exits changed. */
const RESUME_TEXT: Readonly<Partial<Record<PrivateArmingChannelError, string>>> = Object.freeze({
  version_conflict: "The agent's state changed since this card (another pause, a disarm or a settings change). Read /status, then /resume again.",
  state_unavailable: "The runner could not confirm its state. Read /status before another change.",
  // A2a: in the cockpit the seal step opens in this card; these say what is still missing when it was not completed.
  authority_unsealed: "Your settings are not sealed on this computer, or one of them is now looser than what you sealed. Seal them (this card shows "
    + "them, asks the last 6 characters of your Hub wallet and your passphrase), then /resume again.",
  owner_pin_missing: "Your Hub wallet is not sealed on this computer yet. Seal it (compare the whole address with the wallet you signed in to Hub with), then /resume again.",
  owner_pin_invalid: "The sealed record of your Hub wallet does not verify on this computer. Seal it again, then /resume again.",
  owner_pin_mismatch: "The pairing record no longer matches the Hub wallet you sealed. Seal again only if you paired this agent again yourself.",
  proof_required: "Resuming new buys needs your trading wallet passphrase, and it was not entered.",
  passphrase_rejected: "Wrong trading wallet passphrase.",
  wallet_locked: "The trading wallet is locked and was not unlocked here. Unlock it, then /resume again.",
});
export function cockpitEntriesResumeRefusalText(code: PrivateArmingChannelError, agentId: string): string {
  const text = (RESUME_TEXT[code] ?? PRIVATE_ARMING_REFUSAL_TEXT[code]).replace(/<agent>/g, agentId).replace(/ ?Nothing was armed[.;]?/g, "").trim();
  return `New buys stay paused: ${text} Stop-loss and take-profit exits keep running; nothing else was changed.`;
}

/** Runs the /resume card. Returns its result row: the last line it wrote (code-built; the card is a secret card, so it records no line
 * by itself). */
export async function runCockpitResume(deps: CockpitResumeDeps): Promise<string> {
  let last = "";
  const io: CockpitResumeDeps["io"] = { write: async (text) => { last = text.trim(); await deps.io.write(text); }, ask: (question) => deps.io.ask(question) };
  await resumeCard(deps, io);
  return last || "Nothing was changed.";
}

async function resumeCard(deps: CockpitResumeDeps, io: CockpitResumeDeps["io"]): Promise<void> {
  const { agentId, phrase } = deps;
  const state = await deps.readState();
  if (!state) { await io.write("The agent's state could not be read. Nothing was changed.\n"); return; }
  if (state.mode === "live_armed") {
    if (state.entries !== "paused") { await io.write(`${agentId} is armed and buying normally. Nothing to resume.\n`); return; }
    await io.write(`Resume new buys of ${agentId}: it stays armed, and new buys start again within your rules, spend limits and buy size. `
      + "Nothing else changes: no new arming, the same caps, rules and exits; stop-loss and take-profit exits keep running either way. "
      + "The runner refuses if it paused new buys itself (a settings change not saved yet, an unresolved trade) or if anything changed since this card.\n"
      + `Type exactly ${phrase} to resume new buys; any other answer changes nothing.\n`);
    const answer = await io.ask("> ");
    if (answer?.trim() !== phrase) { await io.write("Not confirmed. Nothing was changed; new buys stay paused and exits keep running.\n"); return; }
    let outcome = await deps.resumeEntries(state);
    // A2a: an unsealed Hub wallet or settings opens the seal step here; after a seal the same resume (same typed RESUME) is sent once more.
    if (outcome.kind === "refused" && SEAL_CODES.has(outcome.code) && deps.seal && await deps.seal(outcome.code)) outcome = await deps.resumeEntries(state);
    await io.write(outcome.kind === "resumed" ? `New buys of ${agentId} are on again. It stayed armed the whole time; stop-loss and take-profit exits kept running.\n`
      : outcome.kind === "refused" ? `${cockpitEntriesResumeRefusalText(outcome.code, agentId)}\n`
        : "The resume outcome is unknown. Check /status before another change; nothing was retried. Exits keep running.\n");
    return;
  }
  if (state.lifecycle !== "stopped" && state.mode !== "paused") { await io.write(`${agentId} is not paused or stopped (${cockpitMode(state)}). Nothing to resume.\n`); return; }
  await io.write(`Resume ${agentId}: it returns to shadow mode, which researches signals but cannot trade. Arming stays separate (/arm).\n`
    + `Type exactly ${phrase} to resume; any other answer changes nothing.\n`);
  const answer = await io.ask("> ");
  if (answer?.trim() !== phrase) { await io.write("Not confirmed. Nothing was changed.\n"); return; }
  const outcome = await deps.resumeShadow(state);
  await io.write(outcome === "applied" ? `${agentId} is back in shadow mode. Arm it with /arm to trade again.\n`
    : outcome === "unknown" ? "The resume outcome is unknown. Check balchemy runner status before another change; nothing was retried.\n"
      : "The runner refused the resume (the state changed). Check balchemy runner status.\n");
}
