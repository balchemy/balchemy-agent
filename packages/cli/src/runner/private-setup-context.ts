/** The setup state the cockpit's guide (the inner model) sees: closed values and public facts only. Never a key, a
 * passphrase, an RPC URL or a host. It explains; it decides nothing: cards and every gate are computed by code. */
import type { PrivateBalchemyRpcState } from "./private-balchemy-rpc.js";
import type { PrivateSolanaRpcEndpoint } from "./private-solana-rpc.js";

export type SetupContextStep = "done" | "todo" | "unknown";
/** Owner decision of 17 Nov 2026: users are never asked for an RPC. `balchemy`: Balchemy's two providers are connected; `waiting`:
 * the connection is being set up (nothing for the owner to do); `own`: the owner's own endpoint (an optional advanced setting);
 * `public` / `missing`: no Balchemy connection can be obtained right now and no own endpoint of the owner class is set. */
export type PrivateSetupRpc = "missing" | "public" | "own" | "balchemy" | "waiting";
/** The one mapping from the owner's endpoint class and the Balchemy connection state to the setup value. */
export function privateSetupRpc(ownClass: PrivateSolanaRpcEndpoint["class"] | null, provided: PrivateBalchemyRpcState | null): PrivateSetupRpc {
  if (ownClass === "owner_configured") return "own";
  if (provided === "ready") return "balchemy";
  if (provided === "waiting") return "waiting";
  return ownClass === "public_shadow_only" ? "public" : "missing";
}
/** True when the RPC setup step is done (the agent can execute on it). */
export function privateSetupRpcDone(value: PrivateSetupRpc): boolean { return value === "own" || value === "balchemy"; }
export interface PrivateSetupFacts {
  paired: boolean | "unknown";
  wallet: "absent" | "held" | "locked" | "unlocked" | "unknown";
  walletLinked: boolean | "unknown";
  rpc: PrivateSetupRpc | "unknown";
  limits: boolean | "unknown";
  rules: boolean | "unknown";
  automatic: boolean | "unknown";
  sizing: boolean | "unknown";
  armed: boolean | "unknown";
  walletAddress?: string;
  /** The two Balchemy-provided sources disagreed recently (closed reason rpc_sources_disagree); that step was stopped. */
  rpcSourcesDisagree?: boolean;
}
/** The RPC step comes last before arming: Balchemy provides the connection, so it is only ever the guide's topic when that is
 * unavailable (then the owner's own endpoint is the advanced option). */
const ORDER = ["hub", "wallet", "limits", "rules", "approval", "sizing", "rpc", "arm"] as const;

function step(value: boolean | "unknown"): SetupContextStep { return value === "unknown" ? "unknown" : value ? "done" : "todo"; }

/** Compact JSON for the model: each step, the first unfinished one, and the public wallet address. */
export function privateSetupContext(facts: PrivateSetupFacts): string {
  const steps: Record<(typeof ORDER)[number], SetupContextStep> = {
    hub: step(facts.paired),
    wallet: facts.wallet === "unknown" || facts.walletLinked === "unknown" ? "unknown" : step(facts.wallet === "unlocked" && facts.walletLinked === true),
    rpc: facts.rpc === "unknown" || facts.rpc === "waiting" ? "unknown" : step(privateSetupRpcDone(facts.rpc)),
    limits: step(facts.limits), rules: step(facts.rules), approval: step(facts.automatic), sizing: step(facts.sizing), arm: step(facts.armed),
  };
  const next = ORDER.find((name) => steps[name] !== "done") ?? "running";
  const address = facts.walletAddress && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(facts.walletAddress) ? facts.walletAddress : undefined;
  return JSON.stringify({ chain: "solana", steps, next, ...(facts.wallet === "locked" ? { walletLocked: true } : {}),
    ...(facts.rpc === "public" ? { rpcIsPublicShadowOnly: true } : {}), ...(facts.rpc === "balchemy" ? { rpcProvidedByBalchemy: true } : {}),
    ...(facts.rpc === "waiting" ? { rpcConnecting: true } : {}), ...(facts.rpc === "missing" || facts.rpc === "public" ? { rpcBalchemyUnavailable: true } : {}),
    ...(facts.rpcSourcesDisagree === true ? { rpcSourcesDisagree: true } : {}), ...(address ? { tradingWalletAddress: address } : {}) });
}

/** Reads every fact independently; one failing read is `unknown`, never a guess. */
export async function readPrivateSetupFacts(readers: {
  paired(): boolean;
  wallet(): { state: "absent" | "held" | "locked" | "unlocked"; address?: string };
  walletLinked(): boolean;
  rpc(): PrivateSetupRpc;
  limits(): boolean;
  rules(): { present: boolean; automatic: boolean };
  sizing(): Promise<boolean>;
  armed(): boolean;
  rpcSourcesDisagree?(): boolean;
}): Promise<PrivateSetupFacts> {
  const read = <T>(reader: () => T): T | "unknown" => { try { return reader(); } catch { return "unknown"; } };
  const wallet = read(readers.wallet);
  const rules = read(readers.rules);
  let sizing: boolean | "unknown";
  try { sizing = await readers.sizing(); } catch { sizing = "unknown"; }
  return {
    paired: read(readers.paired), wallet: wallet === "unknown" ? "unknown" : wallet.state, walletLinked: read(readers.walletLinked),
    rpc: read(readers.rpc), limits: read(readers.limits),
    rules: rules === "unknown" ? "unknown" : rules.present, automatic: rules === "unknown" ? "unknown" : rules.automatic,
    sizing, armed: read(readers.armed),
    ...(wallet !== "unknown" && wallet.address ? { walletAddress: wallet.address } : {}),
    ...(read(() => readers.rpcSourcesDisagree?.() === true) === true ? { rpcSourcesDisagree: true } : {}),
  };
}
