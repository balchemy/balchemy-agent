/** F-M36-D15-SF11: the `runner positions` readback of a build without automatic exits (PRIVATE_EXIT_EXECUTION_AVAILABLE false).
 * Such a build constructs no position ledger, exit worker or recovery, so after an owner downgrade from a build with automatic
 * exits the positions that build left behind would be silent: they have no stop-loss here and a pending sell is never settled.
 *
 * This reads the ledger file that build left, read only: a separate ledger instance per readback, closed at once, through the
 * ledger's create=false read (no file is created when none exists; an existing one is only opened for reading). It is never the
 * daemon's exits ledger and is never passed to recovery, submissions or an exit worker; nothing here signs, sends, values, sells
 * or writes. Only open and held positions are returned (closed ones need nothing from the owner), bounded like the full readback.
 * No ledger, or no open or held position in it, gives the plain `{ agentId, exits: "unavailable" }` reply of before. */
import { PRIVATE_POSITION_READBACK_LIMIT, privatePositionView, type PrivatePositionReadback } from "./private-position-recovery.js";
import { PrivatePositionLedger, type PrivatePosition } from "./private-positions.js";

export interface PrivatePositionExitsOffSource {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** The daemon's existing writer capability (this reader takes no lock and never writes). */
  assertAvailable(): void;
}
/** Held first, then open with a pending sell, then open; newest first within each (the full readback's order). */
function rank(position: PrivatePosition): number { return position.state === "held" ? 0 : position.pendingExit !== null ? 1 : 2; }

/** The exits-off readback from a positions read (`read` may throw: the ledger is then reported unreadable, never as empty). */
export function privatePositionReadbackWithoutExits(agentId: string, read: (agentId: string) => readonly PrivatePosition[]): PrivatePositionReadback {
  let active: PrivatePosition[];
  try { active = read(agentId).filter((item) => item.state !== "closed"); }
  catch { return { agentId, exits: "unavailable", ledger: "unreadable" }; }
  if (active.length === 0) return { agentId, exits: "unavailable" };
  const sorted = [...active].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt || (a.positionId < b.positionId ? -1 : 1));
  return { agentId, exits: "unavailable",
    ledger: { total: sorted.length, positions: sorted.slice(0, PRIVATE_POSITION_READBACK_LIMIT).map((item) => privatePositionView(item)) } };
}

/** The daemon's exits-off list handler: one read-only ledger instance for this readback only. */
export function readPrivatePositionsWithoutExits(source: PrivatePositionExitsOffSource, agentId: string): PrivatePositionReadback {
  return privatePositionReadbackWithoutExits(agentId, (id) => {
    const reader = new PrivatePositionLedger({ directory: source.directory, localProfileId: source.localProfileId, agentIds: [...source.agentIds],
      assertAvailable: source.assertAvailable });
    try { return reader.positions(id); } finally { reader.close(); }
  });
}
