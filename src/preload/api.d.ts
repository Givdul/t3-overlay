import type { PanelCommand, PanelItemReply, PanelMessage, PanelReply } from "../shared/panel";
import type { ComposeBranches, ComposeCommand, ComposeContext, ComposeFile, FileScope, LaunchReply, LaunchRequest } from "../shared/compose";
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
  /** A machine's providers and its projects' new-thread defaults. Rejects when the machine is not connected. */
  composeContext(environmentId: string): Promise<ComposeContext>;
  /** The `/` menu's provider commands for an open thread. */
  composeCommands(thread: ThreadRef): Promise<ComposeCommand[]>;
  composeBranches(environmentId: string, projectId: string, query: string): Promise<ComposeBranches>;
  composeFiles(scope: FileScope, query: string): Promise<ComposeFile[]>;
  /** Starts the thread; on success main opens the panel on it. */
  launch(request: LaunchRequest): Promise<LaunchReply>;
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
