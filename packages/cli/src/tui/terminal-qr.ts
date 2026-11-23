/** A minimal QR Code encoder (ISO/IEC 18004) for short public text such as a Solana address, so the cockpit can show the funding
 * address as a terminal QR code without a new dependency. Byte mode, error correction level L, versions 1 to 5: each has a single
 * Reed-Solomon block, so no interleaving is needed (version 3 holds 53 bytes; a Solana address is at most 44 characters). The mask
 * with the lowest penalty is chosen. Pure: it never reads or writes anything. Never encode a secret with it. */

/** Data and error-correction codewords per version at level L (index = version). */
const DATA_CODEWORDS = [0, 19, 34, 55, 80, 108] as const;
const EC_CODEWORDS = [0, 7, 10, 15, 20, 26] as const;
/** Alignment pattern centre coordinates per version (versions 2-5 have one pattern, at the last pair). */
const ALIGNMENT: readonly (readonly number[])[] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30]];
export const QR_MAX_BYTES = DATA_CODEWORDS[5] - 2;

const EXP = new Array<number>(512).fill(0);
const LOG = new Array<number>(256).fill(0);
{
  let value = 1;
  for (let index = 0; index < 255; index++) { EXP[index] = value; LOG[value] = index; value <<= 1; if (value & 0x100) value ^= 0x11d; }
  for (let index = 255; index < 512; index++) EXP[index] = EXP[index - 255]!;
}
function multiply(a: number, b: number): number { return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!; }

/** The Reed-Solomon error-correction codewords of `data` (generator roots alpha^0 .. alpha^(degree-1)). */
export function qrReedSolomon(data: readonly number[], degree: number): number[] {
  let generator = [1];
  for (let index = 0; index < degree; index++) {
    const next = new Array<number>(generator.length + 1).fill(0);
    generator.forEach((coefficient, position) => { next[position] = next[position]! ^ coefficient; next[position + 1] = next[position + 1]! ^ multiply(coefficient, EXP[index]!); });
    generator = next;
  }
  const divisor = generator.slice(1);
  const result = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, position) => { result[position] = result[position]! ^ multiply(coefficient, factor); });
  }
  return result;
}

