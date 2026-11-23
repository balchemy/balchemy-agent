import { createLocalLlmAdapter, type LlmAdapter } from "@balchemyai/agent-sdk";
import type { PrivateBrainModelState } from "./private-brain-protocol.js";
import { isPrivateBrainModelId, isPrivateBrainProvider, privateBrainAdapterConfig, type PrivateBrainProvider } from "./private-brain-providers.js";
import { addRunnerAgent } from "./agent-roster.js";

export interface PrivateBrainModelConfig {
  provider: PrivateBrainProvider;
  model: string;
  apiKey: string;
}
interface Entry {
  revision: number;
  selected?: { provider: PrivateBrainProvider; model: string; adapter: LlmAdapter; selection: PrivateBrainModelSelection };
}
export type PrivateBrainModelSelection = { source: "ephemeral" } | { source: "vault"; vaultRevision: number };

/** Production factory: each provider name maps to one fixed endpoint (see private-brain-providers). */
export function createPrivateBrainAdapter(config: PrivateBrainModelConfig): LlmAdapter {
  return createLocalLlmAdapter(privateBrainAdapterConfig(config));
}

export class PrivateBrainModelError extends Error {
  constructor(readonly code: "unknown_agent" | "model_locked" | "revision_conflict" | "invalid_request" | "closing") {
    super(`Local model ${code}`);
    this.name = "PrivateBrainModelError";
  }
}

/** The daemon owns this interface. Credentials never enter the job journal or
 * public status. Restart deliberately locks models; there is no legacy import. */
export class PrivateBrainModels {
  private readonly entries = new Map<string, Entry>();
  private readonly agentIds: string[];
  private closed = false;

  constructor(agentIds: readonly string[], private readonly invalidate: (agentId: string) => void,
    private readonly factory: (config: PrivateBrainModelConfig) => LlmAdapter = createPrivateBrainAdapter,
    /** Wraps every configured adapter, whichever factory made it (the daily AI budget meter). */
    private readonly meter?: (agentId: string, selected: { provider: PrivateBrainProvider; model: string }, adapter: LlmAdapter) => LlmAdapter) {
    this.agentIds = [...agentIds];
    for (const agentId of agentIds) this.entries.set(agentId, { revision: 0 });
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon starts locked (revision 0), exactly as the
   * constructor starts every agent; no other agent's model, key or revision changes. Idempotent; nothing is added after close. */
  addAgent(agentId: string): void {
    if (this.closed) return;
    if (addRunnerAgent(this.agentIds, agentId)) this.entries.set(agentId, { revision: 0 });
  }

  state(agentId: string): PrivateBrainModelState {
    const entry = this.entry(agentId);
    return entry.selected
      ? Object.freeze({ state: "ready", revision: entry.revision, provider: entry.selected.provider, model: entry.selected.model, ...entry.selected.selection })
      : Object.freeze({ state: "locked", revision: entry.revision });
  }

  configure(agentId: string, expectedRevision: number, config: PrivateBrainModelConfig,
    selection: PrivateBrainModelSelection = { source: "ephemeral" }): PrivateBrainModelState {
    const entry = this.entry(agentId);
    this.checkRevision(entry, expectedRevision);
    if (!config || !isPrivateBrainProvider(config.provider) || !isPrivateBrainModelId(config.model)
      || typeof config.apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(config.apiKey)
      || !selection || (selection.source !== "ephemeral" && selection.source !== "vault")
      || (selection.source === "vault" && (!Number.isSafeInteger(selection.vaultRevision) || selection.vaultRevision < 1))) {
      throw new PrivateBrainModelError("invalid_request");
    }
    let adapter: LlmAdapter;
    try {
      adapter = this.factory({ provider: config.provider, model: config.model, apiKey: config.apiKey });
      if (this.meter) adapter = this.meter(agentId, { provider: config.provider, model: config.model }, adapter);
    } catch { throw new PrivateBrainModelError("invalid_request"); }
    // Invalidate before exposing the new configuration. A prior model's late
    // response can never become a result attributed to this revision.
    this.invalidate(agentId);
    entry.selected = { provider: config.provider, model: config.model, adapter,
      selection: selection.source === "vault" ? { source: "vault", vaultRevision: selection.vaultRevision } : { source: "ephemeral" } };
    entry.revision += 1;
    return this.state(agentId);
  }

  lock(agentId: string, expectedRevision: number): PrivateBrainModelState {
    const entry = this.entry(agentId);
    this.checkRevision(entry, expectedRevision);
    // Even an already-locked model must fence an unlock still deriving its key.
    entry.selected = undefined;
    entry.revision += 1;
    // A failed journal cancellation must never retain usable credentials.
    this.invalidate(agentId);
    return this.state(agentId);
  }

  /** Internal only. Neither the adapter nor its key may be serialized to IPC. */
  current(agentId: string): Readonly<{ revision: number; adapter: LlmAdapter }> {
    const entry = this.entry(agentId);
    if (!entry.selected) throw new PrivateBrainModelError("model_locked");
    return Object.freeze({ revision: entry.revision, adapter: entry.selected.adapter });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.entries.clear();
  }

  private entry(agentId: string): Entry {
    if (this.closed) throw new PrivateBrainModelError("closing");
    const entry = this.entries.get(agentId);
    if (!entry) throw new PrivateBrainModelError("unknown_agent");
    return entry;
  }

  private checkRevision(entry: Entry, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || entry.revision !== expected
      || entry.revision >= Number.MAX_SAFE_INTEGER) throw new PrivateBrainModelError("revision_conflict");
  }
}
