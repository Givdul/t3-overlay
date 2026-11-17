import type {
  PanelAttachmentReply,
  PanelAttachmentUrlReply,
  PanelCommand,
  PanelCreateReply,
  PanelDraftReply,
  PanelEntriesReply,
  PanelForceStopReply,
  PanelItemReply,
  PanelMessage,
  PanelModelsReply,
  PanelReply,
  PanelVoiceReply,
} from "../shared/panel";
import type { DragKind, Extent, OverlaySettings, OverlayState, PanelSurface, Popover, ThreadRef } from "../shared/types";

export interface OverlayApi {
  init(): Promise<{ state: OverlayState }>;
  onState(listener: (state: OverlayState) => void): () => void;
  onFocusComposer(listener: () => void): () => void;
  setExtent(extent: Partial<Extent>): void;
  /** Opens a thread, or the new-thread draft, in the panel. */
  open(target: PanelSurface): void;
  setPopover(popover: Popover | null): void;
  threadMenu(thread: ThreadRef): void;
  /** Main's thread projection for the open panel: snapshots, events and status changes. */
  onPanel(listener: (message: PanelMessage) => void): () => void;
  panel(
    command: PanelCommand,
  ): Promise<
    | PanelReply
    | PanelItemReply
    | PanelAttachmentReply
    | PanelAttachmentUrlReply
    | PanelModelsReply
    | PanelEntriesReply
    | PanelVoiceReply
    | PanelDraftReply
    | PanelCreateReply
    | PanelForceStopReply
  >;
  /** Opens an http(s) link in the system browser, never inside the overlay. */
  openLink(url: string): void;
  /** Brings T3 Code forward on a thread. */
  openInT3(target: ThreadRef): void;
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
