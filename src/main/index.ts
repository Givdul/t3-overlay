import { join } from "node:path";
import { watch } from "node:fs";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeTheme, screen, session, shell, systemPreferences, type IpcMainEvent, type Rectangle } from "electron";
import {
  PANEL_GAP,
  PANEL_MIN,
  POPOVER_SIZE,
  SIDEBAR_WIDTH,
  TOOLTIP_MAX_WIDTH,
  popoverLeft,
  sameThread,
  slotLeft,
  threadKey,
  type Extent,
  type OverlaySettings,
  type OverlayState,
  type PanelEntrance,
  type PanelTarget,
  type Popover,
  type SidebarProject,
  type SidebarThread,
  type ThreadRef,
} from "../shared/types";
import type { PanelCommand, PanelMessage, PanelReply, VoiceFinishReply, VoiceStartReply } from "../shared/panel";
import type { ThemeTokens } from "../shared/tokens";
import { rememberForeground, returnFocus, takeFocus } from "./focus";
import { configPath, loadConfig, loadPersisted, savePersisted } from "./store";
import { ensureSession, readServer, type T3Server } from "./t3";
import { startThreadFeed, type ThreadFeed } from "./threads";
import { startPanel, type Panel } from "./panel";
import { startVoice, type VoiceEvent, type VoiceStream } from "./voice";
import { clientSettingsPath, readAppearance, resolveTheme, type Appearance } from "./theme";
import { createTray, refreshTray } from "./tray";
import { launchT3WithDebugPort, restartT3WithDebugPort } from "./launch";
import { dispatchCommand } from "./rpc";
import { snoozeChoices } from "./snooze";

const persisted = loadPersisted();
let config = loadConfig();
let win: BrowserWindow | null = null;
let extent: Extent = { sidebarHeight: 160, popoverHeight: null, tooltip: null };

/** T3's desktop client settings (fonts, glass, smoothing). Read from its file, not from a page. */
let appearance: Appearance | null = null;

/** T3's own page tokens, read over the debugging port. Null without it. */
let cdpTokens: Partial<ThemeTokens> | null = null;
let feed: ThreadFeed | null = null;
let panel: Panel | null = null;

/** One recording at a time, owned by main so the media ticket stays here. */
let voice: VoiceStream | null = null;

/** This PC's T3 server while the overlay is connected to it. */
let localServer: T3Server | null = null;

const state: OverlayState = {
  t3: "connecting",
  source: "none",
  threads: [],
  working: [],
  unread: [],
  projects: [],
  theme: resolveTheme(null, null),
  panel: null,
  panelEntrance: "slide",
  panelSize: persisted.panelSize,
  popover: null,
  side: "left",
  sidebarOffsetY: 0,
  opacity: persisted.opacity,
  locked: persisted.locked,
  settings: persisted.settings,
  hotkeyFailed: [],
};

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

  // A panel or popover slot is wider than any tooltip, so a tooltip only widens a bare sidebar.
  const slot = state.panel
    ? state.panelSize
    : state.popover
      ? POPOVER_SIZE[state.popover]
      : extent.tooltip
        ? { width: TOOLTIP_MAX_WIDTH, height: 0 }
        : null;
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

  if (extent.tooltip) {
    // The gap is part of the tooltip's rect: it slides in from the sidebar's edge.
    const { top, width: tipWidth, height } = extent.tooltip;
    const x = state.side === "left" ? SIDEBAR_WIDTH : width - SIDEBAR_WIDTH - PANEL_GAP - tipWidth;
    rects.push({ x, y: top, width: PANEL_GAP + tipWidth, height });
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
  if (target !== null && target !== "draft") persisted.lastThread = target;
  save();
  update({ panel: target, panelEntrance: entrance, popover: null, unread: unreadWithout(target) });
  panel?.setTarget(target);
}

/** A thread is read once the panel shows it. */
function unreadWithout(panel: PanelTarget | null): ThreadRef[] {
  return state.unread.filter((thread) => !sameThread(panel, thread));
}

let lastStates = new Map<string, SidebarThread["state"]>();

/** A thread that stops working while it isn't on screen stays unread until it is opened or works again. */
function nextUnread(threads: SidebarThread[]): ThreadRef[] {
  const unread: ThreadRef[] = [];

  for (const thread of threads) {
    const waitsOnUser = thread.state !== "working" && thread.state !== "idle";
    const onScreen = sameThread(state.panel, thread) && win?.isVisible() === true;
    const stopped = lastStates.get(threadKey(thread)) === "working" && !onScreen;

    if (waitsOnUser && (stopped || state.unread.some((ref) => sameThread(ref, thread)))) {
      unread.push({ environmentId: thread.environmentId, threadId: thread.threadId });
    }
  }

  return unread;
}

