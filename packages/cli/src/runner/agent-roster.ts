/** Owner decision of 19 Nov 2026: a new agent can be added to a RUNNING runner, and adding one never disarms or resets the others.
 * Every per-agent store and worker of the daemon keeps its own copy of the agent list (fixed at construction before this decision);
 * each now has an `addAgent(agentId)` that appends to that copy with this one helper, and builds exactly the per-agent in-memory
 * entry its constructor builds for every agent. Nothing existing is rebuilt, reset or re-read. The durable record of the agent
 * list is the control snapshot (RunnerStateStore.registerAgent), written first; removal is not supported. */
import { isId } from "./protocol.js";

export const MAX_RUNNER_AGENTS = 64;

/** Appends `agentId` to a store's own agent list. True when it was added now, false when it was already there (idempotent: nothing
 * changes). Throws, changing nothing, on an invalid id or when the list already holds MAX_RUNNER_AGENTS agents. */
export function addRunnerAgent(agentIds: string[], agentId: string): boolean {
  if (!isId(agentId)) throw new Error("Invalid agent id");
  if (agentIds.includes(agentId)) return false;
  if (agentIds.length >= MAX_RUNNER_AGENTS) throw new Error("Agent limit reached");
  agentIds.push(agentId);
  return true;
}

/** The same for a store whose agent list is its per-agent entry map (the Hub bridges): adds `create()` for a new agent only. */
export function addRunnerAgentEntry<T>(entries: Map<string, T>, agentId: string, create: () => T): boolean {
  if (!isId(agentId)) throw new Error("Invalid agent id");
  if (entries.has(agentId)) return false;
  if (entries.size >= MAX_RUNNER_AGENTS) throw new Error("Agent limit reached");
  entries.set(agentId, create());
  return true;
}
