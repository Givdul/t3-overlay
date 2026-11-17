import { randomUUID } from "node:crypto";
import type {
  PanelApprovalDecision,
  PanelApprovalOption,
  PanelAttachment,
  PanelAttachmentReply,
  PanelAttachmentUploads,
  PanelAttachmentUrlReply,
  PanelAttempt,
  PanelCommandOutput,
  PanelEntriesReply,
  PanelEventPayload,
  PanelFailure,
  PanelFileChange,
  PanelForceStopReply,
  PanelItem,
  PanelItemRef,
  PanelItemReply,
  PanelManagedPolicy,
  PanelMessage,
  PanelMessageContext,
  PanelModel,
  PanelModelOption,
  PanelModelOptionChoice,
  PanelModelOptionDescriptor,
  PanelModelProvider,
  PanelModelSelectOption,
  PanelModelSelection,
  PanelModelsReply,
  PanelModelToggleOption,
  PanelPlan,
  PanelProjectEntry,
  PanelProviderCommand,
  PanelProviderSkill,
  PanelQuestion,
  PanelQueuedMessage,
  PanelReply,
  PanelRun,
  PanelRuntimeRequest,
  PanelThreadCommand,
  PanelTodoStep,
  PanelView,
  PanelVoiceReply,
} from "../shared/panel";
import type { ThreadRef } from "../shared/types";
import { attachmentLimit, attachmentTooLargeMessage, isImageAttachment } from "../shared/attachments";
import { createBackoff, STABLE_AFTER_MS } from "./backoff";
import { AuthExpiredError, commandFrame, connect, type T3Rpc, type ThreadCommand, type WirePayload } from "./rpc";
import type { T3Server } from "./t3";
import { transcribePcm, voiceStatus } from "./voice";

// One thread's projection, trimmed for the panel. Main owns the socket (the token lives here) and
// forwards snapshots and events; the renderer keeps the timeline and draws it.
//
// Wire types below are the slices of T3's contract this client reads
// (packages/contracts/src/orchestrationV2.ts). They are asserted once, where a stream value arrives,
// so every trim below branches on decoded fields instead of re-probing JSON.

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

