import type { ProjectIcon } from "./types";

// The panel's IPC contract. Views are loose on purpose, like main/shell.ts: only the fields the panel
// reads are typed, so a T3 nightly's new field never breaks decoding.

export interface PanelModelSelection {
  instanceId: string;
  model: string;
  options?: { id: string; value: string | boolean }[];
}

// ---------------------------------------------------------------- the composer's provider catalog
// `server.getConfig`, trimmed by main/panel.ts#trimConfig to the fields the menus read.

export interface PanelModelOptionValue {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface PanelModelOption {
  id: string;
  label: string;
  type: "select" | "boolean";
  options?: PanelModelOptionValue[];
  /** Values T3 injects into the prompt instead of the model options (Claude's `ultrathink`). */
  promptInjectedValues?: string[];
  isDefault?: boolean;
}

export interface PanelModel {
  slug: string;
  name: string;
  aliases?: string[];
  isDefault?: boolean;
  options: PanelModelOption[];
}

export interface PanelCommandItem {
  name: string;
  description: string | null;
}

export interface PanelSkillItem {
  name: string;
  description: string | null;
  enabled: boolean;
  userInvocable: boolean;
}

export interface PanelCatalog {
  models: PanelModel[];
  slashCommands: PanelCommandItem[];
  skills: PanelSkillItem[];
}

export interface PanelProvider extends PanelCatalog {
  instanceId: string;
  displayName: string;
  supportedRuntimeModes?: string[];
  /** Per-cwd overrides, matched exactly like T3's `workspaceSnapshots`. */
  workspaces: ({ cwd: string } & PanelCatalog)[];
}

export interface PanelConfig {
  providers: PanelProvider[];
  defaultModel: PanelModelSelection | null;
  defaultRuntimeMode: string;
}

/** A project the draft can start a thread in. Worktree-default projects are disabled. */
export interface DraftProject {
  projectId: string;
  title: string;
  icon: ProjectIcon;
  worktree: boolean;
  workspaceRoot: string;
}

export interface PanelThread {
  id: string;
  projectId: string;
  title: string;
  runtimeMode: string;
  interactionMode: string;
  modelSelection: PanelModelSelection | null;
  /** The thread's checkout: its worktree, else its project's root. Resolved in main. */
  cwd: string | null;
}

export interface PanelRun {
  id: string;
  status: string;
}

export interface PanelAttempt {
  runId: string;
  rootNodeId: string;
  status: string;
}

export interface PanelRuntimeRequest {
  id: string;
  kind: string;
  status: string;
  /** Only a "live" capability can be answered from another client. */
  responseCapability: { type: string };
}

export interface PanelAttachment {
  id?: string;
  type?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface PanelTodoStep {
  id?: string;
  text?: string;
  status?: string;
}

export interface PanelFileChange {
  path?: string;
  fileName?: string;
  additions?: number;
  deletions?: number;
}

export interface PanelQuestionOption {
  label?: string;
  description?: string;
  /** The value T3 expects back in `answers`; the label when the provider sends none. */
  value?: string;
}

export interface PanelQuestion {
  id?: string;
  question?: string;
  header?: string;
  options?: PanelQuestionOption[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  initialAnswer?: string;
}

/**
 * A turn item with only the per-type fields the panel renders; `main/panel.ts#trimItem` builds it.
 * Every field a row reads is declared here, so no row casts a payload to reach it.
 */
export interface PanelItem {
  id: string;
  type: string;
  runId: string | null;
  nodeId: string | null;
  ordinal: number;
  status?: string;
  inputIntent?: string;
  startedAt?: string;
  completedAt?: string;
  title?: string;
  text?: string;
  streaming?: boolean;
  markdown?: string;
  steps?: PanelTodoStep[];
  attachments?: PanelAttachment[];
  input?: string;
  output?: string;
  outputOmitted?: boolean;
  exitCode?: number;
  outputIndicatesFailure?: boolean;
  toolName?: string;
  toolInput?: string;
  fileName?: string;
  additions?: number;
  deletions?: number;
  changes?: PanelFileChange[];
  pattern?: string;
  results?: string[];
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
  questions?: PanelQuestion[];
  responseMode?: string;
}

export interface PanelRow {
  position: number;
  sourceItemId: string;
  item: PanelItem;
}

/** A message whose run is waiting behind the active turn; it is a message, not a turn item yet. */
export interface PanelQueuedMessage {
  id: string;
  runId: string;
  /** T3's queue position; the panel draws the list in this order. */
  position: number;
  text: string;
  attachments?: PanelAttachment[];
}

/** Enough of a turn item to re-evaluate T3's visibility rule after a run changes. */
export interface PanelItemRef {
  id: string;
  type: string;
  runId: string | null;
  nodeId: string | null;
  ordinal: number;
  inputIntent?: string;
}

export interface PanelView {
  thread: PanelThread;
  runs: PanelRun[];
  attempts: PanelAttempt[];
  runtimeRequests: PanelRuntimeRequest[];
  /** The rows T3's timeline shows, in order. */
  rows: PanelRow[];
  /** Every turn item, trimmed to the fields the visibility rule reads. */
  items: PanelItemRef[];
  /** Messages queued behind the active run, in T3's queue order. */
  queued: PanelQueuedMessage[];
}

/** The fields of a domain event the panel folds in; everything else stays in main. */
export interface PanelEventPayload {
  item?: PanelItem;
  id?: string;
  status?: string;
  kind?: string;
  runId?: string | null;
  rootNodeId?: string;
  responseCapability?: { type?: string };
  title?: string;
  runtimeMode?: string;
  interactionMode?: string;
  modelSelection?: PanelModelSelection | null;
}

export interface PanelEvent {
  sequence: number;
  type: string;
  payload: PanelEventPayload;
}

export type PanelMessage =
  | { kind: "status"; status: "connecting" | "live" | "offline" | "ended"; reason?: string }
  | { kind: "snapshot"; threadId: string; view: PanelView; sequence: number | null }
  | { kind: "event"; threadId: string; event: PanelEvent }
  | { kind: "config"; config: PanelConfig }
  | { kind: "draft"; projects: DraftProject[]; lastProjectId: string | null }
  | { kind: "stale" }
  | { kind: "remote" };

export interface PanelUpload {
  /** T3's attached image upload (packages/contracts/src/chatAttachment.ts, UploadChatImageAttachment). */
  type: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface PanelPathEntry {
  path: string;
  kind: "file" | "directory";
}

export type PanelCommand =
  | {
      type: "send";
      text: string;
      images: PanelUpload[];
      queue: boolean;
      model: PanelModelSelection | null;
      runtimeMode: string | null;
      /** The message is exactly `/clear`: start a new provider session on the next send instead. */
      freshContext?: boolean;
    }
  | { type: "start"; projectId: string; text: string; model: PanelModelSelection | null; runtimeMode: string }
  | { type: "searchPaths"; cwd: string; query: string }
  | { type: "stop" }
  | { type: "respond"; requestId: string; decision: "accept" | "decline" }
  | { type: "answer"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "dismissInput"; requestId: string }
  | { type: "turnItem"; itemId: string }
  | { type: "reload" };

export type PanelReply = { ok: true } | { ok: false; error: string };

export type PanelItemReply = { ok: true; item: PanelItem } | { ok: false; error: string };

export type PanelPathsReply = { ok: true; entries: PanelPathEntry[]; truncated: boolean } | { ok: false; error: string };

// ---------------------------------------------------------------- dictation
// T3's streaming dictation, run by main so the media ticket never reaches the page.

export type VoiceEvent = { kind: "text"; committed: string; tentative: string } | { kind: "error"; message: string };

/** `fixture` means main feeds a recorded clip: verification runs without a microphone. */
export type VoiceStartReply = { ok: true; fixture: boolean } | { ok: false; error: string };

export type VoiceFinishReply = { ok: true; text: string } | { ok: false; error: string };
