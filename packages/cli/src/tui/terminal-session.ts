type WritableLike = {
  isTTY?: boolean;
  write: (chunk: string) => boolean;
};

export function enterInteractiveScreen(stream: WritableLike = process.stdout): void {
  if (!stream.isTTY) return;
}

export function leaveInteractiveScreen(stream: WritableLike = process.stdout): void {
  if (!stream.isTTY) return;
}
