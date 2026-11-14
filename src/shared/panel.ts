// The panel's IPC contract. Views are loose on purpose, like main/shell.ts: only the fields the panel
// reads are typed, so a T3 nightly's new field never breaks decoding.

export interface PanelThread {
  id: string;
  projectId: string;
  title: string;
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
}

export interface PanelEvent {
  sequence: number;
  type: string;
  payload: PanelEventPayload;
}

export type PanelMessage =
  | { kind: "status"; status: "connecting" | "live" | "ended"; reason?: string }
  | { kind: "snapshot"; threadId: string; view: PanelView; sequence: number | null }
  | { kind: "event"; threadId: string; event: PanelEvent };

export type PanelCommand =
  | { type: "send"; text: string; queue: boolean }
  /** `runId` comes from the panel's own run list, which folds the stream's events in. */
  | { type: "stop"; runId: string }
  | { type: "respond"; requestId: string; decision: "accept" | "decline" }
  | { type: "answer"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "turnItem"; itemId: string };

export type PanelReply = { ok: true } | { ok: false; error: string };

export type PanelItemReply = { ok: true; item: PanelItem } | { ok: false; error: string };
