/** `balchemy` in a terminal: the cockpit. Phase 2 order (owner-approved, 19 Nov 2026): what you need, the agent name, the runner (it
 * starts by itself in shadow mode, which cannot trade), the AI model (API key checked at once, then the live model list), the daily AI
 * budget, the trading wallet (one passphrase for the model key and the wallet by default), ONE Hub visit (pairing, then the runner links
 * the wallet and asks for the spend ceiling on the same page), then the chat, where the agent talks the owner through the rest and the
 * setup card collects strategy, sources, limits, buy size and funding into one summary with one typed confirmation before arming.
 * The flow re-reads state before each step, so leaving and coming back continues at the first unfinished step. Nothing here arms by
 * itself: arm is the owner's own command with its typed ARM and passphrase. The one passphrase lives only in this process for this run;
 * it is never written or sent anywhere but the local runner.
 * A1 one screen: with an in-screen io (cockpit-terminal.tsx) every step below is a card on the one cockpit screen and a card from the
 * chat runs while the chat stays open; nothing here drops to plain readline or asks "Press Enter to return to the chat". */
import { TerminalError } from "../errors.js";
import { isId } from "../runner/protocol.js";
import { isTradingWalletPassphrase } from "../runner/private-trading-keystore-protocol.js";
import { isPrivateBrainModelId, PRIVATE_BRAIN_PROVIDER_LABELS, type PrivateBrainProvider } from "../runner/private-brain-providers.js";
import type { ModelChoice } from "../runner/private-model-catalog.js";
import { readSetupChecklist, type SetupStateReaders, type SetupStepState } from "../runner/setup-state.js";
import { cardMeta, type CockpitCard, type CockpitCardMeta } from "./cockpit-cards.js";

export interface CockpitIo {
  write(text: string): Promise<void>;
  /** One visible answer; null on Esc, Ctrl+C or closed input. */
  ask(question: string): Promise<string | null>;
  /** One hidden answer (nothing is echoed): API keys and passphrases. Null on Esc, Ctrl+C or closed input. */
  secret(question: string): Promise<string | null>;
  /** A1: one visible answer whose input starts filled with `initial` (the owner edits it, Enter submits). Null on Esc. Absent for a
   * plain io: callers then use `ask`. */
  edit?(question: string, initial: string): Promise<string | null>;
  /** A1: the agent the following `Balchemy` rows belong to (each chat shows only its own agent's rows). Absent for a plain io. */
  agent?(agentId: string): void;
  /** A1: opens an in-screen card; what is written and asked until it closes goes into it. `close(result)` records one Balchemy row.
   * Absent for a plain io (tests): the steps then run as before. */
  card?(meta: CockpitCardMeta): { close(result?: string): void };
}
/** K5b: `switch` (the agents overlay or Ctrl+N) opens another registered agent's chat; `new` names, registers and sets up a new one.
 * Neither restarts the runner, so every other agent keeps running exactly as it is (an armed one stays armed). */
