/** A1: the one sanitiser for untrusted text at the cockpit's render boundary (model replies, token names and symbols, server, runner and
 * signal text, notices). It removes everything that could move the cursor, recolour or reorder the screen, or start a new row:
 * - terminal escape sequences: OSC and DCS/SOS/PM/APC strings, CSI sequences (7-bit ESC and 8-bit C1 forms) and any other ESC pair;
 * - C0 and C1 control characters (newlines, tabs and the other line breaks become one space first, so words stay apart);
 * - bidi embeddings, overrides, isolates and marks (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C).
 * So no untrusted string can draw a fake label (such as `Balchemy`) in the conversation gutter or hide text behind reordered characters.
 * Code-built text goes through it too: it is harmless there and keeps one path for every row. */

/** OSC, DCS, SOS, PM and APC strings up to their terminator (BEL or ST), or to the end of the text when unterminated. */
const ESC_STRING = /(?:\u001b[\]PX^_]|[\u009d\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
/** CSI sequences, in the 7-bit (ESC [) and the 8-bit (U+009B) form. */
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
/** Any other escape: ESC with the one character after it (a lone ESC at the end goes too). */
const ESC_PAIR = /\u001b[\s\S]?/g;
/** Line and paragraph breaks, tabs, vertical tab and form feed: one space each run. */
const BREAKS = /[\r\n\t\u000b\u000c\u0085\u2028\u2029]+/g;
/** Every remaining C0 and C1 control character and DEL. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Bidi embeddings, overrides, isolates and marks, and invisible fillers (zero-width space and joiners, word joiner, BOM, braille blank). */
const BIDI = /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\u2800]/g;
/** A paragraph break in untrusted text (kept only as a row break under the same gutter label). */
const PARAGRAPH = /\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/;

function stripSequences(value: string): string {
  return value.replace(ESC_STRING, "").replace(CSI, "").replace(ESC_PAIR, "");
}

/** One line of untrusted text, safe to draw anywhere on the screen. Non-strings become "". */
export function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripSequences(value).replace(BREAKS, " ").replace(CONTROLS, "").replace(BIDI, "");
}

/** Untrusted text as paragraphs: each piece is `safeText`, an empty string marks one blank row between paragraphs (runs collapse to
 * one), and leading or trailing blanks are dropped. The renderer puts every piece under the entry's own gutter indent, so a newline
 * can never start a row in the label column. */
export function safeParagraphs(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const pieces = stripSequences(value).split(PARAGRAPH).map((piece) => safeText(piece).trim());
  const out: string[] = [];
  for (const piece of pieces) {
    if (!piece && (!out.length || out[out.length - 1] === "")) continue;
    out.push(piece);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
