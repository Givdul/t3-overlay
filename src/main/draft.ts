import { randomUUID } from "node:crypto";
import type {
  PanelAttachment,
  PanelCreateReply,
  PanelDraft,
  PanelDraftReply,
  PanelModelSelection,
  PanelProject,
} from "../shared/panel";
import { defaultModelSelection, trimModelSelection, type WireServerConfig } from "./panel";
import { AuthExpiredError, connect } from "./rpc";
import type { ShellProject } from "./shell";
import type { T3Server } from "./t3";

// The new-thread draft's two calls to T3, made the way T3's own web composer makes them: the thread is
// created together with its first turn, in the project's own checkout, and T3 titles it from that message
// (apps/web/src/components/chat/useComposerSend.ts → packages/client-runtime/src/operations/commands.ts,
// startThreadTurn → `orchestration.launchThread` with workspaceStrategy "root").

/** T3's permission mode for a thread that names none (packages/contracts/src/providerPolicy.ts, DEFAULT_RUNTIME_MODE). */
const T3_DEFAULT_RUNTIME_MODE = "full-access";

/** T3's answer to `orchestration.launchThread` (packages/contracts/src/orchestrationV2.ts, OrchestrationV2ThreadLaunchResult). */
interface WireLaunchReply {
  threadId?: string;
}

export interface DraftSource {
  /** The shell's projects, in its picker order. */
  projects: ShellProject[];
  /** The project of the thread updated most recently. */
  defaultProjectId: string | null;
}

/** The draft's projects, with T3's scratch checkout as the picker's "No project", listed last. */
function draftProjects(source: DraftSource, config: WireServerConfig | undefined): PanelProject[] {
  const serverMode = config?.settings?.defaultRuntimeMode ?? T3_DEFAULT_RUNTIME_MODE;
  const serverModel = trimModelSelection(config?.settings?.defaultModelSelection);

  const projects = source.projects.map((project) => ({
    projectId: project.projectId,
    title: project.title,
    icon: project.icon,
    scratch: config?.scratchWorkspaceRoot !== undefined && sameRoot(project.workspaceRoot, config.scratchWorkspaceRoot),
    // Stored project settings lead the project's legacy field, and both lead the server's own default;
    // once folded, only the stored overrides exist (apps/web/src/hooks/useHandleNewThread.ts →
    // resolveProjectSettings).
    defaultModelSelection: projectModelSelection(config, project, serverModel),
    // A project's own default leads, as its web draft reads it (apps/web/src/hooks/useHandleNewThread.ts).
    defaultRuntimeMode: config?.settings?.projectSettingsOverrides?.[project.projectId]?.defaultRuntimeMode ?? serverMode,
  }));

  return [...projects.filter((project) => !project.scratch), ...projects.filter((project) => project.scratch)];
}

/**
 * The model a project's new thread starts on. A stored override wins over the project's legacy field —
 * even when it stores null, which is a reset — and one T3 would not run is skipped, leaving the server's
 * default (packages/shared/src/projectSettings.ts, resolveProjectOverrides).
 */
function projectModelSelection(
  config: WireServerConfig | undefined,
  project: ShellProject,
  serverModel: PanelModelSelection | null,
): PanelModelSelection | null {
  const stored = config?.settings?.projectSettingsOverrides?.[project.projectId];
  const legacy = config?.settings?.projectSettingsFolded === true ? undefined : (project.defaultModelSelection ?? undefined);
  const namesOverride = stored !== undefined && Object.hasOwn(stored, "defaultModelSelection");
  const overridden = namesOverride ? stored.defaultModelSelection : legacy;

  if (overridden === null) return null;

  if (overridden === undefined) return serverModel;

  const selection = trimModelSelection(overridden);

  return selection !== null && modelRunsHere(config, selection) ? selection : serverModel;
}

/**
 * Whether T3 would run a stored default: its provider is enabled and ready, and the model is not one the
 * user hid. Custom models stay visible (packages/shared/src/projectSettings.ts, resolveProjectOverrides).
 */
function modelRunsHere(config: WireServerConfig | undefined, selection: PanelModelSelection): boolean {
  const provider = (config?.providers ?? []).find((candidate) => candidate.instanceId === selection.instanceId);

  if (provider?.enabled !== true || provider.status !== "ready" || provider.availability === "unavailable") return false;

  const hidden = config?.settings?.providerModelPreferences?.[selection.instanceId]?.hiddenModels ?? [];

  if (!hidden.includes(selection.model)) return true;

  return (provider.models ?? []).some((model) => model.slug === selection.model && model.isCustom === true);
}

