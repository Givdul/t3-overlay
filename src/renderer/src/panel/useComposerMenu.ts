import { useEffect, useState } from "react";
import type {
  PanelModelProvider,
  PanelProjectEntry,
  PanelProviderCommand,
  PanelProviderSkill,
} from "../../../shared/panel";
import { detectComposerTrigger, serializeComposerFileLink, type ComposerTrigger } from "./composerTrigger";

// The composer's two autocomplete menus, built from what this PC's T3 server reports for the thread:
// `/` lists the built-in model picker, then the provider's own commands and skills
// (apps/web/src/components/chat/useComposerMenuItems.ts), and `@` searches the project's files through
// `projects.searchEntries` (apps/web/src/state/queries.ts, useComposerPathSearch). The composer draws
// the rows and applies the pick; this holds the list, the search and the highlight.

/** T3's own debounce before it searches the project's files (apps/web/src/state/queries.ts, useProjectPathSearch). */
const SEARCH_DEBOUNCE_MS = 120;

export type ComposerMenuItemKind = "command" | "skill" | "file" | "directory";

export interface ComposerMenuItem {
  id: string;
  kind: ComposerMenuItemKind;
  label: string;
  description: string;
  /** What the pick inserts before its trailing space; null when it opens a picker instead. */
  insertion: string | null;
  /** T3's built-in `/model`: the pick clears the trigger and opens the model picker. */
  opensModelPicker: boolean;
  /** A skill's origin, drawn beside it as T3's source badge ("user", "repo", …). */
  badge?: string;
}

export interface ComposerMenuState {
  /** Which menu is open, or null: no trigger at the caret, or one the writer dismissed. */
  kind: ComposerTrigger["kind"] | null;
  /** The token the pick replaces. */
  trigger: ComposerTrigger | null;
  items: ComposerMenuItem[];
  /** The row Enter or Tab picks right now. */
  activeId: string | null;
  /** What an empty list says: still searching, or nothing matched. */
  emptyText: string;
  move(delta: number): void;
  highlight(itemId: string): void;
  /** Escape closes the menu and leaves the text alone. */
  dismiss(): void;
  chosen(): ComposerMenuItem | null;
}

interface ComposerMenuOptions {
  /** False on another machine's thread, whose server answers neither menu. */
  enabled: boolean;
  /** The composer's text and caret: the token between them decides the menu. */
  text: string;
  caret: number;
  /** The project whose files `@` searches; null hides the file menu. */
  projectId: string | null;
  /** The selected model's provider, whose commands and skills `/` lists; null until the catalog lands. */
  provider: PanelModelProvider | null;
}

interface PathSearch {
  projectId: string;
  query: string;
  entries: PanelProjectEntry[];
}

