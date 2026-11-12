import { ArrowDown, PenLine } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import type { PanelThread } from "../../shared/panel";
import { threadKey, type OverlaySettings, type OverlayState, type PanelTarget, type SidebarThread } from "../../shared/types";
import { Timeline } from "./panel/Timeline";
import { activeRun, applyPanelMessage, initialState, needsReply, pendingRequests } from "./panel/model";

/**
 * The chat panel: a title row, the thread's timeline and the composer card, all drawn here instead of
 * inside a webview. Main owns the socket and forwards the thread's projection; this file draws it.
 */
export function Panel({ state, style }: { state: OverlayState; style: CSSProperties }) {
  const target = state.panel;
  const targetKey = target === null ? "none" : target === "draft" ? target : threadKey(target);
  const threadId = target === null || target === "draft" ? null : target.threadId;
  const [panel, dispatch] = useReducer(applyPanelMessage, targetKey, initialState);
  /** The read-only composer stands in for the real one: it unfolds, but has nothing to type into yet. */
  const [composerOpen, setComposerOpen] = useState(false);
  const [showToEnd, setShowToEnd] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const threadRef = useRef(threadId);
  const targetRef = useRef(targetKey);
  threadRef.current = threadId;
  targetRef.current = targetKey;

  // A new thread starts clean: no unfolded composer from the last one. Rows reset through the
  // reducer, which tags every message with its target (see panel/model.ts).
  useEffect(() => {
    setComposerOpen(false);
    setShowToEnd(false);
    follow.current = true;
  }, [targetKey]);

  useEffect(
    () =>
      window.overlay.onPanel((message) => {
        if ("threadId" in message && message.threadId !== threadRef.current) return;
        dispatch({ kind: "message", targetKey: targetRef.current, message });
      }),
    [],
  );

  // "Follow" while the reader is at the end; hold the position while they are reading further up.
  useEffect(() => {
    const element = scroller.current;

    if (element && follow.current) element.scrollTop = element.scrollHeight;
  });

  // An event this build cannot fold in: re-read the projection once the burst settles.
  useEffect(() => {
    if (!panel.stale) return;
    const timer = setTimeout(() => void window.overlay.panel({ type: "reload" }), 500);

    return () => clearTimeout(timer);
  }, [panel.stale, panel.sequence]);

  // The hotkey opens the composer, exactly like the webview's did.
  useEffect(() => window.overlay.onFocusComposer(() => setComposerOpen(true)), []);

  const view = panel.view;
  const pending = pendingRequests(view);
  const reply = needsReply(view);
  const running = activeRun(view);
  const { side, settings } = state;
  const title = panelTitle(state, view?.thread ?? null);
  const project = view === null ? undefined : state.projects.find((candidate) => candidate.projectId === view.thread.projectId);
  const environment = environmentLabel(state, target, view?.thread ?? null);
  const offline = panel.status === "offline" || panel.status === "ended";
  const canCompose = target !== null && target !== "draft" && !panel.remote && !offline && view !== null;
  const folded = canCompose && settings.compactComposer && !reply && !composerOpen;
  const titleInCard = settings.titleInComposer && canCompose && !folded;
  const visible = target !== null;

  const onScroll = () => {
    const element = scroller.current;

    if (!element) return;
    const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
    follow.current = atEnd;
    setShowToEnd(!atEnd);
  };

  const scrollToEnd = () => {
    follow.current = true;
    setShowToEnd(false);
    const element = scroller.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  // A transition runs with the values of the state it moves to, so the closed state has none and closes at once.
  // The slide starts inside the gap to the sidebar, so the panel never draws over it.
  const entrance = visible
    ? state.panelEntrance === "slide"
      ? "transition-[opacity,translate] duration-220 ease-out"
      : ""
    : `opacity-0 ${side === "left" ? "motion-safe:-translate-x-1.5" : "motion-safe:translate-x-1.5"}`;

  const corner = side === "left" ? "right-0 cursor-nwse-resize" : "left-0 -scale-x-100 cursor-nesw-resize";

  // The chat window fades with the opacity slider, borders included; the composer card keeps its glass.
  // SAFETY: these are CSS custom properties, which React writes through as strings; the stylesheet
  // reads them inside color-mix() below.
  const chatStyle = {
    "--t3-chat-bg": "color-mix(in srgb, var(--t3-background) var(--t3-chat-opacity), transparent)",
    "--t3-chat-border": "color-mix(in srgb, var(--t3-contrast-border) var(--t3-chat-opacity), transparent)",
  } as CSSProperties;

  const historyClass = [
    "panel-scroll h-full w-full overflow-y-auto rounded-b-[12px] border bg-[var(--t3-chat-bg)] border-[var(--t3-chat-border)]",
    titleInCard ? "rounded-t-[12px] border-t" : "border-t-0",
    canCompose && !folded ? "rounded-b-none border-b-0" : "",
  ].join(" ");

  return (
    <div
      className={`group/chat flex min-h-0 flex-col ${entrance} ${outlineClass(settings.textOutline)} ${
        canCompose && !folded ? "pb-4" : ""
      }`}
      // SAFETY: React passes custom properties through untouched; the CSS reads them as numbers and
      // percentages, and the style's other keys are the panel's placement from App.tsx.
      style={
        {
          ...style,
          ...chatStyle,
          visibility: visible ? "visible" : "hidden",
          "--t3-chat-opacity": `${Math.round(state.opacity * 100)}%`,
          "--t3-overlap": folded ? "0px" : "16px",
        } as CSSProperties
      }
    >
      {!titleInCard && <TitleRow title={title} />}

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          className={historyClass}
          style={{ direction: side === "left" ? "rtl" : "ltr" }}
        >
          {/* The inner lane flips back to LTR, and its tail leaves room for the composer's overlap. */}
          <div style={{ direction: "ltr" }} className="px-3 pt-3">
            {panel.remote ? (
              <MachineCard
                machine={environment}
                onOpen={() => target !== null && target !== "draft" && window.overlay.openInT3(target)}
              />
            ) : target === "draft" ? (
              <PlaceholderCard title="New thread" text="Writing a new thread lands with the composer." />
            ) : offline ? (
              <PlaceholderCard
                title={panel.status === "ended" ? "T3 stream ended" : "T3 is not reachable"}
                text={panel.reason ?? "The connection to T3 stopped."}
                action={{ label: "Retry", onClick: () => window.overlay.retryPanel() }}
              />
            ) : view === null ? (
              <p className="py-2 text-center text-[11px] text-t3-muted">Loading the thread…</p>
            ) : (
              <Timeline view={view} pending={pending} onLink={(url) => window.overlay.openLink(url)} />
            )}
          </div>
          <div aria-hidden style={{ height: "calc(12px + var(--t3-overlap))" }} />
        </div>

        {showToEnd && (
          <button
            type="button"
            onClick={scrollToEnd}
            title="Scroll to end"
            className={`absolute bottom-[calc(12px+var(--t3-overlap))] ${side === "left" ? "right-3.5" : "left-3.5"} z-10 flex size-7 items-center justify-center rounded-full border border-[var(--t3-contrast-border)] bg-[var(--t3-popover)] text-t3-fg shadow-lg shadow-black/30`}
          >
            <ArrowDown size={13} />
          </button>
        )}
      </div>

      {canCompose &&
        (folded ? (
          <button
            type="button"
            title="Write"
            onClick={() => setComposerOpen(true)}
            className={`mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--t3-message-action)] text-[var(--t3-message-action-foreground)] shadow-[inset_0_1px_#ffffff29,0_1px_2px_0_color-mix(in_oklab,var(--t3-message-action)_24%,transparent)] transition-colors hover:bg-[var(--t3-message-action-hover)] ${
              side === "left" ? "self-start" : "self-end"
            }`}
          >
            <PenLine size={14} />
          </button>
        ) : (
          <div
            className="-mt-4 flex shrink-0 flex-col rounded-2xl border glass-card"
            style={{ borderColor: "color-mix(in srgb, var(--t3-contrast-foreground) 8%, transparent)" }}
          >
            {titleInCard && <p className="truncate px-[14px] pt-2 pb-0.5 text-[12px] font-semibold text-t3-fg">{title}</p>}
            <div className={titleInCard ? "px-4 pt-2.5 pb-2" : "px-4 pt-3.5 pb-2"}>
              <div className="flex items-center justify-between gap-2 text-[11px] text-t3-muted">
                <span className="min-w-0 truncate">
                  {[project?.title, environment].filter(Boolean).join(" · ")}
                </span>
                <span className="shrink-0">{(running !== null ? "Working" : reply ? "Waiting for you" : "")}</span>
              </div>
              <p className="py-2 text-[length:var(--t3-font-size-prompt)] text-t3-muted">Sending is next</p>
              {/* The model and permission chips, the send button and the textarea land here. */}
              <div className="flex h-8 items-center justify-end" />
            </div>
          </div>
        ))}

      <div
        className={`absolute bottom-0 size-4 ${corner}`}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          window.overlay.dragStart("resize");
          window.addEventListener("mouseup", () => window.overlay.dragEnd(), { once: true });
        }}
      >
        <ResizeGrip />
      </div>
    </div>
  );
}

