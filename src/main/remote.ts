import type { PanelItem, PanelItemRef, PanelMessage, PanelRow, PanelRun, PanelThread, PanelView } from "../shared/panel";
import type { Machine, SidebarThread, ThreadRef, ThreadState } from "../shared/types";
import { McpAuthExpiredError, openMcp, type ToolArguments } from "./mcp";
import { trimItem } from "./panel";
import { projectIcon, sortSidebar } from "./shell";
import type { T3Server } from "./t3";

// The user's other machines, read through this PC's T3 server: T3 reaches a linked machine over its
// peer link, and the overlay reaches T3's /mcp endpoint with the read-only session. Everything here
// is a read: a remote thread's history, its list row and its state.
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
  /** The read-only MCP session this machine minted for `/mcp`; it reaches no other URL. */
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
    // A read says a request is pending, not what kind it is. A thread that waits on the user gets
    // the attention badge; which one is only P4's pending-request read away.
    if (open !== null && open.target.threadId === thread.threadId && open.pendingRequestCount > 0) return "approval";

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

  return { setTarget, setVisible, stop };
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
  return {
    thread: current.thread,
    runs: current.runs,
    // A thread read carries neither attempts nor runtime requests: a remote thread shows no cards.
    attempts: [],
    runtimeRequests: [],
    rows: current.rows,
    items: current.rows.map((row) => refOf(row.item)),
    queued: [],
  };
}

function refOf(item: PanelItem): PanelItemRef {
  const ref: PanelItemRef = { id: item.id, type: item.type, runId: item.runId, nodeId: item.nodeId, ordinal: item.ordinal };

  if (item.inputIntent !== undefined) ref.inputIntent = item.inputIntent;

  return ref;
}
