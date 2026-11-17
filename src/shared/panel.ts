// The panel's IPC contract. Views are loose on purpose, like main/shell.ts: only the fields the panel
// reads are typed, so a T3 nightly's new field never breaks decoding.

import type { ProjectIcon } from "./types";

/** One option value as T3 stores it (packages/contracts/src/model.ts, ProviderOptionSelection). */
export interface PanelModelOption {
  id: string;
  value: string | boolean;
}

/** The model a thread runs (packages/contracts/src/modelSelection.ts, ModelSelection). */
export interface PanelModelSelection {
  instanceId: string;
  model: string;
  /** The model's option values, e.g. its reasoning effort and fast mode; absent when it declares none. */
  options?: PanelModelOption[];
}

/** One choice of a model option (packages/contracts/src/model.ts, ProviderOptionChoice). */
export interface PanelModelOptionChoice {
  id: string;
  label: string;
  description?: string;
  /** T3 marks the choice a model starts on. */
  isDefault?: boolean;
}

/** A model option with a list of values (packages/contracts/src/model.ts, SelectProviderOptionDescriptor). */
export interface PanelModelSelectOption {
  type: "select";
  id: string;
  label: string;
  description?: string;
  options: PanelModelOptionChoice[];
  /** The value the thread's selection names; main resolves it against the catalog. */
  currentValue?: string;
  /** Values a typed prompt also sets, which the traits menu does not offer (Claude's Ultrathink). */
  promptInjectedValues?: string[];
  /** Set on an agent's own reasoning control, whose id T3 does not know (an ACP thought level). */
  role?: "reasoning";
}

/** A model option that is on or off (packages/contracts/src/model.ts, BooleanProviderOptionDescriptor). */
export interface PanelModelToggleOption {
  type: "boolean";
  id: string;
  label: string;
  description?: string;
  currentValue?: boolean;
}

/** One option a model declares, e.g. reasoning effort or fast mode (ProviderOptionDescriptor). */
export type PanelModelOptionDescriptor = PanelModelSelectOption | PanelModelToggleOption;

/** One model a provider offers (packages/contracts/src/server.ts, ServerProviderModel). */
export interface PanelModel {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  /** T3's "new" marker. */
  badge?: string;
  /** An older model T3 still offers; its picker lists these after the current ones. */
  isLegacy?: boolean;
  /** T3's own default for the provider, which a new thread starts on when nothing else is set. */
  isDefault?: boolean;
  /** The options the model declares, in the order its agent listed them (ModelCapabilities.optionDescriptors). */
  options: PanelModelOptionDescriptor[];
}

/**
 * One command a provider expands itself, e.g. Claude's `/compact`
 * (packages/contracts/src/server.ts, ServerProviderSlashCommand).
 */
export interface PanelProviderCommand {
  name: string;
  description?: string;
  /** The command's argument hint, shown when it has no description (server.ts, input.hint). */
  hint?: string;
}

/** One skill a provider offers, which its composer invokes as `$name` (server.ts, ServerProviderSkill). */
export interface PanelProviderSkill {
  name: string;
  /** T3's label for it, e.g. its title case; the name when the provider sends none. */
  displayName?: string;
  description?: string;
  /** T3's one-line form, which its menus show before the long description. */
  shortDescription?: string;
  /** Where the skill came from: "user", "repo", "project" and so on. */
  scope?: string;
}

/** A provider whose models a thread can switch to (packages/contracts/src/server.ts, ServerProvider). */
export interface PanelModelProvider {
  instanceId: string;
  displayName: string;
  /** T3 draws a plan toggle for this provider's threads (server.ts, showInteractionModeToggle). */
  showInteractionModeToggle: boolean;
  /** The permission modes this provider supports; empty means every one of T3's. */
  supportedRuntimeModes: string[];
  models: PanelModel[];
  /** The provider's own commands, without the ones a skill of the same name stands in for. */
  commands: PanelProviderCommand[];
  /** The skills its composer offers, as `/skill:name` (server.ts, getProviderSkillsForSlashMenu). */
  skills: PanelProviderSkill[];
}

