import * as fs from "node:fs";
import * as tty from "node:tty";

type WritableLike = {
  isTTY?: boolean;
  write: (chunk: string) => boolean;
};

type ReadableTtyLike = {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume?: () => unknown;
};

const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H";
const LEAVE_ALT_SCREEN = "\u001b[?25h\u001b[?1049l";

export interface InteractiveTerminal {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  usingDevTty: boolean;
  dispose: () => void;
}

let previousRawMode: boolean | null = null;

function enterRawMode(input: ReadableTtyLike = process.stdin): void {
  if (!input.isTTY || typeof input.setRawMode !== "function") return;
  if (previousRawMode === null) {
    previousRawMode = input.isRaw === true;
  }
  input.setRawMode(true);
  input.resume?.();
}

function leaveRawMode(input: ReadableTtyLike = process.stdin): void {
  if (previousRawMode === null || !input.isTTY || typeof input.setRawMode !== "function") return;
  input.setRawMode(previousRawMode);
  previousRawMode = null;
}

export function enterInteractiveScreen(
  stream: WritableLike = process.stdout,
  input: ReadableTtyLike = process.stdin,
): void {
  if (!stream.isTTY) return;
  enterRawMode(input);
  stream.write(ENTER_ALT_SCREEN);
}

export function leaveInteractiveScreen(
  stream: WritableLike = process.stdout,
  input: ReadableTtyLike = process.stdin,
): void {
  if (stream.isTTY) {
    stream.write(LEAVE_ALT_SCREEN);
  }
  leaveRawMode(input);
}

export function openInteractiveTerminal(): InteractiveTerminal {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      usingDevTty: false,
      dispose: () => {},
    };
  }

  if (process.platform === "win32") {
    return {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      usingDevTty: false,
      dispose: () => {},
    };
  }

  let readFd: number | null = null;
  let writeFd: number | null = null;

  try {
    readFd = fs.openSync("/dev/tty", "r");
    writeFd = fs.openSync("/dev/tty", "w");
    const stdin = new tty.ReadStream(readFd) as NodeJS.ReadStream;
    const stdout = new tty.WriteStream(writeFd) as NodeJS.WriteStream;

    return {
      stdin,
      stdout,
      stderr: stdout,
      usingDevTty: true,
      dispose: () => {
        stdin.destroy();
        stdout.destroy();
      },
    };
  } catch (_error: unknown) {
    if (readFd !== null) fs.closeSync(readFd);
    if (writeFd !== null) fs.closeSync(writeFd);
    return {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      usingDevTty: false,
      dispose: () => {},
    };
  }
}
