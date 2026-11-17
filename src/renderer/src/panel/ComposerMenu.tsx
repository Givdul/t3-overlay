import { FileText, Folder, Sparkles } from "lucide-react";
import type { ComposerMenuItem, ComposerMenuState } from "./useComposerMenu";

// The composer's suggestion drawer: T3's own `/` and `@` menus, compact enough for the panel. The
// composer keeps the keyboard; hovering a row moves the highlight, and the pick is the composer's.

interface ComposerMenuProps {
  menu: ComposerMenuState;
  onPick: (item: ComposerMenuItem) => void;
}

export function ComposerMenu({ menu, onPick }: ComposerMenuProps) {
  return (
    <div className="absolute inset-x-2 bottom-full z-20 mb-1 overflow-hidden rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] shadow-xl shadow-black/40">
      <div
        role="listbox"
        aria-label={menu.kind === "slash" ? "Commands" : "Files and folders"}
        data-composer-menu-list
        className="panel-scroll max-h-[min(14rem,50vh)] overflow-y-auto p-1"
      >
        {menu.items.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-t3-muted">{menu.emptyText}</p>
        ) : (
          menu.items.map((item) => (
            <ComposerMenuRow
              key={item.id}
              item={item}
              active={item.id === menu.activeId}
              onPick={onPick}
              onHighlight={menu.highlight}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ComposerMenuRow(props: {
  item: ComposerMenuItem;
  active: boolean;
  onPick: (item: ComposerMenuItem) => void;
  onHighlight: (itemId: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.active}
      // The row Enter would pick is kept in view; a ref callback runs whenever that row changes.
      ref={props.active ? revealActive : undefined}
      onMouseMove={() => {
        if (!props.active) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onPick(props.item)}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        props.active ? "bg-t3-accent" : ""
      }`}
    >
      <ItemIcon kind={props.item.kind} />
      <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[12px] font-medium text-t3-fg">{props.item.label}</span>
      {props.item.description !== "" && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-t3-muted">{props.item.description}</span>
      )}
      {props.item.badge !== undefined && (
        <span className="shrink-0 rounded border border-[var(--t3-border)] px-1 text-[9px] tracking-wide text-t3-muted uppercase">
          {props.item.badge}
        </span>
      )}
    </button>
  );
}

/** Commands carry no icon in T3's menu; a file, a folder and a skill keep theirs. */
function ItemIcon({ kind }: { kind: ComposerMenuItem["kind"] }) {
  if (kind === "file") return <FileText size={12} className="shrink-0 text-t3-muted" />;

  if (kind === "directory") return <Folder size={12} className="shrink-0 text-t3-muted" />;

  if (kind === "skill") return <Sparkles size={12} className="shrink-0 text-t3-muted" />;

  return null;
}

function revealActive(node: HTMLButtonElement | null) {
  const list = node?.closest("[data-composer-menu-list]");

  if (!(list instanceof HTMLElement) || node === null) return;

  // Scroll the menu alone: scrollIntoView would move every scrollable box on the way up.
  const row = node.getBoundingClientRect();
  const box = list.getBoundingClientRect();

  if (row.top < box.top) list.scrollTop -= box.top - row.top;
  else if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom;
}
