type WritableLike = {
  isTTY?: boolean;
  write: (chunk: string) => boolean;
};

const ALT_SCREEN_ON = '\u001B[?1049h\u001B[2J\u001B[H';
const ALT_SCREEN_OFF = '\u001B[?1049l';

export function enterInteractiveScreen(stream: WritableLike = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write(ALT_SCREEN_ON);
}

export function leaveInteractiveScreen(stream: WritableLike = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write(ALT_SCREEN_OFF);
}
