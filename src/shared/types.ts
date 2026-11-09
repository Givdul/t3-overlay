export type ThreadState = "working" | "approval" | "input" | "completed" | "failed" | "idle";

export interface ThreadRef {
  environmentId: string;
  threadId: string;
}

export interface ProjectIcon {
  /** Image URL the webview partition can load (same origin as T3), when the project has a favicon. */
  url: string | null;
  /** Lucide icon name from T3's project icon picker, when set. */
  lucide: string | null;
  color: string | null;
  letter: string;
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

export type PanelTarget = ThreadRef | "draft" | "connect";

export interface OverlayState {
  /** Origin the chat panel loads T3's web UI from. */
  origin: string | null;
  /** The panel runs T3's hosted app (signed into T3 Connect) rather than this PC's server. */
  panelHosted: boolean;
  t3: T3Status;
  source: ThreadSource;
  threads: SidebarThread[];
  working: SidebarThread[];
  panel: PanelTarget | null;
  panelSize: { width: number; height: number };
  popover: Popover | null;
  side: "left" | "right";
  sidebarOffsetY: number;
  opacity: number;
  locked: boolean;
  settings: OverlaySettings;
  layoutChanged: boolean;
  hotkeyFailed: string[];
}

export interface OverlaySettings {
  /** Thread title as the first row of the composer card instead of above the chat history. */
  titleInComposer: boolean;
  /** Close the panel after sending a message. */
  closeOnSend: boolean;
  /** Open a thread when it finishes, if no panel is open. */
  openWhenDone: boolean;
  /** Dark outline on chat text, like WoW's chat, for reading over bright scenery. */
  textOutline: boolean;
}

export const DEFAULT_SETTINGS: OverlaySettings = {
  titleInComposer: false,
  closeOnSend: false,
  openWhenDone: false,
  textOutline: false,
};

export interface Extent {
  sidebarHeight: number;
}

/** Small surfaces that open beside the sidebar: the working-thread list and the logo's settings. */
export type Popover = "working" | "settings";

export const SIDEBAR_WIDTH = 52;
export const PANEL_GAP = 6;
export const POPOVER_SIZE: Record<Popover, { width: number; height: number }> = {
  working: { width: 260, height: 300 },
  settings: { width: 250, height: 268 },
};
export const PANEL_MIN = { width: 360, height: 300 };

export function sameThread(a: PanelTarget | null, b: ThreadRef): boolean {
  return typeof a === "object" && a !== null && a.environmentId === b.environmentId && a.threadId === b.threadId;
}
