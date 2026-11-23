/** Immutable working-set segments. Only the checkpoint makes a segment committed. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";

export const WORKING_ARCHIVE_PREFIX = "ws-archive-";
export const BRAIN_ARCHIVE_PREFIX = "pb-archive-";
type ArchiveNamespace = "research" | "brain";
export interface WorkingArchiveHead { readonly endSequence: number; readonly digest: string }
export interface WorkingArchiveSegment<T> {
  schemaVersion: 1; localProfileId: string; previous: WorkingArchiveHead | null; records: T[];
}
interface Options<T> {
  /** Default preserves the original research filenames and digest bytes. */
  namespace?: ArchiveNamespace;
  directory: string; localProfileId: string; maximumBytes: number; maximumRecords: number;
  assertAvailable(): void; decodeRecords(value: unknown): T[];
}
function fail(): never { throw new Error("Working archive unavailable"); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))) fail();
}
export function workingArchiveHead(value: unknown): WorkingArchiveHead | null {
  if (value === null) return null;
  exact(value, ["endSequence", "digest"]);
  if (!Number.isSafeInteger(value.endSequence) || Number(value.endSequence) < 1
    || typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest)) fail();
  return { endSequence: Number(value.endSequence), digest: value.digest };
}
function digest(value: unknown, namespace: ArchiveNamespace): string {
  const domain = namespace === "research" ? "balchemy.private-working-archive.v1\0" : "balchemy.private-brain-archive.v1\0";
  return createHash("sha256").update(domain).update(JSON.stringify(value)).digest("hex");
}
/** A segment never has an update or deletion operation. OwnedJsonSnapshot supplies
 * private ownership, no-follow IO, durable creation and existing-writer fences. */
export class WorkingArchive<T> {
  private readonly namespace: ArchiveNamespace;
  constructor(private readonly options: Options<T>) {
    this.namespace = options.namespace ?? "research";
    if (this.namespace !== "research" && this.namespace !== "brain") fail();
  }
  private names(head: WorkingArchiveHead) {
    workingArchiveHead(head);
    const prefix = this.namespace === "research" ? WORKING_ARCHIVE_PREFIX : BRAIN_ARCHIVE_PREFIX;
    const stem = `${prefix}${head.endSequence}-${head.digest}`;
    return { snapshotFile: `${stem}.json`, markerFile: `${stem}.mark` };
  }
  private open(head: WorkingArchiveHead, initial?: WorkingArchiveSegment<T>): WorkingArchiveSegment<T> {
    const names = this.names(head);
    // Reading a committed descriptor must never create missing history.
    if (!initial) for (const name of Object.values(names)) fs.lstatSync(path.join(this.options.directory, name));
    const decode = (value: unknown): WorkingArchiveSegment<T> => {
      exact(value, ["schemaVersion", "localProfileId", "previous", "records"]);
      if (value.schemaVersion !== 1 || value.localProfileId !== this.options.localProfileId || digest(value, this.namespace) !== head.digest) fail();
      const previous = workingArchiveHead(value.previous); const records = this.options.decodeRecords(value.records);
      if (!records.length || records.length > this.options.maximumRecords
        || (previous?.endSequence ?? 0) + records.length !== head.endSequence) fail();
      return { schemaVersion: 1, localProfileId: this.options.localProfileId, previous, records };
    };
    const saved = new OwnedJsonSnapshot<WorkingArchiveSegment<T>>({ directory: this.options.directory, ...names,
      marker: { schemaVersion: 1, localProfileId: this.options.localProfileId, ...head },
      maximumBytes: this.options.maximumBytes, initial: initial ?? failInitial(), decode,
      assertAvailable: this.options.assertAvailable });
    try { return saved.read(); } finally { saved.close(); }
  }
  read(head: WorkingArchiveHead): WorkingArchiveSegment<T> { return this.open(head); }
  preserve(records: T[], previous: WorkingArchiveHead | null): WorkingArchiveHead {
    const initial: WorkingArchiveSegment<T> = { schemaVersion: 1, localProfileId: this.options.localProfileId, previous, records };
    const head = { endSequence: (previous?.endSequence ?? 0) + records.length, digest: digest(initial, this.namespace) };
    if (!Number.isSafeInteger(head.endSequence)) fail();
    // A complete pre-checkpoint orphan is reusable only at its exact content address.
    this.open(head, initial); return head;
  }
}
// Unused when opening existing files; required by the generic snapshot API.
function failInitial<T>(): T { return undefined as T; }
