import { join } from "node:path";
import { watch } from "node:fs";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, screen, shell, type IpcMainEvent, type Rectangle } from "electron";
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
  type Machine,
  type MachineStatus,
  type OverlaySettings,
  type OverlayState,
  type PanelEntrance,
  type PanelTarget,
  type Popover,
  type SidebarThread,
  type ThreadRef,
} from "../shared/types";
import type { PanelCommand, PanelMessage } from "../shared/panel";
import type { ComposeCommand, FileScope, LaunchReply, LaunchRequest } from "../shared/compose";
import { rememberForeground, returnFocus, takeFocus } from "./focus";
import { configPath, loadConfig, loadPersisted, savePersisted } from "./store";
import { ensureSession, isAuthenticated, readDescriptor, readServer, type T3Server } from "./t3";
import { loadPaired, parsePairingLink, redeemPairing, resolvePairing, savePaired, type PairedMachine } from "./pairing";
import { startThreadFeed, type ThreadFeed } from "./threads";
import { startPanel, type Panel } from "./panel";
import { launchThread, listBranches, readComposeContext, readProviders, searchFiles } from "./compose";
import { createTray, refreshTray } from "./tray";
import { launchT3 } from "./launch";
import { commandFrame, type ThreadCommand } from "./rpc";
import { snoozeChoices } from "./snooze";

const persisted = loadPersisted();
let config = loadConfig();
let win: BrowserWindow | null = null;

let extent: Extent = { sidebarHeight: 160, popoverHeight: null, tooltip: null };

