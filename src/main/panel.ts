import { randomUUID } from "node:crypto";
import type {
  DraftProject,
  PanelAttachment,
  PanelAttempt,
  PanelCommand,
  PanelCommandItem,
  PanelConfig,
  PanelEventPayload,
  PanelFileChange,
  PanelItem,
  PanelItemRef,
  PanelItemReply,
  PanelMessage,
  PanelModel,
  PanelModelOption,
  PanelModelSelection,
  PanelPathsReply,
  PanelProvider,
  PanelQueuedMessage,
  PanelQuestion,
  PanelReply,
  PanelRun,
  PanelRuntimeRequest,
  PanelSkillItem,
  PanelTodoStep,
  PanelView,
} from "../shared/panel";
import type { PanelTarget, SidebarProject } from "../shared/types";
import { AuthExpiredError, connect, type T3Rpc, type WirePayload } from "./rpc";
import type { T3Server } from "./t3";

// One thread's projection, trimmed for the panel. Main owns the socket (the token lives here) and
// forwards snapshots and events; the renderer keeps the timeline and draws it.
//
// Wire types below are the slices of T3's contract this client reads
// (packages/contracts/src/orchestrationV2.ts). They are asserted once, where a stream value arrives,
// so every trim below branches on decoded fields instead of re-probing JSON.

