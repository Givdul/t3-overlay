import type { OverlayTheme } from "./tokens";

export type ThreadState = "working" | "approval" | "input" | "completed" | "failed" | "idle";

export interface ThreadRef {
  environmentId: string;
  threadId: string;
}

/** A project's icon as T3 shows it: the one set in T3's icon picker, else its favicon, else a generated monogram. */
export type ProjectIcon =
  | { kind: "image"; url: string }
  | { kind: "monogram"; text: string; color: string | null }
  | { kind: "emoji"; emoji: string }
  | { kind: "lucide"; name: string; color: string | null };

/** A project as the panel's labels and the draft picker need it. */
export interface SidebarProject {
  environmentId: string;
  projectId: string;
  title: string;
  icon: ProjectIcon;
  /** New threads in this project default to a worktree, which the panel cannot start. */
  worktree: boolean;
  workspaceRoot: string;
}

export interface SidebarThread extends ThreadRef {
  title: string;
  projectName: string;
  icon: ProjectIcon;
  environmentLabel: string;
  state: ThreadState;
  pinned: boolean;
  pinOrder: string | null;
  updatedAt: string;
}

export type T3Status = "connecting" | "offline" | "connected";

/** Where the thread list comes from. "local" means the debug port was missing and only this PC is shown. */
export type ThreadSource = "all-machines" | "local" | "none";

/** A thread, or the draft the `+` button opens. */
export type PanelTarget = ThreadRef | "draft";

/** "slide" fades the panel in out of the sidebar. */
export type PanelEntrance = "slide" | "instant";

export interface OverlayState {
  t3: T3Status;
  source: ThreadSource;
  threads: SidebarThread[];
  working: SidebarThread[];
  /** Threads that stopped working since they were last opened in the panel. */
  unread: ThreadRef[];
  /** The projects of this PC, local machines only: the panel labels threads by them. */
  projects: SidebarProject[];
  /** T3's resolved theme, written to the page as `--t3-*` variables. */
  theme: OverlayTheme;
  panel: PanelTarget | null;
  /** How the panel last opened. The hotkey opens it at once, straight into typing. */
  panelEntrance: PanelEntrance;
  panelSize: { width: number; height: number };
  popover: Popover | null;
  side: "left" | "right";
  sidebarOffsetY: number;
  opacity: number;
  locked: boolean;
  settings: OverlaySettings;
  hotkeyFailed: string[];
}

export const TEXT_OUTLINES = ["off", "thin", "thick"] as const;

export type TextOutline = (typeof TEXT_OUTLINES)[number];

export interface OverlaySettings {
  /** Thread title as the first row of the composer card instead of above the chat history. */
  titleInComposer: boolean;
  /** Close the panel after sending a message. */
  closeOnSend: boolean;
  /** Open a thread when it finishes, if no panel is open. */
  openWhenDone: boolean;
  /** Dark outline on chat text, like WoW's chat, for reading over bright scenery. */
  textOutline: TextOutline;
  /** Fold an empty, unfocused composer into a write button, so the history gets the space. */
  compactComposer: boolean;
  /** The theme picked in the desktop app. Off shows T3's default theme, following the system appearance. */
  customTheme: boolean;
}

export const DEFAULT_SETTINGS: OverlaySettings = {
  titleInComposer: false,
  closeOnSend: false,
  openWhenDone: false,
  textOutline: "off",
  compactComposer: true,
  customTheme: true,
};

/** Content-sized heights the renderer measures. Main sizes and shapes the window by them. */
export interface Extent {
  sidebarHeight: number;
  /** The open popover's height. Null until it reports, then the shape covers its largest size. */
  popoverHeight: number | null;
  /** The sidebar tooltip's box, `top` in window pixels, while one shows or fades out. */
  tooltip: TooltipBox | null;
}

export interface TooltipBox {
  top: number;
  width: number;
  height: number;
}

/** The widest a sidebar tooltip gets. While one shows, the window keeps this much room beside the sidebar. */
export const TOOLTIP_MAX_WIDTH = 240;

/** Small surfaces that open beside the sidebar: the working-thread list and the logo's settings. */
export type Popover = "working" | "settings";

export const SIDEBAR_WIDTH = 52;
export const PANEL_GAP = 6;
export const POPOVER_SIZE: Record<Popover, { width: number; height: number }> = {
  working: { width: 260, height: 300 },
  settings: { width: 250, height: 332 },
};
export const PANEL_MIN = { width: 360, height: 300 };

/** Left edge of the panel or popover slot in the window. The renderer places surfaces by it and main shapes the window. */
export function slotLeft(side: OverlayState["side"]): number {
  return side === "left" ? SIDEBAR_WIDTH + PANEL_GAP : 0;
}

/** Over an open panel, the popover sits on the edge next to the sidebar. */
export function popoverLeft(state: Pick<OverlayState, "panel" | "panelSize" | "side">, popover: Popover): number {
  return state.panel && state.side === "right" ? state.panelSize.width - POPOVER_SIZE[popover].width : slotLeft(state.side);
}

export const threadKey = (thread: ThreadRef) => `${thread.environmentId}:${thread.threadId}`;

export function sameThread(a: PanelTarget | null, b: ThreadRef): boolean {
  return typeof a === "object" && a !== null && a.environmentId === b.environmentId && a.threadId === b.threadId;
}
