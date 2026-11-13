import type { WebContents } from "electron";
import type { SidebarThread } from "../shared/types";
import { ShellModel, sortSidebar } from "./shell";

// Reads the thread list of every machine from the panel's own T3 page over the Chrome DevTools Protocol.
// Seed: T3's IndexedDB shell cache (apps/web/src/connection/storage.ts). Live: the shell stream
// frames T3's page already receives on its sockets, one socket per connected machine.

const SEED_SCRIPT = `(async () => {
  const open = (name) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const all = (db, store) => new Promise((resolve) => {
    if (!db.objectStoreNames.contains(store)) return resolve([]);
    const request = db.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve([]);
  });
  const db = await open("t3code:connection-runtime");
  const shells = await all(db, "shell");
  const configs = await all(db, "server-config");
  db.close();
  let favicons = [];
  try {
    const icons = await open("t3code:project-favicons");
    favicons = await all(icons, "images");
    icons.close();
  } catch {}
  return { shells, configs, favicons };
})()`;

interface Seed {
  shells: unknown[];
  configs: unknown[];
  favicons: { environmentId: string; cwd: string; faviconPath: string | null; dataUrl: string }[];
}

const parse = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export interface GuestFeedOptions {
  /** The panel's webview on T3's own page, with its debugger attached. */
  contents: WebContents;
  /** Only once the page has a cached shell for at least one machine. */
  onThreads: (threads: SidebarThread[]) => void;
}

export function startGuestFeed({ contents, onThreads }: GuestFeedOptions): { stop(): void } {
  const send = (method: string, params: object = {}) => contents.debugger.sendCommand(method, params);

  const models = new Map<string, ShellModel>();
  const socketEnv = new Map<string, string>();
  const partial = new Map<string, string>();
  let stopped = false;

  const emit = () => {
    if (!stopped && models.size > 0) onThreads(sortSidebar([...models.values()].flatMap((model) => model.sidebar())));
  };

  async function seed() {
    const response = await send("Runtime.evaluate", { expression: SEED_SCRIPT, awaitPromise: true, returnByValue: true });
    const seed = response.result?.value as Seed | undefined;
    if (!seed) return;
    const labels = new Map<string, string>();
    for (const raw of seed.configs) {
      const row = parse<{ environmentId: string; config?: { environment?: { label?: string } } }>(raw);
      if (row.config?.environment?.label) labels.set(row.environmentId, row.config.environment.label);
    }
    for (const raw of seed.shells) {
      const row = parse<{ environmentId: string; snapshot: unknown }>(raw);
      let model = models.get(row.environmentId);
      if (!model) {
        model = new ShellModel(row.environmentId, labels.get(row.environmentId) ?? "");
        models.set(row.environmentId, model);
      }
      model.environmentLabel = labels.get(row.environmentId) ?? model.environmentLabel;
      model.merge(row.snapshot);
      model.favicons = new Map(
        seed.favicons
          .filter((icon) => icon.environmentId === row.environmentId)
          .map((icon) => [`${icon.cwd}\n${icon.faviconPath ?? ""}`, icon.dataUrl]),
      );
    }
    emit();
  }

  let reseedTimer: NodeJS.Timeout | null = null;
  const reseedSoon = () => {
    if (reseedTimer) clearTimeout(reseedTimer);
    reseedTimer = setTimeout(() => void seed().catch((error) => console.warn("[t3] panel reseed failed", error)), 1500);
  };

  function onFrame(requestId: string, payload: string) {
    // T3 splits frames over 48 KiB. Every part but the last starts with U+001E.
    if (payload.startsWith("\u001e")) {
      partial.set(requestId, (partial.get(requestId) ?? "") + payload.slice(1));
      return;
    }
    const text = (partial.get(requestId) ?? "") + payload;
    partial.delete(requestId);
    if (!text.includes('"Chunk"')) return;
    let frames: unknown;
    try {
      frames = JSON.parse(text);
    } catch {
      return;
    }
    let changed = false;
    for (const frame of (Array.isArray(frames) ? frames : [frames]) as { _tag?: string; values?: unknown[] }[]) {
      if (frame._tag !== "Chunk" || !frame.values) continue;
      for (const value of frame.values) {
        if (!isShellItem(value)) continue;
        const model = modelFor(requestId, value);
        if (model) changed = model.apply(value) || changed;
        else reseedSoon();
      }
    }
    if (changed) emit();
  }

  function modelFor(requestId: string, item: ShellItemLike): ShellModel | undefined {
    const bound = socketEnv.get(requestId);
    if (bound) return models.get(bound);
    for (const model of models.values()) {
      if (model.owns(item)) {
        socketEnv.set(requestId, model.environmentId);
        return model;
      }
    }
    return undefined;
  }

  const onMessage = (_event: unknown, method: string, params: any) => {
    if (method === "Network.webSocketFrameReceived") {
      onFrame(params.requestId, params.response.payloadData);
    } else if (method === "Network.webSocketCreated" || method === "Network.webSocketClosed") {
      socketEnv.delete(params.requestId);
      reseedSoon();
    }
  };
  contents.debugger.on("message", onMessage);

  // The overlay reads only socket frames, so the page keeps no response bodies for it.
  void send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 })
    .then(seed)
    .catch((error) => console.warn("[t3] panel thread feed failed", error));

  return {
    stop() {
      stopped = true;
      if (reseedTimer) clearTimeout(reseedTimer);
      contents.debugger.off("message", onMessage);
    },
  };
}

type ShellItemLike = { kind: string; [key: string]: unknown };

const SHELL_KINDS = new Set(["thread.updated", "thread.removed", "project.updated", "project.removed"]);

function isShellItem(value: unknown): value is ShellItemLike {
  if (typeof value !== "object" || value === null) return false;
  const item = value as ShellItemLike;
  if (item.kind === "snapshot") {
    // Thread streams also send a "snapshot"; only the shell's has threads and projects.
    const snapshot = item.snapshot as { threads?: unknown; projects?: unknown } | undefined;
    return Array.isArray(snapshot?.threads) && Array.isArray(snapshot?.projects);
  }
  if (item.kind === "thread.updated" && typeof item.thread !== "object") return false;
  return SHELL_KINDS.has(item.kind) && typeof item.sequence === "number";
}
