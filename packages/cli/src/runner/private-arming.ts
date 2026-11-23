/** S8a daemon side of `runner arm` and `runner wallet <agent> limits` (channel `private_arming`). Arming is CLI-only and the
 * only path into live_armed: the server and the web can never arm. Prechecks are closed refusal codes, evaluated in a fixed
 * order and re-evaluated at `arm` after the passphrase check; the owner-confirmed summary is bound by a digest, so any change
 * between review and arm (wallet, binding, RPC endpoint, caps, rules revision, stop-loss, sizing, runtime revision) refuses
 * `summary_changed` and nothing is armed. The final CAS is the state store's arm(expectedVersion) receipt.
 *
 * An armed agent trades automatically within the per-trade and daily caps only after the owner explicitly turned trade
 * approval off (`runner rules <agent> solana approval off`): the confirmed revision must carry the compiler's explicit
 * automatic-within-limits approval record and no approval requirement (confirmBeforeTrade false, requireApprovalAboveUsd
 * null, requireApprovalForNewTokens false). The approval flow is not built, so `owner_approval_required` refuses arming
 * otherwise (and every build, see private-execution-gate.ts). Automatic exits ship since S5 (PRIVATE_EXIT_EXECUTION_AVAILABLE
 * true); the exits-off rollback build (the flag false) refuses every arm `exits_unavailable`, first. While an owner change to rules, RPC, sizing or limits is in
 * flight (`readConfigBusy`), arming refuses `busy`, so a change can never land between the review and the arm.
 *
 * S6 moment 3 (design section 4): right after the limits check, a stored owner wallet approval must cover this computer's
 * trading wallet binding and the current caps, verified locally against the pinned paired wallet (`private-owner-approvals.ts`):
 * otherwise `owner_wallet_approval_missing` (or `owner_approval_unverifiable` for a Base-paired owner). `approval_request` opens
 * (or recovers) one approval for the current caps after every other precheck passes, `approval_poll` reads it; neither arms. The
 * check is re-run at `arm`, so an approval that stopped covering (caps raised, new binding) between review and arm refuses. */
import { createHash, randomUUID } from "node:crypto";
import { deriveBehaviorRuleExecutionPolicy, isBehaviorRuleApprovalAutomatic, toBehaviorRuleExecutionBinding, type BehaviorRuleRevision } from "@balchemyai/agent-rules";
import { PRIVATE_RULE_EXECUTION_OPTIONS } from "./private-typed-rules.js";
import type { RunnerAssessmentRequest, RunnerCapBasis } from "@balchemyai/agent-sdk";
import type { PrivateAssessmentReceipt } from "./private-assessment.js";
import { privateApprovalRequired, PRIVATE_EXECUTION_CAPABILITIES, type PrivateExecutionCapabilities } from "./private-execution-gate.js";
import { parsePrivateArmingRequest, privateArmingFailure, privateArmingSuccess, PRIVATE_ARMING_CHANNEL_ERRORS,
  type PrivateArmingChannelError, type PrivateArmingFee, type PrivateArmingRefusal, type PrivateArmingRequest, type PrivateArmingResponse,
  type PrivateArmingSummary, type PrivateSpendCapProposalView, type PrivateSpendCapQuote, type PrivateSpendLimitsView } from "./private-arming-protocol.js";
import { privateCapTuple, privateFixedPercentCap, validPrivateCapPair, PRIVATE_SPEND_CAP_BASIS_MAX_AGE_MS, PRIVATE_SPEND_CAP_MAX_LAMPORTS,
  type PrivateCapBasis, type PrivateCapChoice, type PrivateCapRequest, type PrivateCapSetting } from "./private-spend-cap.js";
import { PRIVATE_ASSESSMENT_INPUT_MINT } from "./private-signal-job.js";
import { privateSizingSlippageUsable, type PrivateBuyAmountPolicy } from "./private-sizing.js";
import { privateRpcClassExecutable, type PrivateEffectiveRpcStatus } from "./private-solana-rpc-settings.js";
import { PrivateSpendLedgerError, type PrivateSpendLedger, type PrivateSpendStatus } from "./private-spend-ledger.js";
import { privateOwnerApprovalBasis, PrivateOwnerApprovalError, type PrivateOwnerApprovalBinding, type PrivateOwnerApprovalCaps,
  type PrivateOwnerApprovalCoverage, type PrivateOwnerApprovalLink } from "./private-owner-approvals.js";
import type { PrivateTradingBindingRecord } from "./private-trading-binding.js";
import type { PrivateAuthorityCheck } from "./private-authority-seal.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import type { RuleHead } from "./private-rule-store.js";
import type { RunnerAgentState, RunnerRequest, RunnerResponse } from "./protocol.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import type { RunnerEntriesHold, RunnerEntriesRelease } from "./state.js";
import { isPrivateSubmissionTerminal, privateSubmissionArmingCounts, privateSubmissionReleased, PRIVATE_SUBMISSION_MAX_RESENDS,
  type PrivateSubmissionAttempt } from "./private-submission-journal.js";
import { addRunnerAgent } from "./agent-roster.js";

/** Phase 1 (17 Nov 2026): the daemon's arming counts over the journal. `relayableBuys`: unfinished buys whose relay is still open, that
 * no proof released and whose resends are not exhausted, the only attempts whose stored bytes the relay gate (live_armed; an entries
 * pause never holds it, private-submission.ts #reconcileAttempt, the only resend path) could send again once armed. While any exists,
 * exits-only arming is refused. Phase 1 audit M1: a buy that already made its first relay plus PRIVATE_SUBMISSION_MAX_RESENDS can never
 * be sent again by this runner, so it does not count (its relay closes at its blockhash expiry; it stays unfinished, so entries stay
 * paused until it resolves). */
export function privateArmingSubmissionCounts(attempts: readonly PrivateSubmissionAttempt[]): { unfinished: number; copyHolds: number; unrelayed: number;
  relayableBuys: number } {
  return { ...privateSubmissionArmingCounts(attempts), relayableBuys: attempts.filter((item) => item.swap.direction === "buy"
    && !isPrivateSubmissionTerminal(item.state) && item.relay === "open" && !privateSubmissionReleased(item)
    && !(item.submits >= 1 + PRIVATE_SUBMISSION_MAX_RESENDS)).length };
}

/** S8a review: an owner change to the RPC endpoint of a live_armed agent with no open or unsettled trade disarms it BEFORE the
 * change applies (an idempotent ensure-disarm through the normal control path), so re-arming reviews the new endpoint with the
 * passphrase; with a trade open the change is refused (`positions_open`, private-change-entries.ts). Since the owner decision of
 * 17 Nov 2026 a change to rules, sizing or caps no longer disarms: it pauses new entries only (private-change-entries.ts). True
 * when the agent is not live_armed afterwards; false refuses the change. */