function setThreads(threads: SidebarThread[], source: OverlayState["source"]) {
  // A thread that was working a moment ago and is now completed just finished.
  const finished = threads.find((thread) => thread.state === "completed" && lastStates.get(threadKey(thread)) === "working");

  // Opened before the unread pass, so a thread that opens itself is never drawn unread.
  if (finished && state.settings.openWhenDone && state.panel === null && win?.isVisible()) {
    openPanel({ environmentId: finished.environmentId, threadId: finished.threadId });
  }

  const unread = nextUnread(threads);

  lastStates = new Map(threads.map((thread) => [threadKey(thread), thread.state]));
  update({
    source,
    working: threads.filter((thread) => thread.state === "working"),
    threads: threads.filter((thread) => thread.state !== "working" || thread.pinned),
    unread,
  });
}

function setProjects(projects: SidebarProject[]) {
  panel?.setProjects(projects);
  update({ projects });
}

// ---------------------------------------------------------------- theme

/** Custom theme follows T3's page; without it the fallback palette follows the system appearance. */
function applyTheme() {
  update({ theme: resolveTheme(state.settings.customTheme ? cdpTokens : null, appearance) });
}

// ---------------------------------------------------------------- T3 connection

async function connect() {
  const server = await readServer();
  localServer = server;
  if (server === null) {
    feed?.stop();
    feed = null;
    panel?.stop();
    panel = null;
    update({ t3: "offline", source: "none", threads: [], working: [] });
    setTimeout(connect, 5000);
    return;
  }
  try {
    const token = await ensureSession(server);
    appearance = await readAppearance();
    applyTheme();
    update({ t3: "connected" });
    startFeed(server, token);
  } catch (error) {
    console.error("[t3] connect failed", error);
    update({ t3: "offline" });
    setTimeout(connect, 5000);
  }
}

/** A fresh token after T3 rejected this one: the feed and the panel reconnect with it. */
function refreshSession(server: T3Server) {
  void ensureSession(server, true)
    .then((token) => startFeed(server, token))
    .catch((error) => console.error("[t3] session refresh failed", error));
}

function startFeed(server: T3Server, token: string) {
  feed?.stop();
  panel?.stop();
  feed = startThreadFeed({
    server,
    token,
    debugPort: config.debugPort,
    onThreads: setThreads,
    onTokens: (tokens) => {
      cdpTokens = tokens;
      applyTheme();
    },
    onProjects: setProjects,
    onAuthExpired: () => refreshSession(server),
    onLost: () => {
      feed = null;
      update({ t3: "offline", source: "none", threads: [], working: [] });
      setTimeout(connect, 5000);
    },
  });
  panel = startPanel({
    server,
    token,
    environmentId: server.environmentId,
    onMessage: sendPanelMessage,
    onAuthExpired: () => refreshSession(server),
    lastProjectId: () => persisted.lastProjectId,
    onLaunched: (thread, projectId) => {
      persisted.lastProjectId = projectId;
      save();
      openPanel(thread);
    },
  });
  panel.setProjects(state.projects);
  panel.setTarget(state.panel);
}

function sendPanelMessage(message: PanelMessage) {
  win?.webContents.send("overlay:panel", message);
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
    },
  });
  // The overlay's own page never navigates or opens windows; links go to the system browser.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.setAlwaysOnTop(true, "screen-saver");
  win.on("ready-to-show", () => win?.showInactive());
  win.on("show", () => {
    state.unread = unreadWithout(state.panel);
    broadcast();
  });
  win.on("hide", broadcast);
  layout();

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
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

/** Overlay channels answer only the overlay's own window, never a page it opened. */
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

/** The same guard for a handler that takes the renderer's payload. */
function handleHostWith<A extends unknown[], T>(channel: string, handler: (...args: A) => Promise<T> | T) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== win?.webContents) throw new Error(`${channel}: not the overlay window`);

    // SAFETY: the sender is the overlay window, whose preload sends this channel's payload type A.
    return handler(...(args as A));
  });
}

handleHost("overlay:init", () => ({ state }));

onHost("overlay:extent", (_event, next: Partial<Extent>) => {
  // By value: the tooltip's box is an object, and every report of it is a new one.
  if (JSON.stringify({ ...extent, ...next }) === JSON.stringify(extent)) return;

  extent = { ...extent, ...next };
  layout();
  broadcast();
});

onHost("overlay:open", (_event, target: PanelTarget | null) => openPanel(target));

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

async function settle(server: T3Server, thread: ThreadRef) {
  try {
    await dispatchCommand(server, await ensureSession(server), { type: "thread.settle", threadId: thread.threadId });
  } catch (error) {
    console.error("[t3] settle failed", error);
  }
}

