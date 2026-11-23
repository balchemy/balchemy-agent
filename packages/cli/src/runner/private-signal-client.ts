import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateSignalRequest, validatePrivateSignalReply,
  type PrivateSignalBinding, type PrivateSignalRequest, type PrivateSignalResponse } from "./private-signal-protocol.js";

export class PrivateSignalTransportError extends Error {
  constructor() { super("Private signal read unavailable"); this.name = "PrivateSignalTransportError"; }
}
export type PrivateSignalTransport = (socketPath: string, request: PrivateSignalRequest) => Promise<PrivateSignalResponse>;
export function privateSignalBinding(target: PrivateBrainTarget): PrivateSignalBinding {
  return { channel: "private_signals", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId };
}
/** One bounded, read-only exchange. No reconnect, retry or execution path. */
export async function requestPrivateSignal(socketPath: string, input: PrivateSignalRequest): Promise<PrivateSignalResponse> {
  const request = parsePrivateSignalRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateSignalTransportError(); }
  return new Promise<PrivateSignalResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader(); let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; socket.destroy(); reject(new PrivateSignalTransportError());
    };
    const deadline = setTimeout(fail, 3000);
    socket.once("close", () => { clearTimeout(deadline); fail(); }); socket.on("error", fail);
    socket.on("connect", () => socket.end(encodeFrame(request)));
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = validatePrivateSignalReply(request, reader.finish());
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
