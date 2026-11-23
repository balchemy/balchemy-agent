import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { requireUnixPlatform } from "./daemon.js";
import { encodeFrame, FrameReader, parseLocalRequest, parseResponse, type LocalRunnerRequest, type RunnerResponse } from "./protocol.js";

export class RunnerTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown", readonly operationId?: string) {
    super(`Local runner ${code}`);
    this.name = "RunnerTransportError";
  }
}

/** One local command, no retry. An ambiguous mutation must reuse its exact ID. */
export async function requestRunner(socketPath: string, input: LocalRunnerRequest): Promise<RunnerResponse> {
  requireUnixPlatform();
  const request = parseLocalRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath));
    const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) {
      throw new Error("unsafe local socket");
    }
  } catch { throw new RunnerTransportError("connection_unavailable"); }

  return new Promise<RunnerResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const reader = new FrameReader();
    let sent = false;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(sent && request.action !== "status" && request.action !== "daemon_status" && request.action !== "daemon_version" && request.action !== "agent_list"
        ? new RunnerTransportError("outcome_unknown", request.id)
        : new RunnerTransportError("connection_unavailable"));
    };
    socket.setTimeout(3_000, fail);
    socket.on("error", fail);
    socket.on("close", fail);
    socket.on("connect", () => {
      sent = true;
      // Half-close the request stream. The daemon dispatches only after EOF,
      // preventing trailing/multiple frames from racing a first mutation.
      socket.end(encodeFrame(request));
    });
    socket.on("data", (chunk: Buffer) => {
      try { reader.push(chunk); } catch { fail(); }
    });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = parseResponse(reader.finish());
        if (response.id !== request.id
          || ((response.hub || response.brainObservation || response.keystoreObservation || response.submissionSecurity || response.executionStatus) && request.action !== "status")
          || (response.state && (!("agentId" in request) || response.state.agentId !== request.agentId))
          || (response.daemon && (!("instanceId" in request) || response.daemon.instanceId !== request.instanceId))
          || (response.daemon && (response.daemon.packageVersion !== undefined) !== (request.action === "daemon_version"))
          || (response.inventory && (!("instanceId" in request) || response.inventory.instanceId !== request.instanceId))
          // register_agent: every success says whether it added the agent; no other reply carries that.
          || ((response.registration !== undefined) !== (request.action === "register_agent" && response.ok))
          || (response.ok && (("agentId" in request) ? !response.state : request.action === "agent_list" ? !response.inventory : !response.daemon))) { fail(); return; }
        settled = true;
        socket.destroy();
        resolve(response);
      } catch { fail(); }
    });
  });
}