export type CockpitChatExit = { kind: "quit" } | { kind: "card"; card: CockpitCard } | { kind: "switch"; agentId: string } | { kind: "new" };
/** The result of one model operation on the runner. */
export type CockpitModelResult = { kind: "ok" } | { kind: "wrong_passphrase" } | { kind: "failed"; text: string };
/** The immediate key check: the provider's model list (OpenRouter: its key check first). */
export type CockpitKeyCheck = { kind: "ok"; models: ModelChoice[] } | { kind: "rejected" } | { kind: "unavailable" };
/** Phase 2 model step: everything but the prompts (production: cockpit-runtime.ts). */
export interface CockpitModelDeps {
  check(provider: PrivateBrainProvider, apiKey: string): Promise<CockpitKeyCheck>;
  /** OpenRouter's public list without a key (changing only the model of a saved OpenRouter key); undefined when unreachable. */
  publicModels(): Promise<ModelChoice[] | undefined>;
  /** The saved provider and model, readable without the passphrase. */
  saved(agentId: string): Promise<{ provider: PrivateBrainProvider; model: string } | undefined>;
  save(agentId: string, input: { provider: PrivateBrainProvider; model: string; apiKey: string; passphrase: string }): Promise<CockpitModelResult>;
  /** Another model of the saved provider with the saved key (the key is not entered again). */
  reselect(agentId: string, model: string, passphrase: string): Promise<CockpitModelResult>;
  unlock(agentId: string, passphrase: string): Promise<CockpitModelResult>;
  /** D2: stores an OpenRouter model's catalog price in the agent's budget record; false when the runner did not confirm it. A2a:
   * `passphrase` is this model card's passphrase, tried first when the runner asks for the trading-wallet proof (decision 1). */
  price(agentId: string, choice: ModelChoice, passphrase?: string): Promise<boolean>;
}
export interface CockpitBudgetDeps {
  /** The current daily limit as text ("$5.00") and whether the owner has set it. Undefined when unreadable. */
  read(agentId: string): Promise<{ limit: string; set: boolean } | undefined>;
  /** The existing budget command (raising keeps its typed BUDGET confirmation). */
  set(agentId: string, usd: string): Promise<void>;
}
export interface CockpitDeps {
  io: CockpitIo;
  readers: SetupStateReaders;
  /** Agent IDs the runner folder knows (read-only). */
  known(): string[];
  start(agentId: string): Promise<boolean>;
  /** Owner decision of 19 Nov 2026: adds the agent to the RUNNING runner (shadow, unarmed) without a restart, so no other agent is
   * disarmed. True once the runner confirms it is registered. */
  register(agentId: string): Promise<boolean>;
  /** This CLI's version and the running runner's (null when it is too old to say). */
  versions(): Promise<{ cli: string; runner: string | null }>;
  /** The full-screen model setup (kept for a runner without encrypted storage: the key then lives in memory only). */
  runModel(agentId: string, mode: "model" | "model-save" | "model-unlock"): Promise<void>;
  models: CockpitModelDeps;
  /** Optional: without it the budget step is skipped (the runner keeps its default). */
  budget?: CockpitBudgetDeps;
  runPairing(agentId: string): Promise<void>;
  /** `passphrase`: Phase 2 one passphrase (create/import use it instead of asking for a new one). */
  runWallet(agentId: string, action: "create" | "import" | "unlock", passphrase?: string): Promise<void>;
  /** Tries the one passphrase on the locked trading wallet; `rejected` changes nothing (the wallet has its own passphrase); `throttled`
   * (A2a): too many wrong passphrases in a row, nothing was tried. */
  unlockWallet?(agentId: string, passphrase: string): Promise<"unlocked" | "rejected" | "throttled" | "unknown">;
  /** K2 (owner decision of 19 Nov 2026): the runner links the unlocked trading wallet to Hub by itself after pairing (no typed BIND).
   * Waits for that link, showing its progress; a final refusal throws a TerminalError with the reason. */
  waitForLink(agentId: string): Promise<void>;
  /** A2a seal step (plan B3): after pairing and before the wallet link and the ceiling, the owner seals the Hub wallet (the whole address
   * compared, its last 6 characters typed) and the settings with the wallet passphrase. `need` is read-only; `seal` runs the card (its own
   * fresh passphrase prompt) and writes its result. Absent (tests, an older runner): no seal step. */
  ownerPin?: { need(agentId: string): Promise<"needed" | "sealed" | "unpaired" | "unavailable">; seal(agentId: string): Promise<void> };
  /** K2: the spend ceiling the owner proposes and signs on the same Hub page (one visit). Shows the amounts and the LOCAL check code
   * until the runner stored the approval, the owner skips, or the step does not apply (Base pairing, an older site). Never gates the
   * flow: arming's own approval stays the fallback. `fresh`: this run paired or linked (otherwise it only shows a request already open). */
  ceiling?(agentId: string, fresh: boolean): Promise<void>;
  /** The chat screen; it returns when the owner leaves or opens a card. */
  openChat(agentId: string, checklist: readonly SetupStepState[]): Promise<CockpitChatExit>;
  /** Runs the existing owner command a card names, with its own review and typed confirmation. */
  runCard(agentId: string, card: CockpitCard): Promise<void>;
  /** Phase 1: the shutdown warning (an armed agent or open positions, read without unlocking anything), or null when none applies. */
  shutdownWarning?(): Promise<string | null>;
  /** Phase 1: this agent's open, exit-pending and held positions (null when unreadable). */
  openPositions?(agentId: string): Promise<number | null>;
  /** Phase 1 one-step resume: the arm command, which lists the open positions, asks the passphrase once for the unlock and the arm,
   * and keeps the review and the typed ARM <agent>. Phase 2: `passphrase` is the one passphrase already typed in this run. */
  resume?(agentId: string, passphrase?: string): Promise<void>;
  /** A1: leaves the one cockpit screen when the flow ends (also after an error); `message` is printed on the normal screen. */
  close?(message?: string): void;
}
export type CockpitResult = { kind: "left"; agentId: string } | { kind: "stopped"; agentId?: string; reason: string };

