import { Check } from "lucide-react";
import { useState } from "react";
import type { PanelConfig, PanelModel, PanelModelOption, PanelModelSelection, PanelProvider } from "../../../shared/panel";
import { defaultsFor, modelSuffix, optionValue, providerFor } from "./config";

// T3's model picker, cut down to one list: providers as headers, the model's reasoning levels and
// toggles under the selection. A pick changes composer state only; the send carries it (decision 3.9).

interface ModelPickerProps {
  config: PanelConfig | null;
  /** The thread's checkout: its provider catalog can add models of its own. */
  cwd: string | null;
  value: PanelModelSelection | null;
  onChange: (selection: PanelModelSelection) => void;
}

export function ModelPicker({ config, cwd, value, onChange }: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const selectedModel = value === null ? null : modelIn(config, cwd, value);

  return (
    <div className="mx-2 mt-2 mb-1 flex max-h-72 min-h-0 flex-col overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] bg-[var(--t3-popover)]">
      <div className="border-b border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] p-2">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          className="w-full rounded-md border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] bg-[var(--t3-surface-raised)] px-2 py-1 text-[12px] text-t3-fg outline-none placeholder:text-t3-muted focus:border-[color-mix(in_srgb,var(--t3-contrast-foreground)_22%,transparent)]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {config === null || config.providers.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-t3-muted">No models are available. Set one up in T3 Code.</p>
        ) : (
          config.providers.map((provider) => {
            const models = providerModels(provider, cwd).filter(
              (model) =>
                needle === "" ||
                model.slug.toLowerCase().includes(needle) ||
                model.name.toLowerCase().includes(needle) ||
                (model.aliases ?? []).some((alias) => alias.toLowerCase().includes(needle)),
            );

            if (models.length === 0) return null;

            return (
              <div key={provider.instanceId}>
                <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-t3-muted">{provider.displayName}</p>
                {models.map((model) => {
                  const selection = value?.instanceId === provider.instanceId && value.model === model.slug ? value : null;
                  const suffix = selection === null ? null : modelSuffix(model, selection);

                  return (
                    <button
                      key={`${provider.instanceId}:${model.slug}`}
                      type="button"
                      onClick={() =>
                        onChange({ instanceId: provider.instanceId, model: model.slug, options: defaultsFor(model) })
                      }
                      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left ${
                        selection !== null ? "bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_9%,transparent)]" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-t3-fg">{model.name}</span>
                      {suffix !== null && <span className="shrink-0 text-[11px] text-t3-muted">{suffix}</span>}
                      <span className="flex size-3 shrink-0 items-center justify-center text-t3-fg">
                        {selection !== null && <Check size={12} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
      {selectedModel !== null && value !== null && selectedModel.options.length > 0 && (
        <div className="border-t border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] p-2">
          {selectedModel.options.map((option) => (
            <OptionControl key={option.id} option={option} value={value} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

function OptionControl({
  option,
  value,
  onChange,
}: {
  option: PanelModelOption;
  value: PanelModelSelection;
  onChange: (selection: PanelModelSelection) => void;
}) {
  const current = optionValue(option, value);

  const update = (next: string | boolean) => {
    const options = (value.options ?? []).filter((candidate) => candidate.id !== option.id);

    onChange({ ...value, options: [...options, { id: option.id, value: next }] });
  };

  if (option.type === "boolean") {
    const checked = current === true;

    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => update(!checked)}
        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-[12px] text-t3-fg hover:bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_7%,transparent)]"
      >
        {option.label}
        <span className={`flex h-[14px] w-6 shrink-0 items-center rounded-full p-0.5 ${checked ? "bg-[var(--t3-message-action)]" : "bg-white/15"}`}>
          <span className={`size-2.5 rounded-full bg-white transition-transform ${checked ? "translate-x-2.5" : ""}`} />
        </span>
      </button>
    );
  }

  const options = option.options ?? [];

  return (
    <div className="px-1 py-1">
      <p className="mb-1 px-1 text-[11px] text-t3-muted">{option.label}</p>
      <div role="radiogroup" aria-label={option.label} className="flex flex-wrap gap-1">
        {options.map((choice) => {
          const selected = current === choice.id;

          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => update(choice.id)}
              className={`rounded-md px-2 py-1 text-[11px] ${
                selected
                  ? "bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_14%,transparent)] text-t3-fg"
                  : "text-t3-muted hover:bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_7%,transparent)] hover:text-t3-fg"
              }`}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function providerModels(provider: PanelProvider, cwd: string | null): PanelModel[] {
  const workspace = cwd === null ? undefined : provider.workspaces.find((candidate) => candidate.cwd === cwd);

  return workspace?.models ?? provider.models;
}

function modelIn(config: PanelConfig | null, cwd: string | null, selection: PanelModelSelection): PanelModel | null {
  const provider = providerFor(config, selection.instanceId);

  if (provider === null) return null;

  return providerModels(provider, cwd).find((model) => model.slug === selection.model) ?? null;
}
