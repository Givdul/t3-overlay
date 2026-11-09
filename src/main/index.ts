import { join } from "node:path";
import { watch } from "node:fs";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, session, shell } from "electron";
import {
  PANEL_GAP,
  PANEL_MIN,
  POPOVER_SIZE,
  SIDEBAR_WIDTH,
  sameThread,
  type Extent,
  type OverlaySettings,
  type OverlayState,
  type PanelTarget,
  type Popover,
  type SidebarThread,
  type ThreadRef,
} from "../shared/types";
import type { ThemeStorage } from "../shared/theme";
import { rememberForeground, returnFocus, takeFocus } from "./focus";
import { configPath, loadConfig, loadPersisted, savePersisted } from "./store";
import { ensureSession, readDesktopClientSettings, readServer, T3_PARTITION, type T3Server } from "./t3";
import { startThreadFeed, type ThreadFeed } from "./threads";
import { createTray, refreshTray } from "./tray";
import { launchT3WithDebugPort, restartT3WithDebugPort } from "./launch";

const persisted = loadPersisted();
let config = loadConfig();
let win: BrowserWindow | null = null;
let extent: Extent = { sidebarHeight: 160 };
let clientSettings: string | null = null;
/** The desktop app's theme keys, read over the debugging port. Null without it. */
let themeStorage: ThemeStorage | null = null;
let feed: ThreadFeed | null = null;

const state: OverlayState = {
  origin: null,
  panelHosted: false,
  t3: "connecting",
  source: "none",
  threads: [],
  working: [],
  panel: null,
  panelSize: persisted.panelSize,
  popover: null,
  side: "left",
  sidebarOffsetY: 0,
  opacity: persisted.opacity,
  locked: persisted.locked,
  settings: persisted.settings,
  layoutChanged: false,
  hotkeyFailed: [],
};

const guestPreload = join(import.meta.dirname, "../preload/guest.cjs");

function save() {
  persisted.panelSize = state.panelSize;
  persisted.opacity = state.opacity;
  persisted.locked = state.locked;
  persisted.settings = state.settings;
  savePersisted(persisted);
}

function broadcast() {
  win?.webContents.send("overlay:state", state);
  refreshTray(state, win?.isVisible() ?? false);
}

function anchor(): { x: number; y: number } {
  const saved = persisted.anchor;
  if (saved && screen.getAllDisplays().some((display) => display.id === saved.displayId)) return saved;
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x, y: Math.round(area.y + area.height / 2 - extent.sidebarHeight / 2) };
}

function layout() {
  if (!win) return;
  const a = anchor();
  const area = screen.getDisplayNearestPoint(a).workArea;
  state.side = a.x + SIDEBAR_WIDTH / 2 < area.x + area.width / 2 ? "left" : "right";
  const slot = state.panel ? state.panelSize : state.popover ? POPOVER_SIZE[state.popover] : null;
  const slotSpan = slot ? PANEL_GAP + slot.width : 0;
  const height = Math.min(area.height, Math.max(extent.sidebarHeight, slot?.height ?? 0));
  const x = state.side === "left" ? a.x : a.x - slotSpan;
  const y = Math.max(area.y, Math.min(a.y, area.y + area.height - height));
  state.sidebarOffsetY = a.y - y;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: SIDEBAR_WIDTH + slotSpan, height: Math.round(height) });
}

function update(patch: Partial<OverlayState>) {
  Object.assign(state, patch);
  layout();
  broadcast();
}

function openPanel(target: PanelTarget | null) {
  if (target !== null && typeof target === "object") persisted.lastThread = target;
  save();
  update({ panel: target, popover: null });
}

const threadKey = (thread: ThreadRef) => `${thread.environmentId}:${thread.threadId}`;
let lastStates = new Map<string, SidebarThread["state"]>();

function setThreads(threads: SidebarThread[], source: OverlayState["source"]) {
  // A thread that was working a moment ago and is now completed just finished.
  const finished = threads.find((thread) => thread.state === "completed" && lastStates.get(threadKey(thread)) === "working");
  lastStates = new Map(threads.map((thread) => [threadKey(thread), thread.state]));
  if (finished && state.settings.openWhenDone && state.panel === null && win?.isVisible()) {
    openPanel({ environmentId: finished.environmentId, threadId: finished.threadId });
  }
  update({
    source,
    working: threads.filter((thread) => thread.state === "working"),
    threads: threads.filter((thread) => thread.state !== "working" || thread.pinned),
  });
}

