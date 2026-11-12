import type {
  PanelCatalog,
  PanelConfig,
  PanelModel,
  PanelModelOption,
  PanelModelSelection,
  PanelProvider,
} from "../../../shared/panel";

// The catalog helpers the composer menus and the chips read. Everything comes from `server.getConfig`
// that main trimmed and pushed once per connect (main/panel.ts#trimConfig).

export interface SlashItem {
  /** How selecting the row behaves: built-ins act on the composer, commands and skills insert text. */
  kind: "model" | "clear" | "command" | "skill";
  name: string;
  label: string;
  description: string;
}

/** T3's four runtime modes and the labels it shows (apps/web/src/components/chat/runtimeModeConfig.ts). */
export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

export interface RuntimeModeInfo {
  label: string;
  description: string;
}

/** T3's four labels and descriptions, from apps/web/src/components/chat/runtimeModeConfig.ts. */
export function runtimeModeInfo(mode: string): RuntimeModeInfo {
  switch (mode) {
    case "approval-required":
      return { label: "Supervised", description: "Ask before commands and file changes." };
    case "auto-accept-edits":
      return { label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions." };
    case "auto":
      return { label: "Auto", description: "Supported providers approve routine actions; others still ask." };
    case "full-access":
      return { label: "Full access", description: "Allow commands and edits without prompts." };
    default:
      return { label: mode, description: "" };
  }
}

export function runtimeModeLabel(mode: string): string {
  return runtimeModeInfo(mode).label;
}

/** The modes a provider supports, or T3's four when it reports none. */
export function runtimeModes(provider: PanelProvider | null | undefined): string[] {
  const supported = provider?.supportedRuntimeModes;

  return supported !== undefined && supported.length > 0 ? RUNTIME_MODES.filter((mode) => supported.includes(mode)) : [...RUNTIME_MODES];
}

export function providerFor(config: PanelConfig | null, instanceId: string | null | undefined): PanelProvider | null {
  if (config === null || instanceId === null || instanceId === undefined) return null;

  return config.providers.find((provider) => provider.instanceId === instanceId) ?? null;
}

/** The provider's catalog at a checkout: a workspace snapshot for this exact cwd wins, as in T3. */
export function catalogFor(config: PanelConfig | null, instanceId: string | null | undefined, cwd: string | null): PanelCatalog | null {
  const provider = providerFor(config, instanceId);

  if (provider === null) return null;
  const workspace = cwd === null ? undefined : provider.workspaces.find((candidate) => candidate.cwd === cwd);

  if (workspace !== undefined) return { models: workspace.models, slashCommands: workspace.slashCommands, skills: workspace.skills };

  return { models: provider.models, slashCommands: provider.slashCommands, skills: provider.skills };
}

export function modelFor(config: PanelConfig | null, selection: PanelModelSelection | null): PanelModel | null {
  const catalog = catalogFor(config, selection?.instanceId, null);

  return catalog?.models.find((model) => model.slug === selection?.model) ?? null;
}

export function optionValue(option: PanelModelOption, selection: PanelModelSelection): string | boolean | null {
  const found = selection.options?.find((candidate) => candidate.id === option.id);

  if (found !== undefined) return found.value;

  return null;
}

/** The word after the model name: the selected option's label (usually the reasoning effort). */
export function modelSuffix(model: PanelModel | null, selection: PanelModelSelection | null): string | null {
  if (model === null || selection === null) return null;
  const primary = model.options.find((option) => option.options !== undefined);

  if (primary === undefined || primary.options === undefined) return null;
  const value = optionValue(primary, selection);

  return primary.options.find((option) => option.id === String(value))?.label ?? null;
}

/** T3's option defaults: the descriptor's default, else the first value; booleans off. */
export function defaultsFor(model: PanelModel): PanelModelSelection["options"] {
  return model.options.flatMap<{ id: string; value: string | boolean }>((option) => {
    if (option.type === "boolean") return [{ id: option.id, value: false }];
    const choice = option.options?.find((candidate) => candidate.isDefault) ?? option.options?.[0];

    return choice === undefined ? [] : [{ id: option.id, value: choice.id }];
  });
}

export function sameSelection(a: PanelModelSelection | null, b: PanelModelSelection | null): boolean {
  if (a === null || b === null) return a === b;

  return key(a) === key(b);
}

function key(selection: PanelModelSelection): string {
  return JSON.stringify({
    instanceId: selection.instanceId,
    model: selection.model,
    options: [...(selection.options ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

/**
 * T3's `/` list: its own built-ins, the provider's commands, then its skills as `/skill:<name>`.
 * A command a skill covers is dropped (getProviderSlashCommandsForSlashMenu), as is a provider `clear`.
 */
export function slashItems(config: PanelConfig | null, instanceId: string | null | undefined, cwd: string | null): SlashItem[] {
  const provider = providerFor(config, instanceId);
  const catalog = catalogFor(config, instanceId, cwd);

  const items: SlashItem[] = [
    { kind: "model", name: "model", label: "/model", description: "Switch response model for this thread" },
    { kind: "clear", name: "clear", label: "/clear", description: "Start a fresh session; earlier messages stay visible" },
  ];

  if (provider === null || catalog === null) return items;
  const skills = catalog.skills.filter((skill) => skill.enabled && skill.userInvocable && skill.name !== "");
  const skillNames = new Set(skills.map((skill) => skill.name.trim().toLowerCase()));

  for (const command of catalog.slashCommands) {
    if (command.name === "" || command.name === "clear" || skillNames.has(command.name.trim().toLowerCase())) continue;
    items.push({ kind: "command", name: command.name, label: `/${command.name}`, description: command.description ?? "Run provider command" });
  }

  const seen = new Set<string>();

  for (const skill of skills) {
    const normalized = skill.name.trim().toLowerCase();

    if (seen.has(normalized)) continue;
    seen.add(normalized);
    items.push({ kind: "skill", name: skill.name, label: `/skill:${skill.name}`, description: skill.description ?? "Run provider skill" });
  }

  return items;
}

/** Matches the label first and the description after, case-insensitively, both as one plain substring. */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();

  if (needle === "") return [...items];

  return items.filter((item) => item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle));
}
