type WritableLike = {
  isTTY?: boolean;
  write: (chunk: string) => boolean;
};

const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H";
const LEAVE_ALT_SCREEN = "\u001b[?25h\u001b[?1049l";

export function enterInteractiveScreen(stream: WritableLike = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write(ENTER_ALT_SCREEN);
}

export function leaveInteractiveScreen(stream: WritableLike = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write(LEAVE_ALT_SCREEN);
}
