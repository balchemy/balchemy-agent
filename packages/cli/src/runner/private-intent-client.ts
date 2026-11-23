import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateIntentRequest, parsePrivateIntentResponse,
  type PrivateIntentBinding, type PrivateIntentRequest, type PrivateIntentResponse } from "./private-intent-protocol.js";

export class PrivateIntentTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") { super(`Private intent ${code}`); this.name = "PrivateIntentTransportError"; }
}
export type PrivateIntentTransport = (socketPath: string, request: PrivateIntentRequest) => Promise<PrivateIntentResponse>;
export function privateIntentBinding(target: PrivateBrainTarget): PrivateIntentBinding {
  return { channel: "private_intents", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId };
}
/** A sent preview may already be durable. Never retry with another intent ID. */
export async function requestPrivateIntent(socketPath: string, value: PrivateIntentRequest): Promise<PrivateIntentResponse> {
  const request = parsePrivateIntentRequest(value);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateIntentTransportError("connection_unavailable"); }
  return new Promise<PrivateIntentResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; socket.destroy();
      reject(new PrivateIntentTransportError(sent && request.action === "preview" ? "outcome_unknown" : "connection_unavailable"));
    };
    const deadline = setTimeout(fail, 3000);
    socket.once("close", () => { clearTimeout(deadline); fail(); }); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = parsePrivateIntentResponse(reader.finish());
        if (response.id !== request.id || response.localProfileId !== request.localProfileId || response.instanceId !== request.instanceId
          || response.agentId !== request.agentId) { fail(); return; }
        if (response.ok) {
          const preview = response.preview; const intentId = request.action === "preview" ? request.request.intentId : request.intentId;
          if ((request.action === "preview" && preview === null) || (preview && preview.request.intentId !== intentId)) { fail(); return; }
          if (preview && request.action === "preview") {
            const expected = request.request; const got = preview.request;
            if (got.expectedRuntimeVersion !== expected.expectedRuntimeVersion || got.expectedRevisionId !== expected.expectedRevisionId
              || got.refId !== expected.refId || got.amountSol !== expected.amountSol || got.slippageBps !== expected.slippageBps) { fail(); return; }
          }
        }
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
