import { join } from "node:path";
import { watch } from "node:fs";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, shell, type IpcMainEvent, type Rectangle } from "electron";
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
  type PanelTarget,
  type Popover,
  type SidebarThread,
  type ThreadRef,
} from "../shared/types";
import type { PanelCommand, PanelMessage } from "../shared/panel";
import { rememberForeground, returnFocus, takeFocus } from "./focus";
import { configPath, loadConfig, loadPersisted, savePersisted } from "./store";
import { ensureMcpSession, ensureSession, hasMcpGrant, readServer, revokeMcpGrant, saveMcpGrant, type RejectedMcpToken, type T3Server } from "./t3";
import { grantRemoteControl, type GrantConsent } from "./mcpAuth";
import { startThreadFeed, type ProjectWorkspace, type ThreadFeed } from "./threads";
import { startPanel, type Panel } from "./panel";
import { startRemote, type Remote } from "./remote";
import { createTray, refreshTray } from "./tray";
import { launchT3, openProjectInT3 } from "./launch";
import { dispatchCommand } from "./rpc";
import { snoozeChoices } from "./snooze";

const persisted = loadPersisted();
let config = loadConfig();
let win: BrowserWindow | null = null;

let extent: Extent = { sidebarHeight: 160, popoverHeight: null, tooltip: null };
let feed: ThreadFeed | null = null;
let panel: Panel | null = null;
let remote: Remote | null = null;

/** This PC's threads from the shell stream, and the other machines' from /mcp. */
let localThreads: SidebarThread[] = [];
let remoteThreads: SidebarThread[] = [];

/** This PC's T3 server while the overlay is connected to it. */
let localServer: T3Server | null = null;

/** The shell's projects, so `+` can open one in T3 Code. */
let workspaces: ProjectWorkspace[] = [];

