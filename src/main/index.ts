import { join } from "node:path";
import { watch } from "node:fs";
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, shell, type IpcMainEvent, type Rectangle } from "electron";
import {
  PANEL_GAP,
  PANEL_MIN,
  POPOVER_SIZE,
  SIDEBAR_SLOT_HEIGHT,
  SIDEBAR_WIDTH,
  TOOLTIP_MAX_WIDTH,
  popoverLeft,
  sameThread,
  sidebarHeight,
  slotLeft,
  threadKey,
  type DragKind,
  type Extent,
  type OverlaySettings,
  type OverlayState,
  type PanelEntrance,
  type PanelSurface,
  type Popover,
  type SidebarThread,
  type ThreadRef,
  threadTarget,
} from "../shared/types";
import type { PanelCommand, PanelCreateReply, PanelDraftCommand, PanelDraftReply, PanelMessage } from "../shared/panel";
import { createBackoff, STABLE_AFTER_MS } from "./backoff";
import { rememberForeground, returnFocus, takeFocus } from "./focus";
import { configPath, loadConfig, loadPersisted, savePersisted } from "./store";
import { ensureSession, readServer, type T3Server } from "./t3";
import { startThreadFeed, type ThreadFeed } from "./threads";
import type { ShellProject } from "./shell";
import { createThread, readDraft } from "./draft";
import { startPanel, type Panel } from "./panel";
import { createTray, refreshTray } from "./tray";
import { launchT3 } from "./launch";
import { AuthExpiredError, dispatchCommand } from "./rpc";
import { snoozeChoices } from "./snooze";

const persisted = loadPersisted();
let config = loadConfig();
let win: BrowserWindow | null = null;

let extent: Extent = { sidebarHeight: 160, popoverHeight: null, tooltip: null };
let feed: ThreadFeed | null = null;
let panel: Panel | null = null;

/** This PC's T3 server while the overlay is connected to it. */
let localServer: T3Server | null = null;

/** The shell's projects, which the panel's new-thread draft lists. */
let projects: ShellProject[] = [];

const state: OverlayState = {
  t3: "connecting",
  threads: [],
  working: [],
  unread: [],
  panel: null,
  panelEntrance: "slide",
  panelSize: persisted.panelSize,
  popover: null,
  side: "left",
  sidebarOffsetY: 0,
  sidebarListHeight: persisted.sidebarListHeight,
  opacity: persisted.opacity,
  locked: persisted.locked,
  settings: persisted.settings,
  hotkeyFailed: [],
};

function save() {
  persisted.panelSize = state.panelSize;
  persisted.sidebarListHeight = state.sidebarListHeight;
  persisted.opacity = state.opacity;
  persisted.locked = state.locked;
  persisted.settings = state.settings;
  savePersisted(persisted);
}

function broadcast() {
  win?.webContents.send("overlay:state", state);
  refreshTray(state, win?.isVisible() ?? false);
}