interface WireAttachment {
  id?: string;
  type?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** One approval decision T3 offers (packages/contracts/src/providerPolicy.ts, ProviderApprovalOption). */
interface WireApprovalOption {
  decision?: string;
  label?: string;
  warning?: string;
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
  attachments?: WireAttachment[];
  streaming?: boolean;
  markdown?: string;
  /** The plan a proposed_plan row draws (orchestrationV2.ts, proposed_plan.planId). */
  planId?: string;
  steps?: WireTodoStep[];
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
  /** An approval request's decisions, when the provider names them. */
  options?: WireApprovalOption[];
  /** Set once a provider did not confirm Stop, so the panel can offer Force stop. */
  unresponsiveAt?: string;
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
  text?: string;
  attachments?: WireAttachment[];
  context?: PanelMessageContext;
}

/** One option value as T3 stores it (packages/contracts/src/model.ts, ProviderOptionSelection). */
interface WireOptionSelection {
  id?: string;
  value?: string | boolean;
}

/** One choice of a model option (packages/contracts/src/model.ts, ProviderOptionChoice). */
interface WireOptionChoice {
  id?: string;
  label?: string;
  description?: string;
  isDefault?: boolean;
}

/** One option a model declares (packages/contracts/src/model.ts, ProviderOptionDescriptor). */
interface WireOptionDescriptor {
  id?: string;
  label?: string;
  description?: string;
  type?: string;
  options?: WireOptionChoice[];
  currentValue?: string | boolean;
  promptInjectedValues?: string[];
  role?: string;
}

/** A thread's model (packages/contracts/src/modelSelection.ts); `provider` is the older spelling of `instanceId`. */
export interface WireModelSelection {
  instanceId?: string;
  provider?: string;
  model?: string;
  /** T3 sends an array; an older server sent one object keyed by option id. */
  options?: WireOptionSelection[] | Record<string, string | boolean>;
}

interface WireThread {
  id?: string;
  projectId?: string;
  title?: string;
  modelSelection?: WireModelSelection;
  runtimeMode?: string;
  interactionMode?: string;
}

interface WireRun {
  id?: string;
  status?: string;
  userMessageId?: string;
  queuePosition?: number | null;
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

/** One plan the thread has proposed (packages/contracts/src/orchestrationV2.ts, OrchestrationV2PlanArtifact). */
interface WirePlan {
  id?: string;
  kind?: string;
  status?: string;
}

interface WireProjection {
  thread?: WireThread;
  messages?: WireMessage[];
  runs?: WireRun[];
  attempts?: WireAttempt[];
  runtimeRequests?: WireRuntimeRequest[];
  plans?: WirePlan[];
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
  modelSelection?: WireModelSelection;
  runtimeMode?: string;
  interactionMode?: string;
}

interface WireTurnItemReply {
  item?: WireItem;
}

/** One frame of a running command's output (packages/contracts/src/orchestrationV2.ts, OrchestrationV2CommandOutputFrame). */
interface WireCommandOutputFrame {
  kind?: string;
  text?: string;
  /** Earlier output was dropped to keep the tail bounded. */
  truncated?: boolean;
  running?: boolean;
}

/** `attachments.createUploadUrl` mints one signed slot to POST a file's bytes to. */
interface WireUploadReply {
  attachmentId?: string;
  relativeUrl?: string;
  expiresAt?: number;
}

/** `assets.createUrl`'s answer (packages/contracts/src/assets.ts, AssetCreateUrlResult). */
interface WireAssetUrlReply {
  relativeUrl?: string;
  expiresAt?: number;
}

/** One model a provider offers (packages/contracts/src/server.ts, ServerProviderModel). */
interface WireProviderModel {
  slug?: string;
  name?: string;
  shortName?: string;
  subProvider?: string;
  badge?: string;
  isCustom?: boolean;
  isLegacy?: boolean;
  isDefault?: boolean;
  /** The options the model declares, e.g. its reasoning effort (packages/contracts/src/model.ts, ModelCapabilities). */
  capabilities?: { optionDescriptors?: WireOptionDescriptor[] } | null;
}

/** One command a provider expands itself (packages/contracts/src/server.ts, ServerProviderSlashCommand). */
interface WireSlashCommand {
  name?: string;
  description?: string;
  input?: { hint?: string };
}

/** One skill a provider offers (packages/contracts/src/server.ts, ServerProviderSkill). */
interface WireSkill {
  name?: string;
  description?: string;
  shortDescription?: string;
  displayName?: string;
  scope?: string;
  enabled?: boolean;
  /** T3's `user-invocable: false`: only the agent can start it, so its composer hides it. */
  userInvocable?: boolean;
}

/** A provider's scan of one checkout (server.ts, ServerProviderWorkspaceSnapshot). */
interface WireWorkspaceSnapshot {
  cwd?: string;
  slashCommands?: WireSlashCommand[];
  skills?: WireSkill[];
}

/** A provider and its models (packages/contracts/src/server.ts, ServerProvider). */
interface WireProvider {
  instanceId?: string;
  driver?: string;
  displayName?: string;
  enabled?: boolean;
  /** "ready" once the provider can run a model here. */
  status?: string;
  /** "unavailable" when this machine cannot run the provider at all. */
  availability?: string;
  /** T3 draws a plan toggle for this provider's threads. */
  showInteractionModeToggle?: boolean;
  /** The permission modes the provider supports; absent means every one. */
  supportedRuntimeModes?: string[];
  models?: WireProviderModel[];
  /** The commands and skills its composer offers, and those it found in each checkout. */
  slashCommands?: WireSlashCommand[];
  skills?: WireSkill[];
  workspaceSnapshots?: WireWorkspaceSnapshot[];
}

/** One file or folder `projects.searchEntries` answers with (packages/contracts/src/project.ts, ProjectEntry). */
interface WireProjectEntry {
  path?: string;
  kind?: string;
}

/** `projects.searchEntries`'s answer (project.ts, ProjectSearchEntriesResult). */
interface WireSearchReply {
  entries?: WireProjectEntry[];
}

/** The administrator's policy, which caps the permission modes a thread may run (packages/contracts/src/managedPolicy.ts, ManagedPolicySummary). */
interface WireManagedPolicy {
  organization?: string;
  limits?: { maxRuntimeMode?: string };
}

/** The slice of `server.getConfig` the composer's model picker and the new-thread draft read (packages/contracts/src/server.ts). */
export interface WireServerConfig {
  providers?: WireProvider[];
  /** T3's own default model, runtime mode and scratch checkout for a new thread. */
  settings?: {
    providerModelPreferences?: Record<string, { hiddenModels?: string[] }>;
    defaultModelSelection?: WireModelSelection | null;
    defaultRuntimeMode?: string;
    /** Once folded, project settings live only in the overrides, as T3's own resolver treats them. */
    projectSettingsFolded?: boolean;
    /** A project's own settings override the server's, as its web draft's runtime mode reads them. */
    projectSettingsOverrides?: Record<string, { defaultRuntimeMode?: string; defaultModelSelection?: WireModelSelection | null }>;
  };
  /** Present when an administrator's policy manages this environment. */
  managedPolicy?: WireManagedPolicy | null;
  scratchWorkspaceRoot?: string;
}

/** `orchestration.forceStopThread`'s answer (packages/contracts/src/orchestrationV2.ts, OrchestrationV2ForceStopThreadResult). */
interface WireForceStopResult {
  outcome?: string;
  sharedWithThreadIds?: string[];
}

/** The reply shapes this connection asks for: a projection, a turn item, an upload slot, an asset URL, the provider catalog, a file search and a force stop. */
type WireReply =
  | WireProjection
  | WireTurnItemReply
  | WireUploadReply
  | WireAssetUrlReply
  | WireServerConfig
  | WireForceStopResult
  | WireSearchReply;

export interface PanelOptions {
  server: T3Server;
  token: string;
  /** This PC's environment id; a thread from anywhere else is main/remote.ts's to read. */
  environmentId: string;
  /** The checkout a project runs in, which its composer's `@` menu searches; null when T3 lists none. */
  projectRoot: (projectId: string) => string | null;
  /** Re-reads T3's environment descriptor, so an upgraded or restarted server's capabilities are not stale. */
  refreshServer?: () => Promise<T3Server | null>;
  onMessage: (message: PanelMessage) => void;
  onAuthExpired: () => void;
}

export interface Panel {
  /** Starts or stops the subscription. The same target twice keeps the live one. */
  setTarget(target: ThreadRef | null): void;
  command(
    command: PanelThreadCommand,
  ): Promise<
    | PanelReply
    | PanelItemReply
    | PanelAttachmentReply
    | PanelAttachmentUrlReply
    | PanelModelsReply
    | PanelEntriesReply
    | PanelVoiceReply
    | PanelForceStopReply
  >;
  stop(): void;
}

/** Long tool output is fetched per row instead; an event stream must not carry megabytes. */
const OUTPUT_LIMIT = 8000;

/**
 * T3's own follow-up text when a plan is implemented; the server reads the plan from `sourcePlanRef`
 * (apps/web/src/proposedPlan.ts, PLAN_IMPLEMENTATION_PROMPT_PREFIX).
 */
const PLAN_IMPLEMENTATION_PROMPT = "PLEASE IMPLEMENT THIS PLAN:\n";

/** How many files and folders the composer's `@` menu asks T3 for (apps/web/src/state/queries.ts, COMPOSER_PATH_SEARCH_LIMIT). */
const COMPOSER_SEARCH_LIMIT = 80;

/** An event this build cannot fold in re-reads the projection once the burst settles. */
const STALE_DELAY_MS = 500;

export function startPanel(options: PanelOptions): Panel {
  let target: ThreadRef | null = null;
  /** T3's descriptor as last read; a reconnect re-reads it so an upgraded server's flags are not stale. */
  let server = options.server;
  /** Whether this panel has subscribed before, so the next one is a reconnect or a thread switch. */
  let subscribed = false;
  let rpc: T3Rpc<WireReply> | null = null;
  let stopStream: (() => void) | null = null;
  /** The last sequence main forwarded: a resubscribe resumes after it. */
  let lastSequence = 0;
  /** Live output of the expanded running command rows, by turn item id, on this thread's socket. */
  const commandOutputs = new Map<string, () => void>();
  /** Bumped by every (re)subscribe and by stopping, so a late socket can recognise itself as stale. */
  let generation = 0;
  /** The open thread's trimmed projection: the queued row and the run list the composer reads. */
  let view: PanelView | null = null;
  let staleTimer: NodeJS.Timeout | null = null;
  /** A dropped socket reconnects here; a new target or a close cancels it. */
  let retryTimer: NodeJS.Timeout | null = null;
  const backoff = createBackoff();
  /** When this socket came up, so one that stayed up long enough resets the ladder. */
  let connectedAt: number | null = null;

  function setTarget(next: ThreadRef | null) {
    if (sameTarget(next, target)) return;
    target = next;
    view = null;
    stopSubscription();
    lastSequence = 0;

    if (next === null) return;

    // A thread on another machine: main/remote.ts reads it with the MCP session this socket cannot use.
    if (next.environmentId !== options.environmentId) return;

    void subscribe(next.threadId);
  }

  function stopSubscription() {
    generation += 1;
    stopStream?.();
    stopStream = null;
    stopCommandOutputs();
    rpc?.close();
    rpc = null;
    connectedAt = null;

    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = null;

    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  /** Ends every live command-output stream; a collapsed row or a thread switch means none is wanted. */
  function stopCommandOutputs() {
    for (const stop of commandOutputs.values()) stop();

    commandOutputs.clear();
  }

  /**
   * T3 may have been upgraded or restarted on the same origin since the descriptor was read. Re-reading it
   * keeps the capability flags the next snapshot carries current; another origin is main's to reconnect.
   */
  async function refreshServer() {
    if (options.refreshServer === undefined) return;

    try {
      const next = await options.refreshServer();

      if (next !== null && next.origin === server.origin && next.environmentId === server.environmentId) server = next;
    } catch (error) {
      console.warn("[panel] re-reading the descriptor failed", error);
    }
  }

  /**
   * One expanded running row's output. T3's hub sends a bounded tail (`replace`) and then appends, and ends
   * the stream itself when the command settles (apps/server/src/orchestration-v2/CommandOutputHub.ts).
   */
  function watchCommandOutput(threadId: string, itemId: string): PanelReply {
    if (rpc === null) return refuse("T3 is not connected");

    // T3's own clients read the same capability; an older server has no such route.
    if (!server.commandOutputStreaming) return refuse("This T3 server does not stream command output");

    if (commandOutputs.has(itemId)) return { ok: true };

    const stop = rpc.stream<WireCommandOutputFrame>(
      "orchestration.subscribeCommandOutput",
      { threadId, itemId },
      {
        onValue: (frame) => options.onMessage({ kind: "commandOutput", threadId, itemId, frame: trimCommandOutput(frame) }),
        onClose: () => {
          if (commandOutputs.get(itemId) === stop) commandOutputs.delete(itemId);
        },
      },
    );

    commandOutputs.set(itemId, stop);

    return { ok: true };
  }

  /** The row collapsed, or the command finished: ends its stream on T3's side too. */
  function closeCommandOutput(itemId: string): PanelReply {
    const stop = commandOutputs.get(itemId);

    if (stop !== undefined) {
      commandOutputs.delete(itemId);
      stop();
    }

    return { ok: true };
  }

  /**
   * Reopens the thread's stream on the shared ladder, resuming after the last sequence it forwarded.
   * The panel keeps the rows it has meanwhile, and shows itself as connecting until T3 says live.
   */
  function reconnect(threadId: string) {
    if (retryTimer !== null) return;

    if (connectedAt !== null && Date.now() - connectedAt >= STABLE_AFTER_MS) backoff.reset();

    connectedAt = null;
    const delay = backoff.nextDelay();
    console.warn(`[panel] reconnecting in ${delay}ms after ${threadId}`);
    options.onMessage({ kind: "status", status: "connecting" });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void subscribe(threadId);
    }, delay);
  }