interface WireAttachment {
  id?: string;
  type?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

interface WireTodoStep {
  id?: string;
  text?: string;
  status?: string;
}

interface WireFileChange {
  path?: string;
  fileName?: string;
  additions?: number;
  deletions?: number;
}

interface WireQuestionOption {
  label?: string;
  description?: string;
  value?: string;
}

interface WireQuestion {
  id?: string;
  question?: string;
  header?: string;
  options?: WireQuestionOption[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  initialAnswer?: string;
}

interface WireSelection {
  instanceId?: string;
  model?: string;
  options?: { id?: string; value?: string | boolean }[];
}

interface WireItem {
  id?: string;
  type?: string;
  runId?: string | null;
  nodeId?: string | null;
  ordinal?: number;
  status?: string;
  inputIntent?: string;
  startedAt?: string;
  completedAt?: string;
  title?: string;
  text?: string;
  streaming?: boolean;
  markdown?: string;
  steps?: WireTodoStep[];
  attachments?: WireAttachment[];
  input?: string | object;
  output?: string | object;
  outputOmitted?: boolean;
  exitCode?: number;
  outputIndicatesFailure?: boolean;
  toolName?: string;
  fileName?: string;
  additions?: number;
  deletions?: number;
  changes?: WireFileChange[];
  pattern?: string;
  results?: { fileName?: string; line?: number; preview?: string }[];
  patterns?: string[];
  failure?: { message?: string; code?: string };
  message?: string;
  summary?: string;
  beforeTokenCount?: number;
  afterTokenCount?: number;
  prompt?: string;
  progress?: string;
  result?: string;
  origin?: string;
  requestId?: string;
  requestKind?: string;
  reason?: string;
  questions?: WireQuestion[];
  responseMode?: string;
}

interface WireCommandItem extends WireItem {
  input?: string;
  output?: string;
}

interface WireDynamicToolItem extends WireItem {
  input?: object;
  output?: object;
}

interface WireMessage {
  id?: string;
  role?: string;
  text?: string;
  attachments?: WireAttachment[];
}

interface WireThread {
  id?: string;
  projectId?: string;
  title?: string;
  runtimeMode?: string;
  interactionMode?: string;
  modelSelection?: WireSelection | null;
  worktreePath?: string | null;
}

interface WireRun {
  id?: string;
  status?: string;
  userMessageId?: string;
  queuePosition?: number;
}

interface WireAttempt {
  runId?: string;
  rootNodeId?: string;
  status?: string;
}

interface WireRuntimeRequest {
  id?: string;
  kind?: string;
  status?: string;
  responseCapability?: { type?: string };
}

interface WireRow {
  position?: number;
  sourceItemId?: string;
  item?: WireItem;
}

interface WireProjection {
  thread?: WireThread;
  messages?: WireMessage[];
  runs?: WireRun[];
  attempts?: WireAttempt[];
  runtimeRequests?: WireRuntimeRequest[];
  visibleTurnItems?: WireRow[];
  turnItems?: WireItem[];
}

interface WireStreamItem {
  kind?: string;
  snapshotSequence?: number;
  projection?: WireProjection;
  sequence?: number;
  event?: { type?: string; payload?: WireEventPayload };
}

interface WireEventPayload extends WireItem {
  kind?: string;
  rootNodeId?: string;
  responseCapability?: { type?: string };
  runtimeMode?: string;
  interactionMode?: string;
  modelSelection?: WireSelection | null;
}

interface WireTurnItemReply {
  item?: WireItem;
}

interface WireOptionDescriptor {
  id?: string;
  label?: string;
  type?: string;
  options?: { id?: string; label?: string; isDefault?: boolean }[];
  promptInjectedValues?: string[];
  isDefault?: boolean;
}

interface WireModel {
  slug?: string;
  name?: string;
  aliases?: string[];
  isDefault?: boolean;
  capabilities?: { optionDescriptors?: WireOptionDescriptor[] };
}

interface WireCommand {
  name?: string;
  description?: string;
  input?: { hint?: string };
}

interface WireSkill {
  name?: string;
  description?: string;
  shortDescription?: string;
  enabled?: boolean;
  userInvocable?: boolean;
}

interface WireWorkspaceSnapshot {
  cwd?: string;
  models?: WireModel[];
  slashCommands?: WireCommand[];
  skills?: WireSkill[];
}

interface WireProvider {
  instanceId?: string;
  displayName?: string;
  enabled?: boolean;
  installed?: boolean;
  status?: string;
  supportedRuntimeModes?: string[];
  models?: WireModel[];
  slashCommands?: WireCommand[];
  skills?: WireSkill[];
  workspaceSnapshots?: WireWorkspaceSnapshot[];
}

interface WireServerConfig {
  providers?: WireProvider[];
  settings?: {
    defaultModelSelection?: WireSelection;
    defaultRuntimeMode?: string;
    providerModelPreferences?: Record<string, { hiddenModels?: string[]; modelOrder?: string[] }>;
  };
}

interface WireSearchEntries {
  entries?: { path?: string; kind?: string }[];
  truncated?: boolean;
}

interface WireLaunchReply {
  threadId?: string;
}

interface WirePersistedAttachments {
  attachments?: unknown[];
}

/** The reply shapes this connection asks for: a projection, a turn item, the catalog and the composers' calls. */
type WireReply =
  | WireProjection
  | WireTurnItemReply
  | WireServerConfig
  | WireSearchEntries
  | WireLaunchReply
  | WirePersistedAttachments;

export interface PanelOptions {
  server: T3Server;
  token: string;
  /** The local environment's id; a thread from anywhere else is "remote". */
  environmentId: string;
  onMessage: (message: PanelMessage) => void;
  onAuthExpired: () => void;
  /** The draft remembers the project its last thread started in. */
  lastProjectId: () => string | null;
  /** A launched thread: main opens it, so the panel switches to the new thread. */
  onLaunched: (thread: { environmentId: string; threadId: string }, projectId: string) => void;
}

export interface Panel {
  /** Starts or stops the subscription. Same target twice keeps the live one. */
  setTarget(target: PanelTarget | null): void;
  /** This PC's projects, so a thread's checkout resolves to `worktreePath ?? project.workspaceRoot`. */
  setProjects(projects: SidebarProject[]): void;
  command(command: PanelCommand): Promise<PanelReply | PanelItemReply | PanelPathsReply>;
  retry(): void;
  stop(): void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long tool output is fetched per row instead; an event stream must not carry megabytes. */
const OUTPUT_LIMIT = 8000;

export function startPanel(options: PanelOptions): Panel {
  let target: PanelTarget | null = null;
  let projects: SidebarProject[] = [];
  let rpc: T3Rpc<WireStreamItem, WireReply> | null = null;
  let stopStream: (() => void) | null = null;
  /** The last sequence main forwarded: a resubscribe resumes after it. */
  let lastSequence = 0;
  /** Bumped by every (re)subscribe and by stopping, so a late socket can recognise itself as stale. */
  let generation = 0;
  /** The catalog the composer menus read, pushed once per connect. */
  let config: PanelConfig | null = null;
  /** The open thread's trimmed projection: sends compare their picks and the runtime mode with it. */
  let view: PanelView | null = null;
  /** A thread is visited once per time the panel opens it, not once per reconnect. */
  let visited = false;

  function setTarget(next: PanelTarget | null) {
    if (sameTarget(next, target)) return;
    target = next;
    view = null;
    visited = false;
    stopSubscription();
    lastSequence = 0;

    if (next === null) return;

    if (next === "draft") {
      publishDraft();
      // The draft has no thread subscription to carry the catalog, so it fetches it itself.
      void ensureConfig();

      return;
    }

    if (next.environmentId !== options.environmentId) {
      options.onMessage({ kind: "remote" });

      return;
    }

    publishConfig();
    void subscribe(next.threadId, null);
  }

  function stopSubscription() {
    generation += 1;
    stopStream?.();
    stopStream = null;
    rpc?.close();
    rpc = null;
  }

  function publishConfig() {
    if (config !== null) options.onMessage({ kind: "config", config });
  }

  function publishDraft() {
    options.onMessage({ kind: "draft", projects: draftProjects(projects), lastProjectId: options.lastProjectId() });
  }

  /** Connects, subscribes, and reconnects up to three times before giving up on the thread. */
  async function subscribe(threadId: string, afterSequence: number | null) {
    const current = ++generation;
    let reason = "";

    options.onMessage({ kind: "status", status: "connecting" });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await delay(1000);

      if (current !== generation) return;

      try {
        const connection = await connect<WireStreamItem, WireReply>(options.server, options.token);

        if (current !== generation) {
          connection.close();

          return;
        }

        rpc = connection;
        const payload: WirePayload = { threadId, requestCompletionMarker: true };

        if (afterSequence !== null) payload.afterSequence = afterSequence;
        stopStream = connection.stream("orchestration.subscribeThread", payload, {
          onValue: (value) => {
            if (current === generation) onStreamValue(threadId, value);
          },
          onClose: (why) => {
            if (current !== generation) return;
            // The subscription is gone: try to resume right after the last event already forwarded.
            connection.close();
            console.warn("[panel] thread stream closed:", why);
            void subscribe(threadId, lastSequence > 0 ? lastSequence : null);
          },
        });
        void loadConfig(connection);

        if (!visited) {
          visited = true;
          // T3's own "opened": it clears the thread's unread mark when the panel shows it.
          void dispatchOn(connection, { type: "thread.visit", threadId, visitedAt: new Date().toISOString(), opened: true }).catch(
            (cause: unknown) => console.warn("[panel] thread.visit failed", cause),
          );
        }

        return;
      } catch (error) {
        if (error instanceof AuthExpiredError) {
          options.onAuthExpired();
          options.onMessage({ kind: "status", status: "ended", reason: "T3 rejected the overlay's session" });

          return;
        }

        reason = error instanceof Error ? error.message : String(error);
      }
    }

    options.onMessage({ kind: "status", status: "ended", reason: reason === "" ? "T3's stream closed" : reason });
  }

