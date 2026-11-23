import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { readLocalProfile, readDaemonMetadata, inspectDirectory } from "./metadata.js";
import { encodeFrame, FrameReader, isId } from "./protocol.js";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { parsePrivateBrainRequest, parsePrivateBrainResponse,
  type PrivateBrainRequest, type PrivateBrainResponse } from "./private-brain-protocol.js";

export class PrivateBrainTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown", readonly operationId?: string) {
    super(`Local conversation ${code}`); this.name = "PrivateBrainTransportError";
  }
}
export interface PrivateBrainTarget { socketPath: string; localProfileId: string; instanceId: string; agentId: string }

/** Read-only target discovery; the daemon independently validates every binding. */
export function readPrivateBrainTarget(directory: string, agentId: string): PrivateBrainTarget {
  try {
    if (!isId(agentId)) throw new Error("invalid agent");
    const resolved = inspectDirectory(directory);
    if (!resolved) throw new Error("missing directory");
    const profile = readLocalProfile(resolved);
    const metadata = profile ? readDaemonMetadata(resolved, profile) : undefined;
    if (!profile || !metadata) throw new Error("missing metadata");
    return { socketPath: path.join(resolved, "control.sock"), localProfileId: profile.localProfileId,
      instanceId: metadata.instanceId, agentId };
  } catch { throw new PrivateBrainTransportError("connection_unavailable"); }
}

/** No implicit retries, transcript logging, environment imports or key storage. */
export async function requestPrivateBrain(socketPath: string, input: PrivateBrainRequest): Promise<PrivateBrainResponse> {
  // Every field is primitive. Pin the validated operation before connecting;
  // later edits to the caller's object must not change its job or credential.
  const request = Object.freeze({ ...parsePrivateBrainRequest(input) }) as PrivateBrainRequest;
  try {
    const directory = fs.lstatSync(path.dirname(socketPath));
    const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("unsafe socket");
  } catch { throw new PrivateBrainTransportError("connection_unavailable"); }
  return new Promise<PrivateBrainResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true; socket.destroy();
      reject(new PrivateBrainTransportError(sent && request.action !== "chat_read" && request.action !== "model_status"
        ? "outcome_unknown" : "connection_unavailable", request.id));
    };
    // A2a: a model change that carries the trading-wallet proof waits for the daemon's proof deadline.
    const deadline = setTimeout(fail, Object.hasOwn(request, "walletPassphrase") ? SOCKET_PROOF_CLIENT_TIMEOUT_MS : 3_000);
    socket.once("close", () => { clearTimeout(deadline); fail(); });
    socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = parsePrivateBrainResponse(reader.finish());
        const modelRequest = request.action.startsWith("model_");
        if (response.id !== request.id || response.agentId !== request.agentId
          || response.localProfileId !== request.localProfileId || response.instanceId !== request.instanceId
          || (response.ok && (modelRequest ? !("model" in response) : !("job" in response)))
          || (response.ok && "job" in response && response.job && (modelRequest || !("jobId" in request) || response.job.jobId !== request.jobId))) {
          fail(); return;
        }
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
