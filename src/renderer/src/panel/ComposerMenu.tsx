import { FileText, Folder, Hash, Sparkles, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";

// One popover for both composer triggers: T3's `/` list and the `@` file search. It sits above the
// textarea inside the card, so a growing list shrinks the history instead of being clipped.

export interface ComposerTrigger {
  kind: "slash" | "path";
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export type MenuRow = {
  id: string;
  label: string;
  description: string;
  kind: "model" | "clear" | "command" | "skill" | "file" | "directory";
};

interface ComposerMenuProps {
  trigger: ComposerTrigger["kind"];
  rows: MenuRow[];
  activeIndex: number;
  loading: boolean;
  truncated: boolean;
  emptyText: string;
  onHover: (index: number) => void;
  onPick: (row: MenuRow) => void;
}

export function ComposerMenu({ trigger, rows, activeIndex, loading, truncated, emptyText, onHover, onPick }: ComposerMenuProps) {
  const list = useRef<HTMLDivElement>(null);

  // The keyboard walks the list: keep the highlighted row visible.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="mx-2 mt-2 mb-1 flex min-h-0 flex-col overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] bg-[var(--t3-popover)]">
      <div ref={list} role="listbox" aria-label={trigger === "path" ? "Files" : "Commands"} className="max-h-56 min-h-0 overflow-y-auto p-1">
        {rows.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-t3-muted">{loading ? "Searching…" : emptyText}</p>
        ) : (
          rows.map((row, index) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-row-index={index}
              onMouseEnter={() => onHover(index)}
              // The textarea keeps focus: a click must not blur the composer's caret tracking.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(row)}
              className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left ${
                index === activeIndex ? "bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_9%,transparent)]" : ""
              }`}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center text-t3-muted">
                <MenuIcon kind={row.kind} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-t3-fg">{row.label}</span>
              {row.description !== "" && <span className="min-w-0 max-w-[55%] truncate text-[11px] text-t3-muted">{row.description}</span>}
            </button>
          ))
        )}
        {truncated && <p className="px-2 py-1 text-[11px] text-t3-muted">More files match; keep typing.</p>}
      </div>
    </div>
  );
}

function MenuIcon({ kind }: { kind: MenuRow["kind"] }) {
  switch (kind) {
    case "model":
      return <SlidersHorizontal size={12} />;
    case "clear":
      return <Hash size={12} />;
    case "skill":
      return <Sparkles size={12} />;
    case "file":
      return <FileText size={12} />;
    case "directory":
      return <Folder size={12} />;
    default:
      return <Hash size={12} />;
  }
}

// ---------------------------------------------------------------- triggers (packages/shared/src/composerTrigger.ts)

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/** A second slash makes the word a path, even when the caret precedes that slash. */
function isPathWord(text: string, wordStart: number, cursor: number): boolean {
  let wordEnd = cursor;

  while (wordEnd < text.length && !isWhitespace(text[wordEnd])) wordEnd += 1;

  return text.slice(wordStart + 1, wordEnd).includes("/");
}

/** `/` at a line start or in a word, or an `@` token under the caret. */
export function detectTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = Math.max(0, Math.min(text.length, Number.isFinite(cursorInput) ? Math.floor(cursorInput) : text.length));
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);

    if (commandMatch && isPathWord(text, lineStart, cursor)) return null;

    if (commandMatch) return { kind: "slash", query: commandMatch[1] ?? "", rangeStart: lineStart, rangeEnd: cursor };
  }

  let tokenIndex = cursor - 1;

  while (tokenIndex >= 0 && !isWhitespace(text[tokenIndex])) tokenIndex -= 1;
  const tokenStart = tokenIndex + 1;
  const token = text.slice(tokenStart, cursor);

  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor)) return null;

    return { kind: "slash", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
  }

  if (!token.startsWith("@")) return null;

  return { kind: "path", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
}

export function replaceTextRange(text: string, rangeStart: number, rangeEnd: number, replacement: string) {
  const start = Math.max(0, Math.min(text.length, rangeStart));
  const end = Math.max(start, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;

  return { text: nextText, cursor: start + replacement.length };
}

/** Insertions that end in a space swallow the space already after the caret, as T3 does. */
export function extendRangeForTrailingSpace(text: string, rangeEnd: number, replacement: string): number {
  return replacement.endsWith(" ") && text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
}

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  return separator >= 0 ? path.slice(separator + 1) : path;
}

/** T3's `@` insertion: `[Panel.tsx](src/renderer/src/Panel.tsx)` with the link destination encoded. */
export function serializeFileLink(path: string): string {
  const label = basename(path).replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");

  const destination = encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");

  return `[${label}](${destination})`;
}

/** The file row's dim half is the directory, exactly as T3 splits a cwd-relative path. */
export function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/");

  return separator <= 0 ? "" : path.slice(0, separator);
}