  let loadingConfig = false;

  /** The draft's own catalog fetch: one short connection, nothing subscribed. */
  async function ensureConfig() {
    if (config !== null) {
      publishConfig();

      return;
    }

    if (loadingConfig) return;

    loadingConfig = true;

    try {
      const connection = await connect<WireStreamItem, WireReply>(options.server, options.token);

      try {
        const raw = await connection.request<WireServerConfig>("server.getConfig", {});

        config = trimConfig(raw);
        publishConfig();
      } finally {
        connection.close();
      }
    } catch (error) {
      console.warn("[panel] server.getConfig failed", error);
    } finally {
      loadingConfig = false;
    }
  }

  /** The provider catalog the composer's `/`, `@` and pickers read. Failure leaves the thread usable. */
  async function loadConfig(connection: T3Rpc<WireStreamItem, WireReply>) {
    try {
      const raw = await connection.request<WireServerConfig>("server.getConfig", {});
      config = trimConfig(raw);
      // A reconnect can change the catalog; the panel re-reads it for its chips and menus.
      publishConfig();
    } catch (error) {
      console.warn("[panel] server.getConfig failed", error);
    }
  }

  function onStreamValue(threadId: string, item: WireStreamItem) {
    switch (item.kind) {
      case "snapshot": {
        const next = trimView(item.projection, projects);

        if (next === null) return;
        view = next;
        lastSequence = item.snapshotSequence ?? 0;
        options.onMessage({ kind: "snapshot", threadId, view: next, sequence: lastSequence });

        return;
      }

      case "synchronized":
        options.onMessage({ kind: "status", status: "live" });

        return;
      case "event": {
        const sequence = item.sequence ?? 0;

        if (sequence <= lastSequence) return;
        lastSequence = sequence;
        const type = item.event?.type ?? "";
        options.onMessage({ kind: "event", threadId, event: { sequence, type, payload: trimEventPayload(type, item.event?.payload) } });

        return;
      }

      case "unknown-event":
        // A nightly added an event shape this build cannot fold in: the projection may be behind.
        if ((item.sequence ?? 0) > lastSequence) lastSequence = item.sequence ?? 0;
        options.onMessage({ kind: "stale" });

        return;
      default:
        options.onMessage({ kind: "stale" });
    }
  }

  /** A unary call on the thread's socket, or on a short one when the draft has no subscription. */
  async function request<T extends WireReply>(tag: string, payload: WirePayload): Promise<T> {
    if (rpc !== null) return rpc.request<T>(tag, payload);

    const connection = await connect<WireStreamItem, WireReply>(options.server, options.token);

    try {
      return await connection.request<T>(tag, payload);
    } finally {
      connection.close();
    }
  }

  async function dispatchOn(connection: T3Rpc<WireStreamItem, WireReply>, command: WirePayload) {
    return connection.request("orchestration.dispatchCommand", { commandId: randomUUID(), ...command });
  }

