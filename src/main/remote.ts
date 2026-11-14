import type {
  PanelCommand,
  PanelItem,
  PanelItemRef,
  PanelItemReply,
  PanelMessage,
  PanelQuestion,
  PanelReply,
  PanelRow,
  PanelRun,
  PanelRuntimeRequest,
  PanelThread,
  PanelView,
} from "../shared/panel";
import type { Machine, SidebarThread, ThreadRef, ThreadState } from "../shared/types";
import { McpAuthExpiredError, McpToolError, openMcp, type ToolArguments } from "./mcp";
import { trimItem } from "./panel";
import { projectIcon, sortSidebar } from "./shell";
import type { T3Server } from "./t3";

// The user's other machines, reached through this PC's T3 server: T3 reaches a linked machine over its
// peer link, and the overlay reaches T3's /mcp endpoint with the session made for it. Reads are a remote
// thread's history, its list row and its state; writes are the actions /mcp can take, routed by
// environmentId. An approval has no /mcp call, so its card hands the thread to T3.
//
// Wire types below are the slices of the tools' results this client reads
// (packages/contracts/src/orchestratorMcp.ts, project.ts). Only the fields the sidebar and the panel
// draw are typed, so a nightly's new field arrives as absent rather than as a type error.

interface WireLink {
  environmentId: string;
  label: string;
  status: string;
}

interface WireLinks {
  links: WireLink[];
}

interface WireThread {
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  settled: boolean;
  snoozed: boolean;
  updatedAt: string;
  relationshipToParent: string | null;
}

interface WireThreadList {
  threads: WireThread[];
}

interface WireProject {
  id: string;
  title: string;
  workspaceRoot: string;
  faviconPath?: string | null;
  projectIcon?: { kind: string; name?: string; color?: string; text?: string; emoji?: string } | null;
}

interface WireProjectList {
  projects: WireProject[];
}

interface WireDetail {
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  activeRunId: string | null;
  pendingRequestCount: number;
}

interface WireRun {
  runId: string;
  status: string;
}

interface WireItem {
  position: number;
  itemId: string;
  type: string;
  status: string;
  title: string | null;
  text: string | null;
  textTruncated: boolean;
  runId: string | null;
  subagentId?: string;
}

interface WireHistory {
  thread: WireDetail;
  recentRuns: WireRun[];
  items: WireItem[];
  nextPosition: number | null;
  hasMore: boolean;
}

interface WirePendingList {
  requestIds: string[];
}

interface WireQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value?: string }[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  initialAnswer?: string;
}

interface WirePendingRead {
  requestId: string;
  questions: WireQuestion[];
}

/** T3 has no push for another machine: its lists and the open thread are read on a timer. */
const IDLE_MS = 20_000;

/** While the open remote thread has an active run, its reply streams into the panel. */
const ACTIVE_MS = 2_000;

/** T3's largest page, for a thread read and for the sidebar's thread list. */
const MAX_LIMIT = 100;

/** T3's largest `maxCharsPerItem`, so a long message arrives whole. */
const MAX_CHARS = 50_000;

/** A long thread is paged from the start once; rows past this many pages are left out. */
const MAX_PAGES = 10;

/** Every links read probes each machine, so it is not asked on every poll. */
const LINK_REFRESH_MS = 60_000;

const WORKING = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export interface RemoteOptions {
  server: T3Server;
  /** The MCP session this machine minted for `/mcp`; it reaches no other URL. */
  token: string;
  /** Every linked machine, reachable or not, for the logo tooltip's note. */
  onMachines: (machines: Machine[]) => void;
  /** The other machines' thread rows; this PC's own rows come from the shell stream. */
  onThreads: (threads: SidebarThread[]) => void;
  /** The open remote thread: its history, and whether T3 could read it. */
  onPanel: (message: PanelMessage) => void;
  onAuthExpired: () => void;
}

export interface Remote {
  /** The new panel target. A remote thread is read and polled; another target stops that. */
  setTarget(target: ThreadRef | null): void;
  /** Polling pauses while the overlay is hidden, and resumes when it shows. */
  setVisible(visible: boolean): void;
  /** A composer or request-card action on the open remote thread, through `/mcp`. */
  command(command: PanelCommand): Promise<PanelReply | PanelItemReply>;
  /** Settle or snooze a remote thread from its sidebar menu. */
  organize(thread: ThreadRef, action: "settle" | "snooze", snoozedUntil?: string): Promise<void>;
  stop(): void;
}

