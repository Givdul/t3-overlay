import { ArrowUp, PenLine } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import type { PanelRun } from "../../../shared/panel";

// The panel's composer: plain text, Enter sends, Stop while a turn runs. Enter queues behind the
// active run instead of starting one; T3 draws the queued message in the timeline until it starts.

export interface ComposerHandle {
  focus(): void;
}

interface ComposerProps {
  side: "left" | "right";
  running: PanelRun | null;
  /** The thread's project and machine, on the card's status row. */
  contextLabel: string;
  /** "Working", "Waiting for you", or empty. */
  statusLabel: string;
  /** Drawn inside the card when the title-in-composer setting is on. */
  title: string | null;
  folded: boolean;
  onTextChange(text: string): void;
  onFocusChange(focused: boolean): void;
  onBusyChange(busy: boolean): void;
  onUnfold(): void;
  onSent(): void;
  handle: RefObject<ComposerHandle | null>;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const wantFocus = useRef(false);
  const textRef = useRef("");
  textRef.current = text;

  const notify = useRef(props);
  notify.current = props;

  const setDraftText = (value: string) => {
    textRef.current = value;
    setText(value);
    props.onTextChange(value);
  };

  // The fold and the focus hotkey live in Panel; the textarea keeps the actual caret.
  useImperativeHandle(props.handle, () => ({
    focus() {
      wantFocus.current = true;
      textarea.current?.focus();
      const end = textRef.current.length;
      textarea.current?.setSelectionRange(end, end);
    },
  }));

  useEffect(() => {
    if (props.folded || !wantFocus.current) return;
    wantFocus.current = false;
    textarea.current?.focus();
  }, [props.folded]);

  // Auto-grow up to eight lines, then scroll.
  useEffect(() => {
    const element = textarea.current;

    if (element === null) return;
    element.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
    element.style.height = `${Math.min(element.scrollHeight, lineHeight * 8)}px`;
  }, [text]);

  useEffect(() => notify.current.onBusyChange(sending), [sending]);

  async function submit() {
    const value = textRef.current.trim();

    if (sending || value === "") return;
    setSending(true);
    setError(null);

    // T3 clears the box as it dispatches; a failure puts the draft back.
    const snapshot = textRef.current;
    setDraftText("");

    let reply;

    try {
      reply = await window.overlay.panel({ type: "send", text: value, queue: props.running !== null });
    } catch (sendError) {
      reply = { ok: false as const, error: sendError instanceof Error ? sendError.message : String(sendError) };
    }

    setSending(false);

    if (!reply.ok) {
      setError(reply.error);
      setDraftText(snapshot);

      return;
    }

    props.onSent();
    textarea.current?.focus();
  }

  if (props.folded) {
    return (
      <button
        type="button"
        title="Write"
        onClick={props.onUnfold}
        className={`mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--t3-primary)] text-white shadow-[inset_0_1px_#ffffff29,0_1px_2px_0_color-mix(in_oklab,var(--t3-primary)_24%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--t3-primary)_90%,#000)] ${
          props.side === "left" ? "self-start" : "self-end"
        }`}
      >
        <PenLine size={14} />
      </button>
    );
  }

  return (
    <div
      className="-mt-4 flex shrink-0 flex-col rounded-2xl border border-[var(--t3-border)] bg-[color-mix(in_srgb,var(--t3-popover)_92%,transparent)] backdrop-blur-sm"
      onFocus={() => props.onFocusChange(true)}
      onBlur={(event) => {
        const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;

        if (!event.currentTarget.contains(next)) props.onFocusChange(false);
      }}
    >
      {props.title !== null && <p className="truncate px-[14px] pt-2 pb-0.5 text-[12px] font-semibold text-t3-fg">{props.title}</p>}
      <div className="flex items-center justify-between gap-2 px-4 pt-2 pb-1 text-[11px] text-t3-muted">
        <span className="min-w-0 truncate">{props.contextLabel}</span>
        <span className="shrink-0">{props.statusLabel}</span>
      </div>

      <textarea
        ref={textarea}
        rows={1}
        value={text}
        onChange={(event) => setDraftText(event.target.value)}
        onKeyDown={(event) => {
          // An IME's Enter confirms the candidate, not the message.
          if (event.nativeEvent.isComposing) return;

          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={props.running === null ? "Write a message" : "Queue a message"}
        className="mx-4 max-h-40 min-h-[22px] resize-none bg-transparent py-1.5 text-[length:var(--t3-font-size-prompt)] leading-relaxed text-t3-fg outline-none select-text placeholder:text-t3-muted"
      />

      {error !== null && (
        <div className="flex items-start gap-1.5 px-4 pt-1 pb-1 text-[11px] text-[var(--t3-error-foreground)]">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
        </div>
      )}

      <div className="flex h-9 items-center gap-1 px-4 pb-1">
        {props.running !== null && (
          <button
            type="button"
            title="Stop"
            aria-label="Stop"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              void window.overlay.panel({ type: "stop", runId: props.running?.id ?? "" });
              textarea.current?.focus();
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--t3-error-foreground)_90%,transparent)] text-white hover:bg-[var(--t3-error-foreground)]"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
              <rect x="2" y="2" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        )}
        <div className="min-w-0 flex-1" />
        <button
          type="button"
          title={props.running === null ? "Send" : "Queue message"}
          aria-label={props.running === null ? "Send" : "Queue message"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void submit()}
          disabled={sending || text.trim() === ""}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--t3-primary)] text-white shadow-[inset_0_1px_#ffffff29,0_1px_2px_0_color-mix(in_oklab,var(--t3-primary)_24%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--t3-primary)_90%,#000)] disabled:pointer-events-none disabled:bg-[color-mix(in_srgb,var(--t3-foreground)_12%,transparent)] disabled:text-t3-muted disabled:shadow-none"
        >
          <ArrowUp size={15} />
        </button>
      </div>
    </div>
  );
}
