import { useEffect, useRef, useState, type CSSProperties } from "react";
import { defaultThemeStorage, themeApplyScript, type ThemeStorage } from "../../shared/theme";
import type { OverlayState, PanelTarget, SidebarThread, ThreadRef } from "../../shared/types";

interface WebviewElement extends HTMLWebViewElement {
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  send(channel: string, ...args: unknown[]): void;
  sendInputEvent(event: { type: "keyDown" | "keyUp"; keyCode: string; modifiers?: string[] }): void;
}

/**
 * Attributes passed to the webview element as written. React drops `allowpopups={true}` because it
 * doesn't know the attribute, and React's typings only accept a boolean for it.
 */
interface WebviewAttributes {
  [attribute: string]: string;
}

// Without `allowpopups` Electron never calls the main process's window-open handler, so T3's links to
// the system browser open nothing.
const POPUPS_ALLOWED: WebviewAttributes = { allowpopups: "" };

interface DidNavigateEvent extends Event {
  url: string;
}

interface IpcMessageEvent extends Event {
  channel: string;
  args: unknown[];
}

/**
 * @param signInFirst On the hosted app with no machine connected yet, T3 Connect sign-in and the machine
 * list live on the home screen; afterwards machines are managed under Settings → Environments.
 */
function routeFor(target: PanelTarget, signInFirst = false): string {
  if (target === "draft") return "/";
  if (target === "connect") return signInFirst ? "/" : "/settings/connections";
  return `/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`;
}

const sameOrigin = (url: string, origin: string) =>
  URL.canParse(url) && URL.canParse(origin) && new URL(url).origin === new URL(origin).origin;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Machines this T3 page has connected to: it caches each one's server config in IndexedDB
// (apps/web/src/connection/storage.ts). Runs in the page.
const KNOWN_ENVIRONMENTS_SCRIPT = `new Promise((resolve) => {
  const request = indexedDB.open("t3code:connection-runtime");
  request.onupgradeneeded = () => request.transaction.abort();
  request.onerror = () => resolve(null);
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("server-config")) return resolve([]);
    const keys = db.transaction("server-config", "readonly").objectStore("server-config").getAllKeys();
    keys.onsuccess = () => { db.close(); resolve(keys.result); };
    keys.onerror = () => { db.close(); resolve(null); };
  };
})`;

/** `/<environmentId>/<threadId>` is T3's thread route. Drafts and settings live under fixed first segments. */
function threadFromRoute(path: string): ThreadRef | null {
  const match = /^\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match || match[1] === "draft" || match[1] === "settings") return null;
  return { environmentId: decodeURIComponent(match[1]!), threadId: decodeURIComponent(match[2]!) };
}