/**
 * One file or folder the `@` menu offers (packages/contracts/src/project.ts, ProjectEntry). Paths are
 * relative to the project root, as T3's own composer inserts them.
 */
export interface PanelProjectEntry {
  path: string;
  /** "file" or "directory". */
  kind: string;
}

export interface PanelThread {
  id: string;
  projectId: string;
  title: string;
  /** Null when the nightly's projection carries no model selection. */
  modelSelection: PanelModelSelection | null;
  /**
   * The thread's permission mode — "full-access", "approval-required" (T3's "Supervised") and so on
   * (packages/contracts/src/providerPolicy.ts, RuntimeMode). Null hides the control.
   */
  runtimeMode: string | null;
  /** "default" or "plan" (providerPolicy.ts, ProviderInteractionMode). Null hides the plan toggle. */
  interactionMode: string | null;
}

/** A project the new-thread draft can start in (packages/contracts/src/orchestrationProject.ts, OrchestrationProjectShell). */
export interface PanelProject {
  projectId: string;
  title: string;
  /** T3's project icon, as the sidebar draws it. */
  icon: ProjectIcon;
  /** T3's scratch workspace, which the picker offers as "No project". */
  scratch: boolean;
  /** The project's own default model; T3's server default applies when it names none. */
  defaultModelSelection: PanelModelSelection | null;
  /** The permission mode a thread in this project starts in: the project's, else T3's own default. */
  defaultRuntimeMode: string;
}

/** What the new-thread draft reads before a thread exists; a thread's projection carries the same capabilities. */
export interface PanelDraft {
  projects: PanelProject[];
  /** The project the draft starts in: the newest thread's, else the first project. */
  defaultProjectId: string | null;
  /** The model T3 starts a new thread on (packages/contracts/src/settings.ts, defaultModelSelection). */
  defaultModelSelection: PanelModelSelection | null;
  /** The permission mode T3's own setting starts a thread in (settings.ts, defaultRuntimeMode). */
  defaultRuntimeMode: string;
  attachmentUploads: PanelAttachmentUploads | null;
  voiceTranscription: boolean;
}

/** A message attachment record, as T3 sends it (packages/contracts/src/chatAttachment.ts, ChatAttachment). */
export interface PanelAttachment {
  id: string;
  type: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/** The server's attachment upload limit, from its environment descriptor (packages/contracts/src/environment.ts). */
export interface PanelAttachmentUploads {
  maxUploadBytes: number;
}

/**
 * A user message's composer context (packages/contracts/src/composerContext.ts, OrchestrationMessageContext).
 * The panel composes no references of its own, so it carries a queued message's context verbatim: an edit
 * keeps the `@`-mentions T3 Code put there. Unknown fields ride along untouched.
 */
export interface PanelMessageContext {
  /** T3's context format version. */
  version?: number;
  /** The message's references, e.g. `@`-mentions; the panel neither renders nor rewrites them. */
  records?: unknown[];
}

/**
 * One output frame of an expanded running command (packages/contracts/src/orchestrationV2.ts,
 * OrchestrationV2CommandOutputFrame). `replace` resets the bounded tail, `append` extends it, and
 * `running: false` means the command settled and the text is final.
 */
export interface PanelCommandOutput {
  kind: "replace" | "append";
  text: string;
  /** Earlier output was dropped to keep the tail bounded. */
  truncated: boolean;
  running: boolean;
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
  /** A request read from another machine: questions go through /mcp, approvals only through T3. */
  remote?: true;
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
  attachments?: PanelAttachment[];
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
  /** The decisions an approval offers, when the provider names them. */
  options?: PanelApprovalOption[];
  questions?: PanelQuestion[];
  responseMode?: string;
  /** Set when a stop request's provider has not confirmed it; T3 then offers Force stop. */
  unresponsiveAt?: string;
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
  /** The message's attachments; editing keeps them, as T3's composer does. */
  attachments: PanelAttachment[];
  /** The message's composer context; the panel sends it back unchanged when the message is edited. */
  context?: PanelMessageContext;
}

/**
 * One button T3's approval card offers for a request (packages/contracts/src/providerPolicy.ts,
 * ProviderApprovalOption). The provider sends the labels, so the card never invents a decision.
 */
export interface PanelApprovalOption {
  /** `accept`, `acceptForSession`, `acceptAlways`, `decline` or `cancel`; a nightly may add one. */
  decision: PanelApprovalDecision;
  label: string;
  /** A caveat T3 shows with the option, e.g. that it grants more than the user expects. */
  warning?: string;
}

/** T3's approval decisions (packages/contracts/src/providerPolicy.ts, ProviderApprovalDecision). */
export type PanelApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

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
  /**
   * T3's force-stop capability (packages/contracts/src/environment.ts, `threadForceStop`); false hides
   * Force stop, as T3's own clients hide it.
   */
  threadForceStop: boolean;
  /** Null when the server advertises no attachment uploads; the composer hides its attach control. */
  attachmentUploads: PanelAttachmentUploads | null;
  /**
   * T3's own voice-transcription capability, which its composers gate their mic on
   * (packages/contracts/src/environment.ts, `voiceTranscription`; apps/web/src/speech/useEnvironmentSpeechInput.ts).
   */
  voiceTranscription: boolean;
  /**
   * T3's live command-output capability (packages/contracts/src/environment.ts, `commandOutputStreaming`).
   * False keeps the old behavior: an expanded row asks `getTurnItem` for its whole output.
   */
  commandOutputStreaming: boolean;
  /**
   * Whether the composer offers the selected model's options (reasoning effort, fast mode, …). Another
   * machine's thread cannot take a new model selection from here, so its traits menu is hidden.
   */
  modelTraits: boolean;
  /**
   * Whether the composer draws T3's `/` command and `@` file menus from this PC's server. Another machine's
   * thread is read through `/mcp`, which offers neither, so its composer hides both.
   */
  composerMenus: boolean;
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
  modelSelection?: PanelModelSelection;
  runtimeMode?: string;
  interactionMode?: string;
}

