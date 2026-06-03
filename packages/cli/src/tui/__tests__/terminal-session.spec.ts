import test from 'node:test';
import assert from 'node:assert/strict';
import { enterInteractiveScreen, leaveInteractiveScreen } from '../terminal-session.js';

test('terminal session uses alternate screen and restores terminal chrome', () => {
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

  assert.deepEqual(writes, [
    "\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H",
    "\u001b[?25h\u001b[?1049l",
  ]);
});
