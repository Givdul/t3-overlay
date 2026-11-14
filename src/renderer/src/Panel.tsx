import { ArrowDown, ExternalLink } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { threadKey, type OverlaySettings, type OverlayState, type PanelTarget, type SidebarThread } from "../../shared/types";
import { Composer, type ComposerHandle } from "./panel/Composer";
import { Timeline } from "./panel/Timeline";
import { activeRun, applyPanelMessage, initialState, needsReply, pendingRequests } from "./panel/model";

/**
 * The chat panel: a title row, the thread's timeline and a composer, all drawn here. Main owns the
 * socket and forwards the thread's projection; this file draws it.
 */
export function Panel({ state, style }: { state: OverlayState; style: CSSProperties }) {
  const target = state.panel;
  const targetKey = target === null ? "none" : threadKey(target);
  const threadId = target?.threadId ?? null;
  const [panel, dispatch] = useReducer(applyPanelMessage, targetKey, initialState);
  const [composerOpen, setComposerOpen] = useState(false);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showToEnd, setShowToEnd] = useState(false);
  const composer = useRef<ComposerHandle | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastScrollTop = useRef(0);
  const threadRef = useRef(threadId);
  const targetRef = useRef(targetKey);
  threadRef.current = threadId;
  targetRef.current = targetKey;

  // A new thread starts clean: no text, no unfolded composer.
  useEffect(() => {
    setComposerOpen(false);
    setText("");
    setFocused(false);
    setBusy(false);
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

    if (element === null || !follow.current) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTop.current = element.scrollTop;
  });

  // The focus hotkey opens the composer and puts the caret in it.
  useEffect(
    () =>
      window.overlay.onFocusComposer(() => {
        setComposerOpen(true);
        composer.current?.focus();
      }),
    [],
  );

  const view = panel.view;
  const reply = needsReply(view);
  const running = activeRun(view);
  const pending = pendingRequests(view);
  const { side, settings } = state;
  const known = knownThread(state, target);
  const title = view?.thread.title || known?.title || "Thread";
  const contextLabel = [known?.projectName, known?.environmentLabel].filter(Boolean).join(" · ");

  // A thread on another machine is read through this PC's T3 server, and acted on through its `/mcp`
  // endpoint. An approval has no `/mcp` call, so its card hands the thread to T3.
  const remote = target !== null && state.localEnvironmentId !== null && target.environmentId !== state.localEnvironmentId;
  const machine = remote && target !== null ? (state.machines.find((candidate) => candidate.environmentId === target.environmentId)?.label ?? null) : null;
  const openInT3 = remote && target !== null ? () => window.overlay.openInT3(target) : null;

  const statusLabel =
    panel.status === "ended" ? "Disconnected" : panel.status === "connecting" ? "Connecting…" : running !== null ? "Working" : reply ? "Waiting for you" : "";

  const canCompose = target !== null && panel.status !== "ended" && state.t3 === "connected" && view !== null;
  const folded = canCompose && settings.compactComposer && !reply && !composerOpen && text === "" && !busy && !focused;
  const titleInCard = settings.titleInComposer && canCompose && !folded;
  const visible = target !== null;

  // A transition runs with the values of the state it moves to, so the closed state has none and closes at once.
  // The slide starts inside the gap to the sidebar, so the panel never draws over it.
  const entrance = visible
    ? state.panelEntrance === "slide"
      ? "transition-[opacity,translate] duration-220 ease-out"
      : ""
    : `opacity-0 ${side === "left" ? "motion-safe:-translate-x-1.5" : "motion-safe:translate-x-1.5"}`;

  const corner = side === "left" ? "right-0 cursor-nwse-resize" : "left-0 -scale-x-100 cursor-nesw-resize";

  // The chat window fades with the opacity slider, borders included; the composer card keeps its own surface.
  // SAFETY: these are CSS custom properties, which React writes through as strings; the stylesheet reads
  // them inside color-mix() below.
  const chatStyle = {
    "--t3-chat-bg": "color-mix(in srgb, var(--t3-background) var(--t3-chat-opacity), transparent)",
    "--t3-chat-border": "color-mix(in srgb, var(--t3-border) var(--t3-chat-opacity), transparent)",
  } as CSSProperties;

  const historyClass = [
    "panel-scroll h-full w-full overflow-y-auto rounded-b-[12px] border bg-[var(--t3-chat-bg)] border-[var(--t3-chat-border)]",
    titleInCard ? "rounded-t-[12px] border-t" : "border-t-0",
    canCompose && !folded ? "rounded-b-none border-b-0" : "",
  ].join(" ");

  const onScroll = () => {
    const element = scroller.current;

    if (!element) return;
    const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 8;

    // New rows grow the history while the reader is at the end; only scrolling up leaves it.
    if (element.scrollTop < lastScrollTop.current) follow.current = false;

    if (atEnd) follow.current = true;
    lastScrollTop.current = element.scrollTop;
    setShowToEnd(!atEnd);
  };

  const scrollToEnd = () => {
    follow.current = true;
    setShowToEnd(false);
    const element = scroller.current;

    if (element !== null) {
      lastScrollTop.current = element.scrollHeight;
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    }
  };

  const onFocusChange = (next: boolean) => {
    setFocused(next);

    if (next) {
      setComposerOpen(true);

      return;
    }

    // Empty and unfocused folds back into the write button.
    if (text === "" && !busy) setComposerOpen(false);
  };

  return (
    <div
      className={`group/chat flex min-h-0 flex-col ${entrance} ${outlineClass(settings.textOutline)} ${canCompose && !folded ? "pb-4" : ""}`}
      // SAFETY: React passes custom properties through untouched; the CSS reads them as numbers and
      // percentages, and the style's other keys are the panel's placement from App.tsx.
      style={
        {
          ...style,
          ...chatStyle,
          visibility: visible ? "visible" : "hidden",
          "--t3-chat-opacity": `${Math.round(state.opacity * 100)}%`,
          "--t3-bubble-opacity": `${Math.round(settings.bubbles * 100)}%`,
        } as CSSProperties
      }
    >
      {!titleInCard && <TitleRow title={title} target={target} machine={machine} />}

      <div className="relative flex min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className={historyClass} style={{ direction: side === "left" ? "rtl" : "ltr" }}>
          {/* The inner lane flips back to LTR, and its tail leaves room for the composer's overlap. */}
          <div style={{ direction: "ltr" }} className="px-3 pt-3">
            {view !== null ? (
              <Timeline view={view} pending={pending} onLink={(url) => window.overlay.openLink(url)} onOpenInT3={openInT3} />
            ) : panel.status === "ended" ? (
              <PlaceholderCard
                title="This thread is closed here"
                text={panel.reason ?? "The connection to T3 stopped."}
                target={target}
              />
            ) : state.t3 === "offline" ? (
              <PlaceholderCard
                title="T3 Code is not running"
                text="Start T3 Code, and the panel reconnects on its own."
                target={target}
              />
            ) : (
              <p className="py-2 text-center text-[11px] text-t3-muted">Loading the thread…</p>
            )}
          </div>
          <div aria-hidden style={{ height: canCompose && !folded ? "28px" : "12px" }} />
        </div>

        {showToEnd && (
          <button
            type="button"
            onClick={scrollToEnd}
            title="Scroll to end"
            className={`absolute bottom-3 ${side === "left" ? "right-3.5" : "left-3.5"} z-10 flex size-7 items-center justify-center rounded-full border border-[var(--t3-border)] bg-[var(--t3-popover)] text-t3-fg shadow-lg shadow-black/30`}
          >
            <ArrowDown size={13} />
          </button>
        )}
      </div>

      {canCompose && (
        <Composer
          side={side}
          running={running}
          contextLabel={contextLabel}
          statusLabel={statusLabel}
          title={titleInCard ? title : null}
          folded={folded}
          onTextChange={setText}
          onFocusChange={onFocusChange}
          onBusyChange={setBusy}
          onUnfold={() => {
            setComposerOpen(true);
            composer.current?.focus();
          }}
          onSent={() => window.overlay.sent()}
          onOpenInT3={openInT3}
          handle={composer}
        />
      )}

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
 * outline, so they read over any game scenery when the chat background is fully transparent.
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

function TitleRow({ title, target, machine }: { title: string; target: PanelTarget; machine: string | null }) {
  return (
    <div
      className="flex h-[34px] shrink-0 items-center gap-2 truncate rounded-t-[12px] border border-[var(--t3-chat-border)] bg-[var(--t3-chat-bg)] pr-1.5 pl-3 text-[13px] font-semibold text-t3-fg"
      style={{ borderBottomColor: "color-mix(in srgb, var(--t3-border) 50%, transparent)" }}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {machine !== null && <span className="max-w-[45%] shrink-0 truncate text-[11px] font-normal text-t3-muted">{machine}</span>}
      <OpenInT3 target={target} />
    </div>
  );
}

/** Hands the thread to T3 Code, which registers the `t3code://` scheme and routes it. */
function OpenInT3({ target }: { target: PanelTarget }) {
  return (
    <button
      type="button"
      title="Open in T3"
      aria-label="Open in T3"
      disabled={target === null}
      onClick={() => (target === null ? undefined : window.overlay.openInT3(target))}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg disabled:pointer-events-none"
    >
      <ExternalLink size={12} />
      Open in T3
    </button>
  );
}

function PlaceholderCard({ title, text, target }: { title: string; text: string; target: PanelTarget }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] p-4 text-center">
      <p className="text-[13px] text-t3-fg">{title}</p>
      <p className="text-[11px] text-t3-muted">{text}</p>
      <OpenInT3 target={target} />
    </div>
  );
}

function knownThread(state: OverlayState, target: PanelTarget): SidebarThread | undefined {
  if (target === null) return undefined;

  return [...state.threads, ...state.working].find(
    (thread) => thread.environmentId === target.environmentId && thread.threadId === target.threadId,
  );
}