  async function dispatch(command: WirePayload) {
    if (rpc === null) throw new Error("T3 is not connected");

    await dispatchOn(rpc, command);
  }

  async function refuse(reason: string): Promise<PanelReply> {
    return { ok: false, error: reason };
  }

  async function send(command: Extract<PanelCommand, { type: "send" }>): Promise<PanelReply> {
    const thread = target;
    const current = view;

    if (rpc === null || thread === null || thread === "draft" || current === null) return refuse("T3 is not connected");
    const text = command.text.trim();

    if (text === "" && command.images.length === 0) return refuse("Write a message first");

    const messageId = randomUUID();
    let attachments: unknown[] = [];

    if (command.images.length > 0) {
      const stored = await rpc.request<WirePersistedAttachments>("assets.persistChatAttachments", {
        threadId: thread.threadId,
        messageId,
        attachments: command.images,
      });

      attachments = stored.attachments ?? [];
    }

    // T3's own order: the mode the turn should run in, then the message (ChatView#persistThreadSettingsForNextTurn).
    if (command.runtimeMode !== null && command.runtimeMode !== "" && command.runtimeMode !== current.thread.runtimeMode) {
      await dispatch({ type: "thread.runtime-mode.set", threadId: thread.threadId, runtimeMode: command.runtimeMode });
    }

    const payload: WirePayload = {
      type: "message.dispatch",
      threadId: thread.threadId,
      messageId,
      text,
      attachments,
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: command.queue ? "queue_after_active" : "start_immediately" },
    };

    if (command.freshContext === true) payload.freshContext = true;

    if (command.model !== null && !sameSelection(command.model, current.thread.modelSelection)) payload.modelSelection = command.model;

    await dispatch(payload);
    // A queued message has no turn-item event until its run starts: re-read so the row shows at once.
    await pushSnapshot(thread.threadId);

    return { ok: true };
  }

  /** Re-reads the open thread and pushes it as a reset; a read has no event sequence of its own. */
  async function pushSnapshot(threadId: string) {
    if (rpc === null) return;

    try {
      const projection = await rpc.request<WireProjection>("orchestration.getThreadProjection", { threadId });
      const next = trimView(projection, projects);
      // The reader may have switched threads while this read was in flight.
      const current = target;

      if (next === null || current === null || current === "draft" || current.threadId !== threadId) return;

      view = next;
      options.onMessage({ kind: "snapshot", threadId, view: next, sequence: null });
    } catch (cause) {
      console.warn("[panel] projection reload failed", cause);
    }
  }

  async function start(command: Extract<PanelCommand, { type: "start" }>): Promise<PanelReply> {
    const project = projects.find((candidate) => candidate.projectId === command.projectId);

    if (project === undefined) return refuse("Pick a project first");

    if (project.worktree) return refuse("This project starts threads in worktrees. Open T3 to start one.");
    const text = command.text.trim();

    if (text === "") return refuse("Write a message first");

    const model = command.model ?? config?.defaultModel ?? null;

    if (model === null) return refuse("No model is available. Open T3 to start this thread.");

    const threadId = randomUUID();

    const result = await request<WireLaunchReply>("orchestration.launchThread", {
      commandId: randomUUID(),
      creationSource: "web",
      threadId,
      projectId: project.projectId,
      title: firstLine(text),
      generateTitle: true,
      modelSelection: model,
      runtimeMode: command.runtimeMode,
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: randomUUID(), text, attachments: [] },
    });

    options.onLaunched({ environmentId: options.environmentId, threadId: result.threadId ?? threadId }, project.projectId);

    return { ok: true };
  }

