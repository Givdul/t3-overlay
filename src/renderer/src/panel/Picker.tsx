import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

// A chip that opens a menu above itself, like the pickers on T3's composer toolbar. The menu stays inside
// the panel, which is the part of the overlay's window that takes clicks.

export interface PickerItem {
  key: string;
  label: string;
  detail?: string;
  /** A heading row above this item, such as a provider over its models. */
  group?: string;
  selected?: boolean;
}

interface PickerProps {
  /** What the chip shows. */
  label: ReactNode;
  title: string;
  items: PickerItem[];
  onPick(key: string): void;
  /** A search box at the top of the menu, for lists T3 searches itself, such as branches. */
  search?: { placeholder: string; onQuery(query: string): void };
  /** Shown instead of the items while they load or when there are none. */
  empty?: string;
  disabled?: boolean;
  align?: "start" | "end";
}

export function Picker(props: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };

    window.addEventListener("mousedown", close);
    searchBox.current?.focus();

    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (key: string) => {
    setOpen(false);
    props.onPick(key);
  };

  let lastGroup: string | undefined;

  return (
    <div
      ref={root}
      className="relative min-w-0"
      onKeyDown={(event) => {
        // The panel's own Escape closes the panel; inside an open menu it only closes the menu.
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        title={props.title}
        disabled={props.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setQuery("");
          props.search?.onQuery("");
          setOpen((current) => !current);
        }}
        className={`flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full px-2 text-[12px] text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg disabled:pointer-events-none disabled:opacity-40 ${
          open ? "bg-t3-accent text-t3-fg" : ""
        }`}
      >
        <span className="min-w-0 truncate">{props.label}</span>
        <ChevronDown size={12} className="shrink-0 opacity-70" />
      </button>

      {open && (
        <div
          className={`absolute bottom-full z-30 mb-1 flex max-h-64 w-64 flex-col overflow-hidden rounded-xl border border-t3-border bg-t3-popover shadow-xl shadow-black/40 ${
            props.align === "end" ? "right-0" : "left-0"
          }`}
        >
          {props.search !== undefined && (
            <input
              ref={searchBox}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                props.search?.onQuery(event.target.value);
              }}
              placeholder={props.search.placeholder}
              className="m-1 mb-0 rounded-lg bg-[var(--t3-code-background)] px-2 py-1 text-[12px] text-t3-fg outline-none select-text placeholder:text-t3-muted"
            />
          )}
          <div className="flex min-h-0 flex-col overflow-y-auto p-1">
            {props.items.length === 0 ? (
              <p className="px-2 py-1.5 text-[12px] text-t3-muted">{props.empty ?? "Nothing to pick"}</p>
            ) : (
              props.items.map((item) => {
                const heading = item.group !== undefined && item.group !== lastGroup ? item.group : null;
                lastGroup = item.group;

                return (
                  <div key={item.key} className="flex flex-col">
                    {heading !== null && <p className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-t3-muted">{heading}</p>}
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(item.key)}
                      className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] text-t3-fg hover:bg-t3-accent"
                    >
                      <span className="flex size-3 shrink-0 items-center justify-center">{item.selected && <Check size={12} />}</span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.detail !== undefined && <span className="max-w-[45%] shrink-0 truncate text-[11px] text-t3-muted">{item.detail}</span>}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
