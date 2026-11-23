import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { encodeFrame, FrameReader } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateRuleRequest, parsePrivateRuleResponse, MAX_RULE_DOCUMENT_BYTES,
  type PrivateRuleBinding, type PrivateRuleRequest, type PrivateRuleResponse, type RuleDigest, type RuleRevisionId,
  type RuleChannelError } from "./private-rule-protocol.js";

export class PrivateRuleTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown" | "invalid_document") {
    super(`Local rules ${code}`); this.name = "PrivateRuleTransportError";
  }
}
export class PrivateRuleRequestError extends Error {
  constructor(readonly code: RuleChannelError) { super(`Local rules ${code}`); this.name = "PrivateRuleRequestError"; }
}
export type PrivateRuleTarget = PrivateBrainTarget & { chain: "solana" | "base" };
export type PrivateRuleTransport = (socketPath: string, request: PrivateRuleRequest) => Promise<PrivateRuleResponse>;
export function privateRuleBinding(target: PrivateRuleTarget): PrivateRuleBinding {
  return { channel: "private_rules", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId, chain: target.chain };
}
/** One owner-socket operation; no retries or model calls. */
export async function requestPrivateRule(socketPath: string, value: PrivateRuleRequest): Promise<PrivateRuleResponse> {
  const request = Object.freeze({ ...parsePrivateRuleRequest(value) }) as PrivateRuleRequest;
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("unsafe socket");
  } catch { throw new PrivateRuleTransportError("connection_unavailable"); }
  return new Promise<PrivateRuleResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; socket.destroy();
      const mutation = request.action === "propose" || request.action === "rollback" || request.action === "approval" || request.action === "confirm";
      reject(new PrivateRuleTransportError(sent && mutation ? "outcome_unknown" : "connection_unavailable"));
    };
    // A2a: a frame that carries the socket proof waits for the daemon's proof deadline.
    const deadline = setTimeout(fail, Object.hasOwn(request, "passphrase") ? SOCKET_PROOF_CLIENT_TIMEOUT_MS : 3000);
    socket.once("close", () => { clearTimeout(deadline); fail(); }); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = parsePrivateRuleResponse(reader.finish());
        if (response.id !== request.id || response.localProfileId !== request.localProfileId || response.instanceId !== request.instanceId
          || response.agentId !== request.agentId || response.chain !== request.chain) { fail(); return; }
        if (response.ok) {
          const data = response.data;
          switch (request.action) {
            case "head": if (data.kind !== "head") { fail(); return; } break;
            case "propose": case "rollback": case "approval":
              if (data.kind !== "proposal" || data.proposalId !== request.proposalId) { fail(); return; } break;
            case "proposal_read": case "revision_read":
              if (data.kind !== "page" || data.page.offset !== request.offset || data.page.documentId !==
                (request.action === "proposal_read" ? request.proposalId : request.revisionId)) { fail(); return; } break;
            case "confirm": case "receipt":
              if (data.kind !== "receipt" || (request.action === "confirm" && data.receipt === null)
                || (data.receipt && (data.receipt.input.operationId !== request.operationId || (request.action === "confirm"
                  && (data.receipt.input.proposalId !== request.proposalId || data.receipt.input.proposalDigest !== request.proposalDigest
                    || data.receipt.input.expectedRevision !== request.expectedRevision || data.receipt.input.expectedRevisionId !== request.expectedRevisionId))))) { fail(); return; }
              break;
            case "history":
              if (data.kind !== "history" || data.history.some((entry, i, all) =>
                (request.beforeRevision !== null && entry.revision >= request.beforeRevision) || (i > 0 && entry.revision >= all[i - 1]!.revision))) { fail(); return; }
              break;
          }
        }
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
/** Reassemble every byte before presenting a review. A new daemon, wrong page,
 * missing page, changed digest or invalid UTF-8 rejects the entire document. */
export async function readPrivateRuleDocument(targetValue: PrivateRuleTarget,
  referenceValue: { proposalId: string } | { revisionId: RuleRevisionId }, transport: PrivateRuleTransport = requestPrivateRule): Promise<unknown> {
  const target = Object.freeze({ ...targetValue }); const reference = Object.freeze({ ...referenceValue });
  let offset = 0; let total: number | undefined; let digest: RuleDigest | undefined; const chunks: Buffer[] = [];
  const documentId = "proposalId" in reference ? reference.proposalId : reference.revisionId;
  do {
    const request: PrivateRuleRequest = { ...privateRuleBinding(target), offset,
      ...("proposalId" in reference ? { action: "proposal_read", proposalId: reference.proposalId } as const
        : { action: "revision_read", revisionId: reference.revisionId } as const) };
    const response = parsePrivateRuleResponse(await transport(target.socketPath, request));
    if (!response.ok) throw new PrivateRuleRequestError(response.error);
    if (response.data.kind !== "page" || response.id !== request.id || response.localProfileId !== target.localProfileId
      || response.agentId !== target.agentId || response.instanceId !== target.instanceId || response.chain !== target.chain) throw new PrivateRuleTransportError("invalid_document");
    const page = response.data.page;
    if (page.documentId !== documentId || page.offset !== offset || (total !== undefined && total !== page.totalBytes)
      || (digest !== undefined && digest !== page.digest)) throw new PrivateRuleTransportError("invalid_document");
    total = page.totalBytes; digest = page.digest; const chunk = Buffer.from(page.base64, "base64"); chunks.push(chunk); offset += chunk.length;
    if (offset > MAX_RULE_DOCUMENT_BYTES || (page.nextOffset !== null && page.nextOffset !== offset)) throw new PrivateRuleTransportError("invalid_document");
  } while (offset !== total);
  const bytes = Buffer.concat(chunks);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) throw new PrivateRuleTransportError("invalid_document");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new PrivateRuleTransportError("invalid_document"); }
}
