const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function charWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;

  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2329 && codePoint <= 0x232a)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  ) {
    return 2;
  }

  return 1;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function displayWidth(value: string): number {
  return Array.from(stripAnsi(value)).reduce((width, char) => width + charWidth(char), 0);
}

export function sliceToWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  let used = 0;
  let result = "";
  for (const char of Array.from(stripAnsi(value))) {
    const width = charWidth(char);
    if (used + width > maxWidth) break;
    result += char;
    used += width;
  }
  return result;
}

export function truncateEnd(value: string, maxWidth: number, suffix = "..."): string {
  const clean = stripAnsi(value);
  if (displayWidth(clean) <= maxWidth) return clean;
  if (maxWidth <= displayWidth(suffix)) return sliceToWidth(suffix, maxWidth);
  return `${sliceToWidth(clean, maxWidth - displayWidth(suffix))}${suffix}`;
}

export function truncateMiddle(value: string, maxWidth: number): string {
  const clean = stripAnsi(value);
  if (displayWidth(clean) <= maxWidth) return clean;
  if (maxWidth <= 3) return sliceToWidth("...", maxWidth);

  const sideWidth = Math.max(1, Math.floor((maxWidth - 3) / 2));
  const tailWidth = Math.max(1, maxWidth - 3 - sideWidth);
  const chars = Array.from(clean);
  let tail = "";
  let used = 0;

  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i];
    const width = charWidth(char);
    if (used + width > tailWidth) break;
    tail = `${char}${tail}`;
    used += width;
  }

  return `${sliceToWidth(clean, sideWidth)}...${tail}`;
}

function breakLongToken(token: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let used = 0;

  for (const char of Array.from(stripAnsi(token))) {
    const width = charWidth(char);
    if (current.length > 0 && used + width > maxWidth) {
      chunks.push(current);
      current = "";
      used = 0;
    }
    if (width > maxWidth) continue;
    current += char;
    used += width;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function wrapPlainLine(line: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  if (line.trim().length === 0) return [""];

  const tokens = stripAnsi(line).trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const tokenWidth = displayWidth(token);
    if (tokenWidth > maxWidth) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      lines.push(...breakLongToken(token, maxWidth));
      continue;
    }

    const candidate = current.length === 0 ? token : `${current} ${token}`;
    if (displayWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current.length > 0) lines.push(current);
      current = token;
    }
  }

  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export function wrapText(value: string, maxWidth: number, maxLines?: number): string[] {
  const width = Math.max(1, maxWidth);
  const wrapped = stripAnsi(value)
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .flatMap((line) => wrapPlainLine(line, width));

  if (maxLines === undefined || wrapped.length <= maxLines) return wrapped;
  const visible = wrapped.slice(0, Math.max(1, maxLines));
  visible[visible.length - 1] = truncateEnd("... trimmed in activity log", width);
  return visible;
}
