import { randomUUID } from "node:crypto";
import type {
  PanelAttempt,
  PanelCommand,
  PanelEventPayload,
  PanelFileChange,
  PanelItem,
  PanelItemRef,
  PanelItemReply,
  PanelMessage,
  PanelQuestion,
  PanelQueuedMessage,
  PanelReply,
  PanelRun,
  PanelRuntimeRequest,
  PanelTodoStep,
  PanelView,
} from "../shared/panel";
import type { ThreadRef } from "../shared/types";
import { AuthExpiredError, commandFrame, connect, type T3Rpc, type ThreadCommand, type WirePayload } from "./rpc";
import type { T3Server } from "./t3";

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
  text?: string;
}

interface WireThread {
  id?: string;
  projectId?: string;
  title?: string;
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
}

interface WireTurnItemReply {
  item?: WireItem;
}

/** The reply shapes this connection asks for: a projection and a turn item. */
type WireReply = WireProjection | WireTurnItemReply;

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
  command(command: PanelCommand): Promise<PanelReply | PanelItemReply>;
  stop(): void;
}

/** Long tool output is fetched per row instead; an event stream must not carry megabytes. */
const OUTPUT_LIMIT = 8000;

/** An event this build cannot fold in re-reads the projection once the burst settles. */
const STALE_DELAY_MS = 500;

export function startPanel(options: PanelOptions): Panel {
  let target: ThreadRef | null = null;
  let rpc: T3Rpc<WireStreamItem, WireReply> | null = null;
  let stopStream: (() => void) | null = null;
  /** The last sequence main forwarded: a resubscribe resumes after it. */
  let lastSequence = 0;
  /** Bumped by every (re)subscribe and by stopping, so a late socket can recognise itself as stale. */
  let generation = 0;
  /** The open thread's trimmed projection: the queued row and the run list the composer reads. */
  let view: PanelView | null = null;
  let staleTimer: NodeJS.Timeout | null = null;

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
    rpc?.close();
    rpc = null;

    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = null;
  }

  async function subscribe(threadId: string) {
    const current = generation + 1;
    generation = current;
    options.onMessage({ kind: "status", status: "connecting" });

    let connection: T3Rpc<WireStreamItem, WireReply>;

    try {
      connection = await connect<WireStreamItem, WireReply>(options.server, options.token);
    } catch (error) {
      if (current !== generation) return;

      if (error instanceof AuthExpiredError) options.onAuthExpired();

      options.onMessage({ kind: "status", status: "ended", reason: error instanceof Error ? error.message : String(error) });

      return;
    }

    if (current !== generation) {
      connection.close();

      return;
    }

    rpc = connection;
    const payload: WirePayload = { threadId, requestCompletionMarker: true };

    if (lastSequence > 0) payload.afterSequence = lastSequence;

    stopStream = connection.stream("orchestration.subscribeThread", payload, {
      onValue: (value) => {
        if (current === generation) onStreamValue(threadId, value);
      },
      onClose: (reason) => {
        if (current !== generation) return;
        connection.close();
        stopStream = null;
        rpc = null;
        console.warn("[panel] thread stream closed:", reason);
        options.onMessage({ kind: "status", status: "ended", reason });
      },
    });
  }

  function onStreamValue(threadId: string, item: WireStreamItem) {
    switch (item.kind) {
      case "snapshot": {
        const next = trimView(item.projection);

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
      const next = trimView(projection);
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

  async function command(next: PanelCommand): Promise<PanelReply | PanelItemReply> {
    const thread = target;

    if (thread === null) return refuse("No thread is open");

    if (next.type !== "send" && rpc === null) return refuse("T3 is not connected");

    try {
      switch (next.type) {
        case "send": {
          const text = next.text.trim();

          if (text === "") return refuse("Write a message first");

          await dispatch({
            type: "message.dispatch",
            threadId: thread.threadId,
            messageId: randomUUID(),
            text,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: next.queue ? "queue_after_active" : "start_immediately" },
          });
          // A queued message has no turn-item event until its run starts: re-read so the row shows at once.
          await pushSnapshot();

          return { ok: true };
        }

        case "stop":
          await dispatch({ type: "run.interrupt", threadId: thread.threadId, runId: next.runId });

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
          if (rpc === null) return refuse("T3 is not connected");

          const result = await rpc.request<WireTurnItemReply>("orchestration.getTurnItem", {
            threadId: thread.threadId,
            itemId: next.itemId,
          });

          const item = trimItem(result.item);

          return item === null ? { ok: false, error: "T3 has no such turn item" } : { ok: true, item };
        }
      }
    } catch (error) {
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

/** One thread projection reduced to what the panel draws. */
export function trimView(raw: WireProjection | undefined): PanelView | null {
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

    return [{ id: run.userMessageId, runId: run.id, text: message.text, position: run.queuePosition ?? 0 }];
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
    thread: { id: thread.id, projectId: thread.projectId, title: thread.title ?? "" },
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

  return trimmed;
}
