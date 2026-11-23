import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateTradingBindingRequest, validatePrivateTradingBindingReply, TRADING_BINDING_TIMEOUT_MS,
  type PrivateTradingBindingFrame, type PrivateTradingBindingRequest, type PrivateTradingBindingResponse } from "./private-trading-binding-protocol.js";

const STATUS_TIMEOUT_MS = 3_000;

export class PrivateTradingBindingTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") {
    super(`Local trading wallet binding ${code}`); this.name = "PrivateTradingBindingTransportError";
  }
}
export type PrivateTradingBindingTransport = (socketPath: string, request: PrivateTradingBindingRequest) => Promise<PrivateTradingBindingResponse>;
export function privateTradingBindingFrame(target: PrivateBrainTarget): PrivateTradingBindingFrame {
  return { channel: "private_trading_binding", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId };
}
/** One bounded owner-socket exchange. A lost bind reply is unknown and never retried here. */
export async function requestPrivateTradingBinding(socketPath: string, input: PrivateTradingBindingRequest): Promise<PrivateTradingBindingResponse> {
  const request = parsePrivateTradingBindingRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateTradingBindingTransportError("connection_unavailable"); }
  return new Promise<PrivateTradingBindingResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; clearTimeout(deadline); socket.destroy();
      reject(new PrivateTradingBindingTransportError(sent && request.action === "bind" ? "outcome_unknown" : "connection_unavailable"));
    };
    const deadline = setTimeout(fail, request.action === "bind" ? TRADING_BINDING_TIMEOUT_MS : STATUS_TIMEOUT_MS);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = validatePrivateTradingBindingReply(request, reader.finish());
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