export function privateDisarmForOwnerChange(agentId: string, readState: (agentId: string) => RunnerAgentState | undefined,
  control: (request: RunnerRequest) => RunnerResponse): boolean {
  let state: RunnerAgentState | undefined;
  try { state = readState(agentId); } catch { return false; }
  if (!state) return false;
  if (state.mode !== "live_armed") return true;
  let result: RunnerResponse;
  try { result = control({ version: 1, id: randomUUID(), action: "disarm", agentId, expectedVersion: state.version }); } catch { return false; }
  try { return result.ok && result.state?.mode !== "live_armed" && readState(agentId)?.mode !== "live_armed"; } catch { return false; }
}

/** Reference output mint of the read-only fee probe (USDC). The probe never reserves, builds or signs anything. */
export const PRIVATE_ARMING_FEE_PROBE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FEE_PROBE_TIMEOUT_MS = 8_000;

/** S6 moment 3: the daemon's owner-approval store (`PrivateOwnerApprovals`). */
export interface PrivateArmingOwnerApprovals {
  covers(agentId: string, binding: PrivateOwnerApprovalBinding, caps: PrivateOwnerApprovalCaps): PrivateOwnerApprovalCoverage;
  request(agentId: string, binding: PrivateOwnerApprovalBinding, caps: PrivateOwnerApprovalCaps, basis: RunnerCapBasis,
    signal?: AbortSignal): Promise<{ kind: "approved" } | PrivateOwnerApprovalLink>;
  poll(agentId: string, challengeId: string, signal?: AbortSignal): Promise<"pending" | "approved" | "expired">;
}

export interface PrivateArmingOptions {
  localProfileId: string; instanceId: string; agentIds: readonly string[];
  readState(agentId: string): RunnerAgentState | undefined;
  /** True when this agent has an adopted (confirmed) Hub pairing identity. */
  readPaired(agentId: string): boolean;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  readWallet(agentId: string): TradingWalletStatus;
  readBinding(agentId: string): PrivateTradingBindingRecord | undefined;
  /** The RPC this agent executes on: the owner's own endpoint, or (owner decision of 17 Nov 2026) the two Balchemy-provided sources. */
  readRpc(agentId: string): PrivateEffectiveRpcStatus;
  readRules(agentId: string): { head: RuleHead; revision: BehaviorRuleRevision | null };
  readSizing(agentId: string, signal?: AbortSignal): Promise<PrivateBuyAmountPolicy | null>;
  ledger: Pick<PrivateSpendLedger, "status" | "configure">;
  /** S4: the trading wallet's SOL balance at `confirmed`, for fixing a percentage cap (read-only). `purpose`: `cap` fixes lamport caps
   * (two Balchemy-provided sources must agree), `display` only shows it (the first source that answers). */
  readBalance?(agentId: string, walletAddress: string, signal?: AbortSignal, purpose?: "cap" | "display"): Promise<bigint>;
  /** S4: one unconfirmed spend cap proposal saved by the chat brain (read-only; proposals never change caps). */
  readProposal?(agentId: string, proposalId: string, nowMs: number): PrivateSpendCapProposalView | undefined;
  /** Unfinished journal attempts and unacknowledged observed (re-signed) copies. `relayableBuys` (privateArmingSubmissionCounts):
   * unfinished buys whose stored bytes an armed runner could still send; absent means unknown, and exits-only arming is refused. */
  readSubmissions(agentId: string): { unfinished: number; copyHolds: number; unrelayed?: number; relayableBuys?: number };
  /** Phase 1 exits-only arming (17 Nov 2026): the state store's internal entries hold and release (state.ts), and an immediate
   * ensure-disarm. All three are needed; without them an unresolved trade refuses arming `submission_unresolved` as before. */
  holdEntries?(agentId: string): RunnerEntriesHold;
  releaseEntries?(agentId: string, expectedVersion: number): RunnerEntriesRelease;
  disarm?(agentId: string): boolean;
  /** After an exits-only arm and after its entries resumed (the daemon reports it and runs a reconcile pass at once). */
  onExitsOnly?(agentId: string, phase: "held" | "resumed"): void;
  /** The daemon's settings-change hold (private-change-entries.ts `heldVersion`): the state version at which the runner itself paused new
   * entries for an owner change to rules, caps or sizing that is being saved or was not saved. While it equals the current version the
   * pause is the runner's, never the owner's, so an owner `entries_resume` refuses `change_pending`. A throw refuses too. */
  readChangeHold?(agentId: string): number | undefined;
  /** After an owner `entries_resume` released new entries (the daemon reports it with the next heartbeat at once). */
  onEntriesResumed?(agentId: string): void;
  /** One read-only probe assessment for the fee display; any failure shows "fee shown at each trade". */
  assessFee?(agentId: string, request: RunnerAssessmentRequest, signal: AbortSignal | undefined, timeoutMs: number): Promise<PrivateAssessmentReceipt>;
  verifyPassphrase(agentId: string, passphrase: string, signal?: AbortSignal): Promise<true>;
  /** S6 moment 3: the owner's wallet approval of this computer's trading wallet and caps. */
  ownerApprovals: PrivateArmingOwnerApprovals;
  /** A2a (plan section B4): the sealed owner pin's authority read (`PrivateOwnerPins.identity`). It throws `owner_pin_missing`,
   * `owner_pin_invalid`, `owner_pin_mismatch` or `wallet_locked` (each refused with that code; anything else is state_unavailable).
   * Checked before the approval coverage (arm, precheck, entries resume and every resume prerequisite) and in approval_request/poll.
   * The daemon always supplies it; absent (unit tests of other checks) means no pin check. */
  readOwnerPin?(agentId: string): void;
  /** A2a authority watermark (amendments section C): the owner-sealed settings against the current ones
   * (`PrivateAuthoritySeals.verify`). Missing or looser (`authority_unsealed`) or unreadable (`state_unavailable`, a throw or a malformed
   * answer) arms for exits only: new entries stay paused until the watermark verifies and the owner resumes them (entries_resume refuses
   * with the code meanwhile); a locked wallet or no wallet refuses. The daemon always supplies it; absent means no watermark check. */
  verifyAuthority?(agentId: string, signal?: AbortSignal): Promise<PrivateAuthorityCheck>;
  arm(input: { id: string; agentId: string; expectedVersion: number }): RunnerResponse;
  /** The daemon's per-agent owner-config guard: `busy` while a change to rules, RPC, sizing or limits is being applied,
   * `generation` bumped when each such change starts and ends. An arm whose generation moved since its first check refuses. */
  readConfigGuard?(agentId: string): { busy: boolean; generation: number };
  now?(): number;
  /** Test-only seam (see private-execution-gate.ts); production never sets it. */
  capabilities?: PrivateExecutionCapabilities;
}

