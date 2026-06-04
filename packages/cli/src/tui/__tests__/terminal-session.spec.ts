import test from "node:test";
import assert from "node:assert/strict";
import { enterInteractiveScreen, leaveInteractiveScreen } from "../terminal-session.js";

test("interactive screen enables raw mode and restores the previous stdin state", () => {
  const writes: string[] = [];
  const rawModes: boolean[] = [];
  let resumed = false;

  const stream = {
    isTTY: true,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
  };

  const input = {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean): unknown {
      rawModes.push(mode);
      this.isRaw = mode;
      return this;
    },
    resume(): unknown {
      resumed = true;
      return this;
    },
  };

  enterInteractiveScreen(stream, input);
  leaveInteractiveScreen(stream, input);

  assert.equal(resumed, true);
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(writes.length, 2);
  assert.match(writes[0] ?? "", /\u001b\[\?1049h/);
  assert.match(writes[1] ?? "", /\u001b\[\?1049l/);
});

test("interactive screen leaves stdin alone when stdout is not a TTY", () => {
  const rawModes: boolean[] = [];
  const stream = {
    isTTY: false,
    write(_chunk: string): boolean {
      throw new Error("should not write alternate-screen escape codes");
    },
  };
  const input = {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean): unknown {
      rawModes.push(mode);
      return this;
    },
  };

  enterInteractiveScreen(stream, input);
  leaveInteractiveScreen(stream, input);

  assert.deepEqual(rawModes, []);
});
