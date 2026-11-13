import { contextBridge, ipcRenderer } from "electron";
import type { ThemeStorage } from "../shared/theme";
import type { OverlayState, PanelTarget, ThreadRef } from "../shared/types";
import type { OverlayApi } from "./api";

const api: OverlayApi = {
  init: () => ipcRenderer.invoke("overlay:init") as Promise<{ state: OverlayState }>,
  onState: (listener) => {
    const handler = (_event: unknown, state: OverlayState) => listener(state);
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.off("overlay:state", handler);
  },
  onFocusComposer: (listener) => {
    ipcRenderer.on("overlay:focus-composer", listener);
    return () => ipcRenderer.off("overlay:focus-composer", listener);
  },
  setExtent: (extent) => ipcRenderer.send("overlay:extent", extent),
  open: (target: PanelTarget | null) => ipcRenderer.send("overlay:open", target),
  follow: (thread: ThreadRef) => ipcRenderer.send("overlay:follow", thread),
  setPopover: (popover) => ipcRenderer.send("overlay:popover", popover),
  threadMenu: (thread) => ipcRenderer.send("overlay:thread-menu", thread),
  getThemeStorage: () => ipcRenderer.invoke("overlay:get-theme-storage") as Promise<ThemeStorage | null>,
  onThemeStorage: (listener) => {
    const handler = (_event: unknown, storage: ThemeStorage) => listener(storage);
    ipcRenderer.on("overlay:theme-storage", handler);
    return () => ipcRenderer.off("overlay:theme-storage", handler);
  },
  onSettle: (listener) => {
    const handler = (_event: unknown, thread: ThreadRef) => listener(thread);
    ipcRenderer.on("overlay:settle", handler);
    return () => ipcRenderer.off("overlay:settle", handler);
  },
  setOpacity: (opacity: number) => ipcRenderer.send("overlay:opacity", opacity),
  setLocked: (locked: boolean) => ipcRenderer.send("overlay:lock", locked),
  setSettings: (patch) => ipcRenderer.send("overlay:settings", patch),
  dragStart: (kind) => ipcRenderer.send("overlay:drag-start", kind),
  dragEnd: () => ipcRenderer.send("overlay:drag-end"),
  hover: () => ipcRenderer.send("overlay:hover"),
  escape: () => ipcRenderer.send("overlay:escape"),
  sent: () => ipcRenderer.send("overlay:sent"),
  reportHooks: (missing: string[]) => ipcRenderer.send("overlay:hooks", missing),
};

contextBridge.exposeInMainWorld("overlay", api);
