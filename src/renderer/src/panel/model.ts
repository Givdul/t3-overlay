import type {
  PanelApprovalOption,
  PanelAttempt,
  PanelEvent,
  PanelEventPayload,
  PanelItem,
  PanelItemRef,
  PanelMessage,
  PanelQuestion,
  PanelRun,
  PanelRuntimeRequest,
  PanelView,
} from "../../../shared/panel";

// The panel's timeline: a projection main trimmed, plus T3's events folded into it. Ported rules keep
// the row list identical to T3's own timeline (packages/shared/src/orchestrationV2Timeline.ts).

export interface PanelState {
  /** The panel target this state belongs to. A message for another target starts from scratch. */
  targetKey: string;
  /** "live" once T3 said the projection is caught up; "ended" when the stream is gone. */
  status: "connecting" | "live" | "ended";
  /**
   * How many times T3 has said this thread is live: the first, and each reconnect. A live subscription
   * (a running command's output) belongs to one socket, so the rows reopen theirs when this changes.
   */
  connection: number;
  reason: string | null;
  view: PanelView | null;
  /** The last event sequence applied, for dedupe after a resubscribe. */
  sequence: number;
}

/** A message tagged with the target it was drawn for, or a reset to that target's empty state. */
export type PanelAction = { kind: "message"; targetKey: string; message: PanelMessage } | { kind: "reset"; targetKey: string };

export const initialState = (targetKey: string): PanelState => ({
  targetKey,
  status: "connecting",
  connection: 0,
  reason: null,
  view: null,
  sequence: 0,
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
      return {
        ...state,
        status: message.status,
        reason: message.reason ?? null,
        connection: message.status === "live" && state.status !== "live" ? state.connection + 1 : state.connection,
      };
    case "snapshot":
      return { ...state, view: message.view, sequence: message.sequence ?? state.sequence };
    case "event":
      return applyEvent(state, message.event);
    case "commandOutput":
      // A row's live output belongs to the row that asked for it, not to the projection.
      return state;
  }
}

/** Events whose payload never changes a row the panel draws. */
const IGNORED_EVENTS = new Set([
  "message.updated",
  "node.updated",
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
    case "plan.updated": {
      const plan = event.payload.plan;

      if (plan === undefined) return next;

      const plans = upsertBy(view.plans, plan, (candidate) => candidate.id === plan.id);

      return { ...next, view: { ...view, plans } };
    }
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

      // An event shape this build does not know: main re-reads the projection and pushes it back.
      return IGNORED_EVENTS.has(event.type) ? next : state;
  }
}

function applyTurnItem(state: PanelState, view: PanelView, item: PanelItem): PanelState {
  const ref = toRef(item);
  const items = upsertBy(view.items, ref, (candidate) => candidate.id === ref.id);
  const visible = isVisible(ref, view.runs, view.attempts, items);
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
    const other = next[candidate]!.item;

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
  // A queued message becomes a turn item when its run starts; until then it is drawn from the queue.
  const queued = run.status === "queued" ? view.queued : view.queued.filter((message) => message.runId !== run.id);

  return { ...state, view: { ...view, runs, queued, rows: refilterRows(view, runs, view.attempts, view.items) } };
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
  let thread = view.thread;

  if (payload.title !== undefined) thread = { ...thread, title: payload.title };

  // T3 changing the thread's model from its own composer lands here too.
  if (payload.modelSelection !== undefined) thread = { ...thread, modelSelection: payload.modelSelection };

  // So do its permission mode and plan mode, which T3's own composer can change on this thread.
  if (payload.runtimeMode !== undefined) thread = { ...thread, runtimeMode: payload.runtimeMode };

  if (payload.interactionMode !== undefined) thread = { ...thread, interactionMode: payload.interactionMode };

  return thread === view.thread ? state : { ...state, view: { ...view, thread } };
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

/** The run the composer's Stop and queue attach to. A queued follow-up never ran, so it is no active run. */
export function activeRun(view: PanelView | null): PanelRun | null {
  const running: readonly string[] = ["preparing", "starting", "running", "waiting"];

  return view?.runs.findLast((run) => running.includes(run.status)) ?? null;
}

export interface PendingRequests {
  approvals: (PanelRuntimeRequest & {
    prompt: string | null;
    reason: string | null;
    /** The decisions T3's own card offers for this request; empty when the item named none. */
    options: PanelApprovalOption[];
  })[];
  questions: (PanelRuntimeRequest & { questions: PanelQuestion[] })[];
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
      questions.push({ ...request, questions: Array.isArray(item.questions) ? item.questions : [] });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = findLast(view, (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id);
    approvals.push({
      ...request,
      prompt: item?.prompt ?? null,
      reason: item?.reason ?? null,
      options: item?.options ?? [],
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

/**
 * Why a queued message cannot be opened in the composer now, or null when it can
 * (packages/client-runtime/src/queuedRunEdit.ts, queuedRunEditBlockedReason): an open question takes the
 * composer over, so an edit begun then would happen out of sight and could be sent before it is seen.
 */
export function queuedRunEditBlockedReason(pending: PendingRequests): string | null {
  return pending.questions.length > 0 ? "Answer the question to edit queued messages" : null;
}

/** A Stop the provider has not finished yet (packages/client-runtime/src/state/threadExecution.ts, presentRunStop). */
export interface RunStop {
  runId: string;
  /** `unresponsive`: the provider did not confirm the stop in time, so T3 offers Force stop. */
  state: "stopping" | "unresponsive";
  /** When the stop was asked for, for T3's elapsed-time label. */
  requestedAt: string | null;
}

/**
 * The stop T3 draws under the timeline, ported: the latest run's last stop request, unless a result
 * already answered it. A request that named no time to become unresponsive only counts on a live run.
 */
export function presentRunStop(view: PanelView | null): RunStop | null {
  if (view === null) return null;

  const active = activeRun(view);
  // Queued follow-ups never ran, so they hold no Stop of their own.
  const latest = view.runs.findLast((run) => run.status !== "queued") ?? null;
  const run = active ?? latest;

  if (run === null) return null;

  let request: PanelItem | undefined;

  for (const row of view.rows) {
    const item = row.item;

    if (item.runId !== run.id) continue;
    // A provider that stopped late already wrote the result; it needs no banner.

    if (item.type === "run_interrupt_result") return null;

    if (item.type === "run_interrupt_request") request = item;
  }

  if (request === undefined || (active === null && request.unresponsiveAt === undefined)) return null;

  return {
    runId: run.id,
    state: request.unresponsiveAt === undefined ? "stopping" : "unresponsive",
    requestedAt: request.startedAt ?? null,
  };
}

/**
 * What T3 says after a force stop (apps/web/src/components/chat/useForceStopThread.ts). `killed` and
 * `released` end the turn with nothing to explain, so they get T3's own "Turn stopped".
 */
export function forceStopNotice(outcome: string, sharedWithThreadIds: string[]): string {
  if (outcome === "releasing") return "Turn stopped; the agent is still shutting down";

  if (outcome === "shared") {
    const others = sharedWithThreadIds.length === 0 ? "other" : String(sharedWithThreadIds.length);
    const threads = sharedWithThreadIds.length === 1 ? "thread" : "threads";

    return `Turn stopped; the agent process kept running. It is shared with ${others} working ${threads}. Stop those to free it.`;
  }

  return "Turn stopped";
}
