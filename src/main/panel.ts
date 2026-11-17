import { randomUUID } from "node:crypto";
import type {
  PanelApprovalDecision,
  PanelApprovalOption,
  PanelAttachment,
  PanelAttachmentReply,
  PanelAttachmentUploads,
  PanelAttempt,
  PanelCommandOutput,
  PanelEventPayload,
  PanelFileChange,
  PanelForceStopReply,
  PanelItem,
  PanelItemRef,
  PanelItemReply,
  PanelMessage,
  PanelMessageContext,
  PanelModel,
  PanelModelProvider,
  PanelModelSelection,
  PanelModelsReply,
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

/** A thread's model (packages/contracts/src/modelSelection.ts); `provider` is the older spelling of `instanceId`. */
interface WireModelSelection {
  instanceId?: string;
  provider?: string;
  model?: string;
}

interface WireThread {
  id?: string;
  projectId?: string;
  title?: string;
  modelSelection?: WireModelSelection;
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
  modelSelection?: WireModelSelection;
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
  models?: WireProviderModel[];
}

/** The slice of `server.getConfig` the composer's model picker and the new-thread draft read (packages/contracts/src/server.ts). */
export interface WireServerConfig {
  providers?: WireProvider[];
  /** T3's own default model, runtime mode and scratch checkout for a new thread. */
  settings?: {
    providerModelPreferences?: Record<string, { hiddenModels?: string[] }>;
    defaultModelSelection?: WireModelSelection | null;
    defaultRuntimeMode?: string;
  };
  scratchWorkspaceRoot?: string;
}

/** `orchestration.forceStopThread`'s answer (packages/contracts/src/orchestrationV2.ts, OrchestrationV2ForceStopThreadResult). */
interface WireForceStopResult {
  outcome?: string;
  sharedWithThreadIds?: string[];
}

/** The reply shapes this connection asks for: a projection, a turn item, an upload slot, the provider catalog and a force stop. */
type WireReply = WireProjection | WireTurnItemReply | WireUploadReply | WireServerConfig | WireForceStopResult;

export interface PanelOptions {
  server: T3Server;
  token: string;
  /** This PC's environment id; a thread from anywhere else is main/remote.ts's to read. */
  environmentId: string;
  onMessage: (message: PanelMessage) => void;
  onAuthExpired: () => void;
}

export interface Panel {
  /** Starts or stops the subscription. The same target twice keeps the live one. */
  setTarget(target: ThreadRef | null): void;
  command(command: PanelThreadCommand): Promise<PanelReply | PanelItemReply | PanelAttachmentReply | PanelModelsReply | PanelVoiceReply | PanelForceStopReply>;
  stop(): void;
}

/** Long tool output is fetched per row instead; an event stream must not carry megabytes. */
const OUTPUT_LIMIT = 8000;

/** An event this build cannot fold in re-reads the projection once the burst settles. */
const STALE_DELAY_MS = 500;

export function startPanel(options: PanelOptions): Panel {
  let target: ThreadRef | null = null;
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
   * One expanded running row's output. T3's hub sends a bounded tail (`replace`) and then appends, and ends
   * the stream itself when the command settles (apps/server/src/orchestration-v2/CommandOutputHub.ts).
   */
  function watchCommandOutput(threadId: string, itemId: string): PanelReply {
    if (rpc === null) return refuse("T3 is not connected");

    // T3's own clients read the same capability; an older server has no such route.
    if (!options.server.commandOutputStreaming) return refuse("This T3 server does not stream command output");

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

    let connection: T3Rpc<WireReply>;

    try {
      connection = await connect<WireReply>(options.server, options.token);
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
          options.server.attachmentUploads,
          options.server.voiceTranscription,
          options.server.threadForceStop,
          options.server.commandOutputStreaming,
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
        options.server.attachmentUploads,
        options.server.voiceTranscription,
        options.server.threadForceStop,
        options.server.commandOutputStreaming,
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

  function refuse(reason: string): PanelReply {
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

    const connection = await connect<WireReply>(options.server, options.token);

    try {
      return await use(connection);
    } finally {
      connection.close();
    }
  }

  async function command(
    next: PanelThreadCommand,
  ): Promise<PanelReply | PanelItemReply | PanelAttachmentReply | PanelModelsReply | PanelVoiceReply | PanelForceStopReply> {
    try {
      // The draft composer's commands: the server answers them before any thread exists.
      switch (next.type) {
        // Voice is plain HTTP to the same server, so a reconnecting thread socket does not stop it.
        case "voiceStatus":
          return await voiceStatus(options.server, options.token);
        case "transcribe":
          // The audio crosses the IPC boundary as an ArrayBuffer; anything else has no samples to send.
          if (!(next.pcm instanceof ArrayBuffer)) return refuse("That recording could not be read");

          return await transcribePcm(options.server, options.token, next.pcm);
        case "models":
          return {
            ok: true,
            providers: trimModels(await withRpc((connection) => connection.request<WireServerConfig>("server.getConfig", {}))),
          };
        case "attach": {
          const capability = options.server.attachmentUploads;

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

          const uploaded = await fetch(new URL(minted.relativeUrl, options.server.origin), {
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
          if (!options.server.threadForceStop) return refuse("This T3 server cannot force stop a run");

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

        case "setModel":
          await dispatch({
            type: "thread.model-selection.set",
            threadId: thread.threadId,
            modelSelection: { instanceId: next.instanceId, model: next.model },
          });
          // The next turn reads the thread's selection: re-read it so the composer shows the new model.
          await pushSnapshot();

          return { ok: true };
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

          const item = trimItem(result.item);

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
function trimText(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= OUTPUT_LIMIT) return text;

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

  return {
    thread: { id: thread.id, projectId: thread.projectId, title: thread.title ?? "", modelSelection: trimModelSelection(thread.modelSelection) },
    runs,
    attempts,
    runtimeRequests,
    rows,
    items,
    queued,
    attachmentUploads,
    voiceTranscription,
    threadForceStop,
    commandOutputStreaming,
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

  const modelSelection = trimModelSelection(payload.modelSelection);

  if (modelSelection !== null) trimmed.modelSelection = modelSelection;

  return trimmed;
}

/** A thread's model, or null when the nightly names none: the composer then hides its picker. */
export function trimModelSelection(raw: WireModelSelection | null | undefined): PanelModelSelection | null {
  const instanceId = raw?.instanceId ?? raw?.provider;

  if (instanceId === undefined || raw?.model === undefined) return null;

  return { instanceId, model: raw.model };
}

/**
 * The providers a thread can switch to and their models. T3's picker offers a provider only while it is
 * on and ready, and hides the models the user hid (apps/web/src/providerInstances.ts,
 * apps/web/src/modelSelection.ts); custom models stay selectable, as they do there.
 */
export function trimModels(config: WireServerConfig | undefined): PanelModelProvider[] {
  const preferences = config?.settings?.providerModelPreferences ?? {};

  return (config?.providers ?? []).flatMap((provider) => {
    const instanceId = provider.instanceId;

    if (instanceId === undefined) return [];

    if (provider.enabled !== true || provider.status !== "ready" || provider.availability === "unavailable") return [];

    const hidden = new Set(preferences[instanceId]?.hiddenModels ?? []);

    const models = (provider.models ?? []).flatMap((model) => {
      if (model.slug === undefined || model.name === undefined) return [];

      if (model.isCustom !== true && hidden.has(model.slug)) return [];

      const trimmed: PanelModel = { slug: model.slug, name: model.name };

      if (model.shortName !== undefined) trimmed.shortName = model.shortName;

      if (model.subProvider !== undefined) trimmed.subProvider = model.subProvider;

      if (model.badge !== undefined) trimmed.badge = model.badge;

      if (model.isLegacy === true) trimmed.isLegacy = true;

      if (model.isDefault === true) trimmed.isDefault = true;

      return [trimmed];
    });

    // A provider with nothing left to pick is no group in the list.
    if (models.length === 0) return [];

    return [{ instanceId, displayName: provider.displayName ?? provider.driver ?? instanceId, models }];
  });
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