export function useComposerMenu(options: ComposerMenuOptions): ComposerMenuState {
  const trigger = options.enabled ? detectComposerTrigger(options.text, options.caret) : null;
  // T3 dismisses the menu for the token it was closed in, and the next token opens it again
  // (apps/web/src/components/chat/useComposerTriggerState.ts).
  const [dismissed, setDismissed] = useState<{ kind: ComposerTrigger["kind"]; rangeStart: number } | null>(null);
  const [highlight, setHighlight] = useState<{ key: string | null; itemId: string | null }>({ key: null, itemId: null });
  const [search, setSearch] = useState<PathSearch | null>(null);

  const key =
    trigger === null ? null : `${options.text}\n${trigger.kind}:${trigger.rangeStart}:${trigger.rangeEnd}`;

  const kind = trigger?.kind ?? null;
  const pathQuery = trigger?.kind === "path" ? trigger.query : "";
  const projectId = options.projectId;

  const dismissedHere =
    dismissed !== null && trigger !== null && dismissed.kind === trigger.kind && dismissed.rangeStart === trigger.rangeStart;

  const open = trigger !== null && !dismissedHere && (trigger.kind !== "path" || projectId !== null);

  // The writer left the token: a later one is a new menu, not the one they closed.
  useEffect(() => {
    if (trigger === null && dismissed !== null) setDismissed(null);
  }, [trigger, dismissed]);

  // The search runs as the query settles, and its answer is kept with the query it answers: a list for
  // an older query never stands in for the current one.
  useEffect(() => {
    if (!open || kind !== "path" || projectId === null) return;

    let live = true;

    const timer = setTimeout(() => {
      void window.overlay.panel({ type: "entries", projectId, query: pathQuery }).then((reply) => {
        if (!live) return;

        setSearch({ projectId, query: pathQuery, entries: reply.ok && "entries" in reply ? reply.entries : [] });
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, kind, projectId, pathQuery]);

  const searched = search !== null && search.projectId === projectId && search.query === pathQuery;

  const items = !open
    ? []
    : kind === "slash"
      ? matchSlashItems(slashItems(options.provider), trigger?.query ?? "")
      : searched
        ? search.entries.map(entryItem)
        : [];

  const remembered = highlight.key === key && highlight.itemId !== null && items.some((item) => item.id === highlight.itemId);
  const activeId = remembered ? highlight.itemId : (items[0]?.id ?? null);
  const loading = kind === "path" && open && !searched;

  const emptyText =
    kind === "slash"
      ? "No matching command."
      : loading
        ? "Searching workspace files…"
        : "No matching files or folders.";

  return {
    kind: open ? kind : null,
    trigger: open ? trigger : null,
    items,
    activeId,
    emptyText,
    move(delta) {
      if (items.length === 0) return;

      const current = Math.max(0, items.findIndex((item) => item.id === activeId));
      const next = items[(current + delta + items.length) % items.length];

      if (next !== undefined) setHighlight({ key, itemId: next.id });
    },
    highlight(itemId) {
      setHighlight({ key, itemId });
    },
    dismiss() {
      if (trigger !== null) setDismissed({ kind: trigger.kind, rangeStart: trigger.rangeStart });
    },
    chosen() {
      return items.find((item) => item.id === activeId) ?? null;
    },
  };
}

/** The built-in model command, then the provider's commands and skills, as T3's slash menu lists them. */
function slashItems(provider: PanelModelProvider | null): ComposerMenuItem[] {
  const items: ComposerMenuItem[] = [
    {
      // Its own id: a provider may list a `/model` command of its own, which is inserted, not run.
      id: "builtin:model",
      kind: "command",
      label: "/model",
      description: "Switch response model for this thread",
      insertion: null,
      opensModelPicker: true,
    },
  ];

  if (provider === null) return items;

  for (const command of provider.commands) {
    items.push({
      id: `command:${command.name}`,
      kind: "command",
      label: `/${command.name}`,
      description: commandDescription(command),
      insertion: `/${command.name}`,
      opensModelPicker: false,
    });
  }

  for (const skill of provider.skills) {
    const item: ComposerMenuItem = {
      id: `skill:${skill.name}`,
      kind: "skill",
      // T3 labels a skill by its display name, and invokes it by the name its provider knows.
      label: `/skill:${skill.displayName ?? skill.name}`,
      description: skillDescription(skill),
      insertion: `$${skill.name}`,
      opensModelPicker: false,
    };

    if (skill.scope !== undefined) item.badge = skill.scope;

    items.push(item);
  }

  return items;
}

/** T3's own fallbacks for a provider command's one-line description. */
function commandDescription(command: PanelProviderCommand): string {
  return command.description ?? command.hint ?? "Run provider command";
}

function skillDescription(skill: PanelProviderSkill): string {
  return skill.shortDescription ?? skill.description ?? (skill.scope === undefined ? "Run provider skill" : `${skill.scope} skill`);
}

/** What typing narrows the slash menu to, keeping the nearest name matches at the top. */
function matchSlashItems(items: ComposerMenuItem[], rawQuery: string): ComposerMenuItem[] {
  const query = rawQuery.trim().replace(/^\/+/, "").toLowerCase();

  if (query === "") return items;

  const ranked = items.flatMap((item) => {
    const score = slashScore(item, query);

    return score === null ? [] : [{ item, score }];
  });

  return ranked.sort((left, right) => left.score - right.score).map((entry) => entry.item);
}

/** A lower score ranks nearer; an exact name beats a prefix, a name match beats a description one. */
function slashScore(item: ComposerMenuItem, query: string): number | null {
  const name = item.label.replace(/^\//, "").toLowerCase();

  if (name === query) return 0;

  if (name.startsWith(query)) return 1;

  if (name.includes(query)) return 2;

  if (item.description.toLowerCase().includes(query)) return 3;

  return null;
}

/** One row of T3's file menu: its basename, its folder, and the mention its pick inserts. */
function entryItem(entry: PanelProjectEntry): ComposerMenuItem {
  const separator = entry.path.lastIndexOf("/");
  const name = separator >= 0 ? entry.path.slice(separator + 1) : entry.path;

  return {
    id: `${entry.kind}:${entry.path}`,
    kind: entry.kind === "directory" ? "directory" : "file",
    label: name === "" ? entry.path : name,
    description: separator > 0 ? entry.path.slice(0, separator) : "",
    insertion: serializeComposerFileLink(entry.path),
    opensModelPicker: false,
  };
}
