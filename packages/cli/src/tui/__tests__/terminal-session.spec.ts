import test from 'node:test';
import assert from 'node:assert/strict';
import { enterInteractiveScreen, leaveInteractiveScreen } from '../terminal-session.js';

test('terminal session toggles alternate screen for TTY streams', () => {
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

  assert.equal(writes[0], '\u001B[?1049h\u001B[2J\u001B[H');
  assert.equal(writes[1], '\u001B[?1049l');
});