  async function searchPaths(command: Extract<PanelCommand, { type: "searchPaths" }>): Promise<PanelPathsReply> {
    const result = await request<WireSearchEntries>("projects.searchEntries", {
      cwd: command.cwd,
      query: command.query.slice(0, 256),
      limit: 20,
    });

    const entries = (result.entries ?? []).flatMap((entry) =>
      entry.path === undefined ? [] : [{ path: entry.path, kind: entry.kind === "directory" ? ("directory" as const) : ("file" as const) }],
    );

    // Directories first, as T3's own list sorts them; the server's order within each kind is kept.
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1));

    return { ok: true, entries, truncated: result.truncated === true };
  }

  async function command(next: PanelCommand): Promise<PanelReply | PanelItemReply | PanelPathsReply> {
    try {
      switch (next.type) {
        case "send":
          return await send(next);
        case "start":
          return await start(next);
        case "searchPaths":
          return await searchPaths(next);
        case "stop":
          if (rpc === null || target === null || target === "draft") return refuse("T3 is not connected");
          await dispatch({ type: "thread.stop", threadId: target.threadId });

          return { ok: true };
        case "respond":
          if (rpc === null || target === null || target === "draft") return refuse("T3 is not connected");
          await dispatch({ type: "runtime-request.respond", threadId: target.threadId, requestId: next.requestId, decision: next.decision });

          return { ok: true };
        case "answer":
          if (rpc === null || target === null || target === "draft") return refuse("T3 is not connected");
          await dispatch({ type: "runtime-request.respond", threadId: target.threadId, requestId: next.requestId, answers: next.answers });

          return { ok: true };
        case "dismissInput":
          if (rpc === null || target === null || target === "draft") return refuse("T3 is not connected");
          await dispatch({ type: "thread.user-input.dismiss", threadId: target.threadId, requestId: next.requestId });

          return { ok: true };
        case "turnItem": {
          if (rpc === null || target === null || target === "draft") return refuse("T3 is not connected");

          const result = await rpc.request<WireTurnItemReply>("orchestration.getTurnItem", {
            threadId: target.threadId,
            itemId: next.itemId,
          });

          const item = trimItem(result.item);

          return item === null ? { ok: false, error: "T3 has no such turn item" } : { ok: true, item };
        }

        case "reload": {
          if (rpc === null || target === null || target === "draft") return refuse("T3 is not connected");
          const projection = await rpc.request<WireProjection>("orchestration.getThreadProjection", { threadId: target.threadId });
          const next = trimView(projection, projects);

          if (next === null) return refuse("T3 sent no projection");
          view = next;
          // A fresh read keeps its own sequence numbering: `null` leaves the renderer's dedupe alone.
          options.onMessage({ kind: "snapshot", threadId: target.threadId, view: next, sequence: null });

          return { ok: true };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    setTarget,
    setProjects(next) {
      const wasMissing = view !== null && view.thread.cwd === null;

      projects = next;

      if (target === "draft") {
        publishDraft();

        return;
      }

      // The shell's projects arrive after a thread can be opened; one reload resolves its checkout.
      if (wasMissing && target !== null && view !== null && next.some((project) => project.projectId === view?.thread.projectId)) {
        void pushSnapshot(target.threadId);
      }
    },
    command,
    retry() {
      if (target === null || target === "draft" || target.environmentId !== options.environmentId) return;
      stopSubscription();
      void subscribe(target.threadId, lastSequence > 0 ? lastSequence : null);
    },
    stop() {
      generation += 1;
      stopSubscription();
      target = null;
      view = null;
    },
  };
}

/** T3's draft picker lists local projects; a worktree-default project cannot be started from here. */
function draftProjects(projects: readonly SidebarProject[]): DraftProject[] {
  return projects.map((project) => ({
    projectId: project.projectId,
    title: project.title,
    icon: project.icon,
    worktree: project.worktree,
    workspaceRoot: project.workspaceRoot,
  }));
}

/** A model pick equals the thread's own when the instance, the model and every option match. */
function sameSelection(a: PanelModelSelection, b: PanelModelSelection | null): boolean {
  if (b === null) return false;

  return JSON.stringify(selectionKey(a)) === JSON.stringify(selectionKey(b));
}

function selectionKey(selection: PanelModelSelection) {
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    options: [...(selection.options ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/** T3 titles a launched thread from the first line of its message (titleSeed + generateTitle). */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";

  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function sameTarget(a: PanelTarget | null, b: PanelTarget | null): boolean {
  if (a === null || b === null) return a === b;

  if (a === "draft" || b === "draft") return a === b;

  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

// ---------------------------------------------------------------- trimming

/** A turn item with only the fields the panel draws, or null when T3 sent no usable item. */
export function trimItem(raw: WireItem | undefined): PanelItem | null {
  if (raw?.id === undefined || raw.type === undefined) return null;

  const trimmed: PanelItem = {
    id: raw.id,
    type: raw.type,
    runId: raw.runId ?? null,
    nodeId: raw.nodeId ?? null,
    ordinal: raw.ordinal ?? 0,
  };

  copyCommon(raw, trimmed);

  switch (raw.type) {
    case "user_message":
      trimmed.text = raw.text;
      trimmed.attachments = trimAttachments(raw.attachments);
      break;
    case "assistant_message":
    case "reasoning":
      trimmed.text = raw.text;
      trimmed.streaming = raw.streaming;
      break;
    case "proposed_plan":
      trimmed.markdown = raw.markdown;
      break;
    case "todo_list":
      trimmed.steps = trimSteps(raw.steps);
      break;
    case "command_execution": {
      // SAFETY: a command_execution's input is the command line T3 received, always a string
      // (OrchestrationV2CommandExecutionTurnItem); the union exists for the dynamic tool branch.
      const command = raw as WireCommandItem;
      trimmed.input = command.input;
      trimmed.output = trimText(command.output);
      trimmed.outputOmitted = command.outputOmitted === true || trimmed.output !== command.output;
      trimmed.exitCode = raw.exitCode;
      trimmed.outputIndicatesFailure = raw.outputIndicatesFailure;
      break;
    }

    case "dynamic_tool": {
      // SAFETY: a dynamic_tool's input is a JSON object (OrchestrationV2DynamicToolTurnItem), and the
      // row shows it as pretty-printed text, so nothing else has to type it.
      const tool = raw as WireDynamicToolItem;
      trimmed.toolName = tool.toolName;
      trimmed.toolInput = tool.input === undefined ? undefined : JSON.stringify(tool.input, null, 2);
      // A tool's output is arbitrary JSON on this build (delegation answers are objects).
      const output = tool.output === undefined ? undefined : JSON.stringify(tool.output, null, 2);
      trimmed.output = trimText(output);
      trimmed.outputOmitted = tool.outputOmitted === true || trimmed.output !== output;
      break;
    }

    case "file_change":
      trimmed.fileName = raw.fileName;
      trimmed.additions = raw.additions;
      trimmed.deletions = raw.deletions;
      trimmed.changes = trimChanges(raw.changes);
      break;
    case "file_search":
      trimmed.pattern = raw.pattern;
      trimmed.results = (raw.results ?? [])
        .flatMap((result) => {
          if (result.fileName === undefined) return [];

          return [result.line === undefined ? result.fileName : `${result.fileName}:${result.line}`];
        })
        .slice(0, 50);
      break;
    case "web_search":
      trimmed.patterns = (raw.patterns ?? []).filter(Boolean);
      break;
    case "error":
      trimmed.failure = raw.failure;
      break;
    case "system_notice":
    case "run_interrupt_request":
    case "run_interrupt_result":
      trimmed.message = raw.message;
      break;
    case "compaction":
      trimmed.summary = raw.summary;
      trimmed.beforeTokenCount = raw.beforeTokenCount;
      trimmed.afterTokenCount = raw.afterTokenCount;
      break;
    case "subagent":
      trimmed.prompt = raw.prompt;
      trimmed.progress = raw.progress;
      trimmed.result = raw.result;
      trimmed.origin = raw.origin;
      break;
    case "approval_request":
      trimmed.requestId = raw.requestId;
      trimmed.requestKind = raw.requestKind;
      trimmed.prompt = raw.prompt;
      trimmed.reason = raw.reason;
      break;
    case "user_input_request":
      trimmed.requestId = raw.requestId;
      trimmed.questions = trimQuestions(raw.questions);
      trimmed.responseMode = raw.responseMode;
      break;
    default:
      // A nightly's new item type keeps its common fields; the panel draws no row for it.
      break;
  }

  return trimmed;
}

function copyCommon(raw: WireItem, trimmed: PanelItem) {
  if (raw.status !== undefined) trimmed.status = raw.status;

  if (raw.inputIntent !== undefined) trimmed.inputIntent = raw.inputIntent;

  if (raw.startedAt !== undefined) trimmed.startedAt = raw.startedAt;

  if (raw.completedAt !== undefined) trimmed.completedAt = raw.completedAt;

  if (raw.title !== undefined) trimmed.title = raw.title;
}

/** Tool output over the limit is fetched per row from `getTurnItem`, which carries the full body. */
function trimText(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= OUTPUT_LIMIT) return text;

  return `${text.slice(0, OUTPUT_LIMIT)}\n…`;
}

function trimAttachments(attachments: WireAttachment[] | undefined): PanelAttachment[] | undefined {
  if (attachments === undefined) return undefined;

  return attachments.map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  }));
}

function trimSteps(steps: WireTodoStep[] | undefined): PanelTodoStep[] | undefined {
  if (steps === undefined) return undefined;

  return steps.map((step) => ({ id: step.id, text: step.text, status: step.status }));
}

function trimChanges(changes: WireFileChange[] | undefined): PanelFileChange[] | undefined {
  if (changes === undefined) return undefined;

  return changes.map((change) => ({
    path: change.path,
    fileName: change.fileName,
    additions: change.additions,
    deletions: change.deletions,
  }));
}

function trimQuestions(questions: WireQuestion[] | undefined): PanelQuestion[] | undefined {
  if (questions === undefined) return undefined;

  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    header: question.header,
    options: question.options?.map((option) => ({
      label: option.label,
      description: option.description,
      value: option.value,
    })),
    multiSelect: question.multiSelect,
    allowCustomAnswer: question.allowCustomAnswer,
    initialAnswer: question.initialAnswer,
  }));
}

