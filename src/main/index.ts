import { join } from "node:path";
import { watch } from "node:fs";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, session, shell, type IpcMainEvent, type Rectangle, type WebFrameMain } from "electron";
import {
  PANEL_GAP,
  PANEL_MIN,
  POPOVER_SIZE,
  SIDEBAR_WIDTH,
  popoverLeft,
  sameThread,
  slotLeft,
  type Extent,
  type GuestClientSettings,
  type OverlaySettings,
  type OverlayState,
  type PanelEntrance,
  type PanelTarget,
  type Popover,
  type SidebarThread,
  type ThreadRef,
} from "../shared/types";
import type { ThemeStorage } from "../shared/theme";
import { rememberForeground, returnFocus, takeFocus } from "./focus";
import { configPath, loadConfig, loadPersisted, savePersisted } from "./store";
import {
  ensureSession,
  sessionTarget,
  readDesktopClientSettings,
  readServer,
  T3_PARTITION,
  type T3Server,
} from "./t3";
import { startThreadFeed, type ThreadFeed } from "./threads";
import { createTray, refreshTray } from "./tray";
import { launchT3WithDebugPort, restartT3WithDebugPort } from "./launch";
import { dispatchCommand } from "./rpc";
import { snoozeChoices } from "./snooze";
import { setReducedMotion, trackMotion } from "./motion";

const persisted = loadPersisted();
let config = loadConfig();
let win: BrowserWindow | null = null;
let extent: Extent = { sidebarHeight: 160, popoverHeight: null };
let clientSettings: string | null = null;
/** The desktop app's theme keys, read over the debugging port. Null without it. */
let themeStorage: ThemeStorage | null = null;
let feed: ThreadFeed | null = null;

/** This PC's T3 server while the overlay is connected to it. */
let localServer: T3Server | null = null;

const state: OverlayState = {
  origin: null,
  panelHosted: false,
  t3: "connecting",
  source: "none",
  threads: [],
  working: [],
  panel: null,
  panelEntrance: "slide",
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

/** Sizes the window around the sidebar and its open surface. Returns whether the sidebar moved inside it. */
function layout(): boolean {
  if (!win) return false;
  const a = anchor();
  const display = screen.getDisplayNearestPoint(a);
  const area = display.workArea;
  const side = a.x + SIDEBAR_WIDTH / 2 < area.x + area.width / 2 ? "left" : "right";
  const slot = state.panel ? state.panelSize : state.popover ? POPOVER_SIZE[state.popover] : null;
  const slotSpan = slot ? PANEL_GAP + slot.width : 0;
  const height = Math.min(area.height, Math.max(extent.sidebarHeight, slot?.height ?? 0));
  const x = side === "left" ? a.x : a.x - slotSpan;
  const y = Math.max(area.y, Math.min(a.y, area.y + area.height - height));
  const moved = side !== state.side || a.y - y !== state.sidebarOffsetY;
  state.side = side;
  state.sidebarOffsetY = a.y - y;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: SIDEBAR_WIDTH + slotSpan, height: Math.round(height) });
  shape(SIDEBAR_WIDTH + slotSpan, display.scaleFactor);
  return moved;
}

// The window's shape is the surfaces it draws, placed as App.tsx places them. Clicks outside them reach the
// game through Windows' own hit testing. setIgnoreMouseEvents' forward mode would instead install a low-level
// mouse hook, which runs on this thread for every mouse move on the system, game input included.
let lastShape = "";

/** Electron turns the shape into pixels at the window's current scale, so a new scale sets it again. */
function shape(width: number, scaleFactor: number) {
  // macOS has no window shapes. There the transparent gaps take clicks.
  if (!win || process.platform === "darwin") return;
  const rects: Rectangle[] = [
    { x: state.side === "left" ? 0 : width - SIDEBAR_WIDTH, y: state.sidebarOffsetY, width: SIDEBAR_WIDTH, height: extent.sidebarHeight },
  ];
  if (state.panel) rects.push({ x: slotLeft(state.side), y: 0, ...state.panelSize });
  if (state.popover) {
    const size = POPOVER_SIZE[state.popover];
    const height = extent.popoverHeight ?? size.height;
    rects.push({ x: popoverLeft(state, state.popover), y: state.sidebarOffsetY, width: size.width, height });
  }
  const key = JSON.stringify([scaleFactor, rects]);
  if (key === lastShape) return;
  lastShape = key;
  win.setShape(rects);
}

