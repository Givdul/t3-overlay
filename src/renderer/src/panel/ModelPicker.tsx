import { Check, ChevronUp, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { PanelModel, PanelModelProvider, PanelModelSelection } from "../../../shared/panel";
import { findModel } from "./modelTraits";
import type { ModelCatalog } from "./useModelCatalog";
import { usePopoverDismiss } from "./usePopoverDismiss";

// The composer's model control: the open thread's provider and model, and the list T3 offers. Picking
// one dispatches `thread.model-selection.set` (packages/client-runtime/src/operations/commands.ts,
// updateThreadMetadata), so the next turn runs on it and T3 shows the same model on the thread.

interface ModelPickerProps {
  /** The catalog the composer read once for this thread. */
  catalog: ModelCatalog;
  /** The thread's model, from its projection. */
  current: PanelModelSelection;
  /** The list's open state, which the composer also moves from its `/model` command. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The draft composer picks the model its new thread starts on; an open thread switches through main. */
  onPick?: (selection: PanelModelSelection) => void;
}

export function ModelPicker({ catalog, current, open, onOpenChange, onPick }: ModelPickerProps) {
  const [saving, setSaving] = useState<string | null>(null);
  const anchor = usePopoverDismiss(open, () => onOpenChange(false));
  const groups = withCurrent(catalog.providers, current);
  const named = findModel(catalog.providers, current);
  const providerLabel = named?.provider.displayName ?? null;
  // Until the catalog arrives the slug stands in for the model's name.
  const modelLabel = named === null ? current.model : label(named.model, named.provider.displayName);

  async function pick(instanceId: string, model: string, key: string) {
    if (saving !== null) return;

    if (current.instanceId === instanceId && current.model === model) {
      onOpenChange(false);

      return;
    }

    // A draft has no thread to switch yet: it carries the pick into the thread it creates.
    if (onPick !== undefined) {
      onPick({ instanceId, model });
      onOpenChange(false);

      return;
    }

    setSaving(key);
    catalog.reportError(null);

    const reply = await window.overlay.panel({ type: "setModel", instanceId, model });

    setSaving(null);

    if (!reply.ok) {
      catalog.reportError(reply.error);

      return;
    }

    onOpenChange(false);
  }

  return (
    <div ref={anchor} className="relative flex min-w-0">
      <button
        type="button"
        title={providerLabel === null ? modelLabel : `${providerLabel} · ${modelLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          catalog.reportError(null);
          onOpenChange(!open);
        }}
        className="flex h-7 min-w-0 items-center gap-1 rounded-full px-2 text-[11px] transition-colors hover:bg-t3-accent"
      >
        {providerLabel !== null && <span className="shrink-0 truncate text-t3-muted">{providerLabel}</span>}
        <span className="min-w-0 truncate text-t3-fg">{modelLabel}</span>
        <ChevronUp size={11} className="shrink-0 text-t3-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Model"
          className="absolute bottom-full left-0 z-20 mb-1 w-[250px] overflow-hidden rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] shadow-xl shadow-black/40"
        >
          <div className="panel-scroll max-h-[min(16rem,55vh)] overflow-y-auto p-1">
            {groups.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-t3-muted">
                {catalog.providers === null ? "Loading models…" : "No models are available"}
              </p>
            ) : (
              groups.map((provider) => (
                <div key={provider.instanceId}>
                  <p className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-t3-muted uppercase">{provider.displayName}</p>
                  {provider.models.map((model) => {
                    const selected = current.instanceId === provider.instanceId && current.model === model.slug;
                    const key = `${provider.instanceId}:${model.slug}`;

                    return (
                      <button
                        key={key}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={saving !== null}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void pick(provider.instanceId, model.slug, key)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-t3-fg transition-colors hover:bg-t3-accent disabled:pointer-events-none disabled:opacity-60"
                      >
                        <span className="min-w-0 flex-1 truncate">{label(model, provider.displayName)}</span>
                        {model.subProvider !== undefined && (
                          <span className="shrink-0 truncate text-[10px] text-[color-mix(in_srgb,var(--t3-muted-foreground)_70%,transparent)]">
                            {model.subProvider}
                          </span>
                        )}
                        {model.badge === "new" && (
                          <span className="shrink-0 rounded border border-[color-mix(in_srgb,var(--t3-info-foreground)_35%,transparent)] bg-[color-mix(in_srgb,var(--t3-info-foreground)_15%,transparent)] px-1 text-[9px] font-semibold tracking-wide uppercase">
                            New
                          </span>
                        )}
                        {model.isLegacy === true && <span className="shrink-0 text-[10px] text-t3-muted">Legacy</span>}
                        {saving === key ? (
                          <LoaderCircle size={12} className="shrink-0 animate-spin text-t3-muted" />
                        ) : (
                          selected && <Check size={13} className="shrink-0 text-t3-fg" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          {catalog.error !== null && (
            <p className="border-t border-[var(--t3-border)] px-2 py-1.5 text-[11px] whitespace-pre-wrap text-[var(--t3-error-foreground)]">
              {catalog.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** "Claude Opus 5.5" under Claude reads "Opus 5.5", as T3's own labels do (providerIconUtils.ts). */
function label(model: PanelModel, providerName: string): string {
  const short = model.shortName ?? model.name;
  const prefix = `${providerName} `;

  return short.toLowerCase().startsWith(prefix.toLowerCase()) && short.length > prefix.length ? short.slice(prefix.length) : short;
}

/** Older models sit after the current ones, as they do behind T3's "Show more". */
function withCurrent(providers: PanelModelProvider[] | null, current: PanelModelSelection): PanelModelProvider[] {
  if (providers === null) return [];

  return providers.map((provider) => {
    const models = [...provider.models].sort((left, right) => Number(left.isLegacy === true) - Number(right.isLegacy === true));

    // A selection the catalog no longer lists (a hidden or retired model) stays visible, so the list
    // marks it instead of showing no current row at all.
    if (current.instanceId === provider.instanceId && !models.some((model) => model.slug === current.model)) {
      models.unshift({ slug: current.model, name: current.model, options: [] });
    }

    return { ...provider, models };
  });
}