export interface PanelEvent {
  sequence: number;
  type: string;
  payload: PanelEventPayload;
}

export type PanelMessage =
  | { kind: "status"; status: "connecting" | "live" | "ended"; reason?: string }
  | { kind: "snapshot"; threadId: string; view: PanelView; sequence: number | null }
  | { kind: "event"; threadId: string; event: PanelEvent }
  /** One frame of an expanded running command's output, from its own subscription. */
  | { kind: "commandOutput"; threadId: string; itemId: string; frame: PanelCommandOutput };

/** The new-thread draft's commands: main answers them without a thread, before one exists. */
export type PanelDraftCommand =
  /** Reads the projects, the model and the capabilities the draft composer draws. */
  | { type: "draft" }
  /**
   * Creates a thread and its first turn, then main opens the panel on it. T3's own path for a draft
   * (packages/contracts/src/orchestrationV2.ts, launchThread; packages/client-runtime/src/operations/
   * commands.ts, startThreadTurn), in the project root.
   */
  | {
      type: "create";
      projectId: string;
      modelSelection: PanelModelSelection;
      /** The permission mode the new thread starts in, as its composer picked it. */
      runtimeMode: string;
      /** "default", or "plan" when the draft's plan toggle is on. */
      interactionMode: string;
      text: string;
      attachments: PanelAttachment[];
    };

