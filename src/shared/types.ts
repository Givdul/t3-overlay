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

/** "slide" fades the panel in out of the sidebar. */
export type PanelEntrance = "slide" | "instant";

export interface OverlayState {
  /** Origin the chat panel loads T3's web UI from. */
  origin: string | null;
  /** The panel runs T3's hosted app (signed into T3 Connect) rather than this PC's server. */
  panelHosted: boolean;
  t3: T3Status;
  source: ThreadSource;
  threads: SidebarThread[];
  working: SidebarThread[];
  /** Threads that stopped working since they were last opened in the panel. */
  unread: ThreadRef[];
  panel: PanelTarget | null;
  /** How the panel last opened. The hotkey opens it at once, straight into typing. */
  panelEntrance: PanelEntrance;
  panelSize: { width: number; height: number };
  popover: Popover | null;
  side: "left" | "right";
  sidebarOffsetY: number;
  /** Height in pixels of the thread list. With fewer threads, the sidebar is only as tall as they are. */
  sidebarListHeight: number;
  opacity: number;
  locked: boolean;
  settings: OverlaySettings;
  layoutChanged: boolean;
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
  /** Opacity, 0 to 1, of the bubbles behind your messages and the agent's. 0 draws no bubbles. */
  bubbles: number;
}

export const DEFAULT_SETTINGS: OverlaySettings = {
  titleInComposer: false,
  closeOnSend: false,
  openWhenDone: false,
  textOutline: "off",
  compactComposer: true,
  bubbles: 1,
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

export type DragKind = "move" | "resize" | "sidebar-top" | "sidebar-bottom";

export const SIDEBAR_WIDTH = 52;

/** A 36px icon button and one 6px gap. Must match the h-[42px] slot class in Sidebar.tsx. Each item's slot owns its gap, so a slot opening or closing never jumps. One row is also the shortest the resized list gets. */
export const SIDEBAR_SLOT_HEIGHT = 42;

/** Border, padding, the logo and the new-thread button with their gaps. */
export const SIDEBAR_FIXED_HEIGHT = 2 + 8 + 36 + 6 + 36 + 6 + 8;

/** Must match the divider's h-[5px] slot class in Sidebar.tsx. */
export const SIDEBAR_DIVIDER_HEIGHT = 5;

export const PANEL_GAP = 6;
export const POPOVER_SIZE: Record<Popover, { width: number; height: number }> = {
  working: { width: 260, height: 300 },
  settings: { width: 250, height: 332 },
};
export const PANEL_MIN = { width: 360, height: 300 };

/** The sidebar's settled height with the thread list at `listHeight`. Fewer threads make it shorter. */
export function sidebarHeight(threads: number, working: number, listHeight: number): number {
  return (
    SIDEBAR_FIXED_HEIGHT +
    (working > 0 ? SIDEBAR_SLOT_HEIGHT : 0) +
    (threads > 0 ? SIDEBAR_DIVIDER_HEIGHT : 0) +
    Math.min(threads * SIDEBAR_SLOT_HEIGHT, listHeight)
  );
}

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

/**
 * Main's answer to the webview preload's "guest:client-settings": null on a page that isn't T3's,
 * otherwise the desktop settings file's text, or null when it can't be read.
 */
export type GuestClientSettings = { settings: string | null } | null;
