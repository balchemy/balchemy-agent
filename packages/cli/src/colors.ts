/**
 * Shared ANSI color constants and color-awareness logic.
 *
 * All CLI modules import from here instead of defining their own
 * escape sequences. Respects NO_COLOR, TERM=dumb, --no-color, and
 * non-TTY stdout per clig.dev best practices.
 */

// ── Color disable detection ──────────────────────────────────────────────────

let forceNoColor = false;

/** Call once at startup if --no-color was passed. */
export function setNoColor(): void {
  forceNoColor = true;
}

export function isColorEnabled(): boolean {
  if (forceNoColor) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.TERM === "dumb") return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

// ── Brand color codes ────────────────────────────────────────────────────────

function esc(code: string): string {
  return isColorEnabled() ? code : "";
}

/** Teal — primary brand */
export function teal(): string { return esc("\x1b[38;2;0;172;176m"); }
/** Dark teal — subtle variant */
export function darkTeal(): string { return esc("\x1b[38;2;0;120;124m"); }
/** Gold — accent / warnings */
export function gold(): string { return esc("\x1b[38;2;186;115;6m"); }
/** White bold */
export function white(): string { return esc("\x1b[1;37m"); }
/** Dim gray — secondary text */
export function dim(): string { return esc("\x1b[38;5;245m"); }
/** Green — success */
export function green(): string { return esc("\x1b[1;32m"); }
/** Red — error */
export function red(): string { return esc("\x1b[1;31m"); }
/** Reset */
export function reset(): string { return esc("\x1b[0m"); }

// ── Shorthand constants (backward compatible) ────────────────────────────────
// These are evaluated at call time, not import time, so they respect runtime
// NO_COLOR changes. Use the functions above for new code.

export const C = {
  get T() { return teal(); },
  get DT() { return darkTeal(); },
  get G() { return gold(); },
  get W() { return white(); },
  get D() { return dim(); },
  get R() { return reset(); },
  get OK() { return green(); },
  get ERR() { return red(); },
} as const;
