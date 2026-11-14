import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_LIMITS,
  RUNTIME_MODES,
  isImageAttachment,
  type ComposeAttachment,
  type ComposeBranches,
  type ComposeCommand,
  type ComposeContext,
  type ComposeDefaults,
  type ComposeFile,
  type ComposeModel,
  type ComposeOption,
  type ComposeProvider,
  type EnvMode,
  type LaunchRequest,
  type ModelChoice,
} from "../shared/compose";
import type { T3Requests, WireAttachment } from "./rpc";
import type { ProjectShell, ShellModel, WireModelSelection } from "./shell";
import type { T3Server } from "./t3";

// What a new thread can be started with on one machine, and the calls that start it. Everything goes
// over that machine's shell socket, with the same RPCs T3 Code's own composer makes
// (apps/web useComposerSend.ts, ChatComposer.tsx). Wire types are the slices of
// packages/contracts server.ts, settings.ts, git.ts, project.ts and assets.ts this reads.

interface WireOptionDescriptor {
  id: string;
  label: string;
  type: string;
  options?: { id: string; label: string; isDefault?: boolean }[];
  currentValue?: string | boolean;
}

interface WireModel {
  slug: string;
  name: string;
  isDefault?: boolean;
  isLegacy?: boolean;
  capabilities: { optionDescriptors?: WireOptionDescriptor[] } | null;
}

interface WireProvider {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  availability?: string;
  supportedRuntimeModes?: string[];
  models: WireModel[];
  slashCommands?: { name: string; description?: string }[];
  skills?: { name: string; description?: string; displayName?: string; enabled: boolean; userInvocable?: boolean }[];
}

/** The project-scoped settings a new thread reads, at either level. */
interface WireThreadDefaults {
  defaultModelSelection?: WireModelSelection | null;
  defaultRuntimeMode?: string;
  defaultThreadEnvMode?: string | null;
  newWorktreesStartFromOrigin?: boolean;
}

interface WireSettings extends WireThreadDefaults {
  projectSettingsOverrides?: Record<string, WireThreadDefaults>;
  /** Set once T3 moved the projects' own defaults into the overrides; their copies are stale then. */
  projectSettingsFolded?: boolean;
}

interface WireConfig {
  providers: WireProvider[];
  settings: WireSettings;
}

interface WireRefs {
  isRepo: boolean;
  refs: { name: string; isRemote?: boolean; current: boolean; isDefault: boolean; worktreePath: string | null }[];
}

interface WireEntries {
  entries: { path: string; kind: "file" | "directory" }[];
}

interface WireUploadUrl {
  attachmentId: string;
  relativeUrl: string;
}

interface WireLaunchResult {
  threadId: string;
}

/** A machine's provider instances that can start a turn now. */
export async function readProviders(rpc: T3Requests): Promise<ComposeProvider[]> {
  return (await rpc.request<WireConfig>("server.getConfig", {})).providers.flatMap(providerOf);
}

/**
 * One machine's providers and every project's defaults, read fresh each time the composer opens.
 * `sticky` is the model the last new thread on this machine used, as T3 keeps its last choice.
 */
export async function readComposeContext(
  environmentId: string,
  rpc: T3Requests,
  shell: ShellModel,
  sticky: ModelChoice | null,
): Promise<ComposeContext> {
  const config = await rpc.request<WireConfig>("server.getConfig", {});
  const providers = config.providers.flatMap(providerOf);

  return {
    environmentId,
    providers,
    projects: shell.projectList().map((project) => ({
      id: project.id,
      title: project.title,
      defaults: defaultsOf(config.settings, project, providers, sticky),
    })),
  };
}

function providerOf(raw: WireProvider): ComposeProvider[] {
  // T3's composer offers an instance only while it is enabled and not reported unavailable (providerInstances.ts).
  if (!raw.enabled || !raw.installed || raw.availability === "unavailable") return [];

  const models = raw.models.filter((model) => !model.isLegacy).map(modelOf);

  if (models.length === 0) return [];

  // T3 offers every mode when a provider names none.
  const supported: readonly string[] = raw.supportedRuntimeModes ?? RUNTIME_MODES;
  const runtimeModes = RUNTIME_MODES.filter((mode) => supported.includes(mode));

  const commands: ComposeCommand[] = [
    ...(raw.slashCommands ?? []).map((command) => ({ name: command.name, description: command.description ?? "", insert: `/${command.name} ` })),
    // A skill is invoked as `$name`; the server rewrites it for providers that call it `/name`.
    ...(raw.skills ?? [])
      .filter((skill) => skill.enabled && skill.userInvocable !== false)
      .map((skill) => ({ name: skill.name, description: skill.description ?? skill.displayName ?? "Skill", insert: `$${skill.name} ` })),
  ];

  return [{ instanceId: raw.instanceId, name: raw.displayName ?? raw.driver, models, runtimeModes, commands }];
}

