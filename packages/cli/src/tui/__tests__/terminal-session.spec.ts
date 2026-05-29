import test from 'node:test';
import assert from 'node:assert/strict';
import { enterInteractiveScreen, leaveInteractiveScreen } from '../terminal-session.js';

test('terminal session preserves the normal scrollback buffer', () => {
  const writes: string[] = [];
  const stream = {
    isTTY: true,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };

  enterInteractiveScreen(stream);
  leaveInteractiveScreen(stream);

  assert.deepEqual(writes, []);
});