onHost("overlay:thread-menu", (_event, thread: ThreadRef) => {
  const server = state.t3 === "connected" ? localServer : null;
  const listed = [...state.threads, ...state.working].find((candidate) => sameThread(thread, candidate));
  // T3 refuses to snooze a thread that waits on the user.
  const waitsOnUser = listed?.state === "approval" || listed?.state === "input";
  // The overlay's own connection reaches this PC's server only.
  const onThisPc = server !== null && server.environmentId === thread.environmentId;

  Menu.buildFromTemplate([
    {
      label: "Settle",
      enabled: onThisPc,
      click: () => {
        if (server !== null) void settle(server, thread);
      },
    },
    {
      // Menu tooltips only show on macOS, so a disabled item says why in its label.
      label: waitsOnUser ? "Snooze (reply first)" : onThisPc ? "Snooze" : "Snooze (this PC only)",
      enabled: onThisPc && !waitsOnUser,
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

onHost("overlay:open-link", (_event, url: string) => {
  if (!URL.canParse(url)) return;
  const parsed = new URL(url);

  // Only the web opens outside: anything else (file:, t3code:) is not a chat link.
  if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.href);
});

onHost("overlay:open-in-t3", (_event, target: ThreadRef | "new") => {
  const url =
    target === "new"
      ? "t3code://new"
      : `t3code://threads/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`;

  void shell.openExternal(url);
});

onHost("overlay:panel-retry", () => {
  if (panel !== null) panel.retry();
  else void connect();
});

handleHostWith("overlay:panel-command", (command: PanelCommand) => {
  const disconnected: PanelReply = { ok: false, error: "T3 is not connected" };

  return panel === null ? disconnected : panel.command(command);
});

// ---------------------------------------------------------------- dictation

function sendVoiceEvent(event: VoiceEvent) {
  win?.webContents.send("overlay:voice", event);
}

handleHostWith("overlay:voice-start", async (): Promise<VoiceStartReply> => {
  if (localServer === null) return { ok: false, error: "T3 is not connected" };

  // macOS gates the microphone at the OS too; the stock Electron build carries the usage string.
  if (process.platform === "darwin") {
    try {
      if (!(await systemPreferences.askForMediaAccess("microphone"))) {
        return { ok: false, error: "Microphone access is off. Allow t3-overlay in System Settings → Privacy & Security → Microphone." };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Microphone access failed" };
    }
  }

  try {
    const token = await ensureSession(localServer);

    voice?.cancel();
    const stream = startVoice({ server: localServer, token, onEvent: sendVoiceEvent });

    voice = stream;
    await stream.start();

    return { ok: true };
  } catch (error) {
    voice = null;

    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

onHost("overlay:voice-audio", (_event, pcm: ArrayBuffer) => voice?.feed(pcm));

handleHostWith("overlay:voice-finish", async (): Promise<VoiceFinishReply> => {
  const active = voice;

  if (active === null) return { ok: false, error: "Voice input is not running" };

  try {
    return { ok: true, text: await active.finish() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    voice = null;
  }
});

onHost("overlay:voice-cancel", () => {
  voice?.cancel();
  voice = null;
});

onHost("overlay:settings", (_event, patch: Partial<OverlaySettings>) => {
  update({ settings: { ...state.settings, ...patch } });
  save();

  if ("customTheme" in patch) applyTheme();
});

// ---------------------------------------------------------------- app

const trayActions = {
  toggleVisible,
  setLocked: (locked: boolean) => {
    update({ locked });
    save();
  },
  launchT3: () => void launchT3WithDebugPort(config.debugPort),
  restartT3: () => void restartT3WithDebugPort(config.debugPort),
  editConfig: () => void shell.openPath(configPath()),
  quit: () => app.quit(),
};

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  createWindow();
  createTray(trayActions);
  registerHotkeys();
  // The page asks for the microphone and the clipboard; only the overlay's own window may have them.
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      contents === win?.webContents &&
      ((permission === "media" && details.mediaType === "audio") || permission === "clipboard-sanitized-write"),
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    callback(
      contents === win?.webContents &&
        ((permission === "media" && mediaTypes.length > 0 && mediaTypes.every((kind) => kind === "audio")) ||
          permission === "clipboard-sanitized-write"),
    );
  });
  watch(configPath(), () => {
    config = loadConfig();
    registerHotkeys();
  });
  // T3 writes its appearance settings whenever the user changes a font size, the glass or smoothing.
  let appearanceTimer: NodeJS.Timeout | null = null;
  watch(clientSettingsPath(), () => {
    if (appearanceTimer) clearTimeout(appearanceTimer);
    appearanceTimer = setTimeout(() => {
      void readAppearance().then((next) => {
        appearance = next;
        applyTheme();
      });
    }, 150);
  });
  nativeTheme.on("updated", applyTheme);
  screen.on("display-removed", layout);
  screen.on("display-metrics-changed", layout);
  void connect();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