/** Step 1 text (KOKPIT-SPEC §4 step 1, A1): shown on a computer with no agent yet, in the name card. No "Welcome", no separate Enter. */
export const COCKPIT_REQUIREMENTS = "This sets up a trading agent that runs on this computer. Its wallet key and your AI key stay here, encrypted. "
  + "Have these ready:\n"
  + "  · your Balchemy account and identity wallet (for example Phantom)\n"
  + "  · an API key from OpenAI, Anthropic or OpenRouter\n"
  + "  · the SOL you want this agent to trade with\n"
  + "You can leave at any step (Esc) and continue later. Nothing can trade until you arm it in the last step.\n";
const PROVIDERS: readonly PrivateBrainProvider[] = ["openai", "anthropic", "openrouter"];
const KEY_PAGES: Readonly<Record<PrivateBrainProvider, string>> = Object.freeze({
  openai: "platform.openai.com/api-keys", anthropic: "console.anthropic.com/settings/keys", openrouter: "openrouter.ai/keys",
});
const ATTEMPTS = 3;
const LIST_ROWS = 12;

class Stop extends Error { constructor(readonly reason: string) { super(reason); } }
/** Esc (or Ctrl+C) on a setup step: the setup stops; on a card from the chat only that card closes (the chat stays). */
const LEFT = "You left the cockpit. Run balchemy again to continue where you stopped.";
const closedText = (reason: string): string => (reason === LEFT ? "Closed. Nothing was changed." : reason);

export async function runCockpit(deps: CockpitDeps): Promise<CockpitResult> {
  let message: string | undefined;
  try {
    const result = await runCockpitSteps(deps);
    if (result.kind === "stopped") message = result.reason;
    return result;
  } finally { deps.close?.(message); }
}

