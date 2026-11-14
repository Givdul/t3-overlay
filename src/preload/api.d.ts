import type { PanelCommand, PanelItemReply, PanelMessage, PanelReply } from "../shared/panel";
import type { DragKind, Extent, OverlaySettings, OverlayState, PanelTarget, Popover, ThreadRef } from "../shared/types";

export interface OverlayApi {
  init(): Promise<{ state: OverlayState }>;
  onState(listener: (state: OverlayState) => void): () => void;
  onFocusComposer(listener: () => void): () => void;
  setExtent(extent: Partial<Extent>): void;
  open(target: PanelTarget): void;
  setPopover(popover: Popover | null): void;
  threadMenu(thread: ThreadRef): void;
  /** Main's thread projection for the open panel: snapshots, events and status changes. */
  onPanel(listener: (message: PanelMessage) => void): () => void;
  panel(command: PanelCommand): Promise<PanelReply | PanelItemReply>;
  /** Opens an http(s) link in the system browser, never inside the overlay. */
  openLink(url: string): void;
  /** Brings T3 Code forward on a thread, or on a new one. */
  openInT3(target: ThreadRef | "new"): void;
  setOpacity(opacity: number): void;
  setLocked(locked: boolean): void;
  setSettings(patch: Partial<OverlaySettings>): void;
  dragStart(kind: DragKind): void;
  dragEnd(): void;
  hover(): void;
  escape(): void;
  sent(): void;
}

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}
