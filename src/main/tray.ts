import { join } from "node:path";
import { Menu, nativeImage, Tray } from "electron";
import type { OverlayState } from "../shared/types";

export interface TrayActions {
  toggleVisible: () => void;
  setLocked: (locked: boolean) => void;
  launchT3: () => void;
  editConfig: () => void;
  quit: () => void;
}

let tray: Tray | null = null;
let actions: TrayActions | null = null;
let lastKey = "";

const icon = (name: string) => nativeImage.createFromPath(join(import.meta.dirname, "../../resources", name));

export function createTray(trayActions: TrayActions) {
  actions = trayActions;
  tray = new Tray(icon("tray.png"));
  tray.setToolTip("T3 overlay");
  tray.on("click", () => actions?.toggleVisible());
}

export function refreshTray(state: OverlayState, visible: boolean) {
  if (!tray || !actions) return;
  const warning = state.hotkeyFailed.length > 0;
  const key = JSON.stringify([visible, state.locked, state.t3, state.hotkeyFailed]);
  if (key === lastKey) return;
  lastKey = key;

  tray.setImage(icon(warning ? "tray-warning.png" : "tray.png"));
  const notes = [
    state.hotkeyFailed.length > 0 ? `Hotkey taken by another app: ${state.hotkeyFailed.join(", ")}` : null,
  ].filter((note): note is string => note !== null);
  tray.setToolTip(["T3 overlay", ...notes].join("\n"));

  const a = actions;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...notes.map((label) => ({ label, enabled: false })),
      ...(notes.length > 0 ? [{ type: "separator" as const }] : []),
      { label: visible ? "Hide" : "Show", click: a.toggleVisible },
      { label: "Lock position", type: "checkbox", checked: state.locked, click: (item) => a.setLocked(item.checked) },
      { type: "separator" },
      { label: "Launch T3", click: a.launchT3, enabled: state.t3 === "offline" },
      { label: "Edit config", click: a.editConfig },
      { type: "separator" },
      { label: "Quit", click: a.quit },
    ]),
  );
}