/** The 15 format bits for level L and one mask (BCH(15,5), XOR 0x5412), most significant bit first as an integer. */
export function qrFormatBits(mask: number): number {
  const data = (1 << 3) | mask; // level L = 01
  let remainder = data;
  for (let index = 0; index < 10; index++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function codewords(bytes: Uint8Array, version: number): number[] {
  const capacity = DATA_CODEWORDS[version]! * 8;
  const bits: number[] = [];
  const push = (value: number, length: number) => { for (let index = length - 1; index >= 0; index--) bits.push((value >>> index) & 1); };
  push(0b0100, 4); push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let index = 0; index < bits.length; index += 8) data.push(bits.slice(index, index + 8).reduce((value, bit) => (value << 1) | bit, 0));
  for (let pad = 0; data.length < DATA_CODEWORDS[version]!; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11);
  return [...data, ...qrReedSolomon(data, EC_CODEWORDS[version]!)];
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly dark: boolean[][]; readonly fixed: boolean[][];
  constructor(readonly size: number) {
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean): void { this.dark[y]![x] = dark; this.fixed[y]![x] = true; }
  copy(): Grid { const grid = new Grid(this.size); this.dark.forEach((row, y) => row.forEach((value, x) => { grid.dark[y]![x] = value; grid.fixed[y]![x] = this.fixed[y]![x]!; })); return grid; }
}
function functionPatterns(version: number): Grid {
  const size = 17 + 4 * version; const grid = new Grid(size);
  for (let index = 0; index < size; index++) { grid.set(6, index, index % 2 === 0); grid.set(index, 6, index % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy; const distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) grid.set(x, y, distance !== 2 && distance !== 4);
    }
  }
  const centres = ALIGNMENT[version]!;
  for (const [i, cx] of centres.entries()) for (const [j, cy] of centres.entries()) {
    const last = centres.length - 1;
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) grid.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(grid, 0);
  return grid;
}
function drawFormat(grid: Grid, mask: number): void {
  const bits = qrFormatBits(mask), size = grid.size;
  const bit = (index: number) => ((bits >>> index) & 1) === 1;
  for (let index = 0; index <= 5; index++) grid.set(8, index, bit(index));
  grid.set(8, 7, bit(6)); grid.set(8, 8, bit(7)); grid.set(7, 8, bit(8));
  for (let index = 9; index < 15; index++) grid.set(14 - index, 8, bit(index));
  for (let index = 0; index < 8; index++) grid.set(size - 1 - index, 8, bit(index));
  for (let index = 8; index < 15; index++) grid.set(8, size - 15 + index, bit(index));
  grid.set(8, size - 8, true);
}
function place(grid: Grid, data: readonly number[]): void {
  const size = grid.size; let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) for (let column = 0; column < 2; column++) {
      const x = right - column; const upward = ((right + 1) & 2) === 0; const y = upward ? size - 1 - vertical : vertical;
      if (grid.fixed[y]![x] || index >= data.length * 8) continue;
      grid.dark[y]![x] = ((data[index >>> 3]! >>> (7 - (index & 7))) & 1) === 1; index++;
    }
  }
}
function penalty(grid: Grid): number {
  const size = grid.size; let score = 0; let dark = 0;
  const lines = [...grid.dark, ...grid.dark.map((_row, x) => grid.dark.map((row) => row[x]!))];
  for (const line of lines) {
    let run = 1;
    for (let index = 1; index <= size; index++) {
      if (index < size && line[index] === line[index - 1]) { run++; continue; }
      if (run >= 5) score += 3 + run - 5;
      run = 1;
    }
    const text = line.map((value) => (value ? "1" : "0")).join("");
    for (const pattern of ["10111010000", "00001011101"]) for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) score += 40;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (grid.dark[y]![x]) dark++;
    if (x < size - 1 && y < size - 1) {
      const value = grid.dark[y]![x];
      if (grid.dark[y]![x + 1] === value && grid.dark[y + 1]![x] === value && grid.dark[y + 1]![x + 1] === value) score += 3;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The QR matrix (true = dark), rows top to bottom. Throws RangeError for empty text or more than QR_MAX_BYTES UTF-8 bytes. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = [1, 2, 3, 4, 5].find((candidate) => 12 + bytes.length * 8 <= DATA_CODEWORDS[candidate]! * 8);
  if (!bytes.length || version === undefined) throw new RangeError("QR text length");
  const base = functionPatterns(version);
  const data = codewords(bytes, version);
  let best: Grid | undefined; let bestScore = Infinity;
  for (const [mask, invert] of MASKS.entries()) {
    const grid = base.copy();
    place(grid, data);
    for (let y = 0; y < grid.size; y++) for (let x = 0; x < grid.size; x++) if (!grid.fixed[y]![x] && invert(x, y)) grid.dark[y]![x] = !grid.dark[y]![x];
    drawFormat(grid, mask);
    const score = penalty(grid);
    if (score < bestScore) { best = grid; bestScore = score; }
  }
  return best!.dark.map((row) => [...row]);
}

/** The matrix as terminal lines: two module rows per line (upper half block), black on white with a quiet zone, so it scans on a
 * dark or a light terminal theme. Only fixed ANSI colour codes and the half-block character are written. */
export function renderTerminalQr(text: string, quiet = 2): string[] {
  const matrix = qrMatrix(text);
  const width = matrix.length + quiet * 2;
  const row = (y: number): boolean[] => {
    const inner = y - quiet;
    return Array.from({ length: width }, (_value, x) => inner >= 0 && inner < matrix.length && x - quiet >= 0 && x - quiet < matrix.length && matrix[inner]![x - quiet]!);
  };
  const lines: string[] = [];
  for (let y = 0; y < width; y += 2) {
    const top = row(y), bottom = y + 1 < width ? row(y + 1) : new Array<boolean>(width).fill(false);
    lines.push(top.map((dark, x) => `\u001b[${dark ? 30 : 97};${bottom[x] ? 40 : 107}m▀`).join("") + "\u001b[0m");
  }
  return lines;
}

/** The matrix as plain lines for a surface that strips ANSI colour (the in-screen cockpit card). Light modules and the quiet zone are
 * drawn as block characters and dark modules as spaces, two module rows per line, so on a dark terminal theme the code reads as
 * dark on light; on a light theme it is inverted, which common phone scanners also read. The text address is always shown too. */
export function renderTerminalQrPlain(text: string, quiet = 2): string[] {
  const matrix = qrMatrix(text);
  const width = matrix.length + quiet * 2;
  const light = (y: number, x: number): boolean => {
    const inner = y - quiet, col = x - quiet;
    if (y >= width) return false;
    return !(inner >= 0 && inner < matrix.length && col >= 0 && col < matrix.length && matrix[inner]![col]!);
  };
  const lines: string[] = [];
  for (let y = 0; y < width; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = light(y, x), bottom = light(y + 1, x);
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(line);
  }
  return lines;
}
