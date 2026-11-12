import type {
  PanelAttachment,
  PanelAttempt,
  PanelCommand,
  PanelEventPayload,
  PanelFileChange,
  PanelItem,
  PanelItemRef,
  PanelItemReply,
  PanelMessage,
  PanelModelSelection,
  PanelPathsReply,
  PanelQuestion,
  PanelReply,
  PanelRun,
  PanelRuntimeRequest,
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

interface WireQuestion {
  id?: string;
  question?: string;
  header?: string;
  options?: { label?: string }[];
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

/** The reply shapes this connection asks for: the projection and a single turn item. */
type WireReply = WireProjection | WireTurnItemReply;

export interface PanelOptions {
  server: T3Server;
  token: string;
  /** The local environment's id; a thread from anywhere else is "remote". */
  environmentId: string;
  onMessage: (message: PanelMessage) => void;
  onAuthExpired: () => void;
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

  function setTarget(next: PanelTarget | null) {
    if (sameTarget(next, target)) return;
    target = next;
    stopSubscription();
    lastSequence = 0;

    if (next === null || next === "draft") return;

    if (next.environmentId !== options.environmentId) {
      options.onMessage({ kind: "remote" });

      return;
    }

    void subscribe(next.threadId, null);
  }

  function stopSubscription() {
    generation += 1;
    stopStream?.();
    stopStream = null;
    rpc?.close();
    rpc = null;
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

  function onStreamValue(threadId: string, item: WireStreamItem) {
    switch (item.kind) {
      case "snapshot": {
        const view = trimView(item.projection, projects);

        if (view === null) return;
        lastSequence = item.snapshotSequence ?? 0;
        options.onMessage({ kind: "snapshot", threadId, view, sequence: lastSequence });

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

  async function command(next: PanelCommand): Promise<PanelReply | PanelItemReply | PanelPathsReply> {
    if (next.type === "turnItem") {
      if (rpc === null || target === null || target === "draft") return { ok: false, error: "Not connected to T3" };

      try {
        const result = await rpc.request<WireTurnItemReply>("orchestration.getTurnItem", {
          threadId: target.threadId,
          itemId: next.itemId,
        });

        const item = trimItem(result.item);

        return item === null ? { ok: false, error: "T3 has no such turn item" } : { ok: true, item };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    if (next.type === "reload") {
      if (rpc === null || target === null || target === "draft") return { ok: false, error: "Not connected to T3" };

      try {
        const projection = await rpc.request<WireProjection>("orchestration.getThreadProjection", { threadId: target.threadId });
        const view = trimView(projection, projects);

        if (view === null) return { ok: false, error: "T3 sent no projection" };
        // A fresh read keeps its own sequence numbering: `null` leaves the renderer's dedupe alone.
        options.onMessage({ kind: "snapshot", threadId: target.threadId, view, sequence: null });

        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // Sending (step 5) and the pickers (step 6) land on this same command channel.
    return { ok: false, error: "Sending lands in the next step" };
  }

  return {
    setTarget,
    setProjects(next) {
      projects = next;
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
    },
  };
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
    options: question.options?.map((option) => ({ label: option.label })),
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
