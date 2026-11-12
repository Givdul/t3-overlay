import type {
  PanelAttempt,
  PanelEvent,
  PanelEventPayload,
  PanelItem,
  PanelItemRef,
  PanelMessage,
  PanelQuestion,
  PanelRun,
  PanelRuntimeRequest,
  PanelThread,
  PanelView,
} from "../../../shared/panel";

// The panel's timeline: a projection main trimmed, plus T3's events folded into it. Ported rules keep
// the row list identical to T3's own timeline (packages/shared/src/orchestrationV2Timeline.ts).

export interface PanelState {
  /** The panel target this state belongs to. A message for another target starts from scratch. */
  targetKey: string;
  /** "live" once T3 said the projection is caught up; "ended" when the stream is gone for good. */
  status: "connecting" | "live" | "offline" | "ended";
  reason: string | null;
  view: PanelView | null;
  /** The last event sequence applied, for dedupe after a resubscribe. */
  sequence: number;
  /** An event this build does not understand arrived: main should re-read the projection. */
  stale: boolean;
  /** The thread lives on another machine, which this client cannot reach. */
  remote: boolean;
}

/** A message tagged with the target it was drawn for, or a reset to that target's empty state. */
export type PanelAction = { kind: "message"; targetKey: string; message: PanelMessage } | { kind: "reset"; targetKey: string };

export const initialState = (targetKey: string): PanelState => ({
  targetKey,
  status: "connecting",
  reason: null,
  view: null,
  sequence: 0,
  stale: false,
  remote: false,
});

/**
 * Main sends a target's first message right after `overlay:open`, before React has re-rendered, so a
 * reset effect would wipe it. Every action names its target instead: the first one for a new target
 * starts from the empty state and then applies, in that order.
 */
export function applyPanelMessage(state: PanelState, action: PanelAction): PanelState {
  const base = state.targetKey === action.targetKey ? state : initialState(action.targetKey);

  return action.kind === "reset" ? base : applyMessage(base, action.message);
}

function applyMessage(state: PanelState, message: PanelMessage): PanelState {
  switch (message.kind) {
    case "status":
      return { ...state, status: message.status, reason: message.reason ?? null, remote: false };
    case "remote":
      return { ...state, remote: true, view: null, status: "offline", reason: "The thread is on another machine" };
    case "snapshot":
      return {
        ...state,
        view: message.view,
        sequence: message.sequence ?? state.sequence,
        stale: false,
        remote: false,
      };
    case "event":
      return applyEvent(state, message.event);
    case "stale":
      return { ...state, stale: true };
  }
}

/** Events whose payload never changes a row the panel draws. */
const IGNORED_EVENTS = new Set([
  "message.updated",
  "node.updated",
  "plan.updated",
  "provider-turn.updated",
  "provider-thread.updated",
  "provider-session.attached",
  "provider-session.updated",
  "provider-session.detached",
  "subagent.updated",
  "checkpoint-scope.created",
  "checkpoint.captured",
  "checkpoint.rollback-requested",
  "context-handoff.updated",
  "context-transfer.created",
  "context-transfer.updated",
]);

function applyEvent(state: PanelState, event: PanelEvent): PanelState {
  const view = state.view;

  if (view === null || event.sequence <= state.sequence) return state;
  const next = { ...state, sequence: event.sequence };

  switch (event.type) {
    case "turn-item.updated": {
      const item = event.payload.item;

      return item === undefined ? next : applyTurnItem(next, view, item);
    }

    case "run.created":
    case "run.updated":
      return applyRun(next, view, event.payload);
    case "run-attempt.created":
    case "run-attempt.updated":
      return applyAttempt(next, view, event.payload);
    case "runtime-request.updated":
      return applyRuntimeRequest(next, view, event.payload);
    case "message.updated":
      // Assistant text arrives on the turn item; the message store is not rendered.
      return next;
    default:
      if (event.type.startsWith("thread.")) return applyThread(next, view, event.payload);

      // An event shape this build does not know: keep what we have and ask for a fresh projection.
      return { ...next, stale: true };
  }
}

function applyTurnItem(state: PanelState, view: PanelView, item: PanelItem): PanelState {
  const ref = toRef(item);
  const items = upsertBy(view.items, ref, (candidate) => candidate.id === ref.id);
  const runs = view.runs;
  const attempts = view.attempts;
  const visible = isVisible(ref, runs, attempts, items);
  const rows = visible ? upsertRow(view.rows, item, ref) : view.rows.filter((row) => row.sourceItemId !== item.id);

  return { ...state, view: { ...view, items, rows } };
}

/** Rows in T3's order: before the first later item, by ordinal then id. */
function upsertRow(rows: PanelView["rows"], item: PanelItem, ref: PanelItemRef): PanelView["rows"] {
  const next = [...rows];
  const index = next.findIndex((row) => row.sourceItemId === item.id);

  if (index !== -1) {
    next[index] = { ...next[index]!, item };

    return renumber(next);
  }

  let insertion = next.length;

  for (let candidate = 0; candidate < next.length; candidate += 1) {
    const row = next[candidate]!;
    const other = row.item;

    if (other.ordinal > ref.ordinal || (other.ordinal === ref.ordinal && other.id.localeCompare(ref.id) > 0)) {
      insertion = candidate;
      break;
    }
  }

  next.splice(insertion, 0, { position: insertion, sourceItemId: item.id, item });

  return renumber(next);
}

function renumber(rows: PanelView["rows"]): PanelView["rows"] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function applyRun(state: PanelState, view: PanelView, payload: PanelEventPayload): PanelState {
  if (payload.id === undefined) return state;
  const run: PanelRun = { id: payload.id, status: payload.status ?? "" };
  const runs = upsertBy(view.runs, run, (candidate) => candidate.id === run.id);

  return { ...state, view: { ...view, runs, rows: refilterRows(view, runs, view.attempts, view.items) } };
}

