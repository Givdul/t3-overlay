import type {
  PanelModel,
  PanelModelOption,
  PanelModelOptionDescriptor,
  PanelModelProvider,
  PanelModelSelection,
} from "../../../shared/panel";

// The selected model's options, resolved the way T3's composer resolves them (packages/shared/src/model.ts,
// getProviderOptionDescriptors; apps/web/src/components/chat/TraitsPicker.tsx, getSelectedTraits). The
// catalog declares the lists and toggles; the thread's own values sit on top of them.

/**
 * The descriptors with the value the model would run: the thread's own value, then the catalog's, then the
 * choice the model marks as its default. Fast mode is off until someone turns it on, as upstream's
 * implicit default has it (packages/shared/src/model.ts, withImplicitFastModeDefault).
 */
export function resolvedTraits(
  model: { options: PanelModelOptionDescriptor[] },
  selection: PanelModelSelection,
): PanelModelOptionDescriptor[] {
  const selections = withImplicitFastMode(model.options, selection.options);

  return model.options.map((descriptor) => {
    const value = selections.find((option) => option.id === descriptor.id)?.value;

    if (descriptor.type === "boolean") {
      const current = toggleOf(value);

      return current === undefined ? descriptor : { ...descriptor, currentValue: current };
    }

    return { ...descriptor, currentValue: choiceValue(descriptor, value) };
  });
}

/** T3 requires the user to pick fast mode, so a model with the toggle starts with it off. */
function withImplicitFastMode(
  descriptors: PanelModelOptionDescriptor[],
  options: PanelModelOption[] | undefined,
): PanelModelOption[] {
  if (options?.some((option) => option.id === "fastMode")) return options;

  const hasFastMode = descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode");

  return hasFastMode ? [...(options ?? []), { id: "fastMode", value: false }] : (options ?? []);
}

/** A select's value: one its list offers, else the catalog's, else the choice it marks as the default. */
function choiceValue(
  descriptor: Extract<PanelModelOptionDescriptor, { type: "select" }>,
  value: string | boolean | undefined,
): string | undefined {
  const offered = textOf(value);

  if (offered !== undefined && descriptor.options.some((option) => option.id === offered)) {
    // A value a typed prompt sets is not what the menu runs at.
    return descriptor.promptInjectedValues?.includes(offered) === true
      ? (descriptor.currentValue ?? defaultChoice(descriptor))
      : offered;
  }

  return descriptor.currentValue ?? defaultChoice(descriptor);
}

function defaultChoice(descriptor: Extract<PanelModelOptionDescriptor, { type: "select" }>): string | undefined {
  return descriptor.options.find((option) => option.isDefault === true)?.id ?? descriptor.options[0]?.id;
}

/** A selection's value as text, when it is text; a boolean value belongs to a toggle. */
function textOf(value: string | boolean | undefined): string | undefined {
  return value === undefined || value === true || value === false ? undefined : value;
}

/** A selection's value as a toggle, when it is one. */
function toggleOf(value: string | boolean | undefined): boolean | undefined {
  return value === true || value === false ? value : undefined;
}

/** The choices a picker offers: a value only a typed prompt sets is not one of them. */
export function selectableChoices(descriptor: Extract<PanelModelOptionDescriptor, { type: "select" }>) {
  return descriptor.options.filter((option) => descriptor.promptInjectedValues?.includes(option.id) !== true);
}

/** Every descriptor's current value, as `thread.model-selection.set` writes them. */
export function selectionsOf(descriptors: PanelModelOptionDescriptor[]): PanelModelOption[] {
  return descriptors.flatMap((descriptor): PanelModelOption[] => {
    const value =
      descriptor.type === "boolean" ? descriptor.currentValue : (descriptor.currentValue ?? defaultChoice(descriptor));

    return value === undefined ? [] : [{ id: descriptor.id, value }];
  });
}

/** The same descriptors with `id` set to `value`, ready to be written as the model's options. */
export function withChange(
  descriptors: PanelModelOptionDescriptor[],
  id: string,
  value: string | boolean,
): PanelModelOption[] {
  return selectionsOf(
    descriptors.map((descriptor): PanelModelOptionDescriptor => {
      if (descriptor.id !== id) return descriptor;

      if (descriptor.type === "boolean") {
        const toggle = toggleOf(value);

        return toggle === undefined ? descriptor : { ...descriptor, currentValue: toggle };
      }

      const text = textOf(value);

      return text === undefined ? descriptor : { ...descriptor, currentValue: text };
    }),
  );
}

/**
 * The traits trigger's label, as T3's is built (packages/client-runtime/src/modelTraits.ts,
 * buildTraitsTriggerDisplay): the reasoning choice's label, then fast mode when it is on, then any other
 * option that is on. An option that is off adds nothing.
 */
export function traitsLabel(descriptors: PanelModelOptionDescriptor[]): string {
  const labels: string[] = [];
  let speed: string | null = null;

  for (const descriptor of descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speed = descriptor.currentValue === true ? "Fast" : null;
      continue;
    }

    if (descriptor.type === "boolean") {
      if (descriptor.currentValue === true) labels.push(descriptor.label);

      continue;
    }

    const current = descriptor.options.find((option) => option.id === descriptor.currentValue);

    if (current !== undefined) labels.push(current.label);
  }

  if (speed !== null) labels.push(speed);

  return labels.join(" · ");
}

/** The catalog's entry for a selection, or null while the catalog is missing or no longer lists it. */
export function findModel(
  providers: PanelModelProvider[] | null,
  selection: PanelModelSelection,
): { provider: PanelModelProvider; model: PanelModel } | null {
  if (providers === null) return null;

  for (const provider of providers) {
    if (provider.instanceId !== selection.instanceId) continue;
    const model = provider.models.find((candidate) => candidate.slug === selection.model);

    if (model !== undefined) return { provider, model };
  }

  return null;
}