function modelOf(raw: WireModel): ComposeModel {
  const options = (raw.capabilities?.optionDescriptors ?? []).flatMap((descriptor): ComposeOption[] => {
    if (descriptor.type === "boolean") {
      return [{ type: "boolean", id: descriptor.id, label: descriptor.label, defaultValue: descriptor.currentValue === true }];
    }

    if (descriptor.type !== "select" || descriptor.options === undefined) return [];

    const fallback = descriptor.options.find((choice) => choice.isDefault)?.id ?? null;

    return [
      {
        type: "select",
        id: descriptor.id,
        label: descriptor.label,
        choices: descriptor.options.map((choice) => ({ id: choice.id, label: choice.label })),
        defaultValue: typeof descriptor.currentValue === "string" ? descriptor.currentValue : fallback,
      },
    ];
  });

  return { slug: raw.slug, name: raw.name, isDefault: raw.isDefault === true, options };
}

/** As T3's resolveProjectSettings: the project's overrides over the machine's settings (packages/shared projectSettings.ts). */
function defaultsOf(settings: WireSettings, project: ProjectShell, providers: ComposeProvider[], sticky: ModelChoice | null): ComposeDefaults {
  const legacy: WireThreadDefaults = settings.projectSettingsFolded
    ? {}
    : {
        ...(project.defaultModelSelection != null ? { defaultModelSelection: project.defaultModelSelection } : {}),
        ...(project.defaultThreadEnvMode != null ? { defaultThreadEnvMode: project.defaultThreadEnvMode } : {}),
      };

  const resolved: WireThreadDefaults = { ...settings, ...legacy, ...settings.projectSettingsOverrides?.[project.id] };
  const model =
    modelChoiceOf(resolved.defaultModelSelection ?? null, providers) ?? modelChoiceOf(sticky, providers) ?? firstAvailableModel(providers);
  const runtimeMode = RUNTIME_MODES.find((mode) => mode === resolved.defaultRuntimeMode) ?? "full-access";
  const envMode: EnvMode = resolved.defaultThreadEnvMode === "worktree" ? "worktree" : "local";

  return { model, runtimeMode, envMode, startFromOrigin: resolved.newWorktreesStartFromOrigin ?? true };
}

/** A stored selection, if its instance and model are still offered. Legacy `{id: value}` options become T3's array. */
function modelChoiceOf(selection: WireModelSelection | null, providers: ComposeProvider[]): ModelChoice | null {
  if (selection === null) return null;

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);

  if (provider?.models.some((model) => model.slug === selection.model) !== true) return null;

  const options = Array.isArray(selection.options)
    ? selection.options
    : Object.entries(selection.options ?? {}).map(([id, value]) => ({ id, value }));

  return { instanceId: selection.instanceId, model: selection.model, options };
}

/** As T3's fallback: the first provider that can start a turn, with its default model. */
function firstAvailableModel(providers: ComposeProvider[]): ModelChoice | null {
  const provider = providers[0];
  const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];

  return provider === undefined || model === undefined ? null : { instanceId: provider.instanceId, model: model.slug, options: [] };
}

export async function listBranches(rpc: T3Requests, cwd: string, query: string): Promise<ComposeBranches> {
  // T3 takes no blank query: an empty search leaves the field out.
  const search = query.trim();
  const result = await rpc.request<WireRefs>("vcs.listRefs", search === "" ? { cwd, limit: 100 } : { cwd, query: search, limit: 100 });

  return {
    isRepo: result.isRepo,
    branches: result.refs.map((ref) => ({
      name: ref.name,
      isRemote: ref.isRemote === true,
      current: ref.current,
      isDefault: ref.isDefault,
      worktreePath: ref.worktreePath,
    })),
  };
}

/** T3's `@` search. An empty query lists the checkout's top entries; T3 strips a leading `@` itself. */
export async function searchFiles(rpc: T3Requests, cwd: string, query: string): Promise<ComposeFile[]> {
  // T3 caps a query at 256 characters (packages/contracts project.ts).
  const result = await rpc.request<WireEntries>("projects.searchEntries", { cwd, query: query.slice(0, 256), limit: 80 });

  return result.entries.map((entry) => ({ path: entry.path, kind: entry.kind }));
}