/** The commands the panel's connection answers, with or without an open thread. */
export type PanelThreadCommand =
  | { type: "send"; text: string; queue: boolean; attachments: PanelAttachment[] }
  /** Uploads the file's bytes through main, which holds the token, and returns T3's record. */
  | { type: "attach"; name: string; mimeType: string; sizeBytes: number; data: ArrayBuffer }
  /** Stops the active run, as T3 Code's own Stop button does. */
  | { type: "stop" }
  /**
   * Kills an agent that ignored Stop (`orchestration.forceStopThread`); `runId` comes from the panel's
   * own run list, which folds the stream's events in.
   */
  | { type: "forceStop"; runId: string }
  /** Cancels a message that is still waiting behind the active turn (`queued-run.cancel`). */
  | { type: "cancelQueued"; runId: string }
  /**
   * Rewrites a queued message's text; its attachments and composer context stay, as T3's composer leaves
   * them (packages/client-runtime/src/operations/commands.ts, editQueuedRun).
   */
  | { type: "editQueued"; runId: string; text: string; attachments: PanelAttachment[]; context?: PanelMessageContext }
  /**
   * Opens T3's live output stream for an expanded running command row; main forwards its frames as
   * `commandOutput` messages (packages/contracts/src/orchestrationV2.ts, subscribeCommandOutput).
   */
  | { type: "subscribeCommandOutput"; itemId: string }
  /** Ends that stream when the row collapses, the command finishes, or the panel moves on. */
  | { type: "unsubscribeCommandOutput"; itemId: string }
  | { type: "respond"; requestId: string; decision: PanelApprovalDecision }
  | { type: "answer"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "turnItem"; itemId: string }
  /**
   * The models, commands and skills the server offers, grouped by provider. `projectId` adds the skills
   * T3's own scan found in that project's checkout.
   */
  | { type: "models"; projectId?: string }
  /**
   * Searches the project's files for the composer's `@` menu (packages/contracts/src/project.ts,
   * ProjectSearchEntriesInput; apps/web/src/state/queries.ts, useComposerPathSearch).
   */
  | { type: "entries"; projectId: string; query: string }
  /**
   * Switches the open thread's model, so its next turn runs on it. `options` are the model's own
   * option values, which a traits pick writes; a plain model switch leaves them to the model.
   */
  | { type: "setModel"; instanceId: string; model: string; options?: PanelModelOption[] }
  /** Sets the thread's permission mode for its next turns (`thread.runtime-mode.set`). */
  | { type: "setRuntimeMode"; runtimeMode: string }
  /** Puts the thread in plan mode, or back to default (`thread.interaction-mode.set`). */
  | { type: "setInteractionMode"; interactionMode: string }
  /** Asks T3 whether it can transcribe now, so a missing model is reported before a recording. */
  | { type: "voiceStatus" }
  /**
   * Posts a finished recording to T3's transcription route: T3's models take 16 kHz mono float32 PCM
   * (apps/web/src/speech/pcmWorklet.ts).
   */
  | { type: "transcribe"; pcm: ArrayBuffer };

export type PanelCommand = PanelThreadCommand | PanelDraftCommand;

/** `refusal` is T3 turning the action down, which only T3 itself can finish. */
export interface PanelFailure {
  ok: false;
  error: string;
  refusal?: true;
  /** T3 refused because the session's access is below the thread's: granting remote control lifts it. */
  grant?: true;
}

export type PanelReply = { ok: true } | PanelFailure;

export type PanelItemReply = { ok: true; item: PanelItem } | PanelFailure;

export type PanelAttachmentReply = { ok: true; attachment: PanelAttachment } | PanelFailure;

/**
 * The administrator's policy for this T3, which caps the permission modes a thread may run
 * (packages/contracts/src/managedPolicy.ts, ManagedPolicySummary). Null on an unmanaged server.
 */
export interface PanelManagedPolicy {
  organization: string;
  /** The broadest runtime mode the policy allows; null when it caps none. */
  maxRuntimeMode: string | null;
}

export type PanelModelsReply = { ok: true; providers: PanelModelProvider[]; policy: PanelManagedPolicy | null } | PanelFailure;

/** The project's matching files and folders, in T3's own order, bounded as its composer bounds them. */
export type PanelEntriesReply = { ok: true; entries: PanelProjectEntry[] } | PanelFailure;

/** T3's transcript of a recording; `text` is empty when it heard no speech. */
export type PanelVoiceReply = { ok: true; text: string } | PanelFailure;

/**
 * What a force stop did (packages/contracts/src/orchestrationV2.ts, OrchestrationV2ForceStopThreadResult).
 * `outcome` is T3's own word for it: `killed`, `released`, `releasing` or `shared`.
 */
export type PanelForceStopReply =
  | { ok: true; outcome: string; sharedWithThreadIds: string[] }
  | PanelFailure;

export type PanelDraftReply = { ok: true; draft: PanelDraft } | PanelFailure;

/** A created thread's id; main opens the panel on it and the shell feed adds it to the sidebar. */
export type PanelCreateReply = { ok: true; threadId: string } | PanelFailure;