function anchor() {
  const saved = persisted.anchor;
  if (saved && screen.getAllDisplays().some((display) => display.id === saved.displayId)) return saved;

  const display = screen.getPrimaryDisplay();
  const area = display.workArea;

  return { displayId: display.id, x: area.x, y: Math.round(area.y + area.height / 2 - extent.sidebarHeight / 2) };
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

function openPanel(target: PanelSurface, entrance: PanelEntrance = "slide") {
  const thread = threadTarget(target);

  // The draft is not a thread: the hotkey still reopens the last thread that was read.
  if (thread !== null) persisted.lastThread = thread;
  save();
  update({ panel: target, panelEntrance: entrance, popover: null, unread: unreadWithout(target) });
  panel?.setTarget(thread);
}

/** A thread is read once the panel shows it. */
function unreadWithout(panel: PanelSurface): ThreadRef[] {
  return state.unread.filter((thread) => !sameThread(panel, thread));
}

/** The thread updated most recently: the hotkey's target when nothing was read yet. */
function newestThread(): ThreadRef | null {
  const newest = [...state.threads, ...state.working].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

  return newest === undefined ? null : { environmentId: newest.environmentId, threadId: newest.threadId };
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

function setThreads(threads: SidebarThread[]) {
  // A thread that was working a moment ago and is now completed just finished.
  const finished = threads.find((thread) => thread.state === "completed" && lastStates.get(threadKey(thread)) === "working");

  // Opened before the unread pass, so a thread that opens itself is never drawn unread.
  if (finished && state.settings.openWhenDone && state.panel === null && win?.isVisible()) {
    openPanel({ environmentId: finished.environmentId, threadId: finished.threadId });
  }

  const unread = nextUnread(threads);

  lastStates = new Map(threads.map((thread) => [threadKey(thread), thread.state]));
  update({
    working: threads.filter((thread) => thread.state === "working"),
    threads: threads.filter((thread) => thread.state !== "working" || thread.pinned),
    unread,
  });
}

// ---------------------------------------------------------------- T3 connection

/** The shell connection's retry ladder: the panel's own socket climbs the same policy on its own. */
const backoff = createBackoff();
let retryTimer: NodeJS.Timeout | null = null;

/** When the shell connection came up, so one that stayed up long enough resets the ladder. */
let connectedAt: number | null = null;

/** The server and token the live panel belongs to: another connection needs a new panel. */
let panelSession: { origin: string; token: string } | null = null;

async function connect() {
  const server = await readServer();
  localServer = server;
  if (server === null) {
    stopFeed();
    update({ t3: "offline", threads: [], working: [] });
    retryConnection();
    return;
  }
  try {
    const token = await ensureSession(server);
    update({ t3: "connected" });
    startFeed(server, token);
    // The feed's socket opens a moment later; losing it before the reset window keeps the ladder high.
    connectedAt = Date.now();
  } catch (error) {
    console.error("[t3] connect failed", error);
    update({ t3: "offline" });
    retryConnection();
  }
}

/** Retries the connection on the shared backoff, so a restarted server does not draw every retry at once. */
function retryConnection() {
  if (retryTimer !== null) return;

  if (connectedAt !== null && Date.now() - connectedAt >= STABLE_AFTER_MS) backoff.reset();

  connectedAt = null;
  const delay = backoff.nextDelay();
  console.warn(`[t3] reconnecting in ${delay}ms`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

function stopFeed() {
  feed?.stop();
  feed = null;
}

function startFeed(server: T3Server, token: string) {
  stopFeed();
  feed = startThreadFeed({
    server,
    token,
    onThreads: setThreads,
    onProjects: (next) => {
      if (JSON.stringify(next) === JSON.stringify(projects)) return;

      projects = next;
    },
    onAuthExpired: () => refreshSession(server),
    onLost: () => {
      // T3 dropped the shell's socket. The panel has its own socket and resumes on its own.
      stopFeed();
      update({ t3: "offline", threads: [], working: [] });
      retryConnection();
    },
  });

  // A reconnect of the same server with the same token leaves the panel's stream, and the sequence it
  // resumes after, alone; a new server or a fresh token needs a new one.
  if (panel !== null && panelSession?.origin === server.origin && panelSession.token === token) return;

  panel?.stop();
  panelSession = { origin: server.origin, token };
  panel = startPanel({
    server,
    token,
    environmentId: server.environmentId,
    onMessage: sendPanelMessage,
    onAuthExpired: () => refreshSession(server),
  });
  panel.setTarget(threadTarget(state.panel));
}

function sendPanelMessage(message: PanelMessage) {
  win?.webContents.send("overlay:panel", message);
}

/** A fresh token after T3 rejected this one: the feed and the panel reconnect with it. */
function refreshSession(server: T3Server) {
  void ensureSession(server, true)
    .then((token) => startFeed(server, token))
    .catch((error) => console.error("[t3] session refresh failed", error));
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
  // Electron approves every permission request when no handler is installed. The overlay's own page asks
  // for two: the microphone for the composer's dictation, and the clipboard for a message's Copy button
  // (`navigator.clipboard.writeText` is a `clipboard-sanitized-write`). Everything else is refused, and
  // only the overlay's own page may ask.
  const contents = win.webContents;
  contents.session.setPermissionRequestHandler((sender, permission, callback, details) => {
    // The composer records audio only; the camera is never opened.
    const audio = permission === "media" && "mediaTypes" in details && details.mediaTypes?.every((type) => type === "audio") === true;

    callback(sender === contents && (permission === "clipboard-sanitized-write" || audio));
  });
  contents.session.setPermissionCheckHandler(
    (sender, permission, _origin, details) =>
      sender === contents &&
      (permission === "clipboard-sanitized-write" || (permission === "media" && details.mediaType !== "video")),
  );
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

/** The bottom the sidebar keeps while its top edge is dragged. */
let dragBottom: number | null = null;

/** While a sidebar edge moves, main sizes the sidebar itself instead of by the renderer's height reports. */
let sidebarDragging = false;

/** Sizes the sidebar from main's own list height, so the fixed edge holds instead of following a report a round trip later. */
function sizeSidebar() {
  extent.sidebarHeight = sidebarHeight(state.threads.length, state.working.length, state.sidebarListHeight);

  if (dragBottom !== null) persisted.anchor = { ...anchor(), y: Math.round(dragBottom - extent.sidebarHeight) };
}

function maxSidebarListHeight(area: Rectangle, top: number, bottom: number, kind: DragKind): number {
  // The edge that stays put leaves only the work area on the other side of it to grow into.
  const room = kind === "sidebar-top" ? bottom - area.y : area.y + area.height - top;
  const chrome = sidebarHeight(state.threads.length, state.working.length, 0);

  return Math.max(SIDEBAR_SLOT_HEIGHT, room - chrome);
}

function startDrag(kind: DragKind) {
  if (state.locked && kind !== "resize") return;
  const cursor0 = screen.getCursorScreenPoint();
  const anchor0 = anchor();
  const size0 = { ...state.panelSize };
  // Grow the list from what shows, so the edge moves with fewer threads than the list has height for.
  const listHeight0 = Math.min(state.threads.length * SIDEBAR_SLOT_HEIGHT, state.sidebarListHeight);
  const side = state.side;
  const area = screen.getDisplayNearestPoint(anchor0).workArea;
  const bottom0 = Math.min(anchor0.y + extent.sidebarHeight, area.y + area.height);
  const sidebarDrag = kind === "sidebar-top" || kind === "sidebar-bottom";

  if (sidebarDrag) persisted.anchor = anchor0;
  dragBottom = kind === "sidebar-top" ? bottom0 : null;
  sidebarDragging = sidebarDrag;
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
    } else if (kind === "resize") {
      const width = side === "left" ? size0.width + dx : size0.width - dx;
      state.panelSize = {
        width: Math.max(PANEL_MIN.width, Math.min(width, area.width - SIDEBAR_WIDTH - PANEL_GAP)),
        height: Math.max(PANEL_MIN.height, Math.min(size0.height + dy, area.height)),
      };
    } else {
      const max = maxSidebarListHeight(area, anchor0.y, bottom0, kind);
      // The list follows the cursor by the pixel, from the height it showed when the drag began.
      const listHeight = Math.max(SIDEBAR_SLOT_HEIGHT, Math.min(listHeight0 + (kind === "sidebar-top" ? -dy : dy), max));

      if (listHeight === state.sidebarListHeight) return;

      state.sidebarListHeight = listHeight;
      sizeSidebar();
    }

    // A move re-renders only when the sidebar shifts inside the window, such as at a screen edge.
    if (layout() || kind !== "move") broadcast();
  }, 16);
}

function endDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;

  // Settle the height main sized the sidebar by, and pin the bottom a top-edge drag kept.
  if (sidebarDragging) {
    sizeSidebar();
    sidebarDragging = false;
    dragBottom = null;

    if (layout()) broadcast();
  }

  save();
}

// ---------------------------------------------------------------- hotkeys

function focusComposer() {
  if (!win) return;
  rememberForeground(win);
  if (!win.isVisible()) win.showInactive();

  if (state.panel === null) openPanel(persisted.lastThread ?? newestThread(), "instant");
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
  const before = JSON.stringify(extent);
  extent = { ...extent, ...next };

  // A thread arriving mid-drag still resizes the sidebar, by main's height rather than a report a tick behind.
  if (sidebarDragging) sizeSidebar();

  // By value: the tooltip's box is an object, and every report of it is a new one.
  if (JSON.stringify(extent) === before) return;

  layout();
  broadcast();
});

