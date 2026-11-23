/** S4: unconfirmed spend cap proposals from the owner's private chat (`propose_spend_cap`). A proposal is only a suggestion:
 * this store has no access to the spend ledger, and the only cap writer is `PrivateSpendLedger.configure`, reached only from
 * the owner socket's `private_arming limits_set` after the CLI's typed confirmation. Proposals live in the daemon's memory
 * (bounded per agent, 24 hours); a restart forgets them and the owner simply asks again. Grants no authority. */
import { randomBytes } from "node:crypto";
import { PRIVATE_SPEND_CAP_PROPOSAL_ID, type PrivateSpendCapProposalView } from "./private-arming-protocol.js";
import { parsePrivateCapRequest, type PrivateCapProposalInput } from "./private-spend-cap.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_SPEND_CAP_PROPOSAL_TTL_MS = 24 * 60 * 60_000;
const MAX_PER_AGENT = 8;

export class PrivateSpendCapProposals {
  readonly #agentIds: string[];
  readonly #proposals = new Map<string, PrivateSpendCapProposalView[]>();
  constructor(agentIds: readonly string[]) { this.#agentIds = [...agentIds]; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Saves one unconfirmed proposal. Both caps are required and validated again here. */
  propose(agentId: string, input: PrivateCapProposalInput, nowMs: number): PrivateSpendCapProposalView {
    if (!this.#agentIds.includes(agentId) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid spend cap proposal");
    const perTrade = parsePrivateCapRequest(input.perTrade), daily = parsePrivateCapRequest(input.daily);
    if (perTrade.kind === "lamports" && daily.kind === "lamports" && BigInt(perTrade.lamports) > BigInt(daily.lamports)) throw new Error("Invalid spend cap proposal");
    const proposal: PrivateSpendCapProposalView = Object.freeze({ proposalId: `scp_${randomBytes(16).toString("hex")}`, perTrade, daily,
      createdAt: nowMs, expiresAt: nowMs + PRIVATE_SPEND_CAP_PROPOSAL_TTL_MS });
    const kept = this.#live(agentId, nowMs);
    this.#proposals.set(agentId, [...kept, proposal].slice(-MAX_PER_AGENT));
    return proposal;
  }
  get(agentId: string, proposalId: string, nowMs: number): PrivateSpendCapProposalView | undefined {
    if (!this.#agentIds.includes(agentId) || !PRIVATE_SPEND_CAP_PROPOSAL_ID.test(proposalId)) return undefined;
    return this.#live(agentId, nowMs).find((item) => item.proposalId === proposalId);
  }
  #live(agentId: string, nowMs: number): PrivateSpendCapProposalView[] {
    return (this.#proposals.get(agentId) ?? []).filter((item) => item.expiresAt > nowMs && item.createdAt <= nowMs);
  }
}