  async function subscribe(threadId: string) {
    const current = generation + 1;
    generation = current;
    options.onMessage({ kind: "status", status: "connecting" });

    // A thread switch or a dropped socket lands here: T3's flags may have changed with its server.
    if (subscribed) await refreshServer();

    if (current !== generation) return;

    let connection: T3Rpc<WireReply>;

    try {
      connection = await connect<WireReply>(server, options.token);
    } catch (error) {
      if (current !== generation) return;

      // A rejected token cannot succeed on retry: a new one re-mints and restarts the panel.
      if (error instanceof AuthExpiredError) {
        options.onAuthExpired();
        options.onMessage({ kind: "status", status: "ended", reason: error.message });

        return;
      }

      console.warn("[panel] connect failed:", error);
      reconnect(threadId);

      return;
    }

    if (current !== generation) {
      connection.close();

      return;
    }

    rpc = connection;
    connectedAt = Date.now();
    subscribed = true;
    const payload: WirePayload = { threadId, requestCompletionMarker: true };

    if (lastSequence > 0) payload.afterSequence = lastSequence;

    stopStream = connection.stream<WireStreamItem>("orchestration.subscribeThread", payload, {
      onValue: (value) => {
        if (current === generation) onStreamValue(threadId, value);
      },
      onClose: (reason) => {
        if (current !== generation) return;
        connection.close();
        stopStream = null;
        rpc = null;
        console.warn("[panel] thread stream closed:", reason);
        reconnect(threadId);
      },
    });
  }

