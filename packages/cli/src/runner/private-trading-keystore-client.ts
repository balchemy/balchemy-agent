import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateTradingWalletRequest, validatePrivateTradingWalletReply, TRADING_WALLET_UNLOCK_TIMEOUT_MS,
  type PrivateTradingWalletBinding, type PrivateTradingWalletRequest, type PrivateTradingWalletResponse } from "./private-trading-keystore-protocol.js";

const REQUEST_TIMEOUT_MS = 3_000;

export class PrivateTradingWalletTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") {
    super(`Local trading wallet ${code}`); this.name = "PrivateTradingWalletTransportError";
  }
}
export type PrivateTradingWalletTransport = (socketPath: string, request: PrivateTradingWalletRequest) => Promise<PrivateTradingWalletResponse>;
export function privateTradingWalletBinding(target: PrivateBrainTarget): PrivateTradingWalletBinding {
  return { channel: "private_trading_wallet", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId };
}
/** One bounded owner-socket exchange. A lost mutation reply is unknown and never retried.
 * Unlock alone gets the longer scrypt deadline; status and preflight never mutate. */
export async function requestPrivateTradingWallet(socketPath: string, input: PrivateTradingWalletRequest): Promise<PrivateTradingWalletResponse> {
  const request = parsePrivateTradingWalletRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateTradingWalletTransportError("connection_unavailable"); }
  return new Promise<PrivateTradingWalletResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; clearTimeout(deadline); socket.destroy();
      reject(new PrivateTradingWalletTransportError(sent && request.action !== "status" && request.action !== "preflight"
        ? "outcome_unknown" : "connection_unavailable"));
    };
    const deadline = setTimeout(fail, request.action === "unlock" ? TRADING_WALLET_UNLOCK_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = validatePrivateTradingWalletReply(request, reader.finish());
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
