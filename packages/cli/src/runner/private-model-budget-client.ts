import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { encodeFrame, FrameReader } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateModelBudgetRequest, validatePrivateModelBudgetReply,
  type PrivateModelBudgetBinding, type PrivateModelBudgetRequest, type PrivateModelBudgetResponse } from "./private-model-budget-protocol.js";

export class PrivateModelBudgetTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") {
    super(`Local AI budget ${code}`); this.name = "PrivateModelBudgetTransportError";
  }
}
export type PrivateModelBudgetTransport = (socketPath: string, request: PrivateModelBudgetRequest) => Promise<PrivateModelBudgetResponse>;
export function privateModelBudgetBinding(target: PrivateBrainTarget): PrivateModelBudgetBinding {
  return { channel: "private_model_budget", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId };
}
/** One bounded owner-socket exchange. A missing update reply never causes a retry. */
export async function requestPrivateModelBudget(socketPath: string, input: PrivateModelBudgetRequest): Promise<PrivateModelBudgetResponse> {
  const request = parsePrivateModelBudgetRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateModelBudgetTransportError("connection_unavailable"); }
  return new Promise<PrivateModelBudgetResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; clearTimeout(deadline); socket.destroy();
      reject(new PrivateModelBudgetTransportError(sent && request.action === "update" ? "outcome_unknown" : "connection_unavailable"));
    };
    // A2a: a frame that carries the socket proof waits for the daemon's proof deadline.
    const deadline = setTimeout(fail, Object.hasOwn(request, "passphrase") ? SOCKET_PROOF_CLIENT_TIMEOUT_MS : 3000);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = validatePrivateModelBudgetReply(request, reader.finish());
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