/**
 * Two diagonal strokes in the bottom-right corner; the corner mirrors them on the left. White with a dark
 * outline, so they read over any game scenery when the chat background is fully transparent. Shown while
 * the pointer is over the chat.
 */
function ResizeGrip() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className="size-full text-white opacity-0 drop-shadow-[0_0_1px_rgb(0_0_0/0.9)] transition-opacity duration-150 group-hover/chat:opacity-80"
    >
      <path d="M13 5 5 13M13 9.5 9.5 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** WoW-style text outline classes; main/store.ts parses the saved value into one of the three. */
function outlineClass(outline: OverlaySettings["textOutline"]): string {
  return outline === "off" ? "" : `text-outline-${outline}`;
}

function TitleRow({ title }: { title: string }) {
  return (
    <div
      className="h-[34px] shrink-0 truncate rounded-t-[12px] border border-[var(--t3-chat-border)] bg-[var(--t3-chat-bg)] px-3 text-[13px] leading-[32px] font-semibold text-t3-fg"
      style={{ borderBottomColor: "color-mix(in srgb, var(--t3-contrast-border) 50%, transparent)" }}
    >
      {title}
    </div>
  );
}

function MachineCard({ machine, onOpen }: { machine: string; onOpen: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--t3-contrast-border)] bg-[var(--t3-popover)] p-4 text-center">
      <p className="text-[13px] text-t3-fg">This thread is on {machine}.</p>
      <p className="text-[11px] text-t3-muted">Only T3 Code itself can open threads on another machine.</p>
      <button
        type="button"
        onClick={onOpen}
        className="rounded-lg bg-[var(--t3-accent)] px-3 py-1.5 text-[13px] text-t3-fg hover:bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_15%,transparent)]"
      >
        Open in T3
      </button>
    </div>
  );
}

