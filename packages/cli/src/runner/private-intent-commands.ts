/** Local owner preview UI. It cannot approve, sign, arm or broadcast. */
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { CliFlags } from "../cli-options.js";
import { TerminalError } from "../errors.js";
import { readPrivateBrainTarget, type PrivateBrainTarget } from "./private-brain-client.js";
import { knownRunnerAgents, runnerNotRunningError } from "./not-running.js";
import { requestRunner } from "./client.js";
import { privateRuleBinding, requestPrivateRule } from "./private-rule-client.js";
import { privateRuleJson } from "./private-rule-commands.js";
import { isId } from "./protocol.js";
import { parsePrivateSolanaPreviewRequest, type PrivateSolanaIntentPreview } from "./private-solana-intent-preview.js";
import { privateIntentBinding, requestPrivateIntent, PrivateIntentTransportError, type PrivateIntentTransport } from "./private-intent-client.js";
import { parsePrivateIntentResponse } from "./private-intent-protocol.js";

export interface IntentPrompt { ask(question: string): Promise<string | null>; close(): void }
interface Options {
  args: string[]; directory: string; interactive: boolean;
  flags: Pick<CliFlags, "json" | "ci" | "yes" | "force" | "dryRun" | "quiet">;
  write(text: string): void | Promise<void>;
  resolveTarget?(agentId: string): PrivateBrainTarget;
  transport?: PrivateIntentTransport;
  prerequisites?(target: PrivateBrainTarget): Promise<{ version: number; revisionId: `brr_${string}` | null }>;
  createPrompt?(): IntentPrompt;
}
export type IntentCommandResult = { kind: "preview" | "historical"; preview: PrivateSolanaIntentPreview }
  | { kind: "cancelled" } | { kind: "dry_run" }
  | { kind: "not_found"; intentId: string } | { kind: "outcome_unknown"; intentId: string };
function invalid(): never { throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid local intent command",
  cause: "Use runner intent <agent> solana preview, or runner intent <agent> solana show <intent-id>.",
  fix: "Enter the exact asset reference, SOL amount and slippage in the local interactive preview prompt. This does not place an order.", exitCode: 2 }); }