class Refused extends Error { constructor(readonly code: PrivateArmingChannelError) { super(code); } }
function refuse(code: PrivateArmingRefusal | PrivateArmingChannelError): never { throw new Refused(code); }
function readOrRefuse<T>(reader: () => T): T { try { return reader(); } catch { return refuse("state_unavailable"); } }
type PrivateArmingExit = NonNullable<ReturnType<typeof toBehaviorRuleExecutionBinding>>["exitSnapshot"];

type Facts = Omit<PrivateArmingSummary, "fee" | "summaryDigest"> & { rpcRevision: number };
/** The facts plus which runner holds an exits-only arm places (internal: never shown; `entriesHold` is what the digest binds). */
type Evaluated = Facts & { holds: { submissions: boolean; authority: boolean } };
/** Binds every confirmed fact except the informational fee (plus the RPC endpoint revision, so a changed URL on the same host
 * refuses). v2 (S4): each cap is its own tuple, so `unset`, `none` and an amount never share a digest; a percentage basis is
 * bound too (it is part of what the owner reads). */
export function privateArmingSummaryDigest(facts: Omit<Facts, "perTrade" | "daily"> & { perTrade: PrivateCapSetting; daily: PrivateCapSetting }): string {
  return createHash("sha256").update(JSON.stringify(["balchemy.local-agent.arming-summary.v2", facts.agentId, facts.runtimeVersion, facts.mode,
    facts.walletAddress, facts.walletBindingId, facts.rpcHost, facts.rpcRevision, facts.limitsRevision, privateCapTuple(facts.perTrade),
    privateCapTuple(facts.daily), basisTuple(facts.perTradeBasis), basisTuple(facts.dailyBasis), facts.rulesRevisionId, facts.stopLossBps,
    facts.takeProfitLevels, facts.sizingAmountSol, facts.sizingAmountLamports, facts.sizingSlippageBps,
    // Phase 1: exits-only arming is part of what the owner confirms; an arm without it keeps the v2 digest unchanged.
    ...(facts.entriesHold ? ["entries_hold", facts.entriesHold] : [])]), "utf8").digest("hex");
}
function basisTuple(basis: PrivateCapBasis | null): unknown[] { return basis ? [basis.percentBps, basis.balanceLamports, basis.observedAt] : ["none"]; }
function limitsView(status: PrivateSpendStatus): PrivateSpendLimitsView {
  const limits = status.limits;
  return { agentId: status.agentId, revision: limits.revision, perTrade: limits.perTrade, daily: limits.daily, perTradeBasis: limits.perTradeBasis,
    dailyBasis: limits.dailyBasis, utcDay: status.utcDay, spentLamports: status.spentLamports, reservedLamports: status.reservedLamports,
    remaining: status.remaining };
}

