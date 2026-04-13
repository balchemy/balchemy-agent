/**
 * Terminal image rendering for BCrow logo.
 *
 * Terminal emulators do not share one universal "render this SVG" API, so we
 * ship a bundled PNG and use native image protocols when the terminal supports
 * them. Everyone else gets the ANSI art fallback.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = path.dirname(__filename_esm);

// ── Brand colors ──────────────────────────────────────────────────────────────

const T  = "\x1b[38;2;0;172;176m";    // teal
const DT = "\x1b[38;2;0;120;124m";    // dark teal
const G  = "\x1b[38;2;186;115;6m";    // gold
const R  = "\x1b[0m";                  // reset

// ── ANSI fallback logo ────────────────────────────────────────────────────────

// Per-letter gradient colors matching the Balchemy brand logo
// Generated via figlet -f small, then colorized per-letter
const C1 = "\x1b[38;2;0;172;176m";    // B — teal
const C2 = "\x1b[38;2;0;152;160m";    // A — teal-blue
const C3 = "\x1b[38;2;180;100;140m";  // L — rose
const C4 = "\x1b[38;2;186;155;6m";    // C — gold
const C5 = "\x1b[38;2;0;160;170m";    // H — teal
const C6 = "\x1b[38;2;80;130;200m";   // E — blue
const C7 = "\x1b[38;2;170;90;150m";   // M — magenta
const C8 = "\x1b[38;2;90;140;190m";   // Y — slate blue

const D = "\x1b[38;5;245m"; // dim gray
const ANSI_LOGO = [
  ``,
  `  ${C1} ___ ${R}${C2}   _   ${R}${C3} _    ${R}${C4}  ___ ${R}${C5} _  _ ${R}${C6} ___ ${R}${C7} __  __ ${R}${C8}__   __${R}`,
  `  ${C1}| _ )${R}${C2}  /_\\  ${R}${C3}| |   ${R}${C4} / __|${R}${C5}| || |${R}${C6}| __|${R}${C7}|  \\/  |${R}${C8}\\ \\ / /${R}`,
  `  ${C1}| _ \\${R}${C2} / _ \\ ${R}${C3}| |__ ${R}${C4}| (__ ${R}${C5}| __ |${R}${C6}| _| ${R}${C7}| |\\/| |${R}${C8} \\ V / ${R}`,
  `  ${C1}|___/${R}${C2}/_/ \\_\\${R}${C3}|____|${R}${C4} \\___|${R}${C5}|_||_|${R}${C6}|___|${R}${C7}|_|  |_|${R}${C8}  |_|  ${R}`,
  `  ${D}${"─".repeat(52)}${R}`,
  ``,
].join("\n");

interface BundledImage {
  base64: string;
  byteSize: number;
}

// ── Terminal protocol detection ───────────────────────────────────────────────

type ImageProtocol = "iterm2" | "kitty" | "none";

function detectProtocol(): ImageProtocol {
  const term = process.env.TERM_PROGRAM ?? "";
  const termInfo = process.env.TERM ?? "";

  // iTerm2 inline image protocol
  if (
    term === "iTerm.app" ||
    term === "WezTerm" ||
    process.env.WEZTERM_EXECUTABLE
  ) {
    return "iterm2";
  }

  // Kitty graphics protocol
  if (process.env.KITTY_WINDOW_ID || termInfo.includes("kitty")) {
    return "kitty";
  }

  return "none";
}

// ── iTerm2 inline image rendering ─────────────────────────────────────────────

function renderIterm2(image: BundledImage, widthCols: number): string {
  return `\x1b]1337;File=size=${image.byteSize};inline=1;width=${widthCols};preserveAspectRatio=1:${image.base64}\x07`;
}

// ── Kitty graphics protocol rendering ─────────────────────────────────────────

function renderKitty(image: BundledImage, widthCols: number): string {
  const chunks: string[] = [];
  const chunkSize = 4096;
  for (let i = 0; i < image.base64.length; i += chunkSize) {
    const chunk = image.base64.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= image.base64.length;
    if (i === 0) {
      chunks.push(`\x1b_Gq=2,f=100,a=T,c=${widthCols},m=${isLast ? 0 : 1};${chunk}\x1b\\`);
    } else {
      chunks.push(`\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`);
    }
  }
  return chunks.join("");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render the BCrow logo. Uses native terminal image protocol when available,
 * falls back to ANSI block art.
 *
 * @param widthCols — terminal columns to use for the image (default 20)
 */
export function renderLogo(widthCols = 20): string {
  const protocol = detectProtocol();

  if (protocol === "none") {
    return ANSI_LOGO;
  }

  // Try to load the bundled image
  const image = loadBundledImage();
  if (!image) {
    return ANSI_LOGO;
  }

  if (protocol === "iterm2") {
    return "\n" + renderIterm2(image, widthCols) + "\n";
  }

  if (protocol === "kitty") {
    return "\n" + renderKitty(image, widthCols) + "\n";
  }

  return ANSI_LOGO;
}

function loadBundledImage(): BundledImage | null {
  const candidates = [
    path.join(__dirname_esm, "..", "assets", "bcrow.png"),
    path.join(__dirname_esm, "assets", "bcrow.png"),
    path.join(process.cwd(), "create-balchemy-agent", "assets", "bcrow.png"),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const buf = fs.readFileSync(candidate);
        return {
          base64: buf.toString("base64"),
          byteSize: buf.byteLength,
        };
      }
    } catch {
      // continue
    }
  }

  return null;
}
