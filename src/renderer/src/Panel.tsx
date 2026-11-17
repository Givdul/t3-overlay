import { ArrowDown, ExternalLink } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import type { PanelAttachment, PanelQueuedMessage, PanelReply, PanelThreadCommand } from "../../shared/panel";
import {
  NEW_THREAD,
  threadKey,
  threadTarget,
  type OverlaySettings,
  type OverlayState,
  type SidebarThread,
  type ThreadRef,
} from "../../shared/types";
import { Composer, type ComposerHandle } from "./panel/Composer";
import { ProjectPicker } from "./panel/ProjectPicker";
import { Timeline } from "./panel/Timeline";
import { activeRun, applyPanelMessage, forceStopNotice, initialState, needsReply, pendingRequests, presentRunStop } from "./panel/model";
import { useDraftFocus, useNewThreadDraft, type NewThreadDraft } from "./panel/useNewThreadDraft";
import { useQueuedEdit } from "./panel/useQueuedEdit";
import { useStopNotice } from "./panel/useStopNotice";

/**
 * The chat panel: a title row, the thread's timeline and a composer, all drawn here. Main owns the
 * socket and forwards the thread's projection; this file draws it. Pressing `+` opens the same panel on
 * the new-thread draft, where the composer starts a thread instead of joining one.
 */
export function Panel({ state, style }: { state: OverlayState; style: CSSProperties }) {
  const target = state.panel;
  const thread = threadTarget(target);
  const draftOpen = target === NEW_THREAD;
  const targetKey = target === null ? "none" : thread === null ? NEW_THREAD : threadKey(thread);
  const threadId = thread?.threadId ?? null;
  const [panel, dispatch] = useReducer(applyPanelMessage, targetKey, initialState);
  const draft = useNewThreadDraft(draftOpen);
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

  useDraftFocus(draftOpen && draft.info !== null, composer);

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
  const runStop = presentRunStop(view);
  const pending = pendingRequests(view);
  // A queued message being rewritten, and the last force stop's wording; both are per-target.
  const queuedEdit = useQueuedEdit(targetKey, view);
  const stopNotice = useStopNotice(targetKey);
  const { side, settings } = state;
  const known = knownThread(state, thread);
  const title = draftOpen ? "New thread" : view?.thread.title || known?.title || "Thread";
  const contextLabel = [known?.projectName, known?.environmentLabel].filter(Boolean).join(" · ");

  // This thread is connecting again with its own projection already drawn: the socket dropped and main
  // is reopening it, rather than a thread being read for the first time.
  const reconnecting = !draftOpen && panel.status === "connecting" && view !== null && view.thread.id === threadId;

  const statusLabel = draftOpen
    ? ""
    : panel.status === "ended"
      ? "Disconnected"
      : reconnecting
        ? "Reconnecting…"
        : panel.status === "connecting"
          ? "Connecting…"
          : running !== null
            ? "Working"
            : reply
              ? "Waiting for you"
              : "";

  const canCompose = draftOpen
    ? state.t3 === "connected" && draft.info !== null
    : thread !== null && panel.status !== "ended" && state.t3 === "connected" && view !== null;

  // A draft keeps its whole card open: the project picker lives on it.
  const folded = canCompose && !draftOpen && settings.compactComposer && !reply && !composerOpen && text === "" && !busy && !focused;
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

  // Editing puts the queued message's words in the composer; cancelling puts the old draft back.
  function beginQueuedEdit(message: PanelQueuedMessage) {
    // An open question holds the composer, as it does in T3, so the edit would happen out of sight.
    if (pending.questions.length > 0) return;

    queuedEdit.begin(message, text);
    setComposerOpen(true);
    composer.current?.edit(message.text);
  }

  function cancelQueuedEdit() {
    const current = queuedEdit.edit;

    queuedEdit.clear();

    if (current !== null) composer.current?.edit(current.restoreText);
  }

  async function saveQueuedEdit(value: string, attachments: PanelAttachment[]): Promise<PanelReply> {
    const editing = queuedEdit.edit;

    if (editing === null) return { ok: false, error: "No queued message is being edited" };
    const message = view?.queued.find((candidate) => candidate.runId === editing.runId);

    const edit: Extract<PanelThreadCommand, { type: "editQueued" }> = {
      type: "editQueued",
      runId: editing.runId,
      text: value,
      // T3 replaces a queued message's attachments on edit, so its own ride along with the new ones.
      attachments: [...(message?.attachments ?? []), ...attachments],
    };

    // Its composer context rides along unchanged, or an edit would drop the message's `@`-mentions.
    if (message?.context !== undefined) edit.context = message.context;
    const save = await window.overlay.panel(edit);

    // Main re-reads the projection; a failed save leaves the edit open with the user's words in it.
    if (save.ok) queuedEdit.clear();

    return save.ok ? { ok: true } : { ok: false, error: save.error };
  }

  async function cancelQueued(message: PanelQueuedMessage): Promise<string | null> {
    const cancelled = await window.overlay.panel({ type: "cancelQueued", runId: message.runId });

    if (!cancelled.ok) return cancelled.error;

    // The message the composer was rewriting is gone; the words in the box stay for a new message.
    if (queuedEdit.edit?.runId === message.runId) queuedEdit.clear();

    return null;
  }

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
      {!titleInCard && <TitleRow title={title} target={thread} />}

      <div className="relative flex min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className={historyClass} style={{ direction: side === "left" ? "rtl" : "ltr" }}>
          {/* The inner lane flips back to LTR, and its tail leaves room for the composer's overlap. */}
          <div style={{ direction: "ltr" }} className="px-3 pt-3">
            {draftOpen ? (
              <DraftHint draft={draft} />
            ) : view !== null ? (
              <Timeline
                view={view}
                pending={pending}
                stop={runStop}
                connection={panel.connection}
                forceStopNotice={stopNotice.notice}
                editingRunId={queuedEdit.edit?.runId ?? null}
                onForceStopResult={stopNotice.show}
                onEditQueued={beginQueuedEdit}
                onCancelEditQueued={cancelQueuedEdit}
                onCancelQueued={cancelQueued}
                onLink={(url) => window.overlay.openLink(url)}
              />
            ) : panel.status === "ended" ? (
              <PlaceholderCard
                title="This thread is closed here"
                text={panel.reason ?? "The connection to T3 stopped."}
                target={thread}
              />
            ) : state.t3 === "offline" ? (
              <PlaceholderCard
                title="T3 Code is not running"
                text="Start T3 Code, and the panel reconnects on its own."
                target={thread}
              />
            ) : (
              <p className="py-2 text-center text-[11px] text-t3-muted">Loading the thread…</p>
            )}
          </div>
          <div aria-hidden style={{ height: canCompose && !folded ? "28px" : "12px" }} />
        </div>

        {reconnecting && (
          <div className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[var(--t3-border)] bg-[var(--t3-popover)] px-2 py-[3px] text-[10px] font-medium text-t3-muted shadow-lg shadow-black/30">
            Reconnecting…
          </div>
        )}

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
          running={draftOpen ? null : running}
          context={
            draftOpen ? (
              <ProjectPicker projects={draft.info?.projects ?? []} current={draft.project} onSelect={draft.selectProject} />
            ) : (
              contextLabel
            )
          }
          statusLabel={statusLabel}
          title={titleInCard ? title : null}
          threadKey={targetKey}
          attachmentUploads={draftOpen ? (draft.info?.attachmentUploads ?? null) : (view?.attachmentUploads ?? null)}
          voiceTranscription={draftOpen ? draft.info?.voiceTranscription === true : view?.voiceTranscription === true}
          modelSelection={draftOpen ? draft.model : (view?.thread.modelSelection ?? null)}
          onPickModel={draftOpen ? draft.selectModel : undefined}
          onSend={draftOpen ? draft.create : sendMessage}
          editingQueued={queuedEdit.edit !== null}
          onSaveQueuedEdit={saveQueuedEdit}
          folded={folded}
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

function TitleRow({ title, target }: { title: string; target: ThreadRef | null }) {
  return (
    <div
      className="flex h-[34px] shrink-0 items-center gap-2 truncate rounded-t-[12px] border border-[var(--t3-chat-border)] bg-[var(--t3-chat-bg)] pr-1.5 pl-3 text-[13px] font-semibold text-t3-fg"
      style={{ borderBottomColor: "color-mix(in srgb, var(--t3-border) 50%, transparent)" }}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {target !== null && <OpenInT3 target={target} />}
    </div>
  );
}

/** Hands the thread to T3 Code, which registers the `t3code://` scheme and routes it. */
function OpenInT3({ target }: { target: ThreadRef }) {
  return (
    <button
      type="button"
      title="Open in T3"
      aria-label="Open in T3"
      onClick={() => window.overlay.openInT3(target)}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg"
    >
      <ExternalLink size={12} />
      Open in T3
    </button>
  );
}

function PlaceholderCard({ title, text, target }: { title: string; text: string; target: ThreadRef | null }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] p-4 text-center">
      <p className="text-[13px] text-t3-fg">{title}</p>
      <p className="text-[11px] text-t3-muted">{text}</p>
      {target !== null && <OpenInT3 target={target} />}
    </div>
  );
}

