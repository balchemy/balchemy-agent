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
import { C } from "./colors.js";

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = path.dirname(__filename_esm);

// ── ANSI fallback logo ────────────────────────────────────────────────────────

const ANSI_LOGO_LINES = [
  ``,
  `  ${C.G}B${C.T}ALCHEMY${C.R}  ${C.D}AGENT CLI${C.R}`,
  `  ${C.D}calm control for live autonomous trading${C.R}`,
  `  ${C.DT}${"-".repeat(52)}${C.R}`,
  ``,
];

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
    return ANSI_LOGO_LINES.join("\n");
  }

  // Try to load the bundled image
  const image = loadBundledImage();
  if (!image) {
    return ANSI_LOGO_LINES.join("\n");
  }

  if (protocol === "iterm2") {
    return "\n" + renderIterm2(image, widthCols) + "\n";
  }

  if (protocol === "kitty") {
    return "\n" + renderKitty(image, widthCols) + "\n";
  }

  return ANSI_LOGO_LINES.join("\n");
}

function loadBundledImage(): BundledImage | null {
  const candidates = [
    path.join(__dirname_esm, "..", "assets", "bcrow.png"),
    path.join(__dirname_esm, "assets", "bcrow.png"),
    path.join(process.cwd(), "balchemy", "assets", "bcrow.png"),
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