async function runCockpitSteps(deps: CockpitDeps): Promise<CockpitResult> {
  const { io, readers } = deps;
  /** One step as one in-screen card (a plain io runs it as before). `done`: the Balchemy row that records a finished step. */
  const step = async <T>(meta: CockpitCardMeta, run: () => Promise<T>, done?: () => Promise<string | undefined>): Promise<T> => {
    const scope = io.card?.(meta);
    // A step that throws records nothing itself: its reason is written as the next row by the caller.
    let result: string | undefined = "";
    try {
      const value = await run();
      result = undefined;
      if (scope && done) { try { result = await done(); } catch { result = undefined; } }
      return value;
    } finally { scope?.close(result); }
  };
  let agentId: string | undefined;
  /** Phase 2: the one passphrase typed (and confirmed by the runner) in this run, reused for the wallet. Never stored. */
  let passphrase: string | undefined;
  const ask = async (question: string): Promise<string> => {
    const answer = await io.ask(question);
    if (answer === null) throw new Stop(LEFT);
    return answer.trim();
  };
  const secret = async (question: string): Promise<string> => {
    const answer = await io.secret(question);
    if (answer === null) throw new Stop(LEFT);
    return answer;
  };
  const choose = async (question: string, options: readonly string[]): Promise<number> => {
    for (;;) {
      await io.write(options.map((option, index) => `  ${index + 1}) ${option}`).join("\n") + "\n");
      const answer = await ask(`${question} [1-${options.length}, Enter = 1]: `);
      if (answer === "") return 0;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
      await io.write(`Type a number from 1 to ${options.length}.\n`);
    }
  };
  /** Runs one step until it is done. A part that made progress (the state changed) continues at once; only an attempt that
   * changed nothing (cancelled or failed) asks whether to try again or leave. */
  const until = async (done: () => Promise<boolean>, attempt: () => Promise<void>, what: string, snapshot: () => Promise<string> = async () => ""): Promise<void> => {
    while (!await done()) {
      const before = await snapshot();
      // A refused step (for example a wallet Balchemy will not pair) shows its reason; the owner can try again or leave.
      try { await attempt(); }
      catch (error: unknown) {
        if (!(error instanceof TerminalError)) throw error;
        await io.write(`\n${error.title}: ${error.cause}\n${error.fix}\n`);
      }
      if (await done()) return;
      if (await snapshot() !== before) continue;
      const again = await ask(`${what} is not done yet. Press Enter to try again, or type q to leave: `);
      if (again.toLowerCase() === "q") throw new Stop(`Stopped before: ${what.toLowerCase()}. Run balchemy again to continue.`);
    }
  };

  /** A model from a list: a number, or text to search; Enter takes the first shown. Undefined: type an ID instead. */
  const pickModel = async (models: readonly ModelChoice[]): Promise<ModelChoice | undefined> => {
    let query = "";
    for (;;) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = models.filter((choice) => words.every((word) => `${choice.id} ${choice.label}`.toLowerCase().includes(word)));
      const shown = matches.slice(0, LIST_ROWS);
      if (!shown.length) { await io.write(`No model matches "${query}".\n`); query = ""; continue; }
      await io.write([...shown.map((choice, index) => `  ${index + 1}) ${choice.label}${choice.hint && choice.hint !== choice.label ? `  (${choice.hint})` : ""}`),
        `  ${shown.length + 1}) Type a model ID instead`,
        ...(matches.length > shown.length ? [`  ... ${matches.length - shown.length} more: type part of a name to search.`] : []), ""].join("\n"));
      const answer = await ask(`Model number, or text to search [Enter = 1]: `);
      if (answer === "") return shown[0];
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < shown.length) return shown[index];
      if (index === shown.length) return undefined;
      const exact = models.find((choice) => choice.id === answer);
      if (exact) return exact;
      query = answer;
    }
  };
  const typedModel = async (): Promise<ModelChoice> => {
    for (;;) {
      const value = await ask("Model ID (as on your provider's model page): ");
      if (isPrivateBrainModelId(value)) return { id: value, label: value };
      await io.write("Use a model ID of letters, numbers, dots, underscores, colons or hyphens, optionally vendor/model.\n");
    }
  };
  /** The API key provider. A1 (owner decision): an unfinished option is not shown, so the ChatGPT subscription is not listed until it works. */
  const chooseProvider = async (): Promise<PrivateBrainProvider> => {
    const picked = await choose("How does this agent pay for its AI model?", [`${PRIVATE_BRAIN_PROVIDER_LABELS.openai} API key (GPT models)`,
      `${PRIVATE_BRAIN_PROVIDER_LABELS.anthropic} API key (Claude models)`, `${PRIVATE_BRAIN_PROVIDER_LABELS.openrouter} API key (many models with one key)`]);
    return PROVIDERS[picked] ?? "openai";
  };
  /** Provider, key (checked at once; retry on a clear error) and the live model list. Undefined: not finished this attempt. */
  const chooseProviderAndModel = async (): Promise<{ provider: PrivateBrainProvider; apiKey: string; choice: ModelChoice } | undefined> => {
    const provider = await chooseProvider();
    const label = PRIVATE_BRAIN_PROVIDER_LABELS[provider];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const apiKey = (await secret(`Paste your ${label} API key (hidden; create one at ${KEY_PAGES[provider]}): `)).trim();
      if (!/^[!-~]{1,4096}$/.test(apiKey)) { await io.write("That is not an API key (printable characters only, no spaces). Paste it again.\n"); continue; }
      await io.write(`Checking the key with ${label}...\n`);
      const checked = await deps.models.check(provider, apiKey);
      if (checked.kind === "rejected") { await io.write(`${label} rejected this API key. Check that you copied all of it, then paste it again.\n`); continue; }
      if (checked.kind === "unavailable") { await io.write(`${label} could not be reached to check the key. Nothing was saved. Check your connection and try again.\n`); continue; }
      await io.write(`${label} accepted the key.\n`);
      const choice = checked.models.length ? await pickModel(checked.models) ?? await typedModel() : await typedModel();
      return { provider, apiKey, choice };
    }
    return undefined;
  };
  /** D2: an OpenRouter model's catalog price goes into the budget record, so the USD budget estimates its calls at that price. */
  const capturePrice = async (id: string, provider: PrivateBrainProvider, choice: ModelChoice, value?: string): Promise<void> => {
    if (provider !== "openrouter" || !choice.price) return;
    await io.write(await deps.models.price(id, choice, value)
      ? "Saved this model's OpenRouter price for your daily AI budget.\n"
      : "This model's price could not be stored; the AI budget counts its calls at the highest listed price until it is.\n");
  };
  /** A new passphrase typed twice, under the wallet's policy too (NFC-stable), so it can protect both. */
  const newPassphrase = async (): Promise<string | undefined> => {
    await io.write("Choose a passphrase to encrypt the key on this computer: at least 12 characters. You can use the same one for the trading wallet "
      + "next, so one passphrase unlocks both after a restart. A lost passphrase cannot be recovered.\n");
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const first = await secret("New passphrase (hidden): ");
      if (!isTradingWalletPassphrase(first)) { await io.write("Use at least 12 characters and at most 1024 bytes, without control characters.\n"); continue; }
      const second = await secret("Repeat the passphrase (hidden): ");
      if (second.normalize("NFC") === first.normalize("NFC")) return first;
      await io.write("The two passphrases did not match. Try again.\n");
    }
    return undefined;
  };
  const report = async (result: CockpitModelResult, value: string): Promise<boolean> => {
    if (result.kind === "ok") { passphrase = value; return true; }
    await io.write(result.kind === "wrong_passphrase" ? "Wrong passphrase: it did not open the saved key. Nothing was changed.\n" : `${result.text}\n`);
    return false;
  };
  const currentPassphrase = (purpose: string) => secret(`Passphrase of the saved model key (hidden; ${purpose}): `);

  // Whether this run paired or linked: the ceiling step then waits for the page (otherwise it only shows an open request).
  let fresh = false;
  try {
    // 0 and 1. What you need (a computer with no agent yet), then the agent: the one this computer knows, or a new name.
    const state = await readers.inspect("");
    const known = [...new Set([...state.agents, ...safe(deps.known)])];
    if (known.length === 1) agentId = known[0]!;
    else if (known.length > 1) agentId = known[await step({ kind: "SETUP", title: "Which agent" }, () => choose("Which agent?", known))]!;
    else {
      let named = "main";
      agentId = await step({ kind: "SETUP", title: "Name this agent" }, async () => {
        await io.write(COCKPIT_REQUIREMENTS);
        await io.write("\nA short name for this agent. You will type it in confirmations.\n");
        for (;;) {
          const name = (await ask("Name this agent [Enter = main]: ")) || "main";
          if (isId(name)) { named = name; return name; }
          await io.write("Use letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit.\n");
        }
      }, async () => `Agent name: ${named}.`);
    }
    const id = agentId;
    io.agent?.(id);
    // The runner starts by itself (shadow mode; it cannot trade).
    if (state.process !== "running") {
      await io.write(`\nStarting the runner for ${id}: a small background program on this computer that holds ${id}'s wallet and model key. `
        + "It starts in shadow mode, so it cannot trade.\n");
      if (!await deps.start(id)) throw new Stop("The start was not confirmed. Check balchemy runner status, then run balchemy again.");
    }
    // A runner started by another version lacks the cockpit's runner side (setup guide, balance, card-line filtering), so
    // the cockpit does not use it: the owner restarts it on this version first.
    const versions = await deps.versions();
    if (versions.runner !== versions.cli) {
      // Phase 1: the restart stops exits; say so first when an agent is armed or positions are open (a failed read says nothing more).
      let warning: string | null = null;
      try { warning = deps.shutdownWarning ? await deps.shutdownWarning() : null; } catch { warning = null; }
      throw new Stop(`The runner was started by balchemy ${versions.runner ?? "an older version"}; this is ${versions.cli}. `
        + "Run balchemy runner shutdown, then balchemy again (unlock the trading wallet again afterwards)."
        + (warning ? `\n${warning}\nbalchemy runner shutdown asks you to type SHUTDOWN first; afterwards balchemy shows the positions and asks your passphrase once to unlock and arm again.` : ""));
    }
    // After the version check: an older runner cannot add agents (prepare adds this one when the running runner lacks it).
    await prepare(id);
    // 7 to 10. Chat: the agent takes over; the setup card and later cards open the owner's commands and the chat comes back afterwards.
    // K5b: the owner can switch to another agent (or add a new one) from the chat; the runner is never restarted for it.
    let current = id;
    for (;;) {
      const exit = await deps.openChat(current, await readSetupChecklist(current, readers));
      if (exit.kind === "quit") return { kind: "left", agentId: current };
      if (exit.kind === "switch" || exit.kind === "new") {
        let next = exit.kind === "switch" ? exit.agentId : "";
        try {
          if (exit.kind === "new") {
            let chosen = "";
            next = await step({ kind: "SETUP", title: "New agent" }, async () => {
              await io.write("\nA new agent: it is added to the running runner in shadow mode (it cannot trade). Your other agents keep running as they are.\n");
              for (;;) {
                const name = await ask("Name the new agent (or press Enter to go back): ");
                if (!name || isId(name)) { chosen = name; return name; }
                await io.write("Use letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit.\n");
              }
            }, async () => (chosen ? `New agent: ${chosen}.` : "No new agent was added. Nothing was changed."));
            if (!next) continue;
          }
          if (next === current || !isId(next)) continue;
          await io.write(`\nSwitching to ${next}. ${current} keeps running as it is${exit.kind === "new" ? "" : " (nothing is disarmed)"}.\n`);
          // The next agent's steps write its own rows (they never land in the chat of the agent still on screen).
          io.agent?.(next);
          // Each agent has its own model key and wallet; the passphrase typed for the previous one is not reused.
          passphrase = undefined; fresh = false;
          await prepare(next);
          current = next; agentId = next;
        } catch (error: unknown) {
          // Leaving the other agent's steps returns to this agent's chat; a refused step shows its reason. Nothing was changed for `current`.
          io.agent?.(current);
          if (error instanceof Stop) await io.write(`\n${closedText(error.reason)}\nBack to ${current}.\n`);
          else if (error instanceof TerminalError) await io.write(`\n${error.title}: ${error.cause}\n${error.fix}\nBack to ${current}.\n`);
          else throw error;
        }
        continue;
      }
      try {
        if (exit.card.kind === "model") await step(cardMeta(exit.card), () => modelAttempt(current, true), () => modelRow(current));
        else await deps.runCard(current, exit.card);
      } catch (error: unknown) {
        // A refused or failed command ends only that card: its message is shown and the chat continues. Nothing was retried.
        if (error instanceof Stop) { await io.write(`\n${closedText(error.reason)}\n`); continue; }
        if (!(error instanceof TerminalError)) throw error;
        await io.write(`\n${error.title}: ${error.cause}\n${error.fix}\n`);
      }
      // A1: the chat is still on screen (the card ran inside it); there is no "Press Enter to return to the chat" any more.
    }
  } catch (error: unknown) {
    if (error instanceof Stop) { await io.write(`\n${error.reason}\n`); return { kind: "stopped", ...(agentId ? { agentId } : {}), reason: error.reason }; }
    throw error;
  }

  /** One agent's deterministic steps; each is skipped when already done. Used for the first agent and for every switch or new agent. */
  async function prepare(id: string): Promise<void> {
    // Owner decision of 19 Nov 2026: a running runner without this agent gets it added (shadow, unarmed); every other agent keeps
    // running as it is (armed ones stay armed). Re-read on every call: a switch happens long after the first read.
    const now = await readers.inspect("");
    if (now.process === "running" && !now.agents.includes(id)) {
      await io.write(`\nAdding ${id} to the running runner (shadow mode, so it cannot trade). Your other agents keep running as they are.\n`);
      if (!await deps.register(id)) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Agent not added to the running runner",
        cause: `The runner is running with ${now.agents.join(", ") || "no agents"}; ${id} could not be added.`,
        fix: `Check balchemy runner status, then try: balchemy runner add ${id}. Your other agents were not changed.`, exitCode: 2 });
    }
    // 2 and 3. AI model: provider and API key (checked at once), then a model from the live list; a saved one is kept or changed.
    if (!(await readers.model(id)).ready) {
      await step({ kind: "SETUP", title: "AI model", secret: true },
        () => until(async () => (await readers.model(id)).ready, () => modelAttempt(id, false), "Connecting a model"), () => modelRow(id));
    }
    await stepsAfterModel(id);
  }
  /** The Balchemy row of a finished model card (code-read; the key never appears). */
  async function modelRow(id: string): Promise<string | undefined> {
    if (!(await readers.model(id)).ready) return "The AI model is not connected. Nothing else was changed.";
    const saved = await deps.models.saved(id);
    return saved ? `AI model ready: ${PRIVATE_BRAIN_PROVIDER_LABELS[saved.provider]} / ${saved.model}.` : "AI model ready.";
  }

  /** One model attempt. `fromChat` (the /model card): a ready model can be kept without the passphrase. */
  async function modelAttempt(id: string, fromChat: boolean): Promise<void> {
    {
      const model = await readers.model(id);
      await io.write("\nStep: your AI model. The agent's brain is a model you pay for with your own API key. The key stays on this computer; it is never sent to Balchemy.\n");
      if (model.saved === "unavailable") { await deps.runModel(id, "model"); return; }
      if (model.saved === true) {
        const saved = await deps.models.saved(id);
        const label = saved ? `${PRIVATE_BRAIN_PROVIDER_LABELS[saved.provider]} / ${saved.model}` : "a saved model";
        await io.write(`Saved: ${label}.\n`);
        const ready = fromChat && model.ready;
        const keep = await choose("Keep it or change it?", [ready ? "Keep it" : "Keep it (enter your passphrase)", "Change the model"]) === 0;
        if (keep && ready) { await io.write("Kept. Nothing was changed.\n"); return; }
        if (keep) {
          for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
            const value = await secret("Passphrase (hidden; with one passphrase it also unlocks the trading wallet): ");
            if (await report(await deps.models.unlock(id, value), value)) return;
          }
          return;
        }
        const sameKey = saved ? await choose("What changes?", [`Only the model (same ${PRIVATE_BRAIN_PROVIDER_LABELS[saved.provider]} key; no key needed)`,
          "The provider or the API key"]) === 0 : false;
        if (saved && sameKey) {
          // The key never leaves the runner, so only OpenRouter's public list can be read without it; otherwise the ID is typed.
          const list = saved.provider === "openrouter" ? await deps.models.publicModels() : undefined;
          if (saved.provider === "openrouter" && !list) await io.write("OpenRouter's model list could not be read right now; type the model ID instead.\n");
          const choice = list?.length ? await pickModel(list) ?? await typedModel() : await typedModel();
          const value = await currentPassphrase("it stays the same");
          if (await report(await deps.models.reselect(id, choice.id, value), value)) await capturePrice(id, saved.provider, choice, value);
          return;
        }
        const chosen = await chooseProviderAndModel();
        if (!chosen) return;
        const value = await currentPassphrase("replacing the key needs it; it stays the same");
        if (await report(await deps.models.save(id, { provider: chosen.provider, model: chosen.choice.id, apiKey: chosen.apiKey, passphrase: value }), value)) {
          await capturePrice(id, chosen.provider, chosen.choice, value);
        }
        return;
      }
      const chosen = await chooseProviderAndModel();
      if (!chosen) return;
      const value = await newPassphrase();
      if (value === undefined) return;
      await io.write("Encrypting the key on this computer...\n");
      if (await report(await deps.models.save(id, { provider: chosen.provider, model: chosen.choice.id, apiKey: chosen.apiKey, passphrase: value }), value)) {
        await io.write(`Model ready: ${PRIVATE_BRAIN_PROVIDER_LABELS[chosen.provider]} / ${chosen.choice.id}.\n`);
        await capturePrice(id, chosen.provider, chosen.choice, value);
      }
    }
  }

  async function stepsAfterModel(id: string): Promise<void> {
    // 4. Daily AI budget (the existing budget command; raising above the current limit keeps its typed BUDGET confirmation).
    const budget = deps.budget;
    if (budget && (await budget.read(id))?.set === false) {
      await step({ kind: "SETUP", title: "Daily AI budget" }, () => until(async () => (await budget.read(id))?.set !== false, async () => {
        await io.write("\nStep: daily AI budget. It caps this agent's own AI model API cost (billed by your provider) per UTC day. When it is used up, "
          + "the agent makes no AI calls until 00:00 UTC; stop-loss and take-profit exits never use the model and keep running.\n");
        for (;;) {
          const value = (await ask("Daily AI budget in US dollars, 0.10 to 1000 [Enter = 5]: ")) || "5";
          if (/^(0|[1-9][0-9]{0,3})(?:\.[0-9]{1,2})?$/.test(value) && Number(value) >= 0.1 && Number(value) <= 1000) { await budget.set(id, value); return; }
          await io.write("Use a dollar amount from 0.10 to 1000 with at most two decimals, such as 5.\n");
        }
      }, "The daily AI budget"), async () => { const read = await budget.read(id); return read?.set ? `Daily AI budget: ${read.limit}.` : undefined; });
    }

    // 5. Trading wallet (before the Hub visit, so the Hub page never waits for it): create or import, or unlock after a restart.
    // A secret card: a new wallet's key is shown inside it, and passphrases are typed into it.
    if ((await readers.wallet(id)).wallet !== "unlocked") await step({ kind: "SETUP", title: "Trading wallet", secret: true }, () => until(async () => (await readers.wallet(id)).wallet === "unlocked", async () => {
      const wallet = await readers.wallet(id);
      if (wallet.wallet === "held" || wallet.binding === "held") throw new Stop(`The wallet needs recovery first: balchemy runner wallet ${id} recover`);
      if (wallet.wallet === "unavailable") throw new Stop("The wallet state could not be read. Check balchemy runner status.");
      if (wallet.wallet === "absent") {
        await io.write("\nStep: the agent's own trading wallet. It lives encrypted on this computer, separate from your identity wallet; you fund it with only what it may use.\n"
          + "Press Enter to create a new wallet (recommended), or type i to import one you already have.\n");
        // A1 (KOKPIT-SPEC §8): Enter creates, `i` imports; one passphrase by default, `s` chooses a separate one (no numbered lists).
        const key = async (question: string, other: string): Promise<boolean> => {
          for (;;) {
            const answer = (await ask(question)).toLowerCase();
            if (answer === "" || answer === other) return answer === "";
            await io.write(`Press Enter, or type ${other}.\n`);
          }
        };
        const action = await key("Enter: new wallet · i: import", "i") ? "create" : "import";
        let shared: string | undefined;
        if (passphrase !== undefined && isTradingWalletPassphrase(passphrase)) {
          await io.write("The wallet uses the same passphrase as your model key, so one passphrase unlocks both. Type s to choose a separate wallet passphrase instead.\n");
          if (await key("Enter: same passphrase · s: separate", "s")) shared = passphrase;
        }
        await deps.runWallet(id, action, shared);
        return;
      }
      if (wallet.wallet !== "locked") return;
      // Phase 1 one-step resume: open positions after a restart have no stop-loss until the agent is armed again, so the arm
      // command runs now (positions first, one passphrase for unlock and arm, the typed ARM <agent> kept).
      let open: number | null = null;
      try { open = deps.openPositions && deps.resume ? await deps.openPositions(id) : null; } catch { open = null; }
      if (open !== null && open > 0 && deps.resume) {
        await io.write(`\nThe runner restarted while ${id} holds open positions: their stop-loss and take-profit stay off until you arm it again.\n`);
        await deps.resume(id, passphrase);
        if ((await readers.wallet(id)).wallet !== "locked") return;
        await io.write("The trading wallet is still locked. Enter its passphrase to unlock it (arm later with the arm card).\n");
      } else if (passphrase !== undefined && deps.unlockWallet) {
        // Phase 2: the passphrase that just unlocked the model key is tried once on the wallet (no second prompt with one passphrase).
        const tried = await deps.unlockWallet(id, passphrase);
        if (tried === "unlocked") { await io.write("Trading wallet unlocked with the same passphrase.\n"); return; }
        if (tried === "throttled") { await io.write("\nToo many wrong passphrases in a row: the trading wallet does not accept another try for a few minutes. Nothing was changed.\n"); return; }
        await io.write(tried === "rejected" ? "\nThe trading wallet has its own passphrase. Enter it to unlock the wallet.\n"
          : "\nThe trading wallet unlock could not be confirmed. Enter its passphrase to unlock it.\n");
      } else await io.write("\nThe trading wallet is locked (it locks after every runner start). Enter its passphrase to unlock it.\n");
      await deps.runWallet(id, "unlock");
    }, "The trading wallet", async () => JSON.stringify(await readers.wallet(id))),
    async () => (await readers.wallet(id)).wallet === "unlocked" ? "Trading wallet ready and unlocked." : undefined);

    // 6. ONE Hub visit: pairing (identity only; it grants no trading), then the runner links the wallet and the page asks for the ceiling.
    if (await readers.pairing(id) !== "paired") await step({ kind: "SETUP", title: "Link to your Hub account" }, () => until(async () => await readers.pairing(id) === "paired", async () => {
      await io.write("\nStep: link this runner to your Balchemy account (one browser visit). Your browser opens; you sign in and choose your identity wallet. "
        + "This proves ownership only; it grants no trading.\nAfter you sign, keep that page open: the runner links the trading wallet by itself and the same page asks for your spend ceiling.\n");
      fresh = true;
      await deps.runPairing(id);
    }, "Linking to your Hub account"), async () => await readers.pairing(id) === "paired" ? "Linked to your Hub account (identity only; no trading)." : undefined);
    // A2a seal step (between pairing and the wallet link and the ceiling, whose worker trusts only the sealed owner wallet): the whole Hub
    // wallet address to compare, its last 6 characters, the settings, and the wallet passphrase (a fresh prompt; never the run's own).
    // Existing paired agents get it on their next start (migration). A seal that is only looser than the current settings is not a setup
    // step: arm and /resume open the same card inline.
    const ownerPin = deps.ownerPin;
    if (ownerPin && await readers.pairing(id) === "paired" && await ownerPin.need(id) === "needed") {
      await step({ kind: "CONFIRM", title: "Seal your Hub wallet", secret: true }, () => until(async () => await ownerPin.need(id) !== "needed",
        () => ownerPin.seal(id), "Sealing your Hub wallet"),
      async () => await ownerPin.need(id) === "sealed" ? "Hub wallet and settings sealed on this computer." : undefined);
    }
    if ((await readers.wallet(id)).binding !== "bound") await step({ kind: "WAITING", title: "Linking the trading wallet" }, () => until(async () => (await readers.wallet(id)).binding === "bound", async () => {
      const wallet = await readers.wallet(id);
      if (wallet.binding === "held") throw new Stop(`The wallet link needs recovery first: balchemy runner wallet ${id} recover`);
      if (wallet.binding === "unavailable") throw new Stop("Balchemy could not be reached to check the wallet link. Check your connection, then run balchemy again.");
      if (wallet.wallet !== "unlocked") return;
      await io.write("\nLinking this trading wallet to your Hub account, so Balchemy accepts its trades. The runner does it by itself; nothing to type.\n");
      fresh = true;
      await deps.waitForLink(id);
    }, "Linking the trading wallet", async () => JSON.stringify(await readers.wallet(id))),
    async () => (await readers.wallet(id)).binding === "bound" ? "Trading wallet linked to your Hub account." : undefined);
    // K2: the spend ceiling on the same Hub page (skippable; arming asks for an approval otherwise). Its card opens only when it waits.
    if (deps.ceiling) await deps.ceiling(id, fresh);
  }
}
function safe(read: () => string[]): string[] { try { return read(); } catch { return []; } }