/** What the draft's empty history says: why it has no projects, or that sending starts the thread. */
function DraftHint({ draft }: { draft: NewThreadDraft }) {
  if (draft.error !== null) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] p-4 text-center">
        <p className="text-[11px] whitespace-pre-wrap text-t3-muted">{draft.error}</p>
        <button
          type="button"
          onClick={draft.retry}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-t3-fg transition-colors hover:bg-t3-accent"
        >
          Try again
        </button>
      </div>
    );
  }

  if (draft.info === null) return <p className="py-2 text-center text-[11px] text-t3-muted">Loading projects…</p>;

  if (draft.info.projects.length === 0) {
    return <p className="py-2 text-center text-[11px] text-t3-muted">T3 has no projects to start a thread in.</p>;
  }

  return <p className="py-2 text-center text-[11px] text-t3-muted">Send a message to start the thread.</p>;
}

/** The open thread's send: a message into it, queued behind its run when one is active. */
function sendMessage(text: string, attachments: PanelAttachment[], queue: boolean) {
  return window.overlay.panel({ type: "send", text, attachments, queue });
}

function knownThread(state: OverlayState, target: ThreadRef | null): SidebarThread | undefined {
  if (target === null) return undefined;

  return [...state.threads, ...state.working].find(
    (thread) => thread.environmentId === target.environmentId && thread.threadId === target.threadId,
  );
}
