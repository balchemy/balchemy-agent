import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { encodeFrame, FrameReader } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateAutonomyRequest, validatePrivateAutonomyReply,
  type PrivateAutonomyBinding, type PrivateAutonomyRequest, type PrivateAutonomyResponse } from "./private-autonomy-protocol.js";

export class PrivateAutonomyTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") {
    super(`Local model allowance ${code}`); this.name = "PrivateAutonomyTransportError";
  }
}
export type PrivateAutonomyTransport = (socketPath: string, request: PrivateAutonomyRequest) => Promise<PrivateAutonomyResponse>;
export function privateAutonomyBinding(target: PrivateBrainTarget): PrivateAutonomyBinding {
  return { channel: "private_autonomy", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId };
}
/** One bounded owner-socket exchange. A missing update reply never causes a retry. */
export async function requestPrivateAutonomy(socketPath: string, input: PrivateAutonomyRequest): Promise<PrivateAutonomyResponse> {
  const request = parsePrivateAutonomyRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateAutonomyTransportError("connection_unavailable"); }
  return new Promise<PrivateAutonomyResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; clearTimeout(deadline); socket.destroy();
      reject(new PrivateAutonomyTransportError(sent && request.action === "update" ? "outcome_unknown" : "connection_unavailable"));
    };
    // A2a: a frame that carries the socket proof waits for the daemon's proof deadline.
    const deadline = setTimeout(fail, Object.hasOwn(request, "passphrase") ? SOCKET_PROOF_CLIENT_TIMEOUT_MS : 3000);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = validatePrivateAutonomyReply(request, reader.finish());
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
