import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { OverlayState, PanelTarget, ThreadRef } from "../shared/types";
import type { OverlayApi } from "./api";

const api: OverlayApi = {
  init: () => ipcRenderer.invoke("overlay:init") as Promise<{ state: OverlayState }>,
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: OverlayState) => listener(state);
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.off("overlay:state", handler);
  },
  onFocusComposer: (listener) => {
    ipcRenderer.on("overlay:focus-composer", listener);
    return () => ipcRenderer.off("overlay:focus-composer", listener);
  },
  setExtent: (extent) => ipcRenderer.send("overlay:extent", extent),
  open: (target: PanelTarget | null) => ipcRenderer.send("overlay:open", target),
  setPopover: (popover) => ipcRenderer.send("overlay:popover", popover),
  threadMenu: (thread) => ipcRenderer.send("overlay:thread-menu", thread),
  onPanel: (listener) => {
    const handler = (_event: IpcRendererEvent, message: Parameters<typeof listener>[0]) => listener(message);
    ipcRenderer.on("overlay:panel", handler);

    return () => ipcRenderer.off("overlay:panel", handler);
  },
  panel: (command) => ipcRenderer.invoke("overlay:panel-command", command),
  retryPanel: () => ipcRenderer.send("overlay:panel-retry"),
  openLink: (url) => ipcRenderer.send("overlay:open-link", url),
  openInT3: (target) => ipcRenderer.send("overlay:open-in-t3", target),
  setOpacity: (opacity: number) => ipcRenderer.send("overlay:opacity", opacity),
  setLocked: (locked: boolean) => ipcRenderer.send("overlay:lock", locked),
  setSettings: (patch) => ipcRenderer.send("overlay:settings", patch),
  dragStart: (kind) => ipcRenderer.send("overlay:drag-start", kind),
  dragEnd: () => ipcRenderer.send("overlay:drag-end"),
  hover: () => ipcRenderer.send("overlay:hover"),
  escape: () => ipcRenderer.send("overlay:escape"),
  sent: () => ipcRenderer.send("overlay:sent"),
};

contextBridge.exposeInMainWorld("overlay", api);
