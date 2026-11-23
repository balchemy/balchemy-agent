import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { applyPromptEditorInput, getPromptViewport, isTranscriptPageDownInput, isTranscriptPageUpInput,
  type PromptEditorState, type PromptInputKey } from "./ChatPanel.js";
import { wrapText } from "./text-layout.js";
import { enterInteractiveScreen, leaveInteractiveScreen, openInteractiveTerminal } from "./terminal-session.js";
import { requestPrivateBrain, type PrivateBrainTarget } from "../runner/private-brain-client.js";
import { PrivateChatSession, PRIVATE_CHAT_BOUNDARY, privateBrainBinding, privateBrainErrorMessage, privateModelSummary, privateVaultSummary, readPrivateModelStatus,
  type PrivateBrainTransport } from "../runner/private-brain-ui.js";
import { isPrivateModelPassphrase, type PrivateBrainModelState, type PrivateBrainProvider, type PrivateBrainVaultState, type PrivateBrainRequest } from "../runner/private-brain-protocol.js";
import { isPrivateBrainModelId, isPrivateBrainProvider, PRIVATE_BRAIN_PROVIDER_LABELS } from "../runner/private-brain-providers.js";
import { fetchProviderModels, ModelCatalogError, type ModelCatalogFetch, type ModelChoice } from "../runner/private-model-catalog.js";
import { splitSetupCard } from "../runner/private-setup-card.js";
import { exchangeWithSocketProof, socketProofText, socketProofUnlock } from "../runner/private-socket-proof-client.js";
import type { PrivateTradingWalletTransport } from "../runner/private-trading-keystore-client.js";
import { applyChoiceInput, ChoiceListView, EMPTY_CHOICE_STATE, filterChoices, type Choice, type ChoiceListState } from "./choice-list.js";

