import { Check, ChevronUp, Gauge, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { PanelModel, PanelModelOption, PanelModelSelection } from "../../../shared/panel";
import { resolvedTraits, selectableChoices, traitsLabel, withChange } from "./modelTraits";
import { usePopoverDismiss } from "./usePopoverDismiss";

// The composer's traits control: the options the selected model declares — reasoning effort, fast mode,
// context window, whatever else its agent lists — with the value the thread would run
// (apps/web/src/components/chat/TraitsPicker.tsx). A pick writes the model's whole option set through
// `thread.model-selection.set`, as T3's own composer does.

interface TraitsPickerProps {
  /** The open thread, so the menu restarts with it. */
  threadKey: string;
  /** The selected model as the server's catalog lists it; null until the catalog arrives. */
  model: PanelModel | null;
  /** The thread's model, whose options the menu shows and rewrites. */
  current: PanelModelSelection;
  /** The draft composer keeps its pick for the thread it creates; an open thread writes through main. */
  onPick?: (options: PanelModelOption[]) => void;
}

export function TraitsPicker({ threadKey, model, current, onPick }: TraitsPickerProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchor = usePopoverDismiss(open, () => setOpen(false));

  // A model that declares nothing has no traits menu, as T3's own composer shows none.
  if (model === null || model.options.length === 0) return null;

  const descriptors = resolvedTraits(model, current);
  const label = traitsLabel(descriptors);
  const title = label === "" ? "Model options" : `Model options: ${label}`;

  async function write(next: PanelModelOption[], key: string) {
    if (saving !== null) return;

    // A draft has no thread to write to yet: it carries the pick into the thread it creates.
    if (onPick !== undefined) {
      onPick(next);
      setOpen(false);

      return;
    }

    setSaving(key);
    setError(null);

    const reply = await window.overlay.panel({
      type: "setModel",
      instanceId: current.instanceId,
      model: current.model,
      options: next,
    });

    setSaving(null);

    if (!reply.ok) {
      setError(reply.error);

      return;
    }

    setOpen(false);
  }

  return (
    <div ref={anchor} className="relative flex min-w-0">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setError(null);
          setOpen((value) => !value);
        }}
        className="flex h-7 min-w-0 items-center gap-1 rounded-full px-2 text-[11px] text-t3-fg transition-colors hover:bg-t3-accent"
      >
        <Gauge size={12} className="shrink-0 text-t3-muted" />
        {label !== "" && <span className="min-w-0 truncate">{label}</span>}
        <ChevronUp size={11} className="shrink-0 text-t3-muted" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Model options"
          className="absolute bottom-full left-0 z-20 mb-1 w-[240px] overflow-hidden rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] shadow-xl shadow-black/40"
        >
          <div className="panel-scroll max-h-[min(20rem,55vh)] overflow-y-auto p-1">
            {descriptors.map((descriptor, index) => (
              <div key={descriptor.id}>
                {index > 0 && <div className="my-1 h-px bg-[var(--t3-border)]" />}
                <p className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-t3-muted uppercase">
                  {descriptor.label}
                </p>
                {descriptor.type === "boolean"
                  ? (["on", "off"] as const).map((value) => (
                      <TraitsRow
                        key={value}
                        label={value === "on" ? "On" : "Off"}
                        selected={descriptor.currentValue === (value === "on")}
                        saving={saving === `${descriptor.id}:${value}`}
                        busy={saving !== null}
                        onPick={() => void write(withChange(descriptors, descriptor.id, value === "on"), `${descriptor.id}:${value}`)}
                      />
                    ))
                  : selectableChoices(descriptor).map((choice) => (
                      <TraitsRow
                        key={choice.id}
                        label={choice.label}
                        hint={choice.isDefault === true ? "Default" : undefined}
                        description={choice.description}
                        selected={descriptor.currentValue === choice.id}
                        saving={saving === `${descriptor.id}:${choice.id}`}
                        busy={saving !== null}
                        onPick={() =>
                          void write(withChange(descriptors, descriptor.id, choice.id), `${descriptor.id}:${choice.id}`)
                        }
                      />
                    ))}
              </div>
            ))}
          </div>
          {error !== null && (
            <p className="border-t border-[var(--t3-border)] px-2 py-1.5 text-[11px] whitespace-pre-wrap text-[var(--t3-error-foreground)]">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** One pickable value of one option, marked when the model runs it. */
function TraitsRow(props: {
  label: string;
  hint?: string | undefined;
  description?: string | undefined;
  selected: boolean;
  saving: boolean;
  /** Another value of the menu is on its way to T3. */
  busy: boolean;
  onPick(): void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      disabled={props.busy}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onPick}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-t3-accent disabled:pointer-events-none disabled:opacity-60"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[12px] text-t3-fg">{props.label}</span>
          {props.hint !== undefined && (
            <span className="shrink-0 rounded border border-[var(--t3-border)] px-1 text-[9px] font-medium tracking-wide text-t3-muted uppercase">
              {props.hint}
            </span>
          )}
        </span>
        {props.description !== undefined && (
          <span className="text-[11px] leading-snug text-t3-muted">{props.description}</span>
        )}
      </span>
      {props.saving ? (
        <LoaderCircle size={12} className="mt-0.5 shrink-0 animate-spin text-t3-muted" />
      ) : (
        props.selected && <Check size={13} className="mt-0.5 shrink-0 text-t3-fg" />
      )}
    </button>
  );
}