function update(patch: Partial<OverlayState>) {
  Object.assign(state, patch);
  layout();
  broadcast();
}

function openPanel(target: PanelTarget | null, entrance: PanelEntrance = "slide") {
  if (target !== null && typeof target === "object") persisted.lastThread = target;
  save();
  update({ panel: target, panelEntrance: entrance, popover: null });
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
  localServer = server;
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
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  });
  // The overlay's own page never navigates or opens windows; only the T3 webview inside it does.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.setAlwaysOnTop(true, "screen-saver");
  win.on("focus", () => setReducedMotion(false));
  win.on("blur", () => setReducedMotion(true));
  win.on("ready-to-show", () => win?.showInactive());
  win.on("show", broadcast);
  win.on("hide", broadcast);
  layout();

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    webPreferences.preload = guestPreload;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = true;
    params.partition = T3_PARTITION;

    if (!isT3Origin(params.src)) event.preventDefault();
  });
  if (contents.getType() === "webview") {
    trackMotion(contents);
    // The panel never opens app windows. Web links from T3's own page go to the default browser; a page
    // T3 navigated to can't open browser tabs. Electron only consults this because the panel's webview
    // sets `allowpopups`. Without it, T3's `window.open` for a system-browser link opens nothing.
    contents.setWindowOpenHandler(({ url }) => {
      const parsed = parseUrl(url);
      const web = parsed?.protocol === "https:" || parsed?.protocol === "http:";

      if (parsed !== null && web && isT3Origin(contents.getURL())) void shell.openExternal(parsed.href);

      return { action: "deny" };
    });
  }
});

/** A frame that has gone away throws on access; its requests count as from nowhere. */
function frameUrl(frame: WebFrameMain | null | undefined): string | undefined {
  try {
    return frame?.url;
  } catch {
    return undefined;
  }
}

function parseUrl(url: string | undefined): URL | null {
  if (url === undefined || !URL.canParse(url)) return null;

  return new URL(url);
}

/** Whether `url` is on the T3 origin the panel loads. Only that origin gets the panel's grants and data. */
function isT3Origin(url: string | undefined): boolean {
  return state.origin !== null && parseUrl(url)?.origin === new URL(state.origin).origin;
}

function configureT3Partition() {
  const t3 = session.fromPartition(T3_PARTITION);
  // Identity providers such as Google refuse sign-in from pages that announce an embedded Electron app.
  t3.setUserAgent(t3.getUserAgent().replace(/ (Electron|t3-overlay)\/\S+/g, ""));
  // The microphone (dictation) and clipboard are T3's own; pages the panel navigates to get neither.
  t3.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const media = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    const granted = (permission === "media" && !media.includes("video")) || permission.startsWith("clipboard");
    callback(granted && isT3Origin(details.requestingUrl));
  });
  t3.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const granted = (permission === "media" && details.mediaType !== "video") || permission.startsWith("clipboard");

    return granted && isT3Origin(requestingOrigin);
  });
  // The session cookie holds T3's bearer token. Only T3's own page sends it, and only to a connected T3 server:
  // not to another loopback port, not for a page T3 navigated to, and not to a port T3 may have left.
  t3.webRequest.onBeforeSendHeaders((details, callback) => {
    const { requestHeaders } = details;
    const target = sessionTarget(details.url);

    // A navigation counts by where it goes, so only a GET: a form another page posts to T3 carries no session.
    const fromT3 =
      details.resourceType === "mainFrame"
        ? details.method === "GET" && isT3Origin(details.url)
        : isT3Origin(frameUrl(details.frame));

    if (target === "other port" || (target === "server" && !(fromT3 && state.t3 === "connected"))) {
      for (const name of Object.keys(requestHeaders)) if (name.toLowerCase() === "cookie") delete requestHeaders[name];
    }

    callback({ requestHeaders });
  });
}

// ---------------------------------------------------------------- drag and resize

let dragTimer: NodeJS.Timeout | null = null;

