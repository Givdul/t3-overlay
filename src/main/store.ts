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
}

export interface Config {
  hotkeys: { focus: string; toggle: string };
  debugPort: number;
  /**
   * Where the chat panel loads T3's web UI from. The hosted app can sign into T3 Connect and reach
   * every machine; T3 only allows that sign-in over HTTPS on its own domain. "local" uses this PC's
   * T3 server, which reaches only this PC.
   */
  panelOrigin: string;
}

const DEFAULT_PERSISTED: Persisted = {
  anchor: null,
  panelSize: { width: 440, height: 560 },
  opacity: 0.85,
  locked: false,
  settings: DEFAULT_SETTINGS,
  lastThread: null,
};

const DEFAULT_CONFIG: Config = {
  hotkeys: { focus: "Control+Shift+Space", toggle: "Control+Shift+H" },
  debugPort: 9333,
  panelOrigin: "https://app.t3.codes",
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
    panelOrigin: panelOrigin(config.panelOrigin),
  };
}

/** "local", or the origin of an HTTPS URL. Anything else falls back to the hosted app. */
function panelOrigin(value: string): string {
  if (value === "local") return value;

  if (!URL.canParse(value)) return DEFAULT_CONFIG.panelOrigin;
  const url = new URL(value);

  return url.protocol === "https:" ? url.origin : DEFAULT_CONFIG.panelOrigin;
}