/** What the draft composer needs before a thread exists; one short connection reads the server's config. */
export async function readDraft(server: T3Server, token: string, source: DraftSource): Promise<PanelDraftReply> {
  try {
    const rpc = await connect<WireServerConfig>(server, token);
    let config: WireServerConfig;

    try {
      config = await rpc.request<WireServerConfig>("server.getConfig", {});
    } finally {
      rpc.close();
    }

    const projects = draftProjects(source, config);

    const defaultProjectId = projects.some((project) => project.projectId === source.defaultProjectId)
      ? source.defaultProjectId
      : (projects[0]?.projectId ?? null);

    const draft: PanelDraft = {
      projects,
      defaultProjectId,
      defaultModelSelection: defaultModelSelection(config),
      defaultRuntimeMode: config.settings?.defaultRuntimeMode ?? T3_DEFAULT_RUNTIME_MODE,
      attachmentUploads: server.attachmentUploads,
      voiceTranscription: server.voiceTranscription,
    };

    return { ok: true, draft };
  } catch (error) {
    // A rejected token is the expiry the panel re-mints through, not a plain failure.
    if (error instanceof AuthExpiredError) throw error;

    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CreateThreadInput {
  projectId: string;
  modelSelection: PanelModelSelection;
  /** The permission mode the draft picked; T3's own default when the draft names none. */
  runtimeMode?: string;
  /** "default", or "plan" when the draft's plan toggle is on (providerPolicy.ts, ProviderInteractionMode). */
  interactionMode?: string;
  text: string;
  attachments: PanelAttachment[];
}

/** Creates the thread and its first turn; main then opens the panel on it and the shell feed lists it. */
export async function createThread(server: T3Server, token: string, input: CreateThreadInput): Promise<PanelCreateReply> {
  const text = input.text.trim();

  if (text === "" && input.attachments.length === 0) return { ok: false, error: "Write a message first" };

  try {
    const rpc = await connect<WireServerConfig | WireLaunchReply>(server, token);

    try {
      const config = await rpc.request<WireServerConfig>("server.getConfig", {});

      // A provider that draws no plan toggle always runs in build mode, as T3's mobile outbox resolves
      // it (apps/mobile/src/state/thread-outbox-model.ts, resolveProviderInteractionMode).
      const provider = (config.providers ?? []).find(
        (candidate) => candidate.instanceId === input.modelSelection.instanceId,
      );

      const interactionMode = provider?.showInteractionModeToggle === false ? "default" : (input.interactionMode ?? "default");

      const reply = await rpc.request<WireLaunchReply>("orchestration.launchThread", {
        commandId: randomUUID(),
        creationSource: "web",
        projectId: input.projectId,
        title: draftTitle(text, input.attachments),
        // T3 names the thread from its first message, as its web composer's draft does.
        generateTitle: true,
        modelSelection: input.modelSelection,
        // The mode the draft picked, else the user's T3 default; T3's own when the server names none
        // (packages/contracts/src/providerPolicy.ts, DEFAULT_RUNTIME_MODE).
        runtimeMode: input.runtimeMode ?? config.settings?.defaultRuntimeMode ?? T3_DEFAULT_RUNTIME_MODE,
        interactionMode,
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: randomUUID(), text, attachments: input.attachments },
      });

      return reply.threadId === undefined
        ? { ok: false, error: "T3 did not return the new thread" }
        : { ok: true, threadId: reply.threadId };
    } finally {
      rpc.close();
    }
  } catch (error) {
    // A rejected token is the expiry the panel re-mints through, not a plain failure.
    if (error instanceof AuthExpiredError) throw error;

    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** T3's title seed for a thread, before its own titler runs (packages/client-runtime/src/operations/threadTitle.ts). */
function draftTitle(text: string, attachments: PanelAttachment[]): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";

  if (line !== "") return truncate(line);

  const images = attachments.filter((attachment) => attachment.type === "image");

  if (images.length > 0) return images.length === 1 ? "Attached image" : "Attached images";

  const name = attachments[0]?.name.trim() ?? "";

  return name === "" ? "New thread" : truncate(`File: ${name}`);
}

/** T3's own title length (packages/shared/src/String.ts, truncate). */
function truncate(text: string, maxLength = 50): string {
  const characters = Array.from(text.trim());

  return characters.length <= maxLength ? characters.join("") : `${characters.slice(0, maxLength).join("")}…`;
}

/** T3's scratch root and a project's checkout name one folder; only the spelling can differ. */
function sameRoot(left: string, right: string): boolean {
  const trim = (path: string) => path.replace(/[\\/]+$/, "");

  return process.platform === "win32" ? trim(left).toLowerCase() === trim(right).toLowerCase() : trim(left) === trim(right);
}