const EMPTY: PromptEditorState = { value: "", cursorIndex: 0 };
export function applyPrivateInput(state: PromptEditorState, input: string, key: PromptInputKey, secret: boolean | "passphrase"): { state: PromptEditorState; error?: string } {
  const erase = key.backspace || key.delete || input === "\u0008" || input === "\u007f" || /^(?:\u001b)?\[?3(?:;\d+)*~$/.test(input);
  const editing = erase || key.ctrl || key.meta || key.escape || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end || key.tab;
  if (!editing && (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(input) || (secret === true && /[^!-~]/.test(input)) || (secret === "passphrase" && (/[\u0000-\u001f\u007f-\u009f]/u.test(input) || Buffer.from(input, "utf8").toString("utf8") !== input)))) {
    return { state, error: "Control characters and unsupported input were rejected." };
  }
  const next = applyPromptEditorInput(state, secret ? input : input.replace(/\t/g, " "), key);
  if ((secret === true && next.value.length > 4096) || (secret === "passphrase" && Buffer.byteLength(next.value, "utf8") > 1024) || (!secret && Buffer.byteLength(JSON.stringify(next.value), "utf8") > 8192)) {
    return { state, error: secret === "passphrase" ? "Passphrase exceeds 1024 UTF-8 bytes." : secret ? "API key exceeds 4096 characters." : "Message exceeds 8 KiB (JSON UTF-8)." };
  }
  return { state: next };
}
export function PrivatePromptView({ state, width, secret, placeholder }: { state: PromptEditorState; width: number; secret: boolean; placeholder: string }): React.ReactElement {
  const safeValue = secret ? "•".repeat(Array.from(state.value).length) : state.value;
  const viewport = getPromptViewport(safeValue, state.cursorIndex, Math.max(1, width - 1));
  const characters = Array.from(viewport.text);
  return <Box width={width}>{state.value.length ? <Text>{characters.slice(0, viewport.cursorIndex).join("")}<Text color="cyan">▌</Text>{characters.slice(viewport.cursorIndex).join("")}</Text>
    : <Text><Text color="cyan">▌</Text><Text dimColor>{Array.from(placeholder).slice(0, Math.max(0, width - 1)).join("")}</Text></Text>}</Box>;
}
/** Single input owner for editing, masked keys, paging and terminal detachment. */
function useSecretInput(options: { secret: boolean | "passphrase"; active: boolean; focus: boolean; onSubmit: (text: string) => void;
  onDetach: () => void; onFocus: () => void; onPage: (direction: number) => void; onError: (message: string) => void; inputKey: string }) {
  const [state, setState] = useState<PromptEditorState>(EMPTY);
  const submitting = useRef(false);
  useEffect(() => { setState(EMPTY); submitting.current = false; }, [options.inputKey]);
  useInput((input, key) => {
    if ((key.ctrl && (input === "c" || input === "q")) || (key.escape && !options.focus)) { setState(EMPTY); options.onDetach(); return; }
    if ((key.ctrl && input === "f") || (key.escape && options.focus)) { options.onFocus(); return; }
    if (key.pageUp || isTranscriptPageUpInput(input)) { options.onPage(1); return; }
    if (key.pageDown || isTranscriptPageDownInput(input)) { options.onPage(-1); return; }
    if (options.focus) { if (key.upArrow) options.onPage(0.1); if (key.downArrow) options.onPage(-0.1); return; }
    if (!options.active || submitting.current) return;
    if (key.return) {
      const value = options.secret ? state.value : state.value.trim(); if (!value) return;
      submitting.current = true; setState(EMPTY); options.onSubmit(value);
      queueMicrotask(() => { submitting.current = false; }); return;
    }
    const next = applyPrivateInput(state, input, key, options.secret); setState(next.state);
    if (next.error) options.onError(next.error);
  });
  return state;
}
/** `wallet-passphrase` (A2a): the daemon answered `proof_required` or `wallet_locked` to a model change; the trading wallet's passphrase is
 * asked (masked) and the same change is sent again with it. */
type ModelStep = "loading" | "auth" | "provider" | "key" | "listing" | "model" | "model-manual" | "passphrase" | "confirm-passphrase" | "lock" | "sending"
  | "wallet-passphrase" | "done";
const PICKER_STEPS: readonly ModelStep[] = ["auth", "provider", "model"];
const TEXT_STEPS: readonly ModelStep[] = ["key", "model-manual", "passphrase", "confirm-passphrase", "lock", "wallet-passphrase"];
const SECRET_STEPS: readonly ModelStep[] = ["key", "passphrase", "confirm-passphrase", "wallet-passphrase"];
/** Never a model ID: IDs cannot contain spaces. */
const MANUAL_MODEL = " manual";
const AUTH_CHOICES: readonly Choice[] = Object.freeze([
  { value: "api_key", label: "API key", hint: "OpenAI, Anthropic or OpenRouter; the provider bills you per use" },
  { value: "subscription", label: "ChatGPT subscription", hint: "not available in this version" },
]);
const PROVIDER_KEY_PAGES: Readonly<Record<PrivateBrainProvider, string>> = Object.freeze({
  openai: "platform.openai.com/api-keys", anthropic: "console.anthropic.com/settings/keys", openrouter: "openrouter.ai/keys",
});
const PROVIDER_CHOICES: readonly Choice[] = Object.freeze([
  { value: "openai", label: PRIVATE_BRAIN_PROVIDER_LABELS.openai, hint: "GPT models" },
  { value: "anthropic", label: PRIVATE_BRAIN_PROVIDER_LABELS.anthropic, hint: "Claude models" },
  { value: "openrouter", label: PRIVATE_BRAIN_PROVIDER_LABELS.openrouter, hint: "hundreds of models from many vendors with one key" },
]);
const defaultCatalog: ModelCatalogFetch = (provider, apiKey, signal) => fetchProviderModels(provider, apiKey, { signal });
interface LocalRunnerChatProps { target: PrivateBrainTarget; mode: "chat" | "model" | "model-lock" | "model-save" | "model-unlock"; transport?: PrivateBrainTransport;
  /** Reads the provider's model list for the picker; tests inject a fixture. */
  catalog?: ModelCatalogFetch; onDetach?: (jobIds: readonly string[]) => void; onJobIds?: (jobIds: readonly string[]) => void;
  /** A2a: the trading wallet unlock of a model change answered `wallet_locked` (tests inject a fixture). */
  walletTransport?: PrivateTradingWalletTransport }
export function LocalRunnerChat({ target, mode, transport = requestPrivateBrain, catalog = defaultCatalog, onDetach, onJobIds, walletTransport }: LocalRunnerChatProps): React.ReactElement {
  const { exit } = useApp(), { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 80, height: stdout.rows || 24 });
  const session = useMemo(() => new PrivateChatSession(target, { transport }), [target, transport]);
  const chat = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const [model, setModel] = useState<PrivateBrainModelState>();
  const [vault, setVault] = useState<PrivateBrainVaultState>();
  const secrets = useRef({ apiKey: "", passphrase: "" });
  const clearSecrets = () => { secrets.current = { apiKey: "", passphrase: "" }; };
  const [step, setStep] = useState<ModelStep>("loading");
  const [provider, setProvider] = useState<PrivateBrainProvider>("openai"), [modelId, setModelId] = useState("");
  const [models, setModels] = useState<ModelChoice[]>([]), [picker, setPicker] = useState<ChoiceListState>(EMPTY_CHOICE_STATE);
  const [notice, setNotice] = useState("Connecting to the local assistant…"), [inputError, setInputError] = useState("");
  const [focus, setFocus] = useState(false), [scroll, setScroll] = useState(0);
  const alive = useRef(true), mutation = useRef(false), listing = useRef<AbortController | undefined>(undefined);
  /** A2a: the pending answer of the trading-wallet passphrase step (null on leave). The typed value goes only into the one exchange. */
  const walletAnswer = useRef<((value: string | null) => void) | undefined>(undefined);
  const endWalletAnswer = () => { const answer = walletAnswer.current; walletAnswer.current = undefined; answer?.(null); };
  const askWalletPassphrase = (label: string): Promise<string | null> => new Promise((resolve) => {
    if (!alive.current) { resolve(null); return; }
    walletAnswer.current = resolve; setInputError(""); setStep("wallet-passphrase");
    setNotice(`${label.replace(/[\s:]+$/, "")}. This model change needs your trading wallet passphrase (masked; it is never stored). Esc or Ctrl+Q leaves without changing anything.`);
  });
  useEffect(() => { onJobIds?.([...new Set([...chat.replies.map((reply) => reply.jobId), ...(chat.jobId ? [chat.jobId] : [])])]); }, [chat.jobId, chat.replies, onJobIds]);
  useEffect(() => {
    alive.current = true;
    const resize = () => setSize({ width: stdout.columns || 80, height: stdout.rows || 24 }); stdout.on("resize", resize);
    if (mode === "chat") void session.connect();
    else void transport(target.socketPath, { ...privateBrainBinding(target), action: "model_status" }).then((response) => {
      if (!alive.current) return;
      if (!response.ok) { setStep("done"); setNotice(privateBrainErrorMessage(response.error)); return; }
      if (!response.model) { setStep("done"); setNotice("The model state could not be confirmed."); return; }
      setModel(response.model); setVault(response.vault);
      if ((mode === "model-save" || mode === "model-unlock") && response.vault.saved === "unavailable") {
        setStep("done"); setNotice("Encrypted storage is unavailable. Keep the existing record; temporary configuration and memory lock remain available.");
      } else if (mode === "model-unlock" && !response.vault.saved) {
        setStep("done"); setNotice(privateBrainErrorMessage("vault_missing"));
      } else {
        setStep(mode === "model-lock" ? "lock" : mode === "model-unlock" ? "passphrase" : "auth");
        setNotice(mode === "model-lock" ? "Locking removes the model key from daemon memory and cancels active assistant jobs. Encrypted credentials and saved jobs remain; the daemon keeps running."
          : mode === "model-unlock" ? "Enter the saved model passphrase. Unlock selects this saved revision and cancels active assistant jobs. Closing the terminal leaves it unlocked until lock or restart."
          : `How will this agent pay for its AI model? ${mode === "model-save" ? "This saves the key encrypted on this computer" : "This keeps the key in runner memory only (gone after a restart)"}; nothing is sent to Balchemy.`);
      }
    }).catch(() => { if (alive.current) { setStep("done"); setNotice("Local runner unavailable. Inspect runner status before reconnecting."); } });
    return () => { alive.current = false; listing.current?.abort(); clearSecrets(); endWalletAnswer(); session.detach(); stdout.off("resize", resize); };
  }, [mode, session, stdout, target, transport]);
  const detach = () => { alive.current = false; listing.current?.abort(); clearSecrets(); endWalletAnswer(); session.detach();
    const current = session.snapshot();
    onDetach?.([...new Set([...current.replies.map((reply) => reply.jobId), ...(current.jobId ? [current.jobId] : [])])]); exit(); };
  /** A runner started by 0.6.0 refuses a provider or model ID it does not know; say how to restart it on the new version. */
  const olderRunnerHint = (selectedModel: string) => provider === "openrouter" || selectedModel.includes("/")
    ? " If the runner was started by an older balchemy version, it does not know this provider: run balchemy runner shutdown, then balchemy runner start." : "";
  async function refreshModelAfterFailure(explanation: string, unknownOutcome: boolean): Promise<void> {
    clearSecrets(); setModel(undefined); setVault(undefined);
    setNotice(`${explanation} Reading current model status; no change will be resent.`);
    try {
      const current = await readPrivateModelStatus(target, transport);
      if (!alive.current) return;
      if (current.ok && current.model) {
        setModel(current.model); setVault(current.vault);
        setNotice(`${explanation} Current state is shown; ${unknownOutcome ? "this does not confirm the earlier operation" : "the failed operation was not retried"}. No change was resent.`);
      } else setNotice(`${explanation} Current state could not be confirmed. Read runner model-status before any further change. No change was resent.`);
    } catch {
      if (alive.current) setNotice(`${explanation} Current state is unavailable. Read runner model-status before any further change. No change was resent.`);
    }
    if (alive.current) setStep("done");
  }
  function enterPassphraseStep(): void {
    setStep("passphrase"); setPicker(EMPTY_CHOICE_STATE);
    setNotice(vault?.saved === true ? "Enter the current saved passphrase. Enter replaces the encrypted record, selects the new model and cancels active assistant jobs."
      : "Choose a passphrase of at least 12 characters and at most 1024 UTF-8 bytes to encrypt the key on this computer. Spaces are preserved. A lost passphrase cannot be recovered.");
  }
  async function loadModels(selected: PrivateBrainProvider): Promise<void> {
    setStep("listing"); setNotice(`Loading the ${PRIVATE_BRAIN_PROVIDER_LABELS[selected]} models your key can use…`);
    const controller = new AbortController(); listing.current = controller;
    try {
      const list = await catalog(selected, secrets.current.apiKey, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (list.length === 0) throw new ModelCatalogError("unavailable");
      setModels(list); setPicker(EMPTY_CHOICE_STATE); setStep("model");
      setNotice(`Choose a model.${selected === "openrouter" ? " Type part of a name (for example claude, gpt or llama) to search." : ""}${mode === "model"
        ? " Enter puts it in runner memory now and cancels active assistant jobs." : " Next you choose the passphrase that encrypts the key."}`);
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      if (error instanceof ModelCatalogError && error.code === "unauthorized") {
        secrets.current.apiKey = ""; setStep("key");
        setInputError(`${PRIVATE_BRAIN_PROVIDER_LABELS[selected]} did not accept this API key. Paste it again, or press Esc to leave.`); return;
      }
      setStep("model-manual");
      setNotice("The model list could not be loaded (your key was kept). Type the exact model ID from your provider's model page.");
    } finally { if (listing.current === controller) listing.current = undefined; }
  }
  async function afterModel(selected: string): Promise<void> {
    setModelId(selected);
    if (mode === "model-save") { enterPassphraseStep(); return; }
    await apply("", selected);
  }
  async function choose(value: string): Promise<void> {
    setInputError("");
    if (step === "auth") {
      if (value === "subscription") {
        setInputError("Signing in with a ChatGPT subscription is not available in this version yet. Choose API key: you can create one at platform.openai.com/api-keys.");
        return;
      }
      setPicker(EMPTY_CHOICE_STATE); setStep("provider"); setNotice("Choose the provider whose API key you have.");
      return;
    }
    if (step === "provider") {
      if (!isPrivateBrainProvider(value)) return;
      setProvider(value); setPicker(EMPTY_CHOICE_STATE); setStep("key");
      setNotice(`Paste your ${PRIVATE_BRAIN_PROVIDER_LABELS[value]} API key (create one at ${PROVIDER_KEY_PAGES[value]}). It is masked and stays on this computer. Next, the list of models it can use is loaded.`);
      return;
    }
    if (step === "model") {
      if (value === MANUAL_MODEL) { setStep("model-manual"); setNotice("Type the exact model ID from your provider's model page."); return; }
      if (!isPrivateBrainModelId(value)) return;
      await afterModel(value);
    }
  }
  async function submit(value: string): Promise<void> {
    setInputError("");
    if (value === "/exit" && !SECRET_STEPS.includes(step)) { detach(); return; }
    if (step === "wallet-passphrase") {
      const answer = walletAnswer.current;
      if (!answer) return;
      if (!isPrivateModelPassphrase(value)) { setInputError("Use at least 12 characters and at most 1024 UTF-8 bytes, without control characters. Spaces are preserved."); return; }
      walletAnswer.current = undefined; setStep("sending"); setNotice("Applying this model revision…");
      answer(value); return;
    }
    if (mode === "chat") {
      setScroll(0);
      if (value === "/check") await session.check();
      else if (value === "/retry" && chat.retryAllowed) await session.retrySame();
      else if (chat.phase === "ready") await session.submit(value);
      else setInputError(chat.retryAllowed ? "Use /check or /retry for this same job, or /exit." : "Use /check for this job or /exit. New messages wait for a confirmed result.");
      return;
    }
    if (step === "key") {
      if (!/^[!-~]{1,4096}$/.test(value)) { setInputError("Enter a non-empty printable API key, at most 4096 characters."); return; }
      // One list read at a time: a second Enter while it loads is ignored.
      if (listing.current) return;
      secrets.current.apiKey = value; await loadModels(provider); return;
    }
    if (step === "model-manual") {
      if (!isPrivateBrainModelId(value)) { setInputError("Use a model ID of 1–160 letters, numbers, dots, underscores, colons or hyphens, optionally vendor/model."); return; }
      await afterModel(value); return;
    }
    if (!["lock", "passphrase", "confirm-passphrase"].includes(step) || !model || !vault || mutation.current) return;
    if (step === "lock" && value !== `LOCK ${target.agentId}`) { setInputError(`Type LOCK ${target.agentId} exactly, or /exit.`); return; }
    if (step === "passphrase" || step === "confirm-passphrase") {
      if (!isPrivateModelPassphrase(value)) { setInputError("Use at least 12 characters and at most 1024 UTF-8 bytes, without control characters. Spaces are preserved."); return; }
      if (mode === "model-save" && vault.saved === false && step === "passphrase") {
        secrets.current.passphrase = value; setStep("confirm-passphrase");
        setNotice("Repeat the passphrase exactly. Enter saves encrypted credentials, selects this model and cancels active assistant jobs. Restart requires explicit unlock."); return;
      }
      if (step === "confirm-passphrase" && value !== secrets.current.passphrase) { setInputError("Passphrases do not match. Repeat the original passphrase exactly, or leave to start again."); return; }
    }
    await apply(value, modelId);
  }
  /** The single mutation of this screen: one request, never resent after a lost answer. A2a: a validated `proof_required` or
   * `wallet_locked` answer (nothing changed) to a model change is answered once with the trading-wallet proof (a fresh frame id); a saved
   * model's passphrase is tried as that proof first (one passphrase by default), then the wallet's own is asked. */
  async function apply(value: string, selectedModel: string): Promise<void> {
    if (!model || !vault || mutation.current) return;
    mutation.current = true; setStep("sending"); setNotice("Applying this model revision…");
    let apiKey = secrets.current.apiKey; let passphrase = value;
    const proven = (walletPassphrase: string | undefined) => (walletPassphrase !== undefined ? { walletPassphrase } : {});
    const revision = model.revision;
    let build: ((walletPassphrase?: string) => PrivateBrainRequest) | undefined;
    if (mode === "model-lock") build = () => ({ ...privateBrainBinding(target), action: "model_lock", expectedRevision: revision });
    else if (mode === "model-unlock" && vault.saved === true) {
      const expectedVaultRevision = vault.revision;
      build = () => ({ ...privateBrainBinding(target), action: "model_unlock", expectedRevision: revision, expectedVaultRevision, passphrase });
    } else if (mode === "model-save" && vault.saved !== "unavailable") {
      const expectedVaultRevision = vault.revision;
      build = (walletPassphrase) => ({ ...privateBrainBinding(target), action: "model_save", expectedRevision: revision, expectedVaultRevision, provider,
        model: selectedModel, apiKey, passphrase, ...proven(walletPassphrase) });
    } else if (mode === "model") {
      build = (walletPassphrase) => ({ ...privateBrainBinding(target), action: "model_configure", expectedRevision: revision, provider, model: selectedModel,
        apiKey, ...proven(walletPassphrase) });
    } else { clearSecrets(); setStep("done"); setNotice("The selected model operation is unavailable. Read model-status before continuing."); return; }
    clearSecrets();
    const proof = mode === "model-save" || mode === "model";
    try {
      const outcome = await exchangeWithSocketProof({ build, send: (request) => transport(target.socketPath, request),
        error: (reply) => (reply.ok ? undefined : reply.error), secret: proof ? askWalletPassphrase : null,
        ...(mode === "model-save" ? { known: passphrase } : {}), ...(proof ? { unlock: socketProofUnlock(target, walletTransport) } : {}) });
      build = undefined; apiKey = ""; passphrase = ""; value = "";
      if (!alive.current) return;
      setStep("done");
      if (outcome.kind === "cancelled") { await refreshModelAfterFailure("The trading wallet passphrase was not entered. Nothing was changed.", false); return; }
      if (outcome.kind !== "response") { await refreshModelAfterFailure(socketProofText(outcome, target.agentId), false); return; }
      const response = outcome.response;
      if (!response.ok) await refreshModelAfterFailure(`${privateBrainErrorMessage(response.error)}${response.error === "invalid_request" ? olderRunnerHint(selectedModel) : ""}`, false);
      else if (response.model) {
        setModel(response.model); setVault(response.vault);
        setNotice(mode === "model-lock" ? "Model locked. Encrypted credentials and saved jobs remain."
          : mode === "model-save" ? "Encrypted model saved and selected in daemon memory. Restart requires explicit unlock. Provider access is checked on the first request; autonomous execution stays unavailable."
          : mode === "model-unlock" ? "Saved model unlocked in daemon memory. Closing this terminal leaves it unlocked until lock or restart. Provider access is checked on the first request; autonomous execution stays unavailable."
          : "Model configured in daemon memory. Provider access is checked on the first request; autonomous execution stays unavailable.");
      }
    } catch {
      build = undefined; apiKey = ""; passphrase = ""; value = "";
      if (!alive.current) return;
      await refreshModelAfterFailure(`Acknowledgement lost.${olderRunnerHint(selectedModel)}`, true);
    }
  }
  const width = Math.max(1, Math.min(120, size.width)), height = Math.max(1, size.height);
  const activeModel = mode === "chat" ? chat.model : model;
  const activeVault = mode === "chat" ? chat.vault : vault;
  const secretMode = mode !== "chat" && step === "key" ? true
    : mode !== "chat" && (step === "passphrase" || step === "confirm-passphrase" || step === "wallet-passphrase") ? "passphrase" : false;
  const pickerActive = mode !== "chat" && PICKER_STEPS.includes(step);
  const pinned: readonly Choice[] = step === "model" ? [{ value: MANUAL_MODEL, label: "Type a model ID instead…" }] : [];
  const pickerSource: readonly Choice[] = step === "auth" ? AUTH_CHOICES : step === "provider" ? PROVIDER_CHOICES
    : step === "model" ? models.map((choice) => ({ value: choice.id, label: choice.label, ...(choice.hint ? { hint: choice.hint } : {}) })) : [];
  const filterable = step === "model";
  const shown = pickerActive ? filterChoices(pickerSource, filterable ? picker.query : "", pinned) : [];
  // A setup card line is for the cockpit; here it becomes a pointer to the cockpit and, since A1 keeps CLI commands out of the reply
  // text, to this command line's own review command for the same proposal.
  const content = mode === "chat" ? chat.replies.flatMap((reply) => {
    const { text, card } = splitSetupCard(reply.text);
    const review = card?.kind === "rules_review" ? `balchemy runner rules ${target.agentId} solana review ${card.proposalId}`
      : card?.kind === "limits_review" ? `balchemy runner wallet ${target.agentId} limits review ${card.proposalId}` : undefined;
    return [`Job ${reply.jobId}`, text, ...(card ? [`(Open this proposal as a card in the cockpit: run balchemy, then Ctrl+E.${review ? ` Or review it here: ${review}` : ""})`] : []), ""];
  }) : [];
  const lines = content.flatMap((line) => wrapText(line, width));
  const selection = ["key", "listing", "model", "model-manual", "passphrase", "confirm-passphrase"].includes(step) && mode !== "model-unlock"
    ? [`Selection: ${PRIVATE_BRAIN_PROVIDER_LABELS[provider]}${modelId && step !== "model" && step !== "model-manual" ? ` / ${modelId}` : ""} · revision ${model?.revision}`] : [];
  const heading = [`Local assistant · ${target.agentId}`, activeModel ? privateModelSummary(activeModel) : step === "loading" ? "Model state: checking" : "Model state: unconfirmed",
    ...(activeVault ? [privateVaultSummary(activeVault)] : []), PRIVATE_CHAT_BOUNDARY, ...(mode === "chat" && chat.jobId ? [`Job ${chat.jobId}`, `Resume: balchemy runner result ${target.agentId} ${chat.jobId}`] : []),
    mode === "chat" ? chat.notice : notice, ...selection,
    ...(inputError ? [inputError] : [])].flatMap((line) => wrapText(line, width));
  const footer = mode === "chat" ? "Ctrl+Q detach · Ctrl+F read/copy · PgUp/PgDn scroll" : "Ctrl+Q or Esc to leave · Lock clears active credentials";
  const headerLimit = Math.max(3, height - 5);
  const visibleHeading = heading.length <= headerLimit ? heading : heading.slice(0, 2).concat(heading.slice(-(headerLimit - 2)));
  const footerRows = wrapText(footer, width);
  const bodyRows = Math.max(1, height - (focus ? 0 : visibleHeading.length + footerRows.length + 1));
  const offset = Math.min(scroll, Math.max(0, lines.length - bodyRows));
  const visible = lines.slice(Math.max(0, lines.length - offset - bodyRows), lines.length - offset);
  const input = useSecretInput({ secret: secretMode, active: mode === "chat" ? chat.phase !== "loading" : TEXT_STEPS.includes(step), focus,
    inputKey: mode === "chat" ? "chat" : step, onSubmit: (value) => { void submit(value); }, onDetach: detach,
    onFocus: () => { if (mode === "chat") setFocus((value) => !value); }, onPage: (direction) => setScroll((value) => Math.max(0, Math.min(Math.max(0, lines.length - bodyRows), value + Math.sign(direction) * (Math.abs(direction) < 1 ? 1 : bodyRows)))), onError: setInputError });
  useInput((value, key) => {
    if (!pickerActive || mutation.current || (key.ctrl && (value === "c" || value === "q")) || key.escape) return;
    const next = applyChoiceInput(picker, value, key, shown.length, filterable);
    setPicker(next.state);
    if (next.submit) { const chosen = shown[next.state.index]; if (chosen) void choose(chosen.value); }
  });
  // The picker replaces the transcript area and the prompt line; the bottom line of the list carries its own key help.
  const listRows = Math.max(1, bodyRows - (filterable ? 2 : 1));
  return <Box flexDirection="column" width={width} height={height}>
    {!focus && visibleHeading.map((line, index) => <Text key={`h${index}`} color={index === 0 ? "cyan" : undefined}>{line}</Text>)}
    {pickerActive
      ? <Box flexDirection="column" height={bodyRows + 1} justifyContent="flex-end"><ChoiceListView choices={shown} state={picker} width={width} rows={listRows}
        filterable={filterable} total={pickerSource.length} noun="models" pinned={pinned.length} /></Box>
      : <Box flexDirection="column" height={bodyRows} justifyContent="flex-end">{visible.length ? visible.map((line, index) => <Text key={index}>{line}</Text>) : <Text dimColor>{focus ? "No completed replies yet." : step === "listing" ? "Loading…" : " "}</Text>}</Box>}
    {!focus && <>{!pickerActive && <PrivatePromptView state={input} secret={Boolean(secretMode)} width={width} placeholder={mode === "chat" ? chat.phase === "ready" ? "Research, draft rules, or /exit" : chat.retryAllowed ? "/check, /retry (same job), or /exit" : "/check or /exit"
      : step === "model-manual" ? "Model ID, e.g. gpt-5.4-mini or openai/gpt-5.4-mini" : step === "key" ? "API key (masked)" : step === "passphrase" ? "Passphrase (masked)" : step === "confirm-passphrase" ? "Repeat passphrase (masked)"
      : step === "wallet-passphrase" ? "Trading wallet passphrase (masked)" : step === "lock" ? `LOCK ${target.agentId}` : "Ctrl+Q to detach"} />}
      {footerRows.map((line, index) => <Text key={`f${index}`} dimColor>{line}</Text>)}</>}
  </Box>;
}
export async function startLocalRunnerChat(target: PrivateBrainTarget, mode: LocalRunnerChatProps["mode"]): Promise<void> {
  const terminal = openInteractiveTerminal(); let jobIds: readonly string[] = [];
  const remember = (ids: readonly string[]) => { jobIds = ids; };
  enterInteractiveScreen(terminal.stdout, terminal.stdin);
  const app = render(<LocalRunnerChat target={target} mode={mode} onDetach={remember} onJobIds={remember} />, {
    stdin: terminal.stdin, stdout: terminal.stdout, stderr: terminal.stderr, exitOnCtrlC: false,
  });
  const detach = () => app.unmount(); process.once("SIGTERM", detach); process.once("SIGHUP", detach);
  try { await app.waitUntilExit(); }
  finally { process.off("SIGTERM", detach); process.off("SIGHUP", detach); app.unmount(); leaveInteractiveScreen(terminal.stdout, terminal.stdin); terminal.dispose(); }
  process.stdout.write("Detached from the local assistant. The daemon and its jobs were not cancelled.\n");
  for (const jobId of jobIds) process.stdout.write(`Read result: balchemy runner result ${target.agentId} ${jobId}\n`);
}