export function Panel({ state, style }: { state: OverlayState; style: CSSProperties }) {
  const webview = useRef<WebviewElement>(null) as React.RefObject<WebviewElement | null>;
  const [ready, setReady] = useState(false);
  const route = useRef<string | null>(null);
  const titles = useRef(new Map<string, SidebarThread>());
  const settling = useRef(false);
  // The webview keeps its first URL; later moves go through T3's router so the app never reloads.
  // A new T3 origin (T3 restarted) remounts it.
  const [loaded, setLoaded] = useState<{ origin: string; src: string } | null>(null);
  if (state.origin !== null && loaded?.origin !== state.origin) {
    // Start on the draft route; the reachability check below moves to the target once loaded.
    const path = routeFor("draft");
    route.current = path;
    setReady(false);
    setLoaded({ origin: state.origin, src: `${state.origin}${path}` });
  }
  const initialSrc = loaded?.src ?? null;
  // Read by listeners registered once. Electron rewrites the webview's src on every load, so it can't stand in.
  const t3Src = useRef(initialSrc);

  t3Src.current = initialSrc;

  /** Whether the webview still shows T3, not a page T3 navigated to. */
  const showsT3 = (element: WebviewElement) => t3Src.current !== null && sameOrigin(element.getURL(), t3Src.current);

  for (const thread of [...state.threads, ...state.working]) {
    titles.current.set(`${thread.environmentId}:${thread.threadId}`, thread);
  }

  const navigate = async (path: string) => {
    if (!webview.current || route.current === path || !showsT3(webview.current)) return;
    route.current = path;
    await webview.current.executeJavaScript(`history.pushState(null, "", ${JSON.stringify(path)})`);
  };

  useEffect(() => {
    const element = webview.current;

    if (!element || initialSrc === null) return;
    // The thread title, theme and page scripts go only to T3's own page, not to a page it navigated to.
    const onT3 = (url: string) => sameOrigin(url, initialSrc);
    const onReady = () => {
      setReady(onT3(element.getURL()));

      if (onT3(element.getURL())) element.send("opacity", state.opacity);
    };

    const onNavigate = (event: Event) => {
      // SAFETY: Electron fires did-navigate on a <webview> with the new top-level URL.
      if (!onT3((event as DidNavigateEvent).url)) setReady(false);
    };
    const onMessage = (event: Event) => {
      const { channel, args } = event as IpcMessageEvent;

      if (!onT3(element.getURL())) return;
      if (channel === "escape") window.overlay.escape();
      if (channel === "sent") window.overlay.sent();
      if (channel === "hooks") window.overlay.reportHooks(args[0] as string[]);
      if (channel === "route" && !settling.current) {
        const path = args[0] as string;
        route.current = path;
        const thread = threadFromRoute(path);
        if (thread) window.overlay.follow(thread);
      }
      if (channel === "theme") {
        for (const [name, value] of Object.entries(args[0] as Record<string, string>)) {
          document.documentElement.style.setProperty(`--t3-${name}`, value);
        }
      }
    };
    element.addEventListener("dom-ready", onReady);
    element.addEventListener("did-navigate", onNavigate);
    element.addEventListener("ipc-message", onMessage);
    return () => {
      element.removeEventListener("dom-ready", onReady);
      element.removeEventListener("did-navigate", onNavigate);
      element.removeEventListener("ipc-message", onMessage);
    };
  }, [initialSrc]);

  useEffect(() => {
    if (ready) webview.current?.send("opacity", state.opacity);
  }, [ready, state.opacity]);

  // "Custom theme" follows the theme picked in the desktop app, live. Needs T3's debugging port.
  const [desktopTheme, setDesktopTheme] = useState<ThemeStorage | null>(null);
  useEffect(() => {
    const stop = window.overlay.onThemeStorage(setDesktopTheme);
    void window.overlay.getThemeStorage().then(setDesktopTheme);
    return stop;
  }, []);
  const { customTheme } = state.settings;
  useEffect(() => {
    const storage = customTheme ? desktopTheme : defaultThemeStorage(desktopTheme);
    if (ready && storage) void webview.current?.executeJavaScript(themeApplyScript(storage));
  }, [ready, desktopTheme, customTheme]);

  // A thread on a machine this page has no connection to renders as an empty page, so check first.
  const [unreachable, setUnreachable] = useState<SidebarThread | ThreadRef | null>(null);
  useEffect(() => {
    if (!ready || !state.panel) return;
    const target = state.panel;
    void (async () => {
      const known = (await webview.current?.executeJavaScript(KNOWN_ENVIRONMENTS_SCRIPT)) as string[] | null | undefined;
      if (typeof target === "object" && known && !known.includes(target.environmentId)) {
        setUnreachable(titles.current.get(`${target.environmentId}:${target.threadId}`) ?? target);
        return;
      }
      setUnreachable(null);
      await navigate(routeFor(target, state.panelHosted && known?.length === 0));
    })();
  }, [ready, state.panel]);

  // The guest unfolds the composer and focuses T3's editor.
  useEffect(
    () =>
      window.overlay.onFocusComposer(() => {
        webview.current?.focus();
        webview.current?.send("focus-composer");
      }),
    [],
  );

  // Settling goes through T3's own Ctrl+Shift+S binding, so it works for threads on every machine.
  useEffect(
    () =>
      window.overlay.onSettle(async (thread: ThreadRef) => {
        const element = webview.current;
        if (!element || settling.current) return;
        settling.current = true;
        const back = route.current;
        try {
          await navigate(routeFor(thread));
          await wait(500);

          if (!showsT3(element)) return;
          element.sendInputEvent({ type: "keyDown", keyCode: "S", modifiers: ["control", "shift"] });
          element.sendInputEvent({ type: "keyUp", keyCode: "S", modifiers: ["control", "shift"] });
          await wait(300);
          if (back && back !== routeFor(thread)) await navigate(back);
        } finally {
          settling.current = false;
        }
      }),
    [],
  );

  // The title is drawn inside T3's page, above the chat history or atop the composer card.
  const title = panelTitle(state.panel, titles.current);
  const { titleInComposer, textOutline, compactComposer } = state.settings;
  // A thread waiting on an approval or an answer keeps its composer open.
  const target = state.panel;
  const threadState =
    typeof target === "object" && target !== null ? titles.current.get(`${target.environmentId}:${target.threadId}`)?.state : undefined;
  const needsReply = threadState === "approval" || threadState === "input";
  const { side } = state;
  useEffect(() => {
    if (ready) webview.current?.send("chrome", { title, titleInComposer, textOutline, compactComposer, needsReply, side });
  }, [ready, title, titleInComposer, textOutline, compactComposer, needsReply, side]);

  if (initialSrc === null) return null;

  const visible = state.panel !== null;

  // A transition runs with the values of the state it moves to, so the closed state has none and closes at once.
  // The slide starts inside the gap to the sidebar, so the panel never draws over it.
  const entrance = visible
    ? state.panelEntrance === "slide"
      ? "transition-[opacity,translate] duration-220 ease-out"
      : ""
    : `opacity-0 ${state.side === "left" ? "motion-safe:-translate-x-1.5" : "motion-safe:translate-x-1.5"}`;
  const corner = state.side === "left" ? "right-0 cursor-nwse-resize" : "left-0 cursor-nesw-resize";

  return (
    <div className={`flex flex-col ${entrance}`} style={{ ...style, visibility: visible ? "visible" : "hidden" }}>
      <webview
        key={initialSrc}
        ref={webview}
        src={initialSrc}
        partition="persist:t3"
        {...POPUPS_ALLOWED}
        className={`min-h-0 flex-1 ${unreachable ? "invisible" : ""}`}
      />
      {unreachable && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="flex max-w-72 flex-col items-center gap-3 rounded-xl border border-t3-border bg-t3-popover p-4 text-center shadow-xl shadow-black/40">
            <p className="text-[13px] text-t3-fg">
              {"environmentLabel" in unreachable ? unreachable.environmentLabel : "This machine"} isn't reachable from the
              overlay right now. It may be offline, or not connected here yet.
            </p>
            <button
              type="button"
              className="rounded-lg bg-t3-accent px-3 py-1.5 text-[13px] text-t3-fg hover:bg-t3-fg/15"
              onClick={() => window.overlay.open("connect")}
            >
              Open environments
            </button>
          </div>
        </div>
      )}
      <div
        className={`absolute bottom-0 size-4 ${corner}`}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          window.overlay.dragStart("resize");
          window.addEventListener("mouseup", () => window.overlay.dragEnd(), { once: true });
        }}
      />
    </div>
  );
}

function panelTitle(target: PanelTarget | null, known: Map<string, SidebarThread>): string {
  if (target === null) return "";
  if (target === "draft") return "New thread";
  if (target === "connect") return "Connect machines";
  const thread = known.get(`${target.environmentId}:${target.threadId}`);
  if (!thread) return "Thread";
  return [thread.title, [thread.projectName, thread.environmentLabel].filter(Boolean).join(" · ")].filter(Boolean).join("  ·  ");
}
