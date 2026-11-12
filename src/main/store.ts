import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { DEFAULT_SETTINGS, TEXT_OUTLINES, type OverlaySettings, type TextOutline, type ThreadRef } from "../shared/types";

export interface Persisted {
  /** Sidebar top-left in screen DIPs, tied to the display it was placed on. */
  anchor: { displayId: number; x: number; y: number } | null;
  panelSize: { width: number; height: number };
  opacity: number;
  locked: boolean;
  settings: OverlaySettings;
  lastThread: ThreadRef | null;
  /** The project the draft starts its next thread in. */
  lastProjectId: string | null;
}

export interface Config {
  hotkeys: { focus: string; toggle: string };
  /** T3's Chrome DevTools port: the sidebar reads every machine and the theme through it. */
  debugPort: number;
}

const DEFAULT_PERSISTED: Persisted = {
  anchor: null,
  panelSize: { width: 440, height: 560 },
  opacity: 0.85,
  locked: false,
  settings: DEFAULT_SETTINGS,
  lastThread: null,
  lastProjectId: null,
};

const DEFAULT_CONFIG: Config = {
  hotkeys: { focus: "Control+Shift+Space", toggle: "Control+Shift+H" },
  debugPort: 9333,
};

export const statePath = () => join(app.getPath("userData"), "state.json");
export const configPath = () => join(app.getPath("userData"), "config.json");

function readJson<T extends object>(path: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

export function loadPersisted(): Persisted {
  const persisted = readJson(statePath(), DEFAULT_PERSISTED);
  const settings = { ...DEFAULT_SETTINGS, ...persisted.settings };

  return { ...persisted, settings: { ...settings, textOutline: parseTextOutline(settings.textOutline) } };
}

/** Before "Thick" existed, the outline was a boolean: true was today's "thin". */
type StoredTextOutline = TextOutline | boolean;

function parseTextOutline(value: StoredTextOutline): TextOutline {
  if (value === true) return "thin";

  return TEXT_OUTLINES.find((outline) => outline === value) ?? DEFAULT_SETTINGS.textOutline;
}

export function savePersisted(value: Persisted) {
  writeFileSync(statePath(), JSON.stringify(value, null, 2));
}

export function loadConfig(): Config {
  if (!existsSync(configPath())) writeFileSync(configPath(), JSON.stringify(DEFAULT_CONFIG, null, 2));
  const config = readJson(configPath(), DEFAULT_CONFIG);

  return {
    hotkeys: { ...DEFAULT_CONFIG.hotkeys, ...config.hotkeys },
    debugPort: Number.isInteger(config.debugPort) && config.debugPort > 0 && config.debugPort < 65536 ? config.debugPort : DEFAULT_CONFIG.debugPort,
  };
}
