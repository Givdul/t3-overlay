import type { ThemeStorage } from "../shared/theme";
import type { Extent, OverlaySettings, OverlayState, PanelTarget, Popover, ThreadRef } from "../shared/types";

export interface OverlayApi {
  init(): Promise<{ state: OverlayState }>;
  onState(listener: (state: OverlayState) => void): () => void;
  onFocusComposer(listener: () => void): () => void;
  setExtent(extent: Partial<Extent>): void;
  open(target: PanelTarget | null): void;
  /** T3 moved to this thread on its own (a draft became a thread). Ignored while the panel is closed. */
  follow(thread: ThreadRef): void;
  setPopover(popover: Popover | null): void;
  threadMenu(thread: ThreadRef): void;
  onSettle(listener: (thread: ThreadRef) => void): () => void;
  getThemeStorage(): Promise<ThemeStorage | null>;
  onThemeStorage(listener: (storage: ThemeStorage) => void): () => void;
  setOpacity(opacity: number): void;
  setLocked(locked: boolean): void;
  setSettings(patch: Partial<OverlaySettings>): void;
  dragStart(kind: "move" | "resize"): void;
  dragEnd(): void;
  hover(): void;
  escape(): void;
  sent(): void;
  reportHooks(missing: string[]): void;
}

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}
