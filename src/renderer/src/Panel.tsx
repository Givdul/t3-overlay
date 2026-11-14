import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import type { ComposeCommand } from "../../shared/compose";
import { threadKey, type OverlaySettings, type OverlayState, type SidebarThread, type ThreadRef } from "../../shared/types";
import { Composer, type ComposerHandle } from "./panel/Composer";
import { History, PlaceholderCard, TitleRow, machineNote } from "./panel/Frame";
import { NewThread } from "./panel/NewThread";
import { Timeline } from "./panel/Timeline";
import { activeRun, applyPanelMessage, initialState, needsReply, pendingRequests } from "./panel/model";

/**
 * The chat panel: a title row, the thread's timeline and a composer, all drawn here. Main owns the
 * socket and forwards the thread's projection; this file draws it. The `+` button opens the same frame
 * on the new-thread composer.
 */
export function Panel({ state, style }: { state: OverlayState; style: CSSProperties }) {
  const target = state.panel;
  const visible = target !== null;
  const { side, settings } = state;

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

  return (
    <div
      className={`group/chat flex min-h-0 flex-col ${entrance} ${outlineClass(settings.textOutline)}`}
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
      {target === "new" ? <NewThread state={state} /> : <ThreadPanel state={state} target={target} />}

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

function ThreadPanel({ state, target }: { state: OverlayState; target: ThreadRef | null }) {
  const targetKey = target === null ? "none" : threadKey(target);
  const threadId = target?.threadId ?? null;
  const [panel, dispatch] = useReducer(applyPanelMessage, targetKey, initialState);
  const [composerOpen, setComposerOpen] = useState(false);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commands, setCommands] = useState<ComposeCommand[]>([]);
  const composer = useRef<ComposerHandle | null>(null);
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
  }, [targetKey]);

  useEffect(
    () =>
      window.overlay.onPanel((message) => {
        if ("threadId" in message && message.threadId !== threadRef.current) return;
        dispatch({ kind: "message", targetKey: targetRef.current, message });
      }),
    [],
  );

  // The focus hotkey opens the composer and puts the caret in it.
  useEffect(
    () =>
      window.overlay.onFocusComposer(() => {
        setComposerOpen(true);
        composer.current?.focus();
      }),
    [],
  );

  const machine = target === null ? undefined : state.machines.find((candidate) => candidate.environmentId === target.environmentId);
  const connected = machine?.status === "connected";

  // The `/` menu lists this thread's provider's commands, read once per thread while its machine is connected.
  useEffect(() => {
    setCommands([]);

    if (target === null || !connected) return;

    let current = true;
    window.overlay.composeCommands(target).then(
      (found) => current && setCommands(found),
      () => undefined,
    );

    return () => {
      current = false;
    };
    // The target object is a new one on every broadcast; its key is what changes the thread.
  }, [targetKey, connected]);

  const view = panel.view;
  const reply = needsReply(view);
  const running = activeRun(view);
  const pending = pendingRequests(view);
  const { side, settings } = state;
  const known = knownThread(state, target);
  const title = view?.thread.title || known?.title || "Thread";
  const contextLabel = [known?.projectName, known?.environmentLabel].filter(Boolean).join(" · ");

  const statusLabel =
    panel.status === "ended" ? "Disconnected" : panel.status === "connecting" ? "Connecting…" : running !== null ? "Working" : reply ? "Waiting for you" : "";

  const canCompose = target !== null && panel.status !== "ended" && connected && view !== null;
  const folded = canCompose && settings.compactComposer && !reply && !composerOpen && text === "" && !busy && !focused;
  const titleInCard = settings.titleInComposer && canCompose && !folded;

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
    <>
      {!titleInCard && <TitleRow title={title} target={target} machine={machine !== undefined && !machine.local ? machine.label : null} />}

      <History side={side} titleInCard={titleInCard} open={canCompose && !folded}>
        {view !== null ? (
          <Timeline view={view} pending={pending} onLink={(url) => window.overlay.openLink(url)} />
        ) : panel.status === "ended" ? (
          <PlaceholderCard title="This thread is closed here" text={panel.reason ?? "The connection to T3 stopped."} target={target} />
        ) : machine?.local === true && !connected ? (
          <PlaceholderCard title="T3 Code is not running" text="Start T3 Code, and the panel reconnects on its own." target={target} />
        ) : machine !== undefined && !connected ? (
          <PlaceholderCard title={`${machine.label} is not connected`} text={machineNote(machine.status)} target={target} />
        ) : (
          <p className="py-2 text-center text-[11px] text-t3-muted">Loading the thread…</p>
        )}
      </History>

      {canCompose && (
        // A flex column, so the folded write button keeps to the sidebar's side and the card's -mt-4 overlaps the history.
        <div className={`flex shrink-0 flex-col ${folded ? "" : "pb-4"}`}>
          <Composer
            side={side}
            running={running}
            header={
              <>
                <span className="min-w-0 truncate">{contextLabel}</span>
                <span className="shrink-0">{statusLabel}</span>
              </>
            }
            title={titleInCard ? title : null}
            folded={folded}
            placeholder={running === null ? "Write a message" : "Queue a message"}
            files={target === null ? null : { kind: "thread", environmentId: target.environmentId, threadId: target.threadId }}
            commands={commands}
            allowClear
            ready
            onSubmit={(message) => window.overlay.panel({ type: "send", queue: running !== null, ...message })}
            onTextChange={setText}
            onFocusChange={onFocusChange}
            onBusyChange={setBusy}
            onUnfold={() => {
              setComposerOpen(true);
              composer.current?.focus();
            }}
            onSent={() => window.overlay.sent()}
            handle={composer}
          />
        </div>
      )}
    </>
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

function knownThread(state: OverlayState, target: ThreadRef | null): SidebarThread | undefined {
  if (target === null) return undefined;

  return [...state.threads, ...state.working].find(
    (thread) => thread.environmentId === target.environmentId && thread.threadId === target.threadId,
  );
}