const state: OverlayState = {
  t3: "connecting",
  machines: [],
  threads: [],
  working: [],
  unread: [],
  lastLaunch: persisted.lastLaunch,
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
  persisted.lastLaunch = state.lastLaunch;
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
  if (target !== null && target !== "new") persisted.lastThread = target;
  save();
  update({ panel: target, panelEntrance: entrance, popover: null, unread: unreadWithout(target) });

  for (const connection of connections.values()) connection.panel.setTarget(target === "new" ? null : target);
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

/** The sidebar's list: every connected machine's rows. Any machine's stream can change first. */
function mergeThreads() {
  setThreads([...connections.values()].flatMap((connection) => connection.threads));
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

// ---------------------------------------------------------------- machines

/** A machine the overlay is connected to: its shell stream, which also carries the composer's calls, and its panel. */
interface Connection {
  server: T3Server;
  token: string;
  feed: ThreadFeed;
  panel: Panel;
  threads: SidebarThread[];
}

/** By environment id. A machine is here while its shell stream runs. */
const connections = new Map<string, Connection>();

/** This PC's server while the overlay is connected to it. */
let localServer: T3Server | null = null;

/** Paired machines wait this long before trying a machine that did not answer again. */
const PAIRED_RETRY_MS = 15_000;

const retries = new Map<string, NodeJS.Timeout>();

function setMachine(machine: Machine) {
  const machines = state.machines.filter((other) => other.environmentId !== machine.environmentId);

  // This PC first, then the paired machines in the order they were paired.
  update({ machines: machine.local ? [machine, ...machines] : [...machines, machine] });
}

function setStatus(environmentId: string, status: MachineStatus) {
  const machine = state.machines.find((candidate) => candidate.environmentId === environmentId);

  if (machine !== undefined && machine.status !== status) setMachine({ ...machine, status });
}

function sendPanelMessage(message: PanelMessage) {
  win?.webContents.send("overlay:panel", message);
}

interface ConnectionHooks {
  onAuthExpired: () => void;
  onLost: () => void;
}

function startConnection(server: T3Server, token: string, hooks: ConnectionHooks) {
  stopConnection(server.environmentId);

  const connection: Connection = {
    server,
    token,
    threads: [],
    feed: startThreadFeed({
      server,
      token,
      onThreads: (threads) => {
        connection.threads = threads;
        mergeThreads();
      },
      onAuthExpired: hooks.onAuthExpired,
      onLost: hooks.onLost,
    }),
    panel: startPanel({ server, token, onMessage: sendPanelMessage, onAuthExpired: hooks.onAuthExpired }),
  };

  connections.set(server.environmentId, connection);
  connection.panel.setTarget(typeof state.panel === "object" ? state.panel : null);
}

function stopConnection(environmentId: string) {
  const connection = connections.get(environmentId);

  if (connection === undefined) return;

  connection.feed.stop();
  connection.panel.stop();
  connections.delete(environmentId);
  mergeThreads();
}

async function connectLocal() {
  const server = await readServer();

  if (server === null) {
    localOffline();

    return;
  }

  try {
    const token = await ensureSession(server);

    localServer = server;
    setMachine({ environmentId: server.environmentId, label: server.label, status: "connected", local: true });
    update({ t3: "connected" });
    startConnection(server, token, {
      onAuthExpired: () => refreshLocalSession(server),
      onLost: localOffline,
    });
  } catch (error) {
    console.error("[t3] connect failed", error);
    localOffline();
  }
}

function localOffline() {
  if (localServer !== null) {
    stopConnection(localServer.environmentId);
    setStatus(localServer.environmentId, "offline");
  }

  update({ t3: "offline" });
  setTimeout(connectLocal, 5000);
}

/** A fresh token after T3 rejected this one: the feed and the panel reconnect with it. */
function refreshLocalSession(server: T3Server) {
  void ensureSession(server, true)
    .then((token) =>
      startConnection(server, token, {
        onAuthExpired: () => refreshLocalSession(server),
        onLost: localOffline,
      }),
    )
    .catch((error) => console.error("[t3] session refresh failed", error));
}

/**
 * A paired machine, over the origin it was paired on. It must still answer as the same environment
 * before its token is sent there. A machine that is away is tried again; a rejected session waits
 * for the user to pair it again.
 */
async function connectPaired(machine: PairedMachine) {
  const { environmentId, origin, label } = machine.server;

  clearTimeout(retries.get(environmentId));
  retries.delete(environmentId);
  setMachine({ environmentId, label, status: "connecting", local: false });

  const retry = () => {
    setStatus(environmentId, "offline");
    retries.set(
      environmentId,
      setTimeout(() => void stillPaired(environmentId).then((current) => current && connectPaired(current)), PAIRED_RETRY_MS),
    );
  };

  try {
    const server = await readDescriptor(origin);

    if (server.environmentId !== environmentId) throw new Error(`${origin} now answers as another T3 environment`);

    if (!(await isAuthenticated(server, machine.token))) {
      setStatus(environmentId, "expired");

      return;
    }

    // Forgotten while the machine was being reached.
    if ((await stillPaired(environmentId)) === null) return;

    startConnection(server, machine.token, {
      onAuthExpired: () => {
        stopConnection(environmentId);
        setStatus(environmentId, "expired");
      },
      onLost: () => {
        stopConnection(environmentId);
        retry();
      },
    });
    setMachine({ environmentId, label: server.label, status: "connected", local: false });
  } catch (error) {
    console.warn(`[t3] ${label} is not reachable`, error);
    retry();
  }
}

async function stillPaired(environmentId: string): Promise<PairedMachine | null> {
  return (await loadPaired()).find((machine) => machine.server.environmentId === environmentId) ?? null;
}

/**
 * The tray's pairing: the link on the clipboard names a machine, which the user confirms before its
 * one-time code is spent. The session it buys has the permissions the link grants.
 */
async function pairFromClipboard() {
  const link = parsePairingLink(await clipboard.readText());

  if (link === null) {
    await dialog.showMessageBox({
      type: "info",
      message: "Copy a pairing link first",
      detail:
        "On the other machine, open T3 Code's Settings → Sharing & access and create a link, or run `t3 pair --tailscale`. Copy the link it shows, then choose Pair again.",
    });

    return;
  }

  try {
    const target = await resolvePairing(link);

    if (target.server.environmentId === localServer?.environmentId) {
      await dialog.showMessageBox({ type: "info", message: "That link is for this PC", detail: "The overlay already uses this PC's T3 Code." });

      return;
    }

    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Pair", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: `Pair the overlay with ${target.server.label}?`,
      detail: [
        target.server.origin,
        "The overlay gets its own session on that machine, with the permissions the pairing link grants. It can then list, read, start and answer threads there.",
        "The session shows as t3-overlay in that machine's Settings → Sharing & access, where you can revoke it.",
      ].join("\n\n"),
    });

    if (response !== 0) return;

    const machine = await redeemPairing(target);
    const others = (await loadPaired()).filter((other) => other.server.environmentId !== machine.server.environmentId);

    await savePaired([...others, machine]);
    clipboard.clear();
    void connectPaired(machine);
  } catch (error) {
    console.error("[t3] pairing failed", error);
    await dialog.showMessageBox({
      type: "error",
      message: "The machine was not paired",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A session cannot revoke itself in T3, so forgetting only deletes it here and says where to revoke it. */
async function forgetMachine(environmentId: string) {
  const machine = state.machines.find((candidate) => candidate.environmentId === environmentId);

  if (machine === undefined) return;

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Forget", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Forget ${machine.label}?`,
    detail: `The overlay deletes its session for ${machine.label} and stops listing its threads. The session stays valid there until it expires, or until you revoke t3-overlay in that machine's Settings → Sharing & access.`,
  });

  if (response !== 0) return;

  await savePaired((await loadPaired()).filter((paired) => paired.server.environmentId !== environmentId));
  clearTimeout(retries.get(environmentId));
  retries.delete(environmentId);
  stopConnection(environmentId);
  update({ machines: state.machines.filter((candidate) => candidate.environmentId !== environmentId) });

  if (typeof state.panel === "object" && state.panel?.environmentId === environmentId) openPanel(null);
}

/** The connection a thread or composer call goes to, or an error naming the machine that is not connected. */
function connectionFor(environmentId: string): Connection {
  const connection = connections.get(environmentId);

  if (connection !== undefined) return connection;

  const label = state.machines.find((machine) => machine.environmentId === environmentId)?.label ?? "That machine";

  throw new Error(`${label} is not connected`);
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

async function organize(thread: ThreadRef, command: ThreadCommand) {
  try {
    await connectionFor(thread.environmentId).feed.command("orchestration.dispatchCommand", commandFrame(command));
  } catch (error) {
    console.error(`[t3] ${command.type} failed`, error);
  }
}

onHost("overlay:thread-menu", (_event, thread: ThreadRef) => {
  const listed = [...state.threads, ...state.working].find((candidate) => sameThread(thread, candidate));
  // T3 refuses to snooze a thread that waits on the user.
  const waitsOnUser = listed?.state === "approval" || listed?.state === "input";
  const canAct = connections.has(thread.environmentId);

  Menu.buildFromTemplate([
    {
      label: "Settle",
      enabled: canAct,
      click: () => void organize(thread, { type: "thread.settle", threadId: thread.threadId }),
    },
    {
      // Menu tooltips only show on macOS, so a disabled item says why in its label.
      label: waitsOnUser ? "Snooze (reply first)" : "Snooze",
      enabled: canAct && !waitsOnUser,
      submenu: snoozeChoices(new Date()).map((choice) => ({
        label: choice.label,
        click: () => void organize(thread, { type: "thread.snooze", threadId: thread.threadId, snoozedUntil: choice.until.toISOString() }),
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

handleHostWith("overlay:panel-command", (command: PanelCommand) => {
  const target = state.panel;
  const connection = typeof target === "object" && target !== null ? connections.get(target.environmentId) : undefined;

  if (connection === undefined) return { ok: false as const, error: "T3 is not connected" };

  return connection.panel.command(command);
});

// ---------------------------------------------------------------- composer

handleHostWith("overlay:compose-context", (environmentId: string) => {
  const connection = connectionFor(environmentId);
  const sticky = state.lastLaunch?.environmentId === environmentId ? state.lastLaunch.model : null;

  return readComposeContext(environmentId, connection.feed, connection.feed.shell, sticky);
});

/** The `/` menu of an open thread: its provider's commands and skills. */
handleHostWith("overlay:compose-commands", async (thread: ThreadRef): Promise<ComposeCommand[]> => {
  const connection = connectionFor(thread.environmentId);
  const instanceId = connection.feed.shell.thread(thread.threadId)?.modelSelection?.instanceId;
  const providers = await readProviders(connection.feed);

  return providers.find((provider) => provider.instanceId === instanceId)?.commands ?? [];
});

handleHostWith("overlay:compose-branches", (environmentId: string, projectId: string, query: string) => {
  const connection = connectionFor(environmentId);
  const project = connection.feed.shell.project(projectId);

  if (project === undefined) throw new Error("That project is gone");

  return listBranches(connection.feed, project.workspaceRoot, query);
});

/** The `@` menu searches the checkout the message's agent works in, as T3's composer does. */
handleHostWith("overlay:compose-files", (scope: FileScope, query: string) => {
  const connection = connectionFor(scope.environmentId);
  const shellModel = connection.feed.shell;

  if (scope.kind === "project") {
    const root = shellModel.project(scope.projectId)?.workspaceRoot;

    if (root === undefined) return [];

    return searchFiles(connection.feed, scope.worktreePath ?? root, query);
  }

  const thread = shellModel.thread(scope.threadId);
  const cwd = thread?.worktreePath ?? (thread === undefined ? undefined : shellModel.project(thread.projectId)?.workspaceRoot);

  return cwd === undefined ? [] : searchFiles(connection.feed, cwd, query);
});

handleHostWith("overlay:compose-launch", async (request: LaunchRequest): Promise<LaunchReply> => {
  try {
    const connection = connectionFor(request.environmentId);
    const project = connection.feed.shell.project(request.projectId);

    if (project === undefined) return { ok: false, error: "That project is gone" };

    const threadId = await launchThread(connection.server, connection.feed, project, request);

    state.lastLaunch = { environmentId: request.environmentId, projectId: request.projectId, model: request.model };
    openPanel({ environmentId: request.environmentId, threadId });

    return { ok: true, threadId };
  } catch (error) {
    console.error("[t3] launching a thread failed", error);

    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// ---------------------------------------------------------------- app

const trayActions = {
  toggleVisible,
  setLocked: (locked: boolean) => {
    update({ locked });
    save();
  },
  launchT3: () => void launchT3(),
  pairMachine: () => void pairFromClipboard(),
  forgetMachine: (environmentId: string) => void forgetMachine(environmentId),
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
  void connectLocal();
  void loadPaired().then((machines) => {
    for (const machine of machines) void connectPaired(machine);
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