// ---------------------------------------------------------------- T3 connection

async function connect() {
  const server = await readServer();
  if (server === null) {
    feed?.stop();
    feed = null;
    update({ t3: "offline", origin: null, source: "none", threads: [], working: [] });
    setTimeout(connect, 5000);
    return;
  }
  try {
    const token = await ensureSession(server);
    clientSettings = await readDesktopClientSettings();
    update({ t3: "connected", ...panelOrigin(server) });
    startFeed(server, token);
  } catch (error) {
    console.error("[t3] connect failed", error);
    update({ t3: "offline" });
    setTimeout(connect, 5000);
  }
}

function panelOrigin(server: T3Server): Pick<OverlayState, "origin" | "panelHosted"> {
  const hosted = config.panelOrigin !== "local";
  return { origin: hosted ? config.panelOrigin : server.origin, panelHosted: hosted };
}

function startFeed(server: T3Server, token: string) {
  feed?.stop();
  feed = startThreadFeed({
    server,
    token,
    debugPort: config.debugPort,
    onThreads: setThreads,
    onThemeStorage: (storage) => {
      if (JSON.stringify(storage) === JSON.stringify(themeStorage)) return;
      themeStorage = storage;
      win?.webContents.send("overlay:theme-storage", storage);
    },
    onAuthExpired: () => void ensureSession(server, true).catch((error) => console.error(error)),
    onLost: () => {
      feed = null;
      update({ t3: "offline", source: "none", threads: [], working: [] });
      setTimeout(connect, 5000);
    },
  });
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: SIDEBAR_WIDTH,
    height: extent.sidebarHeight,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      webviewTag: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.on("ready-to-show", () => win?.showInactive());
  win.on("show", broadcast);
  win.on("hide", broadcast);
  layout();

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    webPreferences.preload = guestPreload;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = true;
    params.partition = T3_PARTITION;
    if (state.origin === null || !params.src?.startsWith(state.origin)) event.preventDefault();
  });
  if (contents.getType() === "webview") {
    contents.setWindowOpenHandler(({ url }) => {
      // T3 Connect sign-in may pop up auth pages (T3, Clerk, or the identity provider while connecting);
      // they must share the webview's session. Other links open in the default browser.
      if (state.panel === "connect" || /(^|\.)t3\.codes$|clerk/.test(new URL(url).hostname)) {
        return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition: T3_PARTITION } } };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });
  }
});

function configureT3Partition() {
  const t3 = session.fromPartition(T3_PARTITION);
  // Identity providers such as Google refuse sign-in from pages that announce an embedded Electron app.
  t3.setUserAgent(t3.getUserAgent().replace(/ (Electron|t3-overlay)\/\S+/g, ""));
  t3.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const media = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    callback((permission === "media" && !media.includes("video")) || permission.startsWith("clipboard"));
  });
  t3.setPermissionCheckHandler((_contents, permission) => permission === "media" || permission.startsWith("clipboard"));
}

// ---------------------------------------------------------------- drag and resize

let dragTimer: NodeJS.Timeout | null = null;

function startDrag(kind: "move" | "resize") {
  if (kind === "move" && state.locked) return;
  const cursor0 = screen.getCursorScreenPoint();
  const anchor0 = anchor();
  const size0 = { ...state.panelSize };
  const side = state.side;
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - cursor0.x;
    const dy = cursor.y - cursor0.y;
    if (kind === "move") {
      const point = { x: anchor0.x + dx, y: anchor0.y + dy };
      const area = screen.getDisplayNearestPoint(point).workArea;
      const x = Math.max(area.x, Math.min(point.x, area.x + area.width - SIDEBAR_WIDTH));
      const y = Math.max(area.y, Math.min(point.y, area.y + area.height - extent.sidebarHeight));
      persisted.anchor = { displayId: screen.getDisplayNearestPoint(point).id, x, y };
    } else {
      const area = screen.getDisplayNearestPoint(anchor0).workArea;
      const width = side === "left" ? size0.width + dx : size0.width - dx;
      state.panelSize = {
        width: Math.max(PANEL_MIN.width, Math.min(width, area.width - SIDEBAR_WIDTH - PANEL_GAP)),
        height: Math.max(PANEL_MIN.height, Math.min(size0.height + dy, area.height)),
      };
    }
    layout();
    broadcast();
  }, 16);
}

function endDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  save();
}

// ---------------------------------------------------------------- hotkeys

function focusComposer() {
  if (!win) return;
  rememberForeground(win);
  if (!win.isVisible()) win.showInactive();
  if (state.panel === null) openPanel(persisted.lastThread ?? "draft");
  takeFocus(win);
  win.webContents.send("overlay:focus-composer");
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const failed: string[] = [];
  const bind = (accelerator: string, action: () => void) => {
    try {
      if (!globalShortcut.register(accelerator, action)) failed.push(accelerator);
    } catch {
      failed.push(accelerator);
    }
  };
  bind(config.hotkeys.focus, focusComposer);
  bind(config.hotkeys.toggle, toggleVisible);
  update({ hotkeyFailed: failed });
}

// ---------------------------------------------------------------- IPC

ipcMain.handle("overlay:init", () => ({ state }));
ipcMain.handle("overlay:get-theme-storage", () => themeStorage);
ipcMain.on("overlay:extent", (_event, next: Extent) => {
  if (next.sidebarHeight === extent.sidebarHeight) return;
  extent = next;
  layout();
  broadcast();
});
ipcMain.on("overlay:open", (_event, target: PanelTarget | null) => openPanel(target));
ipcMain.on("overlay:follow", (_event, thread: ThreadRef) => {
  if (state.panel !== null && !sameThread(state.panel, thread)) openPanel(thread);
});
ipcMain.on("overlay:popover", (_event, popover: Popover | null) => update({ popover }));
ipcMain.on("overlay:thread-menu", (_event, thread: ThreadRef) => {
  Menu.buildFromTemplate([
    { label: "Settle", click: () => win?.webContents.send("overlay:settle", thread) },
  ]).popup({ window: win ?? undefined });
});
ipcMain.on("overlay:opacity", (_event, opacity: number) => {
  update({ opacity });
  save();
});
ipcMain.on("overlay:lock", (_event, locked: boolean) => {
  update({ locked });
  save();
});
ipcMain.on("overlay:drag-start", (_event, kind: "move" | "resize") => startDrag(kind));
ipcMain.on("overlay:drag-end", endDrag);
ipcMain.on("overlay:ignore-mouse", (_event, ignore: boolean) => win?.setIgnoreMouseEvents(ignore, { forward: true }));
ipcMain.on("overlay:hover", () => {
  if (win && !win.isFocused()) rememberForeground(win);
});
ipcMain.on("overlay:escape", () => {
  if (!win) return;
  openPanel(null);
  returnFocus(win);
});
ipcMain.on("overlay:sent", () => {
  if (!win) return;
  if (state.settings.closeOnSend) openPanel(null);
  returnFocus(win);
});
ipcMain.on("overlay:settings", (_event, patch: Partial<OverlaySettings>) => {
  update({ settings: { ...state.settings, ...patch } });
  save();
});
ipcMain.on("overlay:hooks", (_event, missing: string[]) => {
  if (missing.length > 0) console.warn("[t3] layout hooks missing", missing);
  update({ layoutChanged: missing.length > 0 });
});
ipcMain.on("guest:client-settings", (event) => {
  event.returnValue = clientSettings;
});

// ---------------------------------------------------------------- app

const trayActions = {
  toggleVisible,
  setLocked: (locked: boolean) => {
    update({ locked });
    save();
  },
  connectMachines: () => openPanel("connect"),
  launchT3: () => void launchT3WithDebugPort(config.debugPort),
  restartT3: () => void restartT3WithDebugPort(config.debugPort),
  editConfig: () => void shell.openPath(configPath()),
  quit: () => app.quit(),
};

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  configureT3Partition();
  createWindow();
  createTray(trayActions);
  registerHotkeys();
  watch(configPath(), () => {
    config = loadConfig();
    registerHotkeys();
    if (state.t3 === "connected") void readServer().then((server) => server && update(panelOrigin(server)));
  });
  screen.on("display-removed", layout);
  screen.on("display-metrics-changed", layout);
  void connect();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