function startDrag(kind: "move" | "resize") {
  if (kind === "move" && state.locked) return;
  const cursor0 = screen.getCursorScreenPoint();
  const anchor0 = anchor();
  const size0 = { ...state.panelSize };
  const side = state.side;
  let last = cursor0;
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    const cursor = screen.getCursorScreenPoint();
    if (cursor.x === last.x && cursor.y === last.y) return;
    last = cursor;
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
    // A move re-renders only when the sidebar shifts inside the window, such as at a screen edge.
    if (layout() || kind === "resize") broadcast();
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

  if (state.panel === null) openPanel(persisted.lastThread ?? "draft", "instant");
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

/** Overlay channels answer only the overlay's own window, never the T3 webview or a page it opened. */
function onHost<A extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: A) => void) {
  ipcMain.on(channel, (event, ...args) => {
    if (event.sender !== win?.webContents) return;

    // SAFETY: the sender is the overlay window, whose preload sends this channel's payload type A.
    listener(event, ...(args as A));
  });
}

function handleHost<T>(channel: string, handler: () => T) {
  ipcMain.handle(channel, (event) => {
    if (event.sender !== win?.webContents) throw new Error(`${channel}: not the overlay window`);

    return handler();
  });
}

handleHost("overlay:init", () => ({ state }));

handleHost("overlay:get-theme-storage", () => themeStorage);

onHost("overlay:extent", (_event, next: Partial<Extent>) => {
  if (Object.entries(next).every(([key, value]) => extent[key as keyof Extent] === value)) return;
  extent = { ...extent, ...next };
  layout();
  broadcast();
});

onHost("overlay:open", (_event, target: PanelTarget | null) => openPanel(target));

onHost("overlay:follow", (_event, thread: ThreadRef) => {
  if (state.panel !== null && !sameThread(state.panel, thread)) openPanel(thread);
});

onHost("overlay:popover", (_event, popover: Popover | null) => {
  // Until the new popover reports its height, the window's shape covers its largest size.
  extent = { ...extent, popoverHeight: null };
  update({ popover });
});

async function snooze(server: T3Server, thread: ThreadRef, until: Date) {
  try {
    await dispatchCommand(server, await ensureSession(server), { type: "thread.snooze", threadId: thread.threadId, snoozedUntil: until.toISOString() });
  } catch (error) {
    console.error("[t3] snooze failed", error);
  }
}

onHost("overlay:thread-menu", (_event, thread: ThreadRef) => {
  const server = localServer;
  const listed = [...state.threads, ...state.working].find((candidate) => sameThread(thread, candidate));
  // T3 refuses to snooze a thread that waits on the user.
  const waitsOnUser = listed?.state === "approval" || listed?.state === "input";
  // The overlay's own connection reaches this PC's server only.
  const onThisPc = server !== null && server.environmentId === thread.environmentId;

  Menu.buildFromTemplate([
    { label: "Settle", click: () => win?.webContents.send("overlay:settle", thread) },
    {
      label: "Snooze",
      enabled: onThisPc && !waitsOnUser,
      toolTip: waitsOnUser ? "Respond to the thread first" : onThisPc ? undefined : "Only threads on this PC can be snoozed here",
      submenu: snoozeChoices(new Date()).map((choice) => ({
        label: choice.label,
        click: () => server && void snooze(server, thread, choice.until),
      })),
    },
  ]).popup({ window: win ?? undefined });
});

onHost("overlay:opacity", (_event, opacity: number) => {
  update({ opacity });
  save();
});

onHost("overlay:lock", (_event, locked: boolean) => {
  update({ locked });
  save();
});

onHost("overlay:drag-start", (_event, kind: "move" | "resize") => startDrag(kind));

onHost("overlay:drag-end", endDrag);

onHost("overlay:hover", () => {
  if (win && !win.isFocused()) rememberForeground(win);
});

onHost("overlay:escape", () => {
  if (!win) return;
  openPanel(null);
  returnFocus(win);
});

onHost("overlay:sent", () => {
  if (!win) return;
  if (state.settings.closeOnSend) openPanel(null);
  returnFocus(win);
});

onHost("overlay:settings", (_event, patch: Partial<OverlaySettings>) => {
  update({ settings: { ...state.settings, ...patch } });
  save();
});

onHost("overlay:hooks", (_event, missing: string[]) => {
  if (missing.length > 0) console.warn("[t3] layout hooks missing", missing);
  update({ layoutChanged: missing.length > 0 });
});
ipcMain.on("guest:client-settings", (event) => {
  // The guest preload runs on every page the webview loads; only T3's own page gets the desktop settings.
  const fromT3 = event.sender.getType() === "webview" && isT3Origin(event.senderFrame?.url);
  const reply: GuestClientSettings = fromT3 ? { settings: clientSettings } : null;

  event.returnValue = reply;
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