const state: OverlayState = {
  t3: "connecting",
  localEnvironmentId: null,
  machines: [],
  threads: [],
  working: [],
  unread: [],
  panel: null,
  panelEntrance: "slide",
  panelSize: persisted.panelSize,
  popover: null,
  remoteControl: false,
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

function openPanel(target: PanelTarget, entrance: PanelEntrance = "slide") {
  if (target !== null) persisted.lastThread = target;
  save();
  update({ panel: target, panelEntrance: entrance, popover: null, unread: unreadWithout(target) });
  panel?.setTarget(target);
  remote?.setTarget(target);
}

/** A thread is read once the panel shows it. */
function unreadWithout(panel: PanelTarget): ThreadRef[] {
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

/**
 * The sidebar's list. This PC's rows arrive from the shell stream and the other machines' from the
 * MCP poll; either can change first, and both are merged here.
 */
function setLocalThreads(threads: SidebarThread[]) {
  localThreads = threads;
  setThreads([...localThreads, ...remoteThreads]);
}

function setRemoteThreads(threads: SidebarThread[]) {
  remoteThreads = threads;
  setThreads([...localThreads, ...remoteThreads]);
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

async function connect() {
  const server = await readServer();
  localServer = server;
  if (server === null) {
    stopConnection();
    stopRemote();
    update({ t3: "offline", threads: [], working: [], machines: [] });
    setTimeout(connect, 5000);
    return;
  }
  try {
    const token = await ensureSession(server);
    update({ t3: "connected", localEnvironmentId: server.environmentId });
    startFeed(server, token);
    void connectRemote(server);
  } catch (error) {
    console.error("[t3] connect failed", error);
    update({ t3: "offline" });
    setTimeout(connect, 5000);
  }
}

function stopConnection() {
  feed?.stop();
  feed = null;
  panel?.stop();
  panel = null;
}

function stopRemote() {
  remote?.stop();
  remote = null;
  remoteThreads = [];
}

function startFeed(server: T3Server, token: string) {
  stopConnection();
  feed = startThreadFeed({
    server,
    token,
    onThreads: setLocalThreads,
    onProjects: (projects) => {
      if (JSON.stringify(projects) === JSON.stringify(workspaces)) return;

      workspaces = projects;
    },
    onAuthExpired: () => refreshSession(server),
    onLost: () => {
      stopConnection();
      stopRemote();
      update({ t3: "offline", threads: [], working: [], machines: [] });
      setTimeout(connect, 5000);
    },
  });
  panel = startPanel({
    server,
    token,
    environmentId: server.environmentId,
    onMessage: sendPanelMessage,
    onAuthExpired: () => refreshSession(server),
  });
  panel.setTarget(state.panel);
}

/** The other machines, read through this PC's MCP endpoint with the session made for it. */
async function connectRemote(server: T3Server) {
  try {
    const token = await ensureMcpSession(server);
    // Which token T3 would reject decides the fallback: the grant goes, the session is replaced.
    const granted = hasMcpGrant();

    // Another connect, or none, happened while the token was loading.
    if (localServer !== server) return;

    update({ remoteControl: granted });
    stopRemote();
    remote = startRemote({
      server,
      token,
      onMachines: (machines) => update({ machines }),
      onThreads: setRemoteThreads,
      onPanel: sendPanelMessage,
      onAuthExpired: () => refreshMcpSession(server, granted ? "grant" : "session"),
    });
    remote.setTarget(state.panel);
    remote.setVisible(win?.isVisible() ?? false);
  } catch (error) {
    console.error("[t3] MCP session failed", error);
  }
}

/** A token T3 rejected is replaced at most this often, so a server that rejects every token cannot mint one per poll. */
const MCP_MINT_INTERVAL_MS = 5 * 60_000;

let mcpMintedAt = 0;

/**
 * T3 rejected the token the feed was using. A rejected grant only falls back to the sealed session;
 * a rejected session is replaced, at most once per interval. If the replacement is rejected too, the
 * feed stops instead of minting again on the next poll.
 */
async function refreshMcpSession(server: T3Server, rejected: RejectedMcpToken) {
  // The old feed would report the same rejection again while the replacement loads.
  stopRemote();

  if (rejected === "session") {
    if (Date.now() - mcpMintedAt < MCP_MINT_INTERVAL_MS) {
      console.error("[t3] T3 rejected a freshly minted MCP session; remote reads stay stopped");

      return;
    }

    mcpMintedAt = Date.now();
  }

  try {
    await ensureMcpSession(server, rejected);
    await connectRemote(server);
  } catch (error) {
    console.error("[t3] MCP session refresh failed", error);
  }
}

function sendPanelMessage(message: PanelMessage) {
  win?.webContents.send("overlay:panel", message);
}

// ---------------------------------------------------------------- remote control

/**
 * The tray's grant: T3's MCP OAuth flow, run only from that click. The user confirms what full access
 * covers, including any managed-policy ceiling, and `/mcp` then uses the granted session until it
 * expires, T3 rejects it, or the tray revokes it.
 */
async function grantRemote() {
  const server = state.t3 === "connected" ? localServer : null;

  if (server === null) return;

  try {
    const granted = await grantRemoteControl(server, await ensureSession(server), confirmRemoteControl);

    if (granted === null) return;

    await saveMcpGrant(server, granted);
    update({ remoteControl: hasMcpGrant() });
    await connectRemote(server);
  } catch (error) {
    console.error("[t3] granting remote control failed", error);
    await dialog.showMessageBox({
      type: "error",
      message: "Remote control was not granted",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The confirmation before the overlay asks for full access; no session is created unless it is answered yes. */
function confirmRemoteControl(consent: GrantConsent): Promise<boolean> {
  const ceiling = consent.runtimeModeCeiling;

  return dialog
    .showMessageBox({
      type: "warning",
      buttons: ["Grant full access", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Give the overlay full access on every linked machine?",
      detail: [
        "T3 Code on this PC can then send, stop, settle and answer on any thread on the machines linked to this PC, including threads that run at full access.",
        "Full access also lets it change settings and act on source control on those machines.",
        ceiling === undefined
          ? null
          : `A managed policy for ${ceiling.organization} limits this grant to ${ceiling.maxRuntimeMode}.`,
        "The grant lasts 30 days. Revoke it from this menu at any time.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n\n"),
    })
    .then(({ response }) => response === 0);
}

/**
 * Deletes the grant and revokes its session, then goes back to the minted session for `/mcp`. A revoke
 * that fails is reported: the sealed grant is gone either way, so the overlay stops using it, but T3
 * may still accept the session until it is revoked from the CLI.
 */
async function revokeRemote() {
  try {
    await revokeMcpGrant();
  } catch (error) {
    console.error("[t3] revoking remote control failed", error);
    await dialog.showMessageBox({
      type: "error",
      message: "Remote control may still be granted",
      detail: [
        error instanceof Error ? error.message : String(error),
        "The overlay has stopped using the grant, but T3 may still accept its session.",
        "Run `t3 auth session list`, then `t3 auth session revoke <id>` for the mcp-client session labelled t3-overlay grant.",
      ].join("\n\n"),
    });
  }

  update({ remoteControl: hasMcpGrant() });

  if (state.t3 === "connected" && localServer !== null) await connectRemote(localServer);
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
  // The overlay's own page never navigates or opens windows; links go to the system browser.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.setAlwaysOnTop(true, "screen-saver");
  win.on("ready-to-show", () => win?.showInactive());
  win.on("show", () => {
    state.unread = unreadWithout(state.panel);
    broadcast();
    remote?.setVisible(true);
  });
  win.on("hide", () => {
    broadcast();
    remote?.setVisible(false);
  });
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

onHost("overlay:open", (_event, target: PanelTarget) => openPanel(target));

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

/** The same two actions on another machine, through `/mcp`. */
async function organizeRemote(thread: ThreadRef, action: "settle" | "snooze", until?: Date) {
  try {
    await remote?.organize(thread, action, until?.toISOString());
  } catch (error) {
    console.error(`[t3] remote ${action} failed`, error);
  }
}

onHost("overlay:thread-menu", (_event, thread: ThreadRef) => {
  const server = state.t3 === "connected" ? localServer : null;
  const listed = [...state.threads, ...state.working].find((candidate) => sameThread(thread, candidate));
  // T3 refuses to snooze a thread that waits on the user.
  const waitsOnUser = listed?.state === "approval" || listed?.state === "input";
  // This PC's threads go through its socket; another machine's through the MCP session, while its
  // link answers. A thread that has no row yet is on neither, so its menu stays disabled.
  const onThisPc = server !== null && server.environmentId === thread.environmentId;

  const onRemote =
    !onThisPc && remote !== null && state.machines.some((machine) => machine.environmentId === thread.environmentId && machine.reachable);

  const canAct = onThisPc || onRemote;

  Menu.buildFromTemplate([
    {
      label: "Settle",
      enabled: canAct,
      click: () => {
        if (onThisPc && server !== null) void settle(server, thread);
        else void organizeRemote(thread, "settle");
      },
    },
    {
      // Menu tooltips only show on macOS, so a disabled item says why in its label.
      label: waitsOnUser ? "Snooze (reply first)" : "Snooze",
      enabled: canAct && !waitsOnUser,
      submenu: snoozeChoices(new Date()).map((choice) => ({
        label: choice.label,
        click: () => {
          if (onThisPc && server !== null) void snooze(server, thread, choice.until);
          else void organizeRemote(thread, "snooze", choice.until);
        },
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

onHost("overlay:open-in-t3", (_event, target: ThreadRef | "new") => {
  if (target === "new") {
    // T3 has no empty new-thread link: its `t3code://new` needs a prompt. Opening the project's
    // workspace is what brings up T3's own new-thread draft.
    const newest = [...state.threads, ...state.working].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

    const workspaceRoot =
      workspaces.find((project) => project.projectId === newest?.projectId)?.workspaceRoot ?? workspaces[0]?.workspaceRoot;

    if (workspaceRoot !== undefined) openProjectInT3(workspaceRoot);

    return;
  }

  void shell.openExternal(`t3code://threads/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`);
});

onHost("overlay:settings", (_event, patch: Partial<OverlaySettings>) => {
  update({ settings: { ...state.settings, ...patch } });
  save();
});

handleHostWith("overlay:panel-command", (command: PanelCommand) => {
  const target = state.panel;

  // Another machine's thread is driven through `/mcp`, by its environmentId.
  if (target !== null && localServer !== null && target.environmentId !== localServer.environmentId) {
    if (remote === null) return { ok: false as const, error: "T3 is not connected" };

    return remote.command(command);
  }

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
  grantRemoteControl: () => void grantRemote(),
  revokeRemoteControl: () => void revokeRemote(),
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
