import { generatedIcon } from "../shared/projectIcon";
import type { ProjectIcon, SidebarThread, ThreadState } from "../shared/types";

// Loose views of T3's shell stream (packages/contracts/src/orchestrationV2.ts, OrchestrationV2ShellStreamItem).
// Only the fields the sidebar reads are typed, so new T3 fields never break decoding.

interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  status: string;
  activityRunStatus?: string | null;
  pendingRuntimeRequest: { kind: string } | null;
  lineage: { parentThreadId: string | null; relationshipToParent: string | null; rootThreadId: string; sideChat?: boolean };
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  settledOverride: "settled" | "active" | null;
  snoozedUntil?: string | null;
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
}

interface ProjectShell {
  id: string;
  title: string;
  workspaceRoot: string;
  faviconPath?: string | null;
  projectIcon?: { kind: string; name?: string; color?: string; text?: string; emoji?: string } | null;
}

type ShellItem =
  | {
      kind: "snapshot";
      snapshot: { threads: ThreadShell[]; projects: ProjectShell[] };
      /** Set on a refresh of project repository identities only. Its threads and projects are not the full list. */
      resolvedRepositoryIdentityRoots?: string[];
    }
  | { kind: "thread.updated"; location: "active" | "archive"; thread: ThreadShell }
  | { kind: "thread.removed"; threadId: string }
  | { kind: "project.updated"; project: ProjectShell }
  | { kind: "project.removed"; projectId: string }
  | { kind: string };

const WORKING = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export class ShellModel {
  private threads = new Map<string, ThreadShell>();
  private projects = new Map<string, ProjectShell>();
  hasSnapshot = false;
  /** Project favicons as data URLs, keyed by `${workspaceRoot}\n${faviconPath}`. */
  favicons = new Map<string, string>();

  constructor(
    readonly environmentId: string,
    public environmentLabel: string,
  ) {}

  /** Folds in a cached snapshot that may be older than live updates: the newer row of each thread wins. */
  merge(raw: unknown) {
    const snapshot = raw as { threads: ThreadShell[]; projects: ProjectShell[] };
    for (const project of snapshot.projects) this.projects.set(project.id, project);
    for (const thread of snapshot.threads) {
      const current = this.threads.get(thread.id);
      if (!current || current.updatedAt <= thread.updatedAt) this.threads.set(thread.id, thread);
    }
    this.hasSnapshot = true;
  }

  /** Whether a live stream item belongs to this machine. Thread and project ids are UUIDs, so they never collide. */
  owns(raw: unknown): boolean {
    const item = raw as ShellItem & Record<string, any>;
    switch (item.kind) {
      case "snapshot":
        return item.snapshot.projects.some((project: ProjectShell) => this.projects.has(project.id));
      case "thread.updated":
        return this.threads.has(item.thread.id) || this.projects.has(item.thread.projectId);
      case "thread.removed":
        return this.threads.has(item.threadId);
      case "project.updated":
        return this.projects.has(item.project.id);
      case "project.removed":
        return this.projects.has(item.projectId);
      default:
        return false;
    }
  }

  apply(raw: unknown): boolean {
    const item = raw as ShellItem;
    switch (item.kind) {
      case "snapshot": {
        const { snapshot, resolvedRepositoryIdentityRoots } = item as Extract<ShellItem, { kind: "snapshot" }>;
        // The sidebar reads no repository identities, so a refresh of them changes nothing here.
        if (resolvedRepositoryIdentityRoots !== undefined) return false;
        this.threads = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
        this.projects = new Map(snapshot.projects.map((project) => [project.id, project]));
        this.hasSnapshot = true;
        return true;
      }
      case "thread.updated": {
        const { thread, location } = item as Extract<ShellItem, { kind: "thread.updated" }>;
        if (location === "archive") this.threads.delete(thread.id);
        else this.threads.set(thread.id, thread);
        return true;
      }
      case "thread.removed":
        return this.threads.delete((item as { threadId: string }).threadId);
      case "project.updated": {
        const { project } = item as Extract<ShellItem, { kind: "project.updated" }>;
        this.projects.set(project.id, project);
        return true;
      }
      case "project.removed":
        return this.projects.delete((item as { projectId: string }).projectId);
      default:
        return false;
    }
  }

  sidebar(): SidebarThread[] {
    const now = Date.now();
    // A subagent waiting on the user puts its top-level thread in the same state, as in T3's sidebar.
    const childRequests = new Map<string, ThreadState>();
    for (const thread of this.threads.values()) {
      if (thread.pendingRuntimeRequest && !isListed(thread)) {
        childRequests.set(thread.lineage.rootThreadId, requestState(thread.pendingRuntimeRequest.kind));
      }
    }

    const result: SidebarThread[] = [];
    for (const thread of this.threads.values()) {
      if (!isListed(thread) || thread.archivedAt || thread.deletedAt) continue;
      const pinned = Boolean(thread.pinnedAt);
      const settled = thread.settledOverride === "settled";
      const snoozed = thread.snoozedUntil ? Date.parse(thread.snoozedUntil) > now : false;
      const state = childRequests.get(thread.id) ?? threadState(thread);
      const listed = state === "working" || state === "approval" || state === "input" || (!settled && !snoozed && state !== "idle");
      if (!pinned && !listed) continue;
      const project = this.projects.get(thread.projectId);
      result.push({
        environmentId: this.environmentId,
        threadId: thread.id,
        title: thread.title,
        projectName: project?.title ?? "",
        icon: projectIcon(project, project ? this.favicons.get(`${project.workspaceRoot}\n${project.faviconPath ?? ""}`) : undefined),
        environmentLabel: this.environmentLabel,
        state,
        pinned,
        pinOrder: thread.pinOrderKey ?? null,
        updatedAt: thread.updatedAt,
      });
    }
    return result;
  }
}

function isListed(thread: ThreadShell): boolean {
  return thread.lineage.relationshipToParent !== "subagent" && thread.lineage.sideChat !== true;
}

function requestState(kind: string): ThreadState {
  return kind === "user_input" ? "input" : "approval";
}

function threadState(thread: ThreadShell): ThreadState {
  if (thread.pendingRuntimeRequest) return requestState(thread.pendingRuntimeRequest.kind);
  if (thread.activityRunStatus || WORKING.has(thread.status)) return "working";
  if (thread.status === "failed" || thread.status === "interrupted") return "failed";
  if (thread.status === "completed") return "completed";
  return "idle";
}

function projectIcon(project: ProjectShell | undefined, favicon: string | undefined): ProjectIcon {
  const icon = project?.projectIcon;
  if (icon?.kind === "monogram" && icon.text) return { kind: "monogram", text: icon.text, color: icon.color ?? null };
  if (icon?.kind === "emoji" && icon.emoji) return { kind: "emoji", emoji: icon.emoji };
  if (icon?.kind === "lucide" && icon.name) return { kind: "lucide", name: icon.name, color: icon.color ?? null };
  if (favicon) return { kind: "image", url: favicon };
  return generatedIcon(project?.title ?? "");
}

/** Pinned threads first in T3's pin order, then the rest by most recent update. */
export function sortSidebar(threads: SidebarThread[]): SidebarThread[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return (a.pinOrder ?? "").localeCompare(b.pinOrder ?? "");
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