export function createIntentPrompt(): IntentPrompt {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 });
  let pending: ((value: string | null) => void) | undefined; let closed = false;
  rl.on("line", (line) => { const resolve = pending; pending = undefined; resolve?.(line); });
  rl.on("close", () => { closed = true; const resolve = pending; pending = undefined; resolve?.(null); });
  rl.on("SIGINT", () => rl.close());
  return { ask: (question) => new Promise((resolve) => {
    if (closed) { resolve(null); return; }
    rl.write("", { ctrl: true, name: "u" }); pending = resolve; rl.setPrompt(question); rl.prompt();
  }), close: () => rl.close() };
}
async function prerequisites(target: PrivateBrainTarget): Promise<{ version: number; revisionId: `brr_${string}` | null }> {
  const runtime = await requestRunner(target.socketPath, { version: 1, id: randomUUID(), action: "status", agentId: target.agentId });
  const rules = await requestPrivateRule(target.socketPath, { ...privateRuleBinding({ ...target, chain: "solana" }), action: "head" });
  if (!runtime.ok || !runtime.state || !rules.ok || rules.data.kind !== "head") throw new Error("Private preview state unavailable");
  return { version: runtime.state.version, revisionId: rules.data.head.revisionId };
}
export async function runPrivateIntentCommand(options: Options): Promise<IntentCommandResult> {
  const [agentId, chain, action, intentId] = options.args;
  if (!isId(agentId) || chain !== "solana" || options.flags.yes || options.flags.force || options.flags.quiet
    || (action === "preview" ? options.args.length !== 3 : action !== "show" || options.args.length !== 4 || !isId(intentId))) invalid();
  if (options.flags.dryRun) return { kind: "dry_run" };
  if (action === "preview" && (!options.interactive || options.flags.json || options.flags.ci)) throw new TerminalError({
    code: "TERMINAL_UNSUPPORTED_TUI", title: "Interactive preview required", cause: "Only explicit owner input supplies a proposed amount.",
    fix: "Use a terminal for preview. The show command supports --json and never creates an intent.", exitCode: 2 });
  let discovered: PrivateBrainTarget;
  if (options.resolveTarget) discovered = options.resolveTarget(agentId);
  else {
    try { discovered = readPrivateBrainTarget(options.directory, agentId); }
    catch { throw runnerNotRunningError(agentId, knownRunnerAgents(options.directory)); }
  }
  const target = Object.freeze({ ...discovered });
  if (target.agentId !== agentId) invalid();
  const transport = options.transport ?? requestPrivateIntent;
  const call = async (request: Parameters<PrivateIntentTransport>[1]) => {
    const response = parsePrivateIntentResponse(await transport(target.socketPath, request));
    if (response.id !== request.id || response.agentId !== target.agentId || response.localProfileId !== target.localProfileId
      || response.instanceId !== target.instanceId) throw new PrivateIntentTransportError("connection_unavailable");
    if (!response.ok && request.action === "preview" && response.error === "state_unavailable")
      throw new PrivateIntentTransportError("outcome_unknown");
    if (!response.ok) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Local preview unavailable", cause: response.error,
      fix: "Inspect runner status and the current rules. Keep the intent ID; do not assume a failed response means no preview was stored.", exitCode: 2 });
    const expectedId = request.action === "preview" ? request.request.intentId : request.intentId;
    if ((request.action === "preview" && !response.preview) || (response.preview && response.preview.request.intentId !== expectedId))
      throw new PrivateIntentTransportError(request.action === "preview" ? "outcome_unknown" : "connection_unavailable");
    return response.preview;
  };
  if (action === "show") {
    const preview = await call({ ...privateIntentBinding(target), action: "read", intentId: intentId! });
    return preview ? { kind: "historical", preview } : { kind: "not_found", intentId: intentId! };
  }
  await options.write("Local Solana buy preview only. No approval, signature or order will be created.\nUse an exact asset:solana:<address> reference from your local research.\n");
  const prompt = (options.createPrompt ?? createIntentPrompt)();
  try {
    const refId = await prompt.ask("Asset reference: "); if (refId === null) return { kind: "cancelled" };
    const amountSol = await prompt.ask("Exact SOL amount: "); if (amountSol === null) return { kind: "cancelled" };
    const slippage = await prompt.ask("Slippage in basis points (e.g. 100 = 1%): "); if (slippage === null) return { kind: "cancelled" };
    if (!/^[1-9][0-9]{0,4}$/.test(slippage)) invalid();
    const current = await (options.prerequisites ?? prerequisites)(target);
    const request = parsePrivateSolanaPreviewRequest({ intentId: randomUUID(), expectedRuntimeVersion: current.version,
      expectedRevisionId: current.revisionId, refId, amountSol, slippageBps: Number(slippage) });
    await options.write(`Intent ${request.intentId}\nIf the response is lost, use: balchemy runner intent ${agentId} solana show ${request.intentId}\n`);
    try {
      const preview = await call({ ...privateIntentBinding(target), action: "preview", request });
      return { kind: "preview", preview: preview! };
    } catch (error: unknown) {
      if (error instanceof PrivateIntentTransportError && error.code === "outcome_unknown") return { kind: "outcome_unknown", intentId: request.intentId };
      throw error;
    }
  } finally { prompt.close(); }
}
export function formatPrivateIntentResult(result: IntentCommandResult): string {
  if (result.kind === "cancelled") return "Preview cancelled. No intent was sent.\n";
  if (result.kind === "dry_run") return "Local preview command only; no connection or change made.\n";
  if (result.kind === "not_found") return `No stored preview for ${result.intentId}. No order was submitted.\n`;
  if (result.kind === "outcome_unknown") return `Preview outcome unknown. Keep ${result.intentId} and read it; do not create a replacement. No order was submitted.\n`;
  return `${result.kind === "historical" ? "Historical immutable preview; current conditions were not rechecked." : "Saved local preview."}\n`
    + "Execution is unavailable. Resolution of a preview is not approval to trade.\n" + privateRuleJson(result.preview) + "\n";
}