function itemRef(raw: WireItem): PanelItemRef | null {
  if (raw.id === undefined || raw.type === undefined) return null;

  const ref: PanelItemRef = {
    id: raw.id,
    type: raw.type,
    runId: raw.runId ?? null,
    nodeId: raw.nodeId ?? null,
    ordinal: raw.ordinal ?? 0,
  };

  if (raw.inputIntent !== undefined) ref.inputIntent = raw.inputIntent;

  return ref;
}

function modelSelection(raw: WireSelection | null | undefined): PanelModelSelection | null {
  if (raw?.instanceId === undefined || raw.model === undefined) return null;

  const selection: PanelModelSelection = { instanceId: raw.instanceId, model: raw.model };

  const options = (raw.options ?? []).flatMap((option) => {
    if (option.id === undefined || option.value === undefined) return [];

    return [{ id: option.id, value: option.value }];
  });

  if (options.length > 0) selection.options = options;

  return selection;
}

/** One thread projection reduced to what the panel draws. */
export function trimView(raw: WireProjection | undefined, projects: readonly SidebarProject[]): PanelView | null {
  if (raw === undefined) return null;
  const thread = raw.thread;

  if (thread?.id === undefined || thread.projectId === undefined) return null;

  const project = projects.find((candidate) => candidate.projectId === thread.projectId);
  const worktreePath = thread.worktreePath ?? null;
  const runs: PanelRun[] = (raw.runs ?? []).flatMap((run) => (run.id === undefined ? [] : [{ id: run.id, status: run.status ?? "" }]));

  const attempts: PanelAttempt[] = (raw.attempts ?? []).flatMap((attempt) =>
    attempt.runId === undefined || attempt.rootNodeId === undefined
      ? []
      : [{ runId: attempt.runId, rootNodeId: attempt.rootNodeId, status: attempt.status ?? "" }],
  );

  const runtimeRequests: PanelRuntimeRequest[] = (raw.runtimeRequests ?? []).flatMap((request) =>
    request.id === undefined
      ? []
      : [
          {
            id: request.id,
            kind: request.kind ?? "",
            status: request.status ?? "",
            responseCapability: { type: request.responseCapability?.type ?? "" },
          },
        ],
  );

  const messages = new Map<string, WireMessage>();

  for (const message of raw.messages ?? []) {
    if (message.id !== undefined) messages.set(message.id, message);
  }

  // A queued message has no turn item until its run starts; T3 keeps it in the message store instead.
  const queued: PanelQueuedMessage[] = (raw.runs ?? []).flatMap((run) => {
    if (run.status !== "queued" || run.id === undefined || run.userMessageId === undefined) return [];
    const message = messages.get(run.userMessageId);

    if (message?.text === undefined) return [];

    return [
      {
        id: run.userMessageId,
        runId: run.id,
        text: message.text,
        attachments: trimAttachments(message.attachments),
        position: run.queuePosition ?? 0,
      },
    ];
  });

  queued.sort((left, right) => left.position - right.position);

  const rows = (raw.visibleTurnItems ?? []).flatMap((row) => {
    const item = trimItem(row.item);

    return row.sourceItemId === undefined || item === null ? [] : [{ position: row.position ?? 0, sourceItemId: row.sourceItemId, item }];
  });

  const items = (raw.turnItems ?? []).flatMap((item) => {
    const ref = itemRef(item);

    return ref === null ? [] : [ref];
  });

  return {
    thread: {
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title ?? "",
      runtimeMode: thread.runtimeMode ?? "",
      interactionMode: thread.interactionMode ?? "",
      modelSelection: modelSelection(thread.modelSelection),
      cwd: worktreePath ?? project?.workspaceRoot ?? null,
    },
    runs,
    attempts,
    runtimeRequests,
    rows,
    items,
    queued,
  };
}