onHost("overlay:open", (_event, target: PanelSurface) => openPanel(target));

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

onHost("overlay:drag-start", (_event, kind: DragKind) => startDrag(kind));

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

onHost("overlay:open-in-t3", (_event, target: ThreadRef) => {
  void shell.openExternal(`t3code://threads/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`);
});

onHost("overlay:settings", (_event, patch: Partial<OverlaySettings>) => {
  update({ settings: { ...state.settings, ...patch } });
  save();
});

/** The new-thread draft: the shell's projects and the panel's opening live in main, not in its socket. */
async function draftCommand(command: PanelDraftCommand): Promise<PanelDraftReply | PanelCreateReply> {
  const server = state.t3 === "connected" ? localServer : null;

  if (server === null) return { ok: false, error: "T3 is not connected" };

  try {
    const token = await ensureSession(server);

    if (command.type === "draft") {
      const newest = [...state.threads, ...state.working].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

      return await readDraft(server, token, { projects, defaultProjectId: newest?.projectId ?? null });
    }

    const reply = await createThread(server, token, command);

    // The panel switches to the thread it just made; the shell feed adds it to the sidebar.
    if (reply.ok) openPanel({ environmentId: server.environmentId, threadId: reply.threadId });

    return reply;
  } catch (error) {
    // A rejected token is re-minted the same way the panel's own commands do it; the draft reopens after.
    if (error instanceof AuthExpiredError) {
      refreshSession(server);

      return { ok: false, error: error.message };
    }

    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

handleHostWith("overlay:panel-command", (command: PanelCommand) => {
  if (command.type === "draft" || command.type === "create") return draftCommand(command);

  if (panel === null) return { ok: false as const, error: "T3 is not connected" };

  return panel.command(command);
});

// ---------------------------------------------------------------- app

const trayActions = {
  toggleVisible,
  setLocked: (locked: boolean) => {
    update({ locked });
    save();
  },
  launchT3: () => void launchT3(),
  editConfig: () => void shell.openPath(configPath()),
  quit: () => app.quit(),
};

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  createWindow();
  createTray(trayActions);
  registerHotkeys();
  watch(configPath(), () => {
    config = loadConfig();
    registerHotkeys();
  });
  screen.on("display-removed", layout);
  screen.on("display-metrics-changed", layout);
  void connect();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