function applyAttempt(state: PanelState, view: PanelView, payload: PanelEventPayload): PanelState {
  if (payload.runId === undefined || payload.runId === null || payload.rootNodeId === undefined) return state;
  const attempt: PanelAttempt = { runId: payload.runId, rootNodeId: payload.rootNodeId, status: payload.status ?? "" };

  const attempts = upsertBy(
    view.attempts,
    attempt,
    (candidate) => candidate.runId === attempt.runId && candidate.rootNodeId === attempt.rootNodeId,
  );

  return { ...state, view: { ...view, attempts, rows: refilterRows(view, view.runs, attempts, view.items) } };
}

function applyRuntimeRequest(state: PanelState, view: PanelView, payload: PanelEventPayload): PanelState {
  if (payload.id === undefined) return state;

  const request: PanelRuntimeRequest = {
    id: payload.id,
    kind: payload.kind ?? "",
    status: payload.status ?? "",
    responseCapability: { type: payload.responseCapability?.type ?? "" },
  };

  const runtimeRequests = upsertBy(view.runtimeRequests, request, (candidate) => candidate.id === request.id);

  return { ...state, view: { ...view, runtimeRequests } };
}

function applyThread(state: PanelState, view: PanelView, payload: PanelEventPayload): PanelState {
  const thread: PanelThread = { ...view.thread };

  if (payload.title !== undefined) thread.title = payload.title;

  if (payload.runtimeMode !== undefined) thread.runtimeMode = payload.runtimeMode;

  if (payload.interactionMode !== undefined) thread.interactionMode = payload.interactionMode;

  if (payload.modelSelection !== undefined) thread.modelSelection = payload.modelSelection;

  return { ...state, view: { ...view, thread } };
}

function refilterRows(view: PanelView, runs: PanelRun[], attempts: PanelAttempt[], items: PanelItemRef[]): PanelView["rows"] {
  const rows = view.rows.filter((row) => isVisible(toRef(row.item), runs, attempts, items));

  return rows.length === view.rows.length ? view.rows : renumber(rows);
}

function upsertBy<T>(list: T[], value: T, matches: (candidate: T) => boolean): T[] {
  const index = list.findIndex(matches);

  if (index === -1) return [...list, value];

  const next = [...list];
  next[index] = value;

  return next;
}

export function toRef(item: PanelItem | PanelItemRef): PanelItemRef {
  const ref: PanelItemRef = {
    id: item.id,
    type: item.type,
    runId: item.runId,
    nodeId: item.nodeId,
    ordinal: item.ordinal,
  };

  if (item.inputIntent !== undefined) ref.inputIntent = item.inputIntent;

  return ref;
}

/** T3's visibility rule, ported from packages/shared/src/orchestrationV2Timeline.ts. */
export function isVisible(
  item: PanelItemRef,
  runs: readonly PanelRun[],
  attempts: readonly PanelAttempt[],
  items: readonly PanelItemRef[],
): boolean {
  if (item.runId !== null && runs.some((run) => run.id === item.runId && run.status === "rolled_back")) return false;

  // Cancelled queued input never reached the provider and stays out of the transcript.
  if (
    item.type === "user_message" &&
    item.inputIntent === "queued_turn" &&
    item.runId !== null &&
    runs.some((run) => run.id === item.runId && run.status === "cancelled")
  ) {
    return false;
  }

  if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) return true;

  const superseded = attempts.some(
    (attempt) => attempt.runId === item.runId && attempt.rootNodeId === item.nodeId && attempt.status === "superseded",
  );

  if (!superseded) return true;

  // Show paired stop-then-steer results; hide legacy plain-steer results without a matching request.
  return items.some((candidate) => candidate.type === "run_interrupt_request" && candidate.runId === item.runId);
}

export function activeRun(view: PanelView | null): PanelRun | null {
  const running: readonly string[] = ["preparing", "queued", "starting", "running", "waiting"];

  return view?.runs.findLast((run) => running.includes(run.status)) ?? null;
}

export interface PendingRequests {
  approvals: (PanelRuntimeRequest & { prompt: string | null; reason: string | null })[];
  questions: (PanelRuntimeRequest & { questions: PanelQuestion[]; dismissible: boolean })[];
}

/** Runtime requests waiting on the user, joined with the turn items that carry their details. */
export function pendingRequests(view: PanelView | null): PendingRequests {
  const approvals: PendingRequests["approvals"] = [];
  const questions: PendingRequests["questions"] = [];

  if (view === null) return { approvals, questions };

  for (const request of view.runtimeRequests) {
    if (request.status !== "pending") continue;

    if (request.kind === "user_input") {
      const item = findLast(view, (candidate) => candidate.type === "user_input_request" && candidate.requestId === request.id);

      if (item === undefined) continue;
      questions.push({
        ...request,
        questions: Array.isArray(item.questions) ? item.questions : [],
        dismissible: item.responseMode === "message" || request.responseCapability.type === "message",
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = findLast(view, (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id);
    approvals.push({
      ...request,
      prompt: item?.prompt ?? null,
      reason: item?.reason ?? null,
    });
  }

  return { approvals, questions };
}

function findLast(view: PanelView, matches: (item: PanelItem) => boolean): PanelItem | undefined {
  for (let index = view.rows.length - 1; index >= 0; index -= 1) {
    const item = view.rows[index]!.item;

    if (matches(item)) return item;
  }

  return undefined;
}

export function needsReply(view: PanelView | null): boolean {
  const pending = pendingRequests(view);

  return pending.approvals.length > 0 || pending.questions.length > 0;
}