/**
 * Uploads each attachment to T3's signed upload route and returns them as a message carries them. The
 * route checks its signature and Content-Length only, as T3's web client sends it (attachmentUploadQueue.ts).
 */
export async function uploadAttachments(server: T3Server, rpc: T3Requests, attachments: ComposeAttachment[]): Promise<WireAttachment[]> {
  if (attachments.length > ATTACHMENT_LIMITS.perMessage) throw new Error(`T3 takes at most ${ATTACHMENT_LIMITS.perMessage} attachments per message`);

  const uploaded: WireAttachment[] = [];

  for (const attachment of attachments) {
    const type = isImageAttachment(attachment.mimeType) ? "image" : "file";
    const sizeBytes = attachment.bytes.byteLength;
    const mimeType = attachment.mimeType || "application/octet-stream";

    const target = await rpc.request<WireUploadUrl>("attachments.createUploadUrl", { type, name: attachment.name, mimeType, sizeBytes });

    const response = await fetch(new URL(target.relativeUrl, server.origin), {
      method: "POST",
      headers: { "content-type": mimeType },
      body: attachment.bytes,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) throw new Error(`Uploading ${attachment.name} failed (${response.status})`);

    uploaded.push({ type, id: target.attachmentId, name: attachment.name, mimeType, sizeBytes });
  }

  return uploaded;
}

/** Whether two checkout paths are the same folder. A branch checked out in the project's own folder is no separate worktree. */
function samePath(left: string, right: string): boolean {
  // Only a Windows path, on the machine T3 runs on, ignores case and slash direction.
  const normal = (path: string) => (/^[a-z]:[\\/]/i.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path).replace(/\/+$/, "");

  return normal(left) === normal(right);
}

/** As T3's deriveThreadTitleSeed (client-runtime threadTitle.ts): the prompt's start, else the attachments. */
function titleSeed(text: string, attachments: WireAttachment[]): string {
  const truncate = (value: string) => {
    const characters = Array.from(value.trim());

    return characters.length <= 50 ? value.trim() : `${characters.slice(0, 50).join("")}...`;
  };

  const firstLine = text.trim().split(/\r?\n/)[0] ?? "";

  if (firstLine !== "") return truncate(firstLine);

  const images = attachments.filter((attachment) => attachment.type === "image");

  if (images.length > 0) return images.length === 1 ? "Attached image" : "Attached images";

  return attachments[0] === undefined ? "New thread" : truncate(`File: ${attachments[0].name}`);
}

/**
 * Starts a thread with its first message in one `orchestration.launchThread`, as T3's composer does.
 * T3 creates a worktree itself; a local thread on another branch switches the checkout first, which is
 * what T3's branch picker does before it sends.
 */
export async function launchThread(server: T3Server, rpc: T3Requests, project: ProjectShell, request: LaunchRequest): Promise<string> {
  const branch = request.branch;
  let workspaceStrategy: object;

  if (request.envMode === "worktree") {
    if (branch === null) throw new Error("Pick a base branch for the worktree");

    workspaceStrategy = { type: "worktree", baseRef: branch.name, startFromOrigin: request.startFromOrigin };
  } else if (branch?.worktreePath != null && !samePath(branch.worktreePath, project.workspaceRoot)) {
    workspaceStrategy = { type: "existing_worktree", worktreePath: branch.worktreePath, branch: branch.name };
  } else {
    if (branch !== null && !branch.current) await rpc.request("vcs.switchRef", { cwd: project.workspaceRoot, refName: branch.name });

    workspaceStrategy = branch === null ? { type: "root" } : { type: "root", branch: branch.name };
  }

  const attachments = await uploadAttachments(server, rpc, request.attachments);
  const text = request.text.trim();
  const threadId = randomUUID();

  const result = await rpc.request<WireLaunchResult>("orchestration.launchThread", {
    commandId: randomUUID(),
    creationSource: "web",
    // T3 claims pending uploads by the thread they are sent to, so the id is chosen here.
    threadId,
    projectId: project.id,
    title: titleSeed(text, attachments),
    generateTitle: true,
    modelSelection: request.model,
    runtimeMode: request.runtimeMode,
    interactionMode: "default",
    workspaceStrategy,
    initialMessage: { messageId: randomUUID(), text, attachments },
  });

  return result.threadId;
}