export class PrivateArming {
  readonly #options: PrivateArmingOptions;
  readonly #agentIds: string[];
  readonly #busy = new Set<string>();
  /** Phase 1 exits-only arms in this daemon run: agentId -> the hold version. Memory only: a restart lands live_unarmed anyway. */
  readonly #exitsOnly = new Map<string, number>();
  /** A2a: arms whose new entries this daemon run paused because the owner-sealed settings were missing or looser (agentId -> the hold
   * version). Memory only, like the armed state. Lifted only by the owner's entries_resume once the watermark verifies again. */
  readonly #authorityHeld = new Map<string, number>();
  constructor(options: PrivateArmingOptions) { this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds }; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }
  #now(): number { return (this.#options.now ?? Date.now)(); }

  async handle(input: PrivateArmingRequest, signal?: AbortSignal): Promise<PrivateArmingResponse> {
    const request = parsePrivateArmingRequest(input);
    try {
      if (request.localProfileId !== this.#options.localProfileId) return privateArmingFailure(request, "profile_conflict");
      if (request.instanceId !== this.#options.instanceId) return privateArmingFailure(request, "instance_conflict");
      if (!this.#options.agentIds.includes(request.agentId)) return privateArmingFailure(request, "unknown_agent");
      const agentId = request.agentId;
      if (request.action === "limits_status") return privateArmingSuccess(request, { kind: "limits", limits: limitsView(this.#options.ledger.status(agentId, this.#now())) });
      if (request.action === "entries_resume") {
        // A2a: the watermark is read first (its stores are read asynchronously); the resume itself stays one synchronous section. A frame
        // the state refuses anyway (not armed, another version, entries not paused) reads no store: the section refuses it first.
        let current: RunnerAgentState | undefined;
        try { current = this.#options.readState(agentId); } catch { current = undefined; }
        const pausedArmed = current?.mode === "live_armed" && current.armed === true && current.lifecycle === "idle"
          && current.version === request.expectedVersion && current.entries === "paused";
        const authority = pausedArmed ? await this.#authority(agentId, signal) : undefined;
        return privateArmingSuccess(request, { kind: "entries_resumed", state: this.#resumeEntries(agentId, request.expectedVersion, authority) });
      }
      if (request.action === "limits_proposal") {
        const proposal = this.#options.readProposal?.(agentId, request.proposalId, this.#now());
        if (!proposal || proposal.proposalId !== request.proposalId) return privateArmingFailure(request, "proposal_missing");
        return privateArmingSuccess(request, { kind: "limits_proposal", proposal });
      }
      if (request.action === "limits_quote") return privateArmingSuccess(request, { kind: "limits_quote", quote: await this.#quote(agentId, request, signal) });
      if (request.action === "wallet_balance") {
        const observed = await this.#balance(agentId, signal);
        return privateArmingSuccess(request, { kind: "wallet_balance", walletAddress: observed.address, lamports: observed.balance.toString(), observedAt: observed.observedAt });
      }
      if (request.action === "limits_set") {
        const now = this.#now();
        // A percentage is fixed at confirmation: a new balance read must be recent and not from the future. A cap kept unchanged
        // keeps its stored basis (the same amount and the same reading).
        const stored = this.#options.ledger.status(agentId, now).limits;
        const keeps = (basis: PrivateCapBasis | null, cap: PrivateCapSetting, storedBasis: PrivateCapBasis | null, storedCap: PrivateCapSetting): boolean =>
          basis !== null && JSON.stringify([basis, cap]) === JSON.stringify([storedBasis, storedCap]);
        for (const [basis, cap, storedBasis, storedCap] of [[request.perTradeBasis, request.perTrade, stored.perTradeBasis, stored.perTrade],
          [request.dailyBasis, request.daily, stored.dailyBasis, stored.daily]] as const) {
          if (basis && !keeps(basis, cap, storedBasis, storedCap) && (basis.observedAt > now || now - basis.observedAt > PRIVATE_SPEND_CAP_BASIS_MAX_AGE_MS)) refuse("basis_stale");
        }
        this.#options.ledger.configure(agentId, { expectedRevision: request.expectedRevision, perTrade: request.perTrade, daily: request.daily,
          perTradeBasis: request.perTradeBasis, dailyBasis: request.dailyBasis }, now);
        return privateArmingSuccess(request, { kind: "limits_set", expectedRevision: request.expectedRevision,
          limits: limitsView(this.#options.ledger.status(agentId, now)) });
      }
      // One precheck or arm per agent at a time.
      if (this.#busy.has(agentId)) return privateArmingFailure(request, "busy");
      this.#busy.add(agentId);
      try {
        if (request.action === "precheck") {
          const sizing = await this.#sizing(agentId, signal);
          const facts = this.#evaluate(agentId, sizing, true, await this.#authority(agentId, signal));
          const summaryDigest = privateArmingSummaryDigest(facts);
          const fee = await this.#fee(agentId, facts, signal);
          const { rpcRevision: _rpcRevision, holds: _holds, ...shown } = facts;
          void _rpcRevision; void _holds;
          return privateArmingSuccess(request, { kind: "precheck", summary: { ...shown, fee, summaryDigest } });
        }
        if (request.action === "approval_request") {
          // Every other precheck must pass first (so exits_unavailable still refuses before anything is sent); then exactly the
          // current caps are requested, or a recovered approval that covers them is reported.
          const facts = this.#evaluate(agentId, await this.#sizing(agentId, signal), false);
          // A2a: the approval is requested only for the sealed owner pin's identity.
          this.#ownerPin(agentId);
          const binding = { walletBindingId: facts.walletBindingId, tradingWalletAddress: facts.walletAddress };
          const caps = { perTrade: facts.perTrade, daily: facts.daily };
          if (this.#coverage(agentId, binding, caps) === "covered") return privateArmingSuccess(request, { kind: "approval_status", state: "approved" });
          const result = await this.#options.ownerApprovals.request(agentId, binding, caps,
            privateOwnerApprovalBasis(facts.perTradeBasis, facts.dailyBasis), signal);
          if (result.kind === "approved") return privateArmingSuccess(request, { kind: "approval_status", state: "approved" });
          return privateArmingSuccess(request, { kind: "approval_link", link: { challengeId: result.challengeId, checkCode: result.checkCode,
            expiresAt: result.expiresAt, frontendOrigin: result.frontendOrigin, path: result.path, perTrade: result.perTrade, daily: result.daily } });
        }
        if (request.action === "approval_poll") {
          this.#ownerPin(agentId);
          return privateArmingSuccess(request, { kind: "approval_status", state: await this.#options.ownerApprovals.poll(agentId, request.challengeId, signal) });
        }
        // arm: prechecks + digest + CAS version first, then the passphrase, then everything again with no await before arm().
        const generation = this.#guard(agentId).generation;
        const first = await this.#sizing(agentId, signal);
        const before = this.#evaluate(agentId, first, true, await this.#authority(agentId, signal));
        if (before.runtimeVersion !== request.expectedVersion) refuse("version_conflict");
        if (privateArmingSummaryDigest(before) !== request.summaryDigest) refuse("summary_changed");
        try { await this.#options.verifyPassphrase(agentId, request.passphrase, signal); }
        catch (error: unknown) {
          const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
          refuse(code === "unlock_failed" ? "passphrase_rejected" : code === "wallet_locked" ? "wallet_locked" : code === "wallet_missing" ? "wallet_missing"
            : code === "busy" ? "busy" : code === "cancelled" ? "cancelled" : code === "closing" ? "closing"
              // A2a: the keystore's wrong-passphrase throttle.
              : code === "throttled" ? "proof_throttled" : "state_unavailable");
        }
        const sizing = await this.#sizing(agentId, signal);
        const authority = await this.#authority(agentId, signal);
        if (signal?.aborted) refuse("cancelled");
        const after = this.#evaluate(agentId, sizing, true, authority);
        if (after.runtimeVersion !== request.expectedVersion) refuse("version_conflict");
        if (privateArmingSummaryDigest(after) !== request.summaryDigest) refuse("summary_changed");
        // An owner change that started (or finished) at any point since the first check refuses, even if its read raced.
        if (this.#guard(agentId).generation !== generation) refuse("summary_changed");
        const result = this.#options.arm({ id: request.id, agentId, expectedVersion: request.expectedVersion });
        if (result.ok && result.state?.mode === "live_armed") {
          if (!after.entriesHold) return privateArmingSuccess(request, { kind: "armed", state: result.state });
          // Exits only: new entries pause in the same synchronous step as the arm (no await in between, so no entry step can run).
          const held = this.#holdExitsOnly(agentId, after.holds);
          return held ? privateArmingSuccess(request, { kind: "armed", state: held, exitsOnly: true }) : privateArmingFailure(request, "state_unavailable");
        }
        return privateArmingFailure(request, result.error === "version_conflict" || result.error === "execution_unavailable" ? "version_conflict" : "state_unavailable");
      } finally { this.#busy.delete(agentId); }
    } catch (error: unknown) {
      if (error instanceof Refused) return privateArmingFailure(request, error.code);
      if (error instanceof PrivateOwnerApprovalError) return privateArmingFailure(request, error.code);
      const code = error instanceof PrivateSpendLedgerError ? error.code : "";
      return privateArmingFailure(request, (PRIVATE_ARMING_CHANNEL_ERRORS as readonly string[]).includes(code) && code !== "unknown_agent"
        ? code as PrivateArmingChannelError : "state_unavailable");
    }
  }

  /** One SOL balance read of the trading wallet on the owner's RPC. Read-only: it changes and saves nothing. */
  async #balance(agentId: string, signal?: AbortSignal): Promise<{ address: string; balance: bigint; observedAt: number }> {
    const o = this.#options;
    if (!o.readBalance) refuse("balance_unavailable");
    let wallet: ReturnType<PrivateArmingOptions["readWallet"]>;
    try { wallet = o.readWallet(agentId); } catch { return refuse("state_unavailable"); }
    if (wallet.state === "absent") refuse("wallet_missing");
    if (wallet.state === "held") refuse("state_unavailable");
    let rpc: ReturnType<PrivateArmingOptions["readRpc"]>["endpoint"];
    try { rpc = o.readRpc(agentId).endpoint; } catch { return refuse("state_unavailable"); }
    if (!rpc) refuse("rpc_missing");
    if (!privateRpcClassExecutable(rpc.class)) refuse("rpc_public");
    let balance: bigint;
    try { balance = await o.readBalance(agentId, wallet.address, signal, "display"); } catch { return refuse("balance_unavailable"); }
    if (signal?.aborted) refuse("cancelled");
    if (typeof balance !== "bigint" || balance < 0n || balance > (1n << 64n) - 1n) refuse("balance_unavailable");
    return { address: wallet.address, balance, observedAt: this.#now() };
  }

  /** Fixes each requested percentage into lamports from one balance read on the owner's RPC. Saves nothing. */
  async #quote(agentId: string, request: { perTrade: PrivateCapRequest; daily: PrivateCapRequest }, signal?: AbortSignal): Promise<PrivateSpendCapQuote> {
    const o = this.#options;
    let observed: { balance: bigint; observedAt: number } | undefined;
    if (request.perTrade.kind === "percent" || request.daily.kind === "percent") {
      if (!o.readBalance) refuse("balance_unavailable");
      let wallet: ReturnType<PrivateArmingOptions["readWallet"]>;
      try { wallet = o.readWallet(agentId); } catch { return refuse("state_unavailable"); }
      if (wallet.state === "absent") refuse("wallet_missing");
      if (wallet.state === "held") refuse("state_unavailable");
      let rpc: ReturnType<PrivateArmingOptions["readRpc"]>["endpoint"];
      try { rpc = o.readRpc(agentId).endpoint; } catch { return refuse("state_unavailable"); }
      if (!rpc) refuse("rpc_missing");
      if (!privateRpcClassExecutable(rpc.class)) refuse("rpc_public");
      let balance: bigint;
      try { balance = await o.readBalance(agentId, wallet.address, signal, "cap"); } catch { return refuse("balance_unavailable"); }
      if (signal?.aborted) refuse("cancelled");
      if (typeof balance !== "bigint" || balance < 0n || balance > (1n << 64n) - 1n) refuse("balance_unavailable");
      observed = { balance, observedAt: this.#now() };
    }
    const fix = (cap: PrivateCapRequest): { cap: PrivateCapChoice; basis: PrivateCapBasis | null } => {
      if (cap.kind !== "percent") return { cap, basis: null };
      const amount = privateFixedPercentCap(observed!.balance, cap.percentBps);
      if (amount < 1n || amount > PRIVATE_SPEND_CAP_MAX_LAMPORTS) refuse("cap_out_of_bounds");
      return { cap: { kind: "lamports", lamports: amount.toString() },
        basis: { percentBps: cap.percentBps, balanceLamports: observed!.balance.toString(), observedAt: observed!.observedAt } };
    };
    const perTrade = fix(request.perTrade), daily = fix(request.daily);
    if (!validPrivateCapPair(perTrade.cap, daily.cap)) refuse("cap_out_of_bounds");
    return { perTrade: perTrade.cap, daily: daily.cap, perTradeBasis: perTrade.basis, dailyBasis: daily.basis };
  }

  #guard(agentId: string): { busy: boolean; generation: number } {
    try {
      const value = this.#options.readConfigGuard?.(agentId) ?? { busy: false, generation: 0 };
      if (typeof value.busy !== "boolean" || !Number.isSafeInteger(value.generation)) refuse("state_unavailable");
      return value;
    } catch (error: unknown) { if (error instanceof Refused) throw error; return refuse("state_unavailable"); }
  }

  async #sizing(agentId: string, signal?: AbortSignal): Promise<PrivateBuyAmountPolicy | null> {
    try { return await this.#options.readSizing(agentId, signal); } catch { return refuse("state_unavailable"); }
  }

  /** A2a: the authority watermark's check of the current settings, or undefined without a verifier. A throw or a malformed answer is
   * `state_unavailable` (never covered). */
  async #authority(agentId: string, signal?: AbortSignal): Promise<PrivateAuthorityCheck | undefined> {
    const verify = this.#options.verifyAuthority;
    if (!verify) return undefined;
    try {
      const check = await verify(agentId, signal);
      if (check.ok === true || check.code === "authority_unsealed" || check.code === "wallet_locked" || check.code === "wallet_missing"
        || check.code === "state_unavailable") return check;
    } catch { /* Fail closed below. */ }
    return { ok: false, code: "state_unavailable" };
  }

  /** A2a: the sealed owner pin must verify and equal the pairing record (`readOwnerPin` throws the closed reason otherwise). */
  #ownerPin(agentId: string): void {
    const read = this.#options.readOwnerPin;
    if (!read) return;
    try { read(agentId); }
    catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      refuse(code === "owner_pin_missing" || code === "owner_pin_invalid" || code === "owner_pin_mismatch" || code === "wallet_locked" ? code : "state_unavailable");
    }
  }

  /** The stored owner approval's coverage of these facts; an unreadable store refuses (never "missing"). */
  #coverage(agentId: string, binding: PrivateOwnerApprovalBinding, caps: PrivateOwnerApprovalCaps): PrivateOwnerApprovalCoverage {
    try {
      const coverage = this.#options.ownerApprovals.covers(agentId, binding, caps);
      if (coverage !== "covered" && coverage !== "owner_wallet_approval_missing" && coverage !== "owner_approval_unverifiable") refuse("state_unavailable");
      return coverage;
    } catch (error: unknown) { if (error instanceof Refused) throw error; return refuse("state_unavailable"); }
  }

  /** The confirmed-rules prerequisites of arming and of an entries resume, in arming's order: confirmed, compiled Solana rules
   * with a stop-loss, an executable exit, not shadow mode, and no per-trade owner approval requirement. */
  #rules(agentId: string): { revisionId: string; exit: PrivateArmingExit } {
    const { head, revision } = readOrRefuse(() => this.#options.readRules(agentId));
    if (head.state === "empty" || !head.revisionId || !revision) refuse("rules_missing");
    if (head.state !== "compiled" || revision.revisionId !== head.revisionId || revision.chain !== "solana") refuse("rules_not_executable");
    const stopLossPct = revision.rules.risk?.stopLossPct;
    if (typeof stopLossPct !== "number" || !Number.isFinite(stopLossPct) || stopLossPct === 0) refuse("stop_loss_missing");
    const policy = deriveBehaviorRuleExecutionPolicy(revision, PRIVATE_RULE_EXECUTION_OPTIONS);
    const exit = policy ? toBehaviorRuleExecutionBinding(policy)?.exitSnapshot : undefined;
    if (!policy || !exit) refuse("rules_not_executable");
    if (!(exit.stopLossBps > 0)) refuse("stop_loss_missing");
    if (policy.shadowMode) refuse("rules_shadow_mode");
    if (privateApprovalRequired(policy.approval) || !isBehaviorRuleApprovalAutomatic(revision, PRIVATE_RULE_EXECUTION_OPTIONS)) refuse("owner_approval_required");
    return { revisionId: head.revisionId, exit };
  }

  /** The answered caps and, with `binding`, the stored owner wallet approval's coverage of them (arming and an entries resume). */
  #limits(agentId: string, binding: PrivateOwnerApprovalBinding | null): { spend: PrivateSpendStatus; perTrade: PrivateCapChoice; daily: PrivateCapChoice } {
    const spend = readOrRefuse(() => this.#options.ledger.status(agentId, this.#now()));
    // `unset` (never answered) refuses; an explicit `none` is a valid answer.
    if (!spend.configured || spend.limits.perTrade.kind === "unset" || spend.limits.daily.kind === "unset") refuse("limits_missing");
    const perTrade = spend.limits.perTrade as PrivateCapChoice, daily = spend.limits.daily as PrivateCapChoice;
    if (binding) {
      // A2a: the approval is verified against the sealed owner pin's identity; a missing or broken pin is named before the coverage.
      this.#ownerPin(agentId);
      const coverage = this.#coverage(agentId, binding, { perTrade, daily });
      if (coverage !== "covered") refuse(coverage);
    }
    return { spend, perTrade, daily };
  }

  /** Owner decision of 17 Nov 2026 (private-change-entries.ts): may new entries of this ARMED agent resume after an owner change
   * to rules, caps or sizing was saved? The rule prerequisites and the owner wallet approval coverage arming requires, re-run on
   * the current facts (the agent stays armed, so the arming-only checks such as `already_armed`, the lease or the passphrase do not
   * apply; the execution gate re-reads the rules head and the RPC class at every entry step anyway). Null: may resume. Synchronous
   * and fail-closed: any unreadable fact is `state_unavailable`. */
  entriesResumeRefusal(agentId: string): PrivateArmingChannelError | null {
    try {
      if (!this.#options.agentIds.includes(agentId)) refuse("unknown_agent");
      this.#rules(agentId);
      const wallet = readOrRefuse(() => this.#options.readWallet(agentId));
      if (wallet.state === "absent") refuse("wallet_missing");
      if (wallet.state === "held") refuse("state_unavailable");
      const record = readOrRefuse(() => this.#options.readBinding(agentId));
      if (!record) refuse("wallet_unbound");
      if (record.state !== "active" || record.binding.status !== "active" || record.binding.walletAddress !== wallet.address) refuse("wallet_binding_inactive");
      this.#limits(agentId, { walletBindingId: record.binding.walletBindingId, tradingWalletAddress: wallet.address });
      return null;
    } catch (error: unknown) {
      if (error instanceof Refused) return error.code;
      return "state_unavailable";
    }
  }

  /** What still keeps new entries of an armed agent paused, other than the rules and caps (`entriesResumeRefusal`): an owner change being
   * applied (`change_pending`), an unacknowledged re-signed copy, or an unfinished trade or open spend reservation (`submission_unresolved`).
   * Shared by the exits-only resume and the owner's entries resume. Synchronous; an unreadable fact throws (the caller fails closed). */
  #unresolvedRefusal(agentId: string): PrivateArmingChannelError | null {
    if (this.#guard(agentId).busy) return "change_pending";
    const submissions = this.#options.readSubmissions(agentId);
    const spend = this.#options.ledger.status(agentId, this.#now());
    if (submissions.copyHolds !== 0) return "copy_unacknowledged";
    if (submissions.unfinished !== 0 || spend.open.length !== 0) return "submission_unresolved";
    return null;
  }

  /** The owner's resume of NEW ENTRIES of an armed agent whose entries the owner paused (cockpit `/resume`, typed RESUME <agent>). Only
   * entries: it never arms, never changes caps, rules or exits (the agent stays live_armed and armed throughout, so stop-loss and
   * take-profit keep running). Refused, in this order and changing nothing: not live_armed (`not_armed`), a version other than the one
   * the owner reviewed (`version_conflict`), entries not paused (`entries_not_paused`), a pause the runner placed itself (a settings-change
   * hold at this version or an owner change being saved: `change_pending`; an exits-only arm: `submission_unresolved`, it resumes by
   * itself), an unfinished trade, open reservation or unacknowledged copy, then every entry prerequisite arming checks
   * (`entriesResumeRefusal`). Then the store's release CAS on exactly that version. Synchronous: nothing interleaves from the first read
   * to the release. Returns the released state. */
  #resumeEntries(agentId: string, expectedVersion: number, authority?: PrivateAuthorityCheck): RunnerAgentState {
    const o = this.#options;
    const state = readOrRefuse(() => o.readState(agentId));
    if (!state || state.agentId !== agentId) refuse("state_unavailable");
    if (state.mode !== "live_armed" || state.armed !== true || state.lifecycle !== "idle") refuse("not_armed");
    if (state.version !== expectedVersion) refuse("version_conflict");
    if (state.entries !== "paused") refuse("entries_not_paused");
    if (!o.releaseEntries || !o.readChangeHold) refuse("state_unavailable");
    // The runner's own holds are told apart from an owner pause by their version: a settings-change hold and an exits-only arm each record
    // the version their hold produced, and any owner control (a Hub or CLI pause included) moves the version. Both markers live in daemon
    // memory only, like the armed state itself: every restart lands live_unarmed with no entries key (state.ts), so neither can outlive it.
    const changeHold = readOrRefuse(() => o.readChangeHold?.(agentId));
    if (changeHold === state.version) refuse("change_pending");
    // An exits-only arm resumes by itself; one that is also held for unsealed settings (A2a) waits for this owner resume instead.
    if (this.exitsOnlyHeld(agentId) && !this.authorityHeld(agentId)) refuse("submission_unresolved");
    const unresolved = readOrRefuse(() => this.#unresolvedRefusal(agentId));
    if (unresolved) refuse(unresolved);
    const prerequisite = this.entriesResumeRefusal(agentId);
    if (prerequisite) refuse(prerequisite);
    // A2a: new entries turn on again only under settings the owner sealed (equal or tighter): missing or looser refuses
    // `authority_unsealed` until the owner's seal step; a locked wallet or an unreadable fact refuses with its code.
    if (authority && !authority.ok) refuse(authority.code);
    // The state became resumable after the watermark read was skipped: never resumed unchecked.
    if (o.verifyAuthority && !authority) refuse("state_unavailable");
    let released: RunnerEntriesRelease;
    try { released = o.releaseEntries(agentId, expectedVersion); } catch { return refuse("state_unavailable"); }
    if (released.kind === "refused") refuse("state_unavailable");
    if (released.kind === "version_changed") refuse("version_conflict");
    if (released.kind === "not_paused") refuse("entries_not_paused");
    if (released.kind === "not_armed") refuse("not_armed");
    const after = released.state;
    this.#authorityHeld.delete(agentId); this.#exitsOnly.delete(agentId);
    if (after.mode !== "live_armed" || after.armed !== true || after.entries !== "enabled" || after.version !== expectedVersion + 1) refuse("state_unavailable");
    try { o.onEntriesResumed?.(agentId); } catch { /* The heartbeat interval reports it. */ }
    return after;
  }

  /** Phase 1: pauses new entries of the agent just armed exits-only. A hold that did not apply never leaves entries on: the agent is
   * disarmed again at once (nothing executes) and the arm reads `state_unavailable` (the CLI then says to check and disarm). */
  #holdExitsOnly(agentId: string, holds: Evaluated["holds"]): RunnerAgentState | null {
    let hold: RunnerEntriesHold | undefined;
    try { hold = this.#options.holdEntries?.(agentId); } catch { hold = undefined; }
    if (hold?.kind === "held" && hold.state.mode === "live_armed" && hold.state.entries === "paused") {
      if (holds.submissions) this.#exitsOnly.set(agentId, hold.state.version);
      if (holds.authority) this.#authorityHeld.set(agentId, hold.state.version);
      try { this.#options.onExitsOnly?.(agentId, "held"); } catch { /* The daemon's next interval reports and reconciles. */ }
      return hold.state;
    }
    try { this.#options.disarm?.(agentId); } catch { /* The next status read shows the state; the CLI tells the owner to disarm. */ }
    return null;
  }

  /** True while this agent is armed exits-only by this daemon run and no control moved its state since (same hold version). */
  exitsOnlyHeld(agentId: string): boolean {
    const version = this.#exitsOnly.get(agentId);
    if (version === undefined) return false;
    try {
      const state = this.#options.readState(agentId);
      return state?.mode === "live_armed" && state.entries === "paused" && state.version === version;
    } catch { return false; }
  }

  /** A2a: true while this agent is armed with new entries paused by this daemon run because the owner-sealed settings were missing or
   * looser, and no control moved its state since (same hold version). Only the owner's entries_resume lifts it. */
  authorityHeld(agentId: string): boolean {
    const version = this.#authorityHeld.get(agentId);
    if (version === undefined) return false;
    try {
      const state = this.#options.readState(agentId);
      return state?.mode === "live_armed" && state.entries === "paused" && state.version === version;
    } catch { return false; }
  }

  /** Phase 1: the daemon's periodic check of an exits-only arm. `none`: no such arm; `ended`: a control moved the state (a Hub or CLI
   * pause, disarm, stop or another arm wins, nothing is lifted); `waiting`: an unresolved trade, an unacknowledged copy, an open
   * reservation, an owner change in flight or a failed entry prerequisite keeps entries paused; `resumed`: new entries are on again.
   * The same prerequisites as a change pause (`entriesResumeRefusal`), then the release CAS on the hold version. Synchronous. */
  resumeExitsOnly(agentId: string): "none" | "ended" | "waiting" | "resumed" {
    const version = this.#exitsOnly.get(agentId);
    if (version === undefined) return "none";
    let state: RunnerAgentState | undefined;
    try { state = this.#options.readState(agentId); } catch { return "waiting"; }
    if (!state) return "waiting";
    if (state.mode !== "live_armed" || state.entries !== "paused" || state.version !== version) { this.#exitsOnly.delete(agentId); return "ended"; }
    try { if (this.#unresolvedRefusal(agentId) !== null) return "waiting"; } catch { return "waiting"; }
    if (this.entriesResumeRefusal(agentId) !== null) return "waiting";
    // A2a: the same arm is also held for unsealed settings: its exits-only part is over, but only the owner's entries_resume (after the
    // seal step) turns new entries on again.
    if (this.authorityHeld(agentId)) { this.#exitsOnly.delete(agentId); return "ended"; }
    let released: RunnerEntriesRelease | undefined;
    try { released = this.#options.releaseEntries?.(agentId, version); } catch { return "waiting"; }
    if (!released || released.kind === "refused") return "waiting";
    this.#exitsOnly.delete(agentId);
    if (released.kind !== "released") return "ended";
    try { this.#options.onExitsOnly?.(agentId, "resumed"); } catch { /* The heartbeat interval reports it. */ }
    return "resumed";
  }

  /** Every precheck in a fixed order; the first failing one is the refusal. Synchronous: nothing interleaves. `approval` false
   * (only for approval_request) skips the owner-approval check itself, never any other. */
  #evaluate(agentId: string, sizing: PrivateBuyAmountPolicy | null, approval = true, authority?: PrivateAuthorityCheck): Evaluated {
    const o = this.#options;
    const read = <T>(reader: () => T): T => { try { return reader(); } catch { return refuse("state_unavailable"); } };
    // First: a build without automatic exits refuses every arm before any setup precheck, so the owner learns it up front.
    if ((o.capabilities ?? PRIVATE_EXECUTION_CAPABILITIES).exits !== true) refuse("exits_unavailable");
    const state = read(() => o.readState(agentId));
    if (!state || state.agentId !== agentId) refuse("state_unavailable");
    if (state.lifecycle === "stopped") refuse("agent_stopped");
    if (state.mode === "live_armed") refuse("already_armed");
    if (state.mode !== "shadow" && state.mode !== "live_unarmed") refuse("agent_paused");
    if (!read(() => o.readPaired(agentId))) refuse("not_paired");
    const lease = read(() => o.readLease(agentId));
    if (!lease || lease.instanceId !== o.instanceId || !(lease.remainingMs > 0)) refuse("lease_unavailable");
    const wallet = read(() => o.readWallet(agentId));
    if (wallet.state === "absent") refuse("wallet_missing");
    if (wallet.state === "held") refuse("state_unavailable");
    if (wallet.state !== "unlocked" || !wallet.addressVerified) refuse("wallet_locked");
    const record = read(() => o.readBinding(agentId));
    if (!record) refuse("wallet_unbound");
    if (record.state !== "active") refuse("wallet_binding_inactive");
    const bound = record.binding;
    if (bound.status !== "active" || bound.walletAddress !== wallet.address || bound.agentId !== lease.agentId || bound.bindingDigest !== lease.bindingDigest
      || bound.runnerPublicKey !== lease.runnerPublicKey || record.frontendOrigin !== lease.frontendOrigin) refuse("wallet_binding_inactive");
    const rpc = read(() => o.readRpc(agentId)).endpoint;
    if (!rpc) refuse("rpc_missing");
    // Decision 12: a public endpoint is shadow-only; live execution needs the owner's own RPC or (owner decision of 17 Nov 2026) the
    // two Balchemy-provided sources.
    if (!privateRpcClassExecutable(rpc.class)) refuse("rpc_public");
    const { revisionId: rulesRevisionId, exit } = this.#rules(agentId);
    // S6 moment 3: the owner's wallet approval must cover this binding and the current caps (verified locally, offline).
    const { spend, perTrade, daily } = this.#limits(agentId, approval ? { walletBindingId: bound.walletBindingId, tradingWalletAddress: wallet.address } : null);
    if (!sizing) refuse("sizing_missing");
    // A stored size above the execution bound could never buy: refused, never quietly reviewed at a lower slippage.
    if (!privateSizingSlippageUsable(sizing.slippageBps)) refuse("sizing_slippage_above_bound");
    // A2a authority watermark (amendments section C): settings the owner never sealed, or looser than the seal, never turn new entries on;
    // they arm for exits only (below), so open positions are never left without their stop-loss. An unreadable watermark
    // (`state_unavailable`: a corrupt or held model vault, launchpad mirror, seal or any other store it reads) is never covered either, and
    // arms exits-only the same way: those stores were never arming prerequisites, so they must not block stop-loss and take-profit. The
    // entries stay paused and entries_resume refuses until the watermark verifies again. A locked wallet (`wallet_locked`) and no wallet
    // (`wallet_missing`) keep their meaning and refuse.
    let authorityHold = false;
    if (authority && !authority.ok) {
      if (authority.code === "wallet_locked" || authority.code === "wallet_missing") refuse(authority.code);
      authorityHold = true;
    }
    const submissions = read(() => o.readSubmissions(agentId));
    if (submissions.copyHolds > 0) refuse("copy_unacknowledged");
    // M3.6 D6 K1 and B1: when every unresolved attempt is a trade Balchemy never received, the refusal names that hold (the runner's own
    // not-landed proof ends it while disarmed; `runner trades` shows what the proof waits for).
    const unrelayed = submissions.unrelayed ?? 0;
    if (unrelayed > 0 && unrelayed === submissions.unfinished) refuse("submission_unrelayed");
    // Phase 1 (17 Nov 2026), the restart deadlock: every restart disarms, and the release of a runner dispute (F2) or of a buy Balchemy
    // leaves unresolved (SF R10) needs the armed exit gate, while these attempts never become terminal by themselves (only the owner's
    // `runner trades <agent> close <attempt>` ends them). Refusing here left every OTHER open position without stop-loss. So, when no
    // unfinished buy can be sent again (its relay closed or released: a runner dispute, a held buy negative, an unresolved sell), arming
    // proceeds EXITS ONLY: new entries stay paused (holdEntries, right after arm) until no unresolved trade remains. A buy whose relay is
    // still open and that can still be resent keeps the refusal, also a stalled one whose relay the runner has not closed yet (it closes
    // after a status read that shows the blockhash expired, private-submission.ts #reconcileAttempt), and an unknown count (fail closed).
    // Audit M1: a buy whose resends are exhausted can never be sent again, so it no longer keeps the refusal (privateArmingSubmissionCounts).
    let submissionsHold = false;
    if (submissions.unfinished > 0 || spend.open.length > 0) {
      if (!o.holdEntries || !o.releaseEntries || !o.disarm || submissions.relayableBuys !== 0) refuse("submission_unresolved");
      submissionsHold = true;
    }
    // A2a: an exits-only arm needs the same internal hold, release and ensure-disarm; without them the watermark's own code refuses.
    if (authorityHold && (!o.holdEntries || !o.releaseEntries || !o.disarm)) refuse(authority && !authority.ok ? authority.code : "authority_unsealed");
    const entriesHold = authorityHold ? "authority_unsealed" as const : submissionsHold ? "submission_unresolved" as const : undefined;
    // Last, synchronously before the caller's arm(): an owner change being applied right now refuses this arm.
    if (this.#guard(agentId).busy) refuse("busy");
    return { holds: { submissions: submissionsHold, authority: authorityHold }, ...(entriesHold ? { entriesHold } : {}), agentId, runtimeVersion: state.version, mode: state.mode, walletAddress: wallet.address, walletBindingId: bound.walletBindingId,
      rpcHost: rpc.host, rpcRevision: rpc.revision, limitsRevision: spend.limits.revision, perTrade, daily,
      perTradeBasis: spend.limits.perTradeBasis, dailyBasis: spend.limits.dailyBasis, rulesRevisionId, stopLossBps: exit.stopLossBps,
      takeProfitLevels: exit.takeProfitLevels.length, sizingAmountSol: sizing.amountSol, sizingAmountLamports: sizing.amountBaseUnits,
      sizingSlippageBps: sizing.slippageBps };
  }

  /** One read-only assessment of the configured trade size into the reference mint, for the global fee display only. */
  async #fee(agentId: string, facts: Facts, signal?: AbortSignal): Promise<PrivateArmingFee> {
    if (!this.#options.assessFee) return { state: "unavailable" };
    const request: RunnerAssessmentRequest = { version: 1, chain: "solana", inputMint: PRIVATE_ASSESSMENT_INPUT_MINT, outputMint: PRIVATE_ARMING_FEE_PROBE_MINT,
      grossInputLamports: facts.sizingAmountLamports, slippageBps: facts.sizingSlippageBps,
      planDigest: createHash("sha256").update(JSON.stringify(["balchemy.local-agent.arming-fee-probe.v1", agentId, randomUUID()]), "utf8").digest("hex") };
    try {
      const receipt = await this.#options.assessFee(agentId, request, signal, FEE_PROBE_TIMEOUT_MS);
      const fee = receipt.response.assessment.fee;
      if (fee.source !== "backend_global_fee_config" || fee.grossInputLamports !== request.grossInputLamports
        || !Number.isSafeInteger(fee.rateBps) || fee.rateBps < 0 || fee.rateBps > 10_000) return { state: "unavailable" };
      return { state: "shown", rateBps: fee.rateBps, grossInputLamports: fee.grossInputLamports, feeLamports: fee.feeLamports };
    } catch { return { state: "unavailable" }; }
  }
}
