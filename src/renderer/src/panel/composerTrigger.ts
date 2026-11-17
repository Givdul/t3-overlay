// T3's composer triggers, as its own editor reads them (packages/shared/src/composerTrigger.ts): the
// whitespace-delimited token at the caret decides the menu. A token that starts with `/` lists commands
// and skills, unless another slash or backslash makes it a path; one that starts with `@` searches the
// project's files. A suggestion replaces that token, as T3's own composer replaces it.

export type ComposerTriggerKind = "slash" | "path";

/** The composer's text after a pick, with where its caret goes. */
export interface ComposerEdit {
  text: string;
  caret: number;
}

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  /** What follows the sigil, e.g. "com" for `/com`. */
  query: string;
  /** Where the token starts and where the caret is. */
  rangeStart: number;
  rangeEnd: number;
}

function clampCaret(text: string, caret: number): number {
  if (!Number.isFinite(caret)) return text.length;

  return Math.max(0, Math.min(text.length, Math.floor(caret)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

export function detectComposerTrigger(text: string, caretInput: number): ComposerTrigger | null {
  const caret = clampCaret(text, caretInput);
  let start = caret - 1;

  while (start >= 0 && !isWhitespace(text[start] ?? "")) start -= 1;

  const rangeStart = start + 1;
  const token = text.slice(rangeStart, caret);

  if (token.startsWith("/")) {
    // A word carrying another slash or backslash is a path, so typing one opens no command menu.
    let end = caret;

    while (end < text.length && !isWhitespace(text[end] ?? "")) end += 1;

    if (/[/\\]/.test(text.slice(rangeStart + 1, end))) return null;

    return { kind: "slash", query: token.slice(1), rangeStart, rangeEnd: caret };
  }

  if (!token.startsWith("@")) return null;

  return { kind: "path", query: token.slice(1), rangeStart, rangeEnd: caret };
}

/**
 * The mention T3's composer inserts for a file: a markdown link whose label is the basename and whose
 * destination is the project-relative path (packages/shared/src/composerTrigger.ts,
 * serializeComposerFileLink). The agent opens it; it is the message's text, not a context record.
 */
export function serializeComposerFileLink(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = separator >= 0 ? path.slice(separator + 1) : path;
  const label = basename.replace(/[\\[\]*_]/g, "\\$&");

  const destination = encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");

  return `[${label}](${destination})`;
}

/** Replaces the trigger's token with `insertion` and a trailing space, as every T3 suggestion does. */
export function applyComposerSuggestion(
  text: string,
  trigger: ComposerTrigger,
  insertion: string,
): ComposerEdit {
  const replacement = `${insertion} `;
  // A space the writer already typed is the one the suggestion ends with.
  const end = text[trigger.rangeEnd] === " " ? trigger.rangeEnd + 1 : trigger.rangeEnd;

  return {
    text: `${text.slice(0, trigger.rangeStart)}${replacement}${text.slice(end)}`,
    caret: trigger.rangeStart + replacement.length,
  };
}

/** `/model` clears the trigger and opens a picker instead of inserting text (Composer.tsx, T3's own menu). */
export function clearComposerTrigger(text: string, trigger: ComposerTrigger): ComposerEdit {
  return {
    text: `${text.slice(0, trigger.rangeStart)}${text.slice(trigger.rangeEnd)}`,
    caret: trigger.rangeStart,
  };
}