/** Event payloads are whole entities; the panel folds in only the fields it renders. */
function trimEventPayload(type: string, payload: WireEventPayload | undefined): PanelEventPayload {
  if (payload === undefined) return {};

  if (type === "turn-item.updated") {
    const item = trimItem(payload);

    return item === null ? {} : { item };
  }

  const trimmed: PanelEventPayload = {};

  if (payload.id !== undefined) trimmed.id = payload.id;

  if (payload.status !== undefined) trimmed.status = payload.status;

  if (payload.kind !== undefined) trimmed.kind = payload.kind;

  if (payload.runId !== undefined) trimmed.runId = payload.runId;

  if (payload.rootNodeId !== undefined) trimmed.rootNodeId = payload.rootNodeId;

  if (payload.responseCapability !== undefined) trimmed.responseCapability = { type: payload.responseCapability.type ?? "" };

  if (payload.title !== undefined) trimmed.title = payload.title;

  if (payload.runtimeMode !== undefined) trimmed.runtimeMode = payload.runtimeMode;

  if (payload.interactionMode !== undefined) trimmed.interactionMode = payload.interactionMode;

  if (payload.modelSelection !== undefined) trimmed.modelSelection = modelSelection(payload.modelSelection);

  return trimmed;
}

// ---------------------------------------------------------------- the composer's catalog