/** The open remote thread: its last read, folded over the pages read before it. */
interface OpenThread {
  target: ThreadRef;
  thread: PanelThread;
  runs: PanelRun[];
  rows: PanelRow[];
  /** The last row T3 has sent: the next page starts after it. */
  lastPosition: number;
  /** Whether the first pages have been read; before that a read starts from position 0. */
  loaded: boolean;
  activeRunId: string | null;
  pendingRequestCount: number;
  /** The questions `t3_pending_request` lists for this thread, in its order. */
  questions: WirePendingRead[];
  /** Whether the thread also waits on an approval, which no `/mcp` call can answer. */
  approval: boolean;
}

export function startRemote(options: RemoteOptions): Remote {
  const mcp = openMcp(options.server, options.token);
  const projects = new Map<string, Map<string, WireProject>>();
  const machines = new Map<string, Machine>();
  let open: OpenThread | null = null;
  let visible = true;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let linksAt = 0;
  let published = "";

  function schedule(delayMs: number) {
    if (stopped || !visible) return;

    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void poll(), delayMs);
  }

  async function poll() {
    timer = null;

    if (stopped || !visible) return;

    if (running) {
      // A read outlived its interval: look again shortly rather than stacking another one on it.
      schedule(ACTIVE_MS);

      return;
    }

    running = true;
    let active = false;

    try {
      await readLinks();
      await readThreads();
      active = await readOpenThread();
    } catch (error) {
      if (error instanceof McpAuthExpiredError) {
        if (!stopped) options.onAuthExpired();
      } else {
        console.warn("[remote] poll failed", error);
        linksAt = 0;
      }
    } finally {
      running = false;
    }

    schedule(active ? ACTIVE_MS : IDLE_MS);
  }

  /** Every links read probes each machine, so it runs on start, after a failure and once a minute. */
  async function readLinks() {
    if (Date.now() - linksAt < LINK_REFRESH_MS) return;

    linksAt = Date.now();
    const result = await mcp.callTool<WireLinks>("t3_environment_links");
    // The endpoint's own machine is not one of "the other machines", and its rows come from /ws.
    const linked = result.links.filter((link) => link.environmentId !== options.server.environmentId);

    const changed =
      linked.length !== machines.size ||
      linked.some((link) => {
        const machine = machines.get(link.environmentId);

        return machine === undefined || machine.label !== link.label || machine.reachable !== (link.status === "reachable");
      });

    machines.clear();

    for (const link of linked) {
      machines.set(link.environmentId, { environmentId: link.environmentId, label: link.label, reachable: link.status === "reachable" });
    }

    if (changed) options.onMachines([...machines.values()]);
  }

  async function readThreads() {
    const next: SidebarThread[] = [];
    let failed = false;

    for (const machine of machines.values()) {
      if (!machine.reachable) continue;

      try {
        next.push(...(await listThreads(machine)));
      } catch (error) {
        if (error instanceof McpAuthExpiredError) throw error;
        // The link answered a moment ago; the next links read decides whether it still does.
        failed = true;

        console.warn(`[remote] listing ${machine.label} failed`, error);
      }
    }

    if (failed) linksAt = 0;
    publish(sortSidebar(next));
  }

  /** The rows of one machine, filtered as T3's own sidebar filters them. */
  async function listThreads(machine: Machine): Promise<SidebarThread[]> {
    const projects = await projectsOf(machine.environmentId);

    const result = await mcp.callTool<WireThreadList>("t3_thread_list", {
      environmentId: machine.environmentId,
      allProjects: true,
      includeSubagents: false,
      limit: MAX_LIMIT,
    });

    return result.threads.flatMap((thread) => {
      if (thread.relationshipToParent === "subagent") return [];

      const state = stateOf(thread);

      // T3's sidebar keeps what still wants attention; a closed remote thread carries no pin order
      // and no icon of its own here, so it has nothing left to show.
      if (state !== "working" && (thread.settled || thread.snoozed || state === "idle")) return [];

      const project = projects.get(thread.projectId);

      return [
        {
          environmentId: machine.environmentId,
          threadId: thread.threadId,
          title: thread.title,
          projectId: thread.projectId,
          projectName: project?.title ?? "",
          icon: projectIcon(project, undefined),
          environmentLabel: machine.label,
          state,
          pinned: false,
          pinOrder: null,
          updatedAt: thread.updatedAt,
        },
      ];
    });
  }

  /** A remote thread's state, from its run status and, for the open one, its pending requests. */
  function stateOf(thread: WireThread): ThreadState {
    // Which request is waiting is only known for the open thread: its pending read tells a question
    // from an approval, while a closed one shows the attention badge without the distinction.
    if (open !== null && open.target.threadId === thread.threadId && open.pendingRequestCount > 0) {
      return open.approval ? "approval" : "input";
    }

    return runState(thread.status);
  }

  async function projectsOf(environmentId: string): Promise<Map<string, WireProject>> {
    const cached = projects.get(environmentId);

    if (cached !== undefined) return cached;

    // Projects change rarely, so one read serves every poll: a new project's icon arrives on restart.
    const result = await mcp.callTool<WireProjectList>("t3_project_list", { environmentId, limit: MAX_LIMIT });
    const listed = new Map(result.projects.map((project) => [project.id, project]));

    projects.set(environmentId, listed);

    return listed;
  }

  /** Reads the open thread and pushes it to the panel. Returns whether its run is still going. */
  async function readOpenThread(): Promise<boolean> {
    const current = open;

    if (current === null) return false;

    try {
      if (current.loaded) await refreshTail(current);
      else await loadPages(current);

      if (open !== current) return false;
      await readPending(current);

      if (open !== current) return false;

      options.onPanel({ kind: "snapshot", threadId: current.target.threadId, view: viewOf(current), sequence: null });
      options.onPanel({ kind: "status", status: "live" });

      return current.activeRunId !== null;
    } catch (error) {
      if (error instanceof McpAuthExpiredError) {
        if (!stopped) options.onAuthExpired();

        return false;
      }

      console.warn("[remote] reading the open thread failed", error);
      linksAt = 0;

      // The panel keeps the history it has; an empty one says why it is empty.
      if (!current.loaded) options.onPanel({ kind: "status", status: "ended", reason: error instanceof Error ? error.message : String(error) });

      return false;
    }
  }

  function read(thread: OpenThread, afterPosition: number | null): Promise<WireHistory> {
    const args: ToolArguments = {
      environmentId: thread.target.environmentId,
      threadId: thread.target.threadId,
      view: "messages",
      limit: MAX_LIMIT,
      runLimit: 50,
      maxCharsPerItem: MAX_CHARS,
    };

    if (afterPosition !== null) args.afterPosition = afterPosition;

    return mcp.callTool<WireHistory>("t3_thread_read", args);
  }

  /**
   * T3 lists only questions, never approvals, so a count above the listed questions is an approval.
   * A listed question can be answered between the list and the read; that one is skipped.
   */
  async function readPending(current: OpenThread) {
    const listed =
      current.pendingRequestCount > 0
        ? await mcp.callTool<WirePendingList>("t3_pending_request", {
            environmentId: current.target.environmentId,
            threadId: current.target.threadId,
            action: "list",
          })
        : { requestIds: [] };

    const questions: WirePendingRead[] = [];

    for (const requestId of listed.requestIds) {
      try {
        questions.push(
          await mcp.callTool<WirePendingRead>("t3_pending_request", {
            environmentId: current.target.environmentId,
            threadId: current.target.threadId,
            action: "read",
            requestId,
          }),
        );
      } catch (error) {
        if (error instanceof McpAuthExpiredError) throw error;

        console.warn(`[remote] reading request ${requestId} failed`, error);
      }
    }

    if (open !== current) return;

    current.questions = questions;
    current.approval = current.pendingRequestCount > listed.requestIds.length;
  }

  /** The first read pages from the start, so the panel shows the thread's whole history. */
  async function loadPages(current: OpenThread) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await read(current, page === 0 ? null : current.lastPosition);

      if (open !== current) return;
      absorb(current, result);

      if (!result.hasMore || result.nextPosition === null) break;
    }

    current.loaded = true;
  }

  /** A later read re-reads the tail: a row already in the panel changes while its run streams. */
  async function refreshTail(current: OpenThread) {
    // Short enough to fit one page: re-read it whole, so the first row is in it too. T3's
    // `afterPosition` is a position, never negative.
    const start = current.lastPosition - (MAX_LIMIT - 1);
    const result = await read(current, start > 0 ? start : null);

    if (open !== current) return;
    absorb(current, result);
  }

  function absorb(current: OpenThread, result: WireHistory) {
    const detail = result.thread;

    current.thread = { id: detail.threadId, projectId: detail.projectId, title: detail.title };
    current.runs = result.recentRuns.map((run) => ({ id: run.runId, status: run.status }));
    current.activeRunId = detail.activeRunId;
    current.pendingRequestCount = detail.pendingRequestCount;

    const rows = new Map(current.rows.map((row) => [row.sourceItemId, row]));

    for (const raw of result.items) {
      const row = rowOf(raw);

      if (row !== null) rows.set(row.sourceItemId, row);
    }

    current.rows = [...rows.values()].sort((left, right) => left.position - right.position);
    current.lastPosition = Math.max(current.lastPosition, result.nextPosition ?? current.lastPosition);
  }

  function publish(next: SidebarThread[]) {
    const key = JSON.stringify(next);

    // A poll that found nothing new must not redraw the sidebar.
    if (key === published) return;
    published = key;
    options.onThreads(next);
  }

  function refuse(reason: string): PanelReply {
    return { ok: false, error: reason };
  }

  /** A composer or request-card action on the open remote thread. T3's refusal keeps its own message. */
  async function command(next: PanelCommand): Promise<PanelReply | PanelItemReply> {
    const current = open;

    if (current === null) return refuse("No thread is open");
    const { environmentId, threadId } = current.target;

    try {
      switch (next.type) {
        case "send": {
          const text = next.text.trim();

          if (text === "") return refuse("Write a message first");

          // T3's own rule: `auto` starts an idle thread, `queue` always waits behind the active run.
          await mcp.callTool("t3_thread_send", {
            environmentId,
            threadId,
            message: text,
            mode: next.queue ? "queue" : "auto",
          });
          schedule(0);

          return { ok: true };
        }

        case "stop":
          await mcp.callTool("t3_thread_interrupt", { environmentId, threadId, runId: next.runId });
          schedule(0);

          return { ok: true };
        case "answer":
          await mcp.callTool("t3_pending_request", {
            environmentId,
            threadId,
            action: "respond",
            requestId: next.requestId,
            answers: next.answers,
          });
          schedule(0);

          return { ok: true };
        case "respond":
          return refuse("Approve this in T3 Code");
        case "turnItem": {
          // The expanded row's full text, as the local panel fetches it from `getTurnItem`.
          const result = await mcp.callTool<WireHistory>("t3_thread_read", {
            environmentId,
            threadId,
            itemId: next.itemId,
            textOffset: 0,
            limit: 1,
            runLimit: 1,
            maxCharsPerItem: MAX_CHARS,
          });

          const item = result.items.flatMap((raw) => rowOf(raw) ?? []).find((row) => row.item.id === next.itemId)?.item;

          return item === undefined ? refuse("T3 has no such turn item") : { ok: true, item };
        }
      }
    } catch (error) {
      if (error instanceof McpAuthExpiredError) {
        if (!stopped) options.onAuthExpired();

        return refuse("This PC's T3 no longer accepts the remote session");
      }

      console.warn(`[remote] ${next.type} on ${threadId} failed`, error);

      if (error instanceof McpToolError) {
        const refusal = error.code === "runtime_mode_escalation_denied" || error.code === "capability_denied";

        return refusal ? { ok: false, error: error.detail, refusal: true } : refuse(error.detail);
      }

      return refuse(error instanceof Error ? error.message : String(error));
    }
  }

  async function organize(thread: ThreadRef, action: "settle" | "snooze", snoozedUntil?: string) {
    const args: ToolArguments = { environmentId: thread.environmentId, threadId: thread.threadId, action };

    if (snoozedUntil !== undefined) args.snoozedUntil = snoozedUntil;

    await mcp.callTool("t3_thread_organize", args);
    // The row leaves, or the snooze hides it, on the next list read.
    schedule(0);
  }

  function setTarget(target: ThreadRef | null) {
    const next = target !== null && target.environmentId !== options.server.environmentId ? target : null;

    if (sameTarget(open?.target ?? null, next)) return;

    // A local thread or a closed panel stops the read; the rows and the note keep their poll.
    open =
      next === null
        ? null
        : {
            target: next,
            thread: { id: next.threadId, projectId: "", title: "" },
            runs: [],
            rows: [],
            lastPosition: -1,
            loaded: false,
            activeRunId: null,
            pendingRequestCount: 0,
            questions: [],
            approval: false,
          };

    if (next === null) {
      schedule(IDLE_MS);

      return;
    }

    options.onPanel({ kind: "status", status: "connecting" });
    schedule(0);
  }

  function setVisible(next: boolean) {
    if (visible === next) return;

    visible = next;

    if (next) schedule(0);
    else if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stop() {
    stopped = true;
    open = null;

    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  schedule(0);

  return { setTarget, setVisible, command, organize, stop };
}

function sameTarget(left: ThreadRef | null, right: ThreadRef | null): boolean {
  if (left === null || right === null) return left === right;

  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

/** T3's run status as a sidebar state, as main/shell.ts maps the shell stream's. */
function runState(status: string): ThreadState {
  if (WORKING.has(status)) return "working";

  if (status === "failed" || status === "interrupted") return "failed";

  if (status === "completed") return "completed";

  return "idle";
}

/** One read item as a timeline row. The read gives one rendered `text`; the panel wants its type's field. */
function rowOf(raw: WireItem): PanelRow | null {
  const text = raw.text === null ? undefined : raw.textTruncated ? `${raw.text}…` : raw.text;

  const item = trimItem({
    id: raw.itemId,
    type: raw.type,
    runId: raw.runId,
    nodeId: raw.subagentId ?? null,
    ordinal: raw.position,
    status: raw.status,
    title: raw.title ?? undefined,
    text,
    markdown: raw.type === "proposed_plan" ? text : undefined,
  });

  return item === null ? null : { position: raw.position, sourceItemId: item.id, item };
}

function viewOf(current: OpenThread): PanelView {
  // A thread read carries no attempts: a remote thread shows no subagent rows.
  const rows = [...current.rows, ...rowsOfPending(current)];

  return {
    thread: current.thread,
    runs: current.runs,
    attempts: [],
    runtimeRequests: requestsOfPending(current),
    rows,
    items: rows.map((row) => refOf(row.item)),
    queued: [],
  };
}

const approvalRequestId = (current: OpenThread) => `pending-approval:${current.target.threadId}`;

/** The requests `/mcp` lists are questions; a count above them is an approval T3 alone can answer. */
function requestsOfPending(current: OpenThread): PanelRuntimeRequest[] {
  const requests: PanelRuntimeRequest[] = current.questions.map((read) => ({
    id: read.requestId,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "" },
    remote: true,
  }));

  if (current.approval) {
    requests.push({
      id: approvalRequestId(current),
      kind: "",
      status: "pending",
      responseCapability: { type: "" },
      remote: true,
    });
  }

  return requests;
}

/** The cards go after the last row read; T3's own timeline draws them where the request happened. */
function rowsOfPending(current: OpenThread): PanelRow[] {
  let position = Math.max(current.lastPosition, ...current.rows.map((row) => row.position), -1) + 1;
  const rows: PanelRow[] = [];

  for (const read of current.questions) {
    const id = `pending:${read.requestId}`;

    rows.push({
      position,
      sourceItemId: id,
      item: {
        id,
        type: "user_input_request",
        runId: null,
        nodeId: null,
        ordinal: position,
        status: "pending",
        requestId: read.requestId,
        questions: read.questions.map(questionOf),
      },
    });
    position += 1;
  }

  if (current.approval) {
    const requestId = approvalRequestId(current);
    const id = `pending:${requestId}`;

    rows.push({
      position,
      sourceItemId: id,
      item: { id, type: "approval_request", runId: null, nodeId: null, ordinal: position, status: "pending", requestId },
    });
  }

  return rows;
}

function questionOf(raw: WireQuestion): PanelQuestion {
  return {
    id: raw.id,
    question: raw.question,
    header: raw.header,
    options: raw.options.map((option) => ({ label: option.label, description: option.description, value: option.value })),
    multiSelect: raw.multiSelect,
    allowCustomAnswer: raw.allowCustomAnswer,
    initialAnswer: raw.initialAnswer,
  };
}

function refOf(item: PanelItem): PanelItemRef {
  const ref: PanelItemRef = { id: item.id, type: item.type, runId: item.runId, nodeId: item.nodeId, ordinal: item.ordinal };

  if (item.inputIntent !== undefined) ref.inputIntent = item.inputIntent;

  return ref;
}
