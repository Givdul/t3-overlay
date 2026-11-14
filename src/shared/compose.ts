// The composer's IPC contract: what main reads from a machine's T3 for the new-thread composer and
// for the `@` and `/` menus, and what the renderer sends back. Loose like shared/panel.ts: only the
// fields the composer draws are typed.

/** T3's runtime modes, in the order its mode picker lists them (apps/web runtimeModeConfig.ts). */
export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export type EnvMode = "local" | "worktree";

/** One model option T3 offers, such as reasoning effort. A select has choices; a boolean is a toggle. */
export type ComposeOption =
  | { type: "select"; id: string; label: string; choices: { id: string; label: string }[]; defaultValue: string | null }
  | { type: "boolean"; id: string; label: string; defaultValue: boolean };

export interface ComposeModel {
  slug: string;
  name: string;
  isDefault: boolean;
  options: ComposeOption[];
}

export interface ComposeCommand {
  /** Shown as `/name`. */
  name: string;
  description: string;
  /** What picking it puts in the message: `/name ` for a command, `$name ` for a skill. */
  insert: string;
}

/** A provider instance that can start a turn now: enabled and not reported unavailable. */
export interface ComposeProvider {
  instanceId: string;
  name: string;
  models: ComposeModel[];
  runtimeModes: RuntimeMode[];
  /** The provider's own commands and user-invocable skills, machine-wide. */
  commands: ComposeCommand[];
}

export interface ModelChoice {
  instanceId: string;
  model: string;
  options: { id: string; value: string | boolean }[];
}

/** A project's new-thread defaults, resolved from T3's settings and that project's overrides. */
export interface ComposeDefaults {
  model: ModelChoice | null;
  runtimeMode: RuntimeMode;
  envMode: EnvMode;
  startFromOrigin: boolean;
}

export interface ComposeProject {
  id: string;
  title: string;
  defaults: ComposeDefaults;
}

/** One machine's choices for a new thread, read when the composer opens. */
export interface ComposeContext {
  environmentId: string;
  projects: ComposeProject[];
  providers: ComposeProvider[];
}

export interface ComposeBranch {
  name: string;
  isRemote: boolean;
  current: boolean;
  isDefault: boolean;
  /** Set when the branch is checked out in a worktree: a local thread there runs in that worktree. */
  worktreePath: string | null;
}

export interface ComposeBranches {
  isRepo: boolean;
  branches: ComposeBranch[];
}

export interface ComposeFile {
  /** Relative to the search's checkout, with forward slashes. */
  path: string;
  kind: "file" | "directory";
}

/** A file the user attached, read in the renderer and uploaded to T3 by main when the message goes out. */
export interface ComposeAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Where the `@` menu searches: an open thread's checkout, or a new thread's project. */
export type FileScope =
  | { kind: "thread"; environmentId: string; threadId: string }
  | { kind: "project"; environmentId: string; projectId: string; worktreePath: string | null };

export interface LaunchRequest {
  environmentId: string;
  projectId: string;
  text: string;
  attachments: ComposeAttachment[];
  model: ModelChoice;
  runtimeMode: RuntimeMode;
  envMode: EnvMode;
  /** Local mode: the branch to run on, switched to first. Worktree mode: the base of the new worktree. */
  branch: ComposeBranch | null;
  startFromOrigin: boolean;
}

export type LaunchReply = { ok: true; threadId: string } | { ok: false; error: string };

/** T3's attachment limits (packages/contracts chatAttachment.ts and assets.ts). */
export const ATTACHMENT_LIMITS = {
  imageTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
  imageBytes: 10 * 1024 * 1024,
  fileBytes: 50 * 1024 * 1024,
  perMessage: 100,
} as const;

export function isImageAttachment(mimeType: string): boolean {
  return (ATTACHMENT_LIMITS.imageTypes as readonly string[]).includes(mimeType);
}