/** Long menu descriptions are one line each; T3 clips them the same way in its own list. */
const DESCRIPTION_LIMIT = 200;

/** `server.getConfig` reduced to the providers, models, commands and skills the composer draws. */
export function trimConfig(raw: WireServerConfig | undefined): PanelConfig {
  const preferences = raw?.settings?.providerModelPreferences ?? {};

  const providers = (raw?.providers ?? []).flatMap((provider): PanelProvider[] => {
    if (provider.instanceId === undefined) return [];

    // T3 lists a provider only when it is turned on, installed and answering; its models gate the picker.
    if (provider.enabled === false || provider.installed === false) return [];

    if (provider.status !== undefined && provider.status !== "ready") return [];
    const instanceId = provider.instanceId;
    const models = trimModels(provider.models, preferences[instanceId]);

    if (models.length === 0) return [];

    const entry: PanelProvider = {
      instanceId,
      displayName: provider.displayName ?? instanceId,
      models,
      slashCommands: trimCommands(provider.slashCommands),
      skills: trimSkills(provider.skills),
      workspaces: (provider.workspaceSnapshots ?? []).flatMap((snapshot) =>
        snapshot.cwd === undefined
          ? []
          : [
              {
                cwd: snapshot.cwd,
                models: trimModels(snapshot.models ?? provider.models, preferences[instanceId]),
                slashCommands: trimCommands(snapshot.slashCommands ?? provider.slashCommands),
                skills: trimSkills(snapshot.skills ?? provider.skills),
              },
            ],
      ),
    };

    if (provider.supportedRuntimeModes !== undefined) entry.supportedRuntimeModes = provider.supportedRuntimeModes;

    return [entry];
  });

  return {
    providers,
    defaultModel: modelSelection(raw?.settings?.defaultModelSelection),
    defaultRuntimeMode: raw?.settings?.defaultRuntimeMode ?? "full-access",
  };
}

function trimModels(raw: WireModel[] | undefined, preference: { hiddenModels?: string[]; modelOrder?: string[] } | undefined): PanelModel[] {
  const hidden = new Set(preference?.hiddenModels ?? []);

  const models = (raw ?? []).flatMap((model): PanelModel[] => {
    if (model.slug === undefined || hidden.has(model.slug)) return [];

    const options = (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor): PanelModelOption[] => {
      if (descriptor.id === undefined) return [];

      if (descriptor.type === "boolean") {
        return [{ id: descriptor.id, label: descriptor.label ?? descriptor.id, type: "boolean", isDefault: descriptor.isDefault }];
      }

      const option: PanelModelOption = {
        id: descriptor.id,
        label: descriptor.label ?? descriptor.id,
        type: "select",
        isDefault: descriptor.isDefault,
        options: (descriptor.options ?? []).flatMap((choice) =>
          choice.id === undefined ? [] : [{ id: choice.id, label: choice.label ?? choice.id, isDefault: choice.isDefault }],
        ),
      };

      if (descriptor.promptInjectedValues !== undefined) option.promptInjectedValues = descriptor.promptInjectedValues;

      return [option];
    });

    const trimmed: PanelModel = { slug: model.slug, name: model.name ?? model.slug, isDefault: model.isDefault === true, options };

    if (model.aliases !== undefined) trimmed.aliases = model.aliases;

    return [trimmed];
  });

  // The order the user set in T3 comes first; everything else follows in the server's order.
  const order = (preference?.modelOrder ?? []).flatMap((slug, index) => {
    const position = models.findIndex((model) => model.slug === slug);

    return position === -1 ? [] : [{ index, model: models[position]! }];
  });

  order.sort((left, right) => left.index - right.index);

  return [...order.map((entry) => entry.model), ...models.filter((model) => !order.some((entry) => entry.model === model))];
}

function trimCommands(raw: WireCommand[] | undefined): PanelCommandItem[] {
  return (raw ?? []).flatMap((command) =>
    command.name === undefined ? [] : [{ name: command.name, description: clip(command.description ?? command.input?.hint ?? null) }],
  );
}

function trimSkills(raw: WireSkill[] | undefined): PanelSkillItem[] {
  return (raw ?? []).flatMap((skill) =>
    skill.name === undefined
      ? []
      : [
          {
            name: skill.name,
            description: clip(skill.shortDescription ?? skill.description ?? null),
            enabled: skill.enabled !== false,
            userInvocable: skill.userInvocable !== false,
          },
        ],
  );
}

function clip(text: string | null): string | null {
  if (text === null || text === "") return null;

  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT)}…` : text;
}