function PlaceholderCard({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--t3-contrast-border)] bg-[var(--t3-popover)] p-4 text-center">
      <p className="text-[13px] text-t3-fg">{title}</p>
      <p className="text-[11px] text-t3-muted">{text}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="rounded-lg bg-[var(--t3-accent)] px-3 py-1.5 text-[13px] text-t3-fg hover:bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_15%,transparent)]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function knownThread(state: OverlayState, target: PanelTarget | null): SidebarThread | undefined {
  if (target === null || target === "draft") return undefined;

  return [...state.threads, ...state.working].find(
    (thread) => thread.environmentId === target.environmentId && thread.threadId === target.threadId,
  );
}

/** `title  ·  project · environment`, the row the webview's title used to show. */
function panelTitle(state: OverlayState, thread: PanelThread | null): string {
  const target = state.panel;
  if (target === null) return "";
  if (target === "draft") return "New thread";
  const known = knownThread(state, target);
  const project = state.projects.find((candidate) => candidate.projectId === thread?.projectId);
  const heading = thread?.title || known?.title || "Thread";
  const meta = [project?.title ?? known?.projectName ?? "", known?.environmentLabel ?? "This PC"].filter(Boolean).join(" · ");

  return [heading, meta].filter(Boolean).join("  ·  ");
}

function environmentLabel(state: OverlayState, target: PanelTarget | null, thread: PanelThread | null): string {
  const known = knownThread(state, target);

  if (known !== undefined) return known.environmentLabel;

  if (target !== null && target !== "draft" && thread === null) return target.environmentId;

  return "This PC";
}