  function onStreamValue(threadId: string, item: WireStreamItem) {
    switch (item.kind) {
      case "snapshot": {
        const next = trimView(
          item.projection,
          server.attachmentUploads,
          server.voiceTranscription,
          server.threadForceStop,
          server.commandOutputStreaming,
        );

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

      default:
        // A nightly added an event shape this build cannot fold in: the projection may be behind.
        if ((item.sequence ?? 0) > lastSequence) lastSequence = item.sequence ?? 0;
        markStale();
    }
  }

  /** Re-reads the open thread and pushes it as a reset; a read has no event sequence of its own. */
  async function pushSnapshot() {
    const thread = target;

    if (rpc === null || thread === null) return;

    try {
      const projection = await rpc.request<WireProjection>("orchestration.getThreadProjection", { threadId: thread.threadId });

      const next = trimView(
        projection,
        server.attachmentUploads,
        server.voiceTranscription,
        server.threadForceStop,
        server.commandOutputStreaming,
      );
      // The reader may have switched threads while this read was in flight.
      const current = target;

      if (next === null || current?.threadId !== thread.threadId) return;

      view = next;
      options.onMessage({ kind: "snapshot", threadId: thread.threadId, view: next, sequence: null });
    } catch (cause) {
      console.warn("[panel] projection reload failed", cause);
    }
  }

  function markStale() {
    if (staleTimer !== null) return;

    staleTimer = setTimeout(() => {
      staleTimer = null;
      void pushSnapshot();
    }, STALE_DELAY_MS);
  }

  function refuse(reason: string): PanelFailure {
    return { ok: false, error: reason };
  }

  async function dispatch(command: ThreadCommand) {
    if (rpc === null) throw new Error("T3 is not connected");

    await rpc.command("orchestration.dispatchCommand", commandFrame(command));
  }

  /**
   * Runs `use` on the open thread's socket, or on a short-lived one when no thread is open: the draft
   * composer uploads its files and reads the model list before there is a thread to read them from.
   */
  async function withRpc<T>(use: (connection: T3Rpc<WireReply>) => Promise<T>): Promise<T> {
    if (rpc !== null) return use(rpc);

    const connection = await connect<WireReply>(server, options.token);

    try {
      return await use(connection);
    } finally {
      connection.close();
    }
  }

  /**
   * `server.getConfig` read once: the providers a thread can switch to, the commands and skills each
   * offers, the options each model declares, and the policy that caps its threads' permission modes.
   */
  async function readCatalog(projectId: string | undefined): Promise<PanelModelsReply> {
    const cwd = projectId === undefined ? null : options.projectRoot(projectId);
    const config = await withRpc((connection) => connection.request<WireServerConfig>("server.getConfig", {}));

    return { ok: true, providers: trimModels(config, cwd), policy: trimPolicy(config) };
  }

  /** The project's matching files and folders, for the composer's `@` menu. */
  async function readEntries(projectId: string, query: string): Promise<PanelEntriesReply> {
    const cwd = options.projectRoot(projectId);

    if (cwd === null) return refuse("T3 does not list this thread's project here");

    // T3's own search bounds: its composer asks for these and cuts a lone surrogate off the query
    // (apps/web/src/state/queries.ts, useProjectPathSearch).
    const reply = await withRpc((connection) =>
      connection.request<WireSearchReply>("projects.searchEntries", {
        cwd,
        query: query.slice(0, 256).replace(/[\uD800-\uDBFF]$/, ""),
        limit: COMPOSER_SEARCH_LIMIT,
      }),
    );

    const entries: PanelProjectEntry[] = (reply.entries ?? []).flatMap((entry) =>
      entry.path === undefined || entry.path === "" ? [] : [{ path: entry.path, kind: entry.kind ?? "file" }],
    );

    return { ok: true, entries };
  }

  async function command(
    next: PanelThreadCommand,
  ): Promise<
    | PanelReply
    | PanelItemReply
    | PanelAttachmentReply
    | PanelAttachmentUrlReply
    | PanelModelsReply
    | PanelEntriesReply
    | PanelVoiceReply
    | PanelForceStopReply
  > {
    try {
      // The draft composer's commands: the server answers them before any thread exists.
      switch (next.type) {
        // Voice is plain HTTP to the same server, so a reconnecting thread socket does not stop it.
        case "voiceStatus":
          return await voiceStatus(server, options.token);
        case "transcribe":
          // The audio crosses the IPC boundary as an ArrayBuffer; anything else has no samples to send.
          if (!(next.pcm instanceof ArrayBuffer)) return refuse("That recording could not be read");

          return await transcribePcm(server, options.token, next.pcm);
        case "models":
          return await readCatalog(next.projectId);
        case "entries":
          return await readEntries(next.projectId, next.query);
        case "attach": {
          const capability = server.attachmentUploads;

          if (capability === null) return refuse("This T3 server does not accept attachments");

          // The bytes cross the IPC boundary as an ArrayBuffer; anything else is not a file's content.
          if (!(next.data instanceof ArrayBuffer)) return refuse("That file could not be read");

          const mimeType = next.mimeType.toLowerCase().slice(0, 100) || "application/octet-stream";
          const name = next.name.trim().slice(0, 255) || (isImageAttachment(mimeType) ? "image" : "file");
          const data = new Uint8Array(next.data);
          const limit = attachmentLimit(capability.maxUploadBytes, mimeType);

          // Checked here too, not only in the composer: the descriptor's limit is what T3 enforces.
          if (data.byteLength === 0) return refuse("That file is empty");

          if (data.byteLength > limit) return refuse(attachmentTooLargeMessage(name, limit));

          const isImage = isImageAttachment(mimeType);
          const upload: WirePayload = { name, mimeType, sizeBytes: data.byteLength };

          // An image is `createUploadUrl`'s default; a file has to say so.
          if (!isImage) upload.type = "file";

          const minted = await withRpc((connection) => connection.request<WireUploadReply>("attachments.createUploadUrl", upload));

          if (minted.attachmentId === undefined || minted.relativeUrl === undefined) {
            return refuse("T3 did not mint an upload slot");
          }

          const uploaded = await fetch(new URL(minted.relativeUrl, server.origin), {
            method: "POST",
            headers: { "content-type": mimeType },
            body: data,
          });

          if (!uploaded.ok) return refuse(`T3 refused the upload (${uploaded.status})`);

          const attachment: PanelAttachment = {
            id: minted.attachmentId,
            type: isImage ? "image" : "file",
            name,
            mimeType,
            sizeBytes: data.byteLength,
          };

          return { ok: true, attachment };
        }

        case "attachmentUrl": {
          const reply = await withRpc((connection) =>
            connection.request<WireAssetUrlReply>("assets.createUrl", {
              resource: { _tag: "attachment", attachmentId: next.attachmentId },
            }),
          );

          if (reply.relativeUrl === undefined) return refuse("T3 did not return an asset URL");

          // T3's own web client puts this signed URL in an `<img>`; the bearer token never leaves main.
          return { ok: true, url: new URL(reply.relativeUrl, server.origin).toString() };
        }

        case "releaseAttachment":
          // T3 deletes a pending upload when its composer drops it; a sent one is the thread's.
          await withRpc((connection) => connection.command("attachments.delete", { attachmentId: next.attachmentId }));

          return { ok: true };
      }

      const thread = target;

      if (thread === null) return refuse("No thread is open");

      if (rpc === null) return refuse("T3 is not connected");

      switch (next.type) {
        case "send": {
          const text = next.text.trim();
          const attachments = next.attachments;

          if (text === "" && attachments.length === 0) return refuse("Write a message first");

          await dispatch({
            type: "message.dispatch",
            threadId: thread.threadId,
            messageId: randomUUID(),
            text,
            attachments,
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: next.queue ? "queue_after_active" : "start_immediately" },
          });
          // A queued message has no turn-item event until its run starts: re-read so the row shows at once.
          await pushSnapshot();

          return { ok: true };
        }

        case "stop":
          // T3's own Stop (packages/client-runtime/src/operations/commands.ts, stopThread): it ends the
          // thread's turn and its delegated work, and only this path can go unresponsive into Force stop.
          await dispatch({ type: "thread.stop", threadId: thread.threadId });

          return { ok: true };
        case "forceStop": {
          // T3 hides Force stop without this capability, and an older server has no such route.
          if (!server.threadForceStop) return refuse("This T3 server cannot force stop a run");

          const result = await rpc.request<WireForceStopResult>("orchestration.forceStopThread", {
            threadId: thread.threadId,
            runId: next.runId,
          });

          await pushSnapshot();

          return { ok: true, outcome: result.outcome ?? "", sharedWithThreadIds: (result.sharedWithThreadIds ?? []).filter(Boolean) };
        }

        case "cancelQueued":
          await dispatch({ type: "queued-run.cancel", threadId: thread.threadId, runId: next.runId });
          // A cancelled queued run keeps no turn item; re-read so its row leaves at once.
          await pushSnapshot();

          return { ok: true };
        case "subscribeCommandOutput":
          return watchCommandOutput(thread.threadId, next.itemId);
        case "unsubscribeCommandOutput":
          return closeCommandOutput(next.itemId);
        case "editQueued": {
          const edit: Extract<ThreadCommand, { type: "queued-run.edit" }> = {
            type: "queued-run.edit",
            threadId: thread.threadId,
            runId: next.runId,
            text: next.text,
            attachments: next.attachments,
          };

          // The panel does not compose references, so the message's own context rides along unchanged.
          if (next.context !== undefined) edit.context = next.context;

          await dispatch(edit);
          // The message store holds the queued text; re-read so the row shows the new words.
          await pushSnapshot();

          return { ok: true };
        }

        case "setModel": {
          const modelSelection: Extract<ThreadCommand, { type: "thread.model-selection.set" }>["modelSelection"] = {
            instanceId: next.instanceId,
            model: next.model,
          };

          // A traits pick writes the model's own options; a plain model switch leaves them to the model.
          if (next.options !== undefined) modelSelection.options = next.options;

          await dispatch({ type: "thread.model-selection.set", threadId: thread.threadId, modelSelection });
          // The next turn reads the thread's selection: re-read it so the composer shows the new model.
          await pushSnapshot();

          return { ok: true };
        }

        case "setRuntimeMode":
          // T3's own command (packages/client-runtime/src/operations/commands.ts, setThreadRuntimeMode).
          await dispatch({ type: "thread.runtime-mode.set", threadId: thread.threadId, runtimeMode: next.runtimeMode });

          await pushSnapshot();

          return { ok: true };
        case "setInteractionMode":
          await dispatch({
            type: "thread.interaction-mode.set",
            threadId: thread.threadId,
            interactionMode: next.interactionMode,
          });

          await pushSnapshot();

          return { ok: true };
        case "implementPlan": {
          // T3 leaves plan mode for the implementing turn (apps/web/src/hooks/useHandleNewThread.ts,
          // persistThreadSettingsForNextTurn writes the mode before the message).
          if (view?.thread.interactionMode === "plan") {
            await dispatch({ type: "thread.interaction-mode.set", threadId: thread.threadId, interactionMode: "default" });
          }

          await dispatch({
            type: "message.dispatch",
            threadId: thread.threadId,
            messageId: randomUUID(),
            text: PLAN_IMPLEMENTATION_PROMPT,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
            sourcePlanRef: { threadId: thread.threadId, planId: next.planId },
          });
          await pushSnapshot();

          return { ok: true };
        }
        case "respond":
          await dispatch({
            type: "runtime-request.respond",
            threadId: thread.threadId,
            requestId: next.requestId,
            decision: next.decision,
          });
          await pushSnapshot();

          return { ok: true };
        case "answer":
          await dispatch({
            type: "runtime-request.respond",
            threadId: thread.threadId,
            requestId: next.requestId,
            answers: next.answers,
          });
          await pushSnapshot();

          return { ok: true };
        case "turnItem": {
          const result = await rpc.request<WireTurnItemReply>("orchestration.getTurnItem", {
            threadId: thread.threadId,
            itemId: next.itemId,
          });

          const item = trimItem(result.item, true);

          return item === null ? { ok: false, error: "T3 has no such turn item" } : { ok: true, item };
        }
      }
    } catch (error) {
      // A 401 from any request is the same expired session the socket reports (voice routes included):
      // re-mint one instead of only telling the reader it failed.
      if (error instanceof AuthExpiredError) {
        options.onAuthExpired();

        return refuse(error.message);
      }

      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    setTarget,
    command,
    stop() {
      stopSubscription();
      target = null;
      view = null;
    },
  };
}

function sameTarget(a: ThreadRef | null, b: ThreadRef | null): boolean {
  if (a === null || b === null) return a === b;

  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

// ---------------------------------------------------------------- trimming

/** A turn item with only the fields the panel draws, or null when T3 sent no usable item. */
export function trimItem(raw: WireItem | undefined, completeOutput = false): PanelItem | null {
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
      trimmed.planId = raw.planId;
      break;
    case "todo_list":
      trimmed.steps = trimSteps(raw.steps);
      break;
    case "command_execution": {
      // SAFETY: a command_execution's input is the command line T3 received, always a string
      // (OrchestrationV2CommandExecutionTurnItem); the union exists for the dynamic tool branch.
      const command = raw as WireCommandItem;
      trimmed.input = command.input;
      trimmed.output = trimText(command.output, completeOutput);
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
      trimmed.output = trimText(output, completeOutput);
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
      // T3 offers Force stop only on a request whose provider never confirmed Stop.
      trimmed.unresponsiveAt = raw.unresponsiveAt;
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
      trimmed.options = trimApprovalOptions(raw.options);
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
function trimText(text: string | undefined, complete = false): string | undefined {
  if (complete || text === undefined || text.length <= OUTPUT_LIMIT) return text;

  return `${text.slice(0, OUTPUT_LIMIT)}\n…`;
}

function trimSteps(steps: WireTodoStep[] | undefined): PanelTodoStep[] | undefined {
  if (steps === undefined) return undefined;

  return steps.map((step) => ({ id: step.id, text: step.text, status: step.status }));
}

/** Only a well-formed record renders; a nightly's extra attachment kind keeps its common fields. */
function trimAttachments(attachments: WireAttachment[] | undefined): PanelAttachment[] | undefined {
  if (attachments === undefined) return undefined;

  return attachments.flatMap((attachment) =>
    attachment.id === undefined ||
    attachment.type === undefined ||
    attachment.name === undefined ||
    attachment.mimeType === undefined ||
    attachment.sizeBytes === undefined
      ? []
      : [
          {
            id: attachment.id,
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
  );
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

function trimApprovalOptions(options: WireApprovalOption[] | undefined): PanelApprovalOption[] | undefined {
  if (options === undefined) return undefined;

  // A decision without its label has no button; one this build cannot send is T3's to offer.
  return options.flatMap((option) =>
    option.decision === undefined || option.label === undefined || !isApprovalDecision(option.decision)
      ? []
      : [{ decision: option.decision, label: option.label, warning: option.warning }],
  );
}

/** T3's approval decisions (packages/contracts/src/providerPolicy.ts, ProviderApprovalDecision). */
function isApprovalDecision(value: string): value is PanelApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "acceptAlways" || value === "decline" || value === "cancel";
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

/** A thread projection's streaming frame, reduced to what the row draws; an unknown kind reads as more text. */
function trimCommandOutput(raw: WireCommandOutputFrame): PanelCommandOutput {
  return {
    kind: raw.kind === "replace" ? "replace" : "append",
    text: raw.text ?? "",
    truncated: raw.truncated === true,
    running: raw.running === true,
  };
}

/** The thread projection reduced to what the panel draws. The server's speech capability rides along, as its upload one does. */
export function trimView(
  raw: WireProjection | undefined,
  attachmentUploads: PanelAttachmentUploads | null,
  voiceTranscription: boolean,
  threadForceStop: boolean,
  commandOutputStreaming: boolean,
): PanelView | null {
  if (raw === undefined) return null;
  const thread = raw.thread;

  if (thread?.id === undefined || thread.projectId === undefined) return null;

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

    const queuedMessage: PanelQueuedMessage = {
      id: run.userMessageId,
      runId: run.id,
      text: message.text,
      attachments: trimAttachments(message.attachments) ?? [],
      position: run.queuePosition ?? 0,
    };

    // An edit must keep the references T3 Code put on the message, so they travel whole.
    if (message.context !== undefined) queuedMessage.context = message.context;

    return [queuedMessage];
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

  const plans = (raw.plans ?? []).flatMap((plan) => {
    const trimmed = trimPlan(plan);

    return trimmed === null ? [] : [trimmed];
  });

  return {
    thread: {
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title ?? "",
      modelSelection: trimModelSelection(thread.modelSelection),
      runtimeMode: thread.runtimeMode ?? null,
      interactionMode: thread.interactionMode ?? null,
    },
    runs,
    attempts,
    runtimeRequests,
    rows,
    items,
    queued,
    plans,
    attachmentUploads,
    voiceTranscription,
    threadForceStop,
    commandOutputStreaming,
    // This thread is on this PC's server, whose socket takes a model selection from the panel.
    modelTraits: true,
    // Its composer asks this socket for the provider's commands and the project's files, as T3's does.
    composerMenus: true,
    // A plan this thread proposed can be sent back through this socket with T3's plan reference.
    planImplementation: true,
    // Its images are minted through this socket as T3's own web client mints them.
    imagePreviews: true,
  };
}

/** Event payloads are whole entities; the panel folds in only the fields it renders. */
function trimEventPayload(type: string, payload: WireEventPayload | undefined): PanelEventPayload {
  if (payload === undefined) return {};

  if (type === "turn-item.updated") {
    const item = trimItem(payload);

    return item === null ? {} : { item };
  }

  // The plan artifact itself is the payload, so its status (completed once implemented) rides here.
  if (type === "plan.updated") {
    const plan = trimPlan(payload);

    return plan === null ? {} : { plan };
  }

  const trimmed: PanelEventPayload = {};

  if (payload.id !== undefined) trimmed.id = payload.id;

  if (payload.status !== undefined) trimmed.status = payload.status;

  if (payload.kind !== undefined) trimmed.kind = payload.kind;

  if (payload.runId !== undefined) trimmed.runId = payload.runId;

  if (payload.rootNodeId !== undefined) trimmed.rootNodeId = payload.rootNodeId;

  if (payload.responseCapability !== undefined) trimmed.responseCapability = { type: payload.responseCapability.type ?? "" };

  if (payload.title !== undefined) trimmed.title = payload.title;

  const modelSelection = trimModelSelection(payload.modelSelection);

  if (modelSelection !== null) trimmed.modelSelection = modelSelection;

  // T3's own composer switching a thread's permission or plan mode lands here too.
  if (payload.runtimeMode !== undefined) trimmed.runtimeMode = payload.runtimeMode;

  if (payload.interactionMode !== undefined) trimmed.interactionMode = payload.interactionMode;

  return trimmed;
}

/** One plan of a thread, or null when the artifact names no id: a row cannot implement it. */
function trimPlan(raw: WirePlan | undefined): PanelPlan | null {
  if (raw?.id === undefined) return null;

  return { id: raw.id, kind: raw.kind ?? "", status: raw.status ?? "" };
}

/**
 * A thread's model, or null when the nightly names none: the composer then hides its picker.
 * `options` hold the model's own values, e.g. its reasoning effort (packages/contracts/src/model.ts,
 * ProviderOptionSelection); an older server sent one object keyed by option id instead of an array.
 */
export function trimModelSelection(raw: WireModelSelection | null | undefined): PanelModelSelection | null {
  const instanceId = raw?.instanceId ?? raw?.provider;

  if (instanceId === undefined || raw?.model === undefined) return null;

  const selection: PanelModelSelection = { instanceId, model: raw.model };
  const options = trimModelOptions(raw.options);

  if (options !== undefined && options.length > 0) selection.options = options;

  return selection;
}

/** The option values a model selection carries; the legacy object spelling is read as the array it became. */
function trimModelOptions(raw: WireModelSelection["options"]): PanelModelOption[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  const entries: WireOptionSelection[] = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([id, value]) => ({ id, value }));

  // An option without an id, or without a value this build can send, is not one it may write back.
  const options = entries.flatMap((entry) =>
    entry.id === undefined || entry.id === "" || entry.value === undefined ? [] : [{ id: entry.id, value: entry.value }],
  );

  return options.length > 0 ? options : undefined;
}

/**
 * The options a model declares, with the thread's own values on them: the menu draws each list and toggle
 * with the value its model would run (apps/web/src/components/chat/TraitsPicker.tsx, getSelectedTraits;
 * packages/shared/src/model.ts, getProviderOptionDescriptors).
 */
function trimModelOptionDescriptors(raw: WireOptionDescriptor[] | undefined): PanelModelOptionDescriptor[] {
  const descriptors: PanelModelOptionDescriptor[] = [];

  for (const descriptor of raw ?? []) {
    if (descriptor.id === undefined || descriptor.id === "" || descriptor.label === undefined) continue;

    if (descriptor.type === "boolean") {
      const toggle: PanelModelToggleOption = {
        type: "boolean",
        id: descriptor.id,
        label: descriptor.label,
      };

      if (descriptor.description !== undefined) toggle.description = descriptor.description;

      const current = toggleValue(descriptor.currentValue);

      if (current !== undefined) toggle.currentValue = current;

      descriptors.push(toggle);
      continue;
    }

    if (descriptor.type !== "select") continue;

    const select: PanelModelSelectOption = {
      type: "select",
      id: descriptor.id,
      label: descriptor.label,
      options: trimOptionChoices(descriptor.options),
    };

    if (descriptor.description !== undefined) select.description = descriptor.description;

    const current = textValue(descriptor.currentValue);

    if (current !== undefined && current !== "") select.currentValue = current;

    const injected = (descriptor.promptInjectedValues ?? []).filter(Boolean);

    if (injected.length > 0) select.promptInjectedValues = injected;

    if (descriptor.role === "reasoning") select.role = "reasoning";

    descriptors.push(select);
  }

  return descriptors;
}

/** A wire value as text, when it is text: a select's value, which a boolean is not. */
function textValue(value: string | boolean | undefined): string | undefined {
  return value === undefined || value === true || value === false ? undefined : value;
}

/** A wire value as a toggle's, when it is one: a boolean, which a string is not. */
function toggleValue(value: string | boolean | undefined): boolean | undefined {
  return value === true || value === false ? value : undefined;
}

function trimOptionChoices(raw: WireOptionChoice[] | undefined): PanelModelOptionChoice[] {
  return (raw ?? []).flatMap((choice) => {
    if (choice.id === undefined || choice.id === "" || choice.label === undefined) return [];

    const trimmed: PanelModelOptionChoice = { id: choice.id, label: choice.label };

    if (choice.description !== undefined) trimmed.description = choice.description;

    if (choice.isDefault === true) trimmed.isDefault = true;

    return [trimmed];
  });
}

/**
 * The providers a thread can switch to, their models, and the commands and skills their composer offers.
 * T3's picker offers a provider only while it is on and ready, and hides the models the user hid
 * (apps/web/src/providerInstances.ts, apps/web/src/modelSelection.ts); custom models stay selectable, as
 * they do there. A checkout's own scan adds its skills, so `cwd` picks the snapshot T3's composer reads.
 */
export function trimModels(config: WireServerConfig | undefined, cwd: string | null = null): PanelModelProvider[] {
  const preferences = config?.settings?.providerModelPreferences ?? {};

  return (config?.providers ?? []).flatMap((provider) => {
    const instanceId = provider.instanceId;

    if (instanceId === undefined) return [];

    if (provider.enabled !== true || provider.status !== "ready" || provider.availability === "unavailable") return [];

    const hidden = new Set(preferences[instanceId]?.hiddenModels ?? []);

    const models = (provider.models ?? []).flatMap((model) => {
      if (model.slug === undefined || model.name === undefined) return [];

      if (model.isCustom !== true && hidden.has(model.slug)) return [];

      const trimmed: PanelModel = {
        slug: model.slug,
        name: model.name,
        options: trimModelOptionDescriptors(model.capabilities?.optionDescriptors),
      };

      if (model.shortName !== undefined) trimmed.shortName = model.shortName;

      if (model.subProvider !== undefined) trimmed.subProvider = model.subProvider;

      if (model.badge !== undefined) trimmed.badge = model.badge;

      if (model.isLegacy === true) trimmed.isLegacy = true;

      if (model.isDefault === true) trimmed.isDefault = true;

      return [trimmed];
    });

    // A provider with nothing left to pick is no group in the list.
    if (models.length === 0) return [];

    // T3's composer resolves a provider's commands and skills for the thread's checkout, and falls back
    // to the machine-wide lists (packages/client-runtime/src/providerSkills.ts, resolveProviderSkillsForCwd).
    const snapshot = (provider.workspaceSnapshots ?? []).find((candidate) => cwd !== null && candidate.cwd !== undefined && sameProjectRoot(candidate.cwd, cwd));
    const skills = trimProviderSkills(snapshot?.skills ?? provider.skills);

    return [
      {
        instanceId,
        displayName: provider.displayName ?? provider.driver ?? instanceId,
        // T3's own graph: a provider that names no toggle shows none, and one that names no modes takes all.
        showInteractionModeToggle: provider.showInteractionModeToggle !== false,
        supportedRuntimeModes: (provider.supportedRuntimeModes ?? []).filter(Boolean),
        models,
        commands: trimProviderCommands(snapshot?.slashCommands ?? provider.slashCommands, skills),
        skills,
      },
    ];
  });
}

/**
 * The skills T3's slash menu lists: the user-invocable ones, one per name
 * (packages/client-runtime/src/providerSkills.ts, getProviderSkillsForSlashMenu).
 */
function trimProviderSkills(raw: WireSkill[] | undefined): PanelProviderSkill[] {
  const seen = new Set<string>();
  const skills: PanelProviderSkill[] = [];

  for (const skill of raw ?? []) {
    const name = skill.name?.trim() ?? "";

    if (name === "" || skill.enabled === false || skill.userInvocable === false) continue;

    const key = name.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);

    const trimmed: PanelProviderSkill = { name };

    if (skill.displayName !== undefined && skill.displayName.trim() !== "") trimmed.displayName = skill.displayName;

    if (skill.description !== undefined) trimmed.description = skill.description;

    if (skill.shortDescription !== undefined) trimmed.shortDescription = skill.shortDescription;

    if (skill.scope !== undefined && skill.scope.trim() !== "") trimmed.scope = skill.scope;

    skills.push(trimmed);
  }

  return skills;
}

/** A provider's commands, one per name, without the ones a listed skill of that name stands in for. */
function trimProviderCommands(raw: WireSlashCommand[] | undefined, skills: PanelProviderSkill[]): PanelProviderCommand[] {
  const skillNames = new Set(skills.map((skill) => skill.name.toLowerCase()));
  const seen = new Set<string>();

  return (raw ?? []).flatMap((command) => {
    const name = command.name?.trim() ?? "";
    const key = name.toLowerCase();

    if (name === "" || skillNames.has(key) || seen.has(key)) return [];
    seen.add(key);

    const trimmed: PanelProviderCommand = { name };

    if (command.description !== undefined) trimmed.description = command.description;

    if (command.input?.hint !== undefined) trimmed.hint = command.input.hint;

    return [trimmed];
  });
}

/** T3's scratch root and a project's checkout name one folder; only the spelling can differ. */
function sameProjectRoot(left: string, right: string): boolean {
  const trim = (path: string) => path.replace(/[\\/]+$/, "");

  return process.platform === "win32" ? trim(left).toLowerCase() === trim(right).toLowerCase() : trim(left) === trim(right);
}

/** The administrator's cap on permission modes, or null on an unmanaged server. */
export function trimPolicy(config: WireServerConfig | undefined): PanelManagedPolicy | null {
  const policy = config?.managedPolicy;

  if (policy === undefined || policy === null || policy.organization === undefined) return null;

  return { organization: policy.organization, maxRuntimeMode: policy.limits?.maxRuntimeMode ?? null };
}

/**
 * The model a new thread starts on: T3's own default from its settings, else the first model of the first
 * provider it can run, as its web composer resolves one (apps/web/src/providerInstances.ts,
 * resolveProjectDefaultProviderModelSelection). Null when no provider is ready.
 */
export function defaultModelSelection(config: WireServerConfig | undefined): PanelModelSelection | null {
  const configured = trimModelSelection(config?.settings?.defaultModelSelection);

  if (configured !== null) return configured;

  for (const provider of trimModels(config)) {
    const model = provider.models.find((candidate) => candidate.isDefault === true) ?? provider.models[0];

    if (model !== undefined) return { instanceId: provider.instanceId, model: model.slug };
  }

  return null;
}
