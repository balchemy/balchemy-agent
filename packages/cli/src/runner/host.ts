/** Private child entry point. It receives no credentials or configuration. */
import { startRunnerDaemon, type RunnerDaemonHandle } from "./daemon.js";
import { DAEMON_FILE, exists, inspectDirectory, readLocalProfile, removeOwnedDaemonMetadata, writeMetadata, type LocalProfile } from "./metadata.js";
import { exactKeys, isId, isRecord } from "./protocol.js";
import * as path from "node:path";
import { RunnerKernelLock } from "./kernel-lock.js";
import { spawnPrivateKeepAwake } from "./private-keep-awake.js";

export interface RunnerBootstrap { directory: string; localProfileId: string; instanceId: string; agentIds: string[] }

export function parseBootstrap(value: unknown): RunnerBootstrap {
  if (!isRecord(value) || !exactKeys(value, ["directory", "localProfileId", "instanceId", "agentIds"])
    || typeof value.directory !== "string" || !path.isAbsolute(value.directory)
    || !isId(value.localProfileId) || !isId(value.instanceId) || !Array.isArray(value.agentIds)
    || value.agentIds.length === 0 || value.agentIds.length > 64 || value.agentIds.some((id) => !isId(id))
    || new Set(value.agentIds).size !== value.agentIds.length) throw new Error("Invalid runner bootstrap");
  return value as unknown as RunnerBootstrap;
}

// This module is a process entry, not an importable service. No socket, file or
// provider is touched before the private parent channel supplies valid options.
if (!process.send) process.exitCode = 1;
else {
  const bootstrapDeadline = setTimeout(() => process.exit(1), 5_000);
  process.once("message", (input: unknown) => {
    clearTimeout(bootstrapDeadline);
    void runHost(input);
  });
}

async function runHost(input: unknown): Promise<void> {
  let handle: RunnerDaemonHandle | undefined;
  let profile: LocalProfile | undefined;
  let options: RunnerBootstrap | undefined;
  let recorded = false;
  let writer: RunnerKernelLock | undefined;
  let stopRequested = false;
  const stop = (): void => { stopRequested = true; if (handle) void handle.close(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Closing a CLI attachment is deliberately not a shutdown signal.
  try {
    options = parseBootstrap(input);
    writer = RunnerKernelLock.inheritWriter(options.directory);
    if (inspectDirectory(options.directory) !== options.directory) throw new Error("Invalid directory");
    profile = readLocalProfile(options.directory);
    if (!profile || profile.localProfileId !== options.localProfileId || exists(path.join(options.directory, DAEMON_FILE))) throw new Error("Invalid profile");
    // Phase 1: the real sleep inhibitor (caffeinate / systemd-inhibit) while an agent is armed or holds open positions.
    handle = await startRunnerDaemon({ directory: options.directory, ownerId: profile.localProfileId, agentIds: options.agentIds, instanceId: options.instanceId, writerLock: writer,
      keepAwake: { spawn: spawnPrivateKeepAwake },
      // Owner decision of 17 Nov 2026: the Balchemy-provided Solana RPC (two providers), fetched over the runner proof.
      balchemyRpc: { enabled: true },
      // K2 one-visit setup (owner decisions of 19 Nov 2026): the automatic trading-wallet link after pairing and the spend ceiling.
      setup: { enabled: true } });
    if (stopRequested) { await handle.close(); return; }
    writeMetadata(options.directory, DAEMON_FILE, { schemaVersion: 2, localProfileId: profile.localProfileId, instanceId: handle.instanceId, pid: process.pid, startedAt: Date.now() }, writer);
    recorded = true;
    if (process.connected) process.send?.({ ready: true, instanceId: handle.instanceId, pid: process.pid }, () => { /* Launcher may already have detached. */ });
    await handle.closed;
  } catch {
    if (process.connected) process.send?.({ ready: false }, () => { /* No parent means no status recipient. */ });
    process.exitCode = 1;
  } finally {
    await handle?.close();
    if (recorded && options && profile && handle && writer) {
      try { removeOwnedDaemonMetadata(options.directory, profile, handle.instanceId, writer); }
      catch { process.exitCode = 1; /* Preserve changed/ambiguous metadata. */ }
    }
    writer?.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    if (process.connected) process.disconnect();
  }
}
