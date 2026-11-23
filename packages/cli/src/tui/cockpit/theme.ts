/** A1: the cockpit palette (KOKPIT-SPEC §3). Colour reinforces a label or glyph; it never carries meaning alone, and body text always
 * stays in the terminal's own foreground. Roles:
 * - control (teal): the wordmark, `›`, the cursor, the `Agent` label, neutral card titles;
 * - owner: the `You` label (default colour, bold);
 * - caution (amber): `!` and `?` record marks, caution mode words, CONFIRM / ARM / BACK UP titles;
 * - failure (red): `×` marks, OFFLINE, TRANSFER OUT and stop titles;
 * - confirmed (green): `✓` on confirmed outcomes only;
 * - muted: the `Balchemy` label, times, rules, key hints and the panel border (a real grey, never `dimColor` or bright black).
 * The theme comes from BALCHEMY_THEME=dark|light, else COLORFGBG, else a middle set readable on both. Without truecolor the 16 named
 * colours are used. When colour is off (NO_COLOR, TERM=dumb, --no-color, no TTY) no colour prop is passed at all: labels, glyphs and
 * words carry the meaning, and only the wordmark and `You` stay bold. A non-UTF-8 locale or TERM=dumb also switches to ASCII glyphs. */
import { isColorEnabled } from "../../colors.js";

export type CockpitRole = "control" | "owner" | "caution" | "failure" | "confirmed" | "muted";
export interface CockpitStyle { color?: string; bold?: boolean }
export type CockpitBackground = "dark" | "light" | "unknown";
/** Record row marks (KOKPIT-SPEC §3): checked, submitted, confirmed, held, failed, unknown. */
export type CockpitRecordMark = "check" | "submit" | "done" | "held" | "failed" | "unknown";
export interface CockpitGlyphs {
  prompt: string; cursor: string; rule: string; border: string; chip: string;
  marks: Readonly<Record<CockpitRecordMark, string>>;
}
export interface CockpitTheme {
  readonly colors: boolean;
  readonly background: CockpitBackground;
  readonly glyphs: CockpitGlyphs;
  style(role: CockpitRole): CockpitStyle;
}
type Env = Readonly<Record<string, string | undefined>>;

const HEX: Readonly<Record<CockpitBackground, Readonly<Record<Exclude<CockpitRole, "owner">, string>>>> = Object.freeze({
  dark: { control: "#26A3AA", caution: "#D4943A", failure: "#E05545", confirmed: "#3B9B62", muted: "#9A958C" },
  light: { control: "#17616B", caution: "#94602A", failure: "#A83A32", confirmed: "#2A6F45", muted: "#4E4C46" },
  unknown: { control: "#1F8A94", caution: "#B87A22", failure: "#D24A3C", confirmed: "#349058", muted: "#858078" },
});
/** 16-colour terminals: muted stays the default foreground (bright black vanishes on common themes). */
const NAMED: Readonly<Record<Exclude<CockpitRole, "owner">, string | undefined>> = Object.freeze({
  control: "cyan", caution: "yellow", failure: "red", confirmed: "green", muted: undefined,
});
export const COCKPIT_UNICODE_GLYPHS: CockpitGlyphs = Object.freeze({ prompt: "›", cursor: "▌", rule: "─", border: "│", chip: "▸",
  marks: Object.freeze({ check: "·", submit: "→", done: "✓", held: "!", failed: "×", unknown: "?" }) });
export const COCKPIT_ASCII_GLYPHS: CockpitGlyphs = Object.freeze({ prompt: ">", cursor: "_", rule: "-", border: "|", chip: ">",
  marks: Object.freeze({ check: ".", submit: "->", done: "ok", held: "!", failed: "x", unknown: "?" }) });

/** The terminal background: BALCHEMY_THEME first, then COLORFGBG ("fg;bg", bg 0-6 or 8 is dark, 7 or 9-15 light), else unknown. */
export function cockpitBackground(env: Env): CockpitBackground {
  const chosen = env.BALCHEMY_THEME?.trim().toLowerCase();
  if (chosen === "dark" || chosen === "light") return chosen;
  const bg = /;(\d{1,2})$/.exec(env.COLORFGBG?.trim() ?? "")?.[1];
  if (bg === undefined) return "unknown";
  const value = Number(bg);
  return value === 7 || (value >= 9 && value <= 15) ? "light" : value <= 8 ? "dark" : "unknown";
}
/** UTF-8 glyphs unless TERM=dumb or the locale names a non-UTF-8 charset (an unset locale keeps today's UTF-8 screen). */
export function cockpitUnicode(env: Env): boolean {
  if (env.TERM === "dumb") return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return !locale || /utf-?8/i.test(locale);
}

/** The theme for `env`. `colorEnabled` is the CLI's colour switch (colors.ts isColorEnabled), passed in so both paths are testable. */
export function resolveCockpitTheme(input: { env: Env; colorEnabled: boolean }): CockpitTheme {
  const { env, colorEnabled } = input;
  const background = cockpitBackground(env);
  const truecolor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");
  const glyphs = cockpitUnicode(env) ? COCKPIT_UNICODE_GLYPHS : COCKPIT_ASCII_GLYPHS;
  const colors = colorEnabled && env.TERM !== "dumb";
  const style = (role: CockpitRole): CockpitStyle => {
    if (role === "owner") return { bold: true };
    if (!colors) return role === "control" ? { bold: true } : {};
    const color = truecolor ? HEX[background][role] : NAMED[role];
    const bold = role === "control" || role === "caution" || role === "failure";
    return { ...(color ? { color } : {}), ...(bold ? { bold: true } : {}) };
  };
  return Object.freeze({ colors, background, glyphs, style });
}

/** The theme of the running process (NO_COLOR, TERM, --no-color and a TTY decide colour). */
export function processCockpitTheme(): CockpitTheme {
  return resolveCockpitTheme({ env: process.env, colorEnabled: isColorEnabled() });
}
