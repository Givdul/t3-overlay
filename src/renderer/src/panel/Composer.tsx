import { ArrowUp, ExternalLink, FileText, ListChecks, LoaderCircle, Mic, Paperclip, PenLine, Square, X } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from "react";
import { formatAttachmentSize } from "../../../shared/attachments";
import type {
  PanelAttachment,
  PanelAttachmentReply,
  PanelAttachmentUploads,
  PanelCreateReply,
  PanelModelOption,
  PanelModelSelection,
  PanelReply,
  PanelRun,
} from "../../../shared/panel";
import { findModel } from "./modelTraits";
import { ComposerMenu } from "./ComposerMenu";
import { applyComposerSuggestion, clearComposerTrigger } from "./composerTrigger";
import { ModelPicker } from "./ModelPicker";
import { RuntimeModePicker } from "./RuntimeModePicker";
import { TraitsPicker } from "./TraitsPicker";
import { useComposerAttachments } from "./useComposerAttachments";
import { useComposerMenu, type ComposerMenuItem } from "./useComposerMenu";
import { useModelCatalog } from "./useModelCatalog";
import { usePendingCaret } from "./usePendingCaret";
import { useVoiceInput, type VoicePhase } from "./useVoiceInput";

// The panel's composer: plain text, attachments, dictation, Enter sends, Stop while a turn runs. Enter
// queues behind the active run instead of starting one; T3 draws the queued message until it starts.
// The new-thread draft draws the same card, and its send starts the thread instead of joining one.
// Its footer holds T3's composer settings: the model, the model's options, plan mode and the thread's
// permission mode. Typing `/` or `@` opens T3's own command and file menus above the box.

export interface ComposerHandle {
  focus(): void;
  /** Puts an existing message's text in the box, for editing a queued message. */
  edit(text: string): void;
}

interface ComposerProps {
  side: "left" | "right";
  running: PanelRun | null;
  /** The thread's project and machine, on the card's status row; the draft puts its project picker there. */
  context: ReactNode;
  /** "Working", "Waiting for you", or empty. */
  statusLabel: string;
  /** Drawn inside the card when the title-in-composer setting is on. */
  title: string | null;
  /** The open thread, so an attachment never travels to the next one. */
  threadKey: string;
  /** The server's upload capability; null hides the attach control. */
  attachmentUploads: PanelAttachmentUploads | null;
  /** The server transcribes speech itself; false hides the mic. */
  voiceTranscription: boolean;
  /** The thread's model; null hides the model control. */
  modelSelection: PanelModelSelection | null;
  /** Whether the model's options are offered; another machine's thread cannot take them. */
  modelTraits: boolean;
  /** The thread's permission mode; null hides the mode control. */
  runtimeMode: string | null;
  /** "default" or "plan"; null hides the plan toggle. */
  interactionMode: string | null;
  /** The project whose files `@` searches, and whose own skills the provider scan adds; null hides the file menu. */
  projectId: string | null;
  /** Whether `/` and `@` open T3's menus; another machine's thread offers neither. */
  composerMenus: boolean;
  /** The draft picks the model its new thread starts on; an open thread switches through main. */
  onPickModel?: (selection: PanelModelSelection) => void;
  /** The draft keeps the model's options for the thread it creates; an open thread writes through main. */
  onPickModelOptions?: (options: PanelModelOption[]) => void;
  /** The draft keeps the permission mode for the thread it creates; an open thread writes through main. */
  onPickRuntimeMode?: (mode: string) => void;
  /** The draft keeps plan mode for the thread it creates; an open thread writes through main. */
  onSetPlanMode?: (plan: boolean) => void;
  /** Sends the message into the open thread, or starts the draft's thread with it. */
  onSend(text: string, attachments: PanelAttachment[], queue: boolean): Promise<PanelReply | PanelAttachmentReply | PanelCreateReply>;
  /** The queued message this box is editing; its save replaces send and queue. */
  editingQueued: boolean;
  /** Saves the edited text into the queued message, with its existing and new attachments. */
  onSaveQueuedEdit?: (text: string, attachments: PanelAttachment[]) => Promise<PanelReply | PanelAttachmentReply>;
  folded: boolean;
  onTextChange(text: string): void;
  onFocusChange(focused: boolean): void;
  onBusyChange(busy: boolean): void;
  onUnfold(): void;
  onSent(): void;
  /** Set for a thread on another machine, whose refusals only T3 can get past. */
  onOpenInT3: (() => void) | null;
  handle: RefObject<ComposerHandle | null>;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ error: string; grant: boolean } | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  const textRef = useRef("");
  textRef.current = text;
  const placeCaret = usePendingCaret(text, textarea);

  const notify = useRef(props);
  notify.current = props;

  // The panel keeps the composer unfolded while either kind of draft is on its way somewhere.
  const attachmentsBusy = useRef(false);
  const voicePhase = useRef<VoicePhase>("idle");
  const reportBusy = () => notify.current.onBusyChange(attachmentsBusy.current || voicePhase.current !== "idle");

  const draft = useComposerAttachments({
    threadKey: props.threadKey,
    capability: props.attachmentUploads,
    active: sending,
    onError: setError,
    onBusy: (busy) => {
      attachmentsBusy.current = busy;
      reportBusy();
    },
  });

  const voice = useVoiceInput({
    threadKey: props.threadKey,
    enabled: props.voiceTranscription,
    onTranscript: insertTranscript,
    onError: setError,
    onPhase: (phase) => {
      voicePhase.current = phase;
      reportBusy();
    },
  });

  const attachments = draft.attachments;
  const attachable = props.attachmentUploads !== null;
  const uploading = attachments.some((attachment) => attachment.status !== "ready");

  // The catalog is read once for the whole footer: the model list, the model's options, the provider's
  // permission modes, plan toggle, commands and skills all come from it.
  const catalog = useModelCatalog(props.threadKey, props.projectId);
  const named = props.modelSelection === null ? null : findModel(catalog.providers, props.modelSelection);
  const planAllowed = props.interactionMode !== null && named?.provider.showInteractionModeToggle !== false;
  const planOn = props.interactionMode === "plan";

  // T3's two autocomplete menus, read from the token at the caret.
  const menu = useComposerMenu({
    enabled: props.composerMenus,
    text,
    caret,
    projectId: props.projectId,
    provider: named?.provider ?? null,
  });

  /** T3's plan toggle (apps/mobile/src/state/thread-outbox-model.ts, resolveProviderInteractionMode). */
  async function togglePlan() {
    const next = planOn ? "default" : "plan";

    if (props.onSetPlanMode !== undefined) {
      props.onSetPlanMode(next === "plan");

      return;
    }

    setError(null);
    const reply = await window.overlay.panel({ type: "setInteractionMode", interactionMode: next });

    if (!reply.ok) setError(reply.error);
  }

  const setDraftText = (value: string) => {
    textRef.current = value;
    setText(value);
    props.onTextChange(value);
  };

  /** Applies a menu pick to the box: T3 inserts the text at the trigger and leaves the caret after it. */
  function pickSuggestion(item: ComposerMenuItem) {
    const trigger = menu.trigger;

    if (trigger === null) return;

    // T3's `/model` clears the trigger and opens the model list instead of sending a command.
    if (item.opensModelPicker) {
      const cleared = clearComposerTrigger(textRef.current, trigger);

      setDraftText(cleared.text);
      setCaret(cleared.caret);
      placeCaret(cleared.caret);
      setModelPickerOpen(true);

      return;
    }

    if (item.insertion === null) return;

    const next = applyComposerSuggestion(textRef.current, trigger, item.insertion);

    setDraftText(next.text);
    setCaret(next.caret);
    placeCaret(next.caret);
  }

  /** Puts a transcript where the caret was, with a space where words would otherwise run together. */
  function insertTranscript(transcript: string) {
    const element = textarea.current;
    const value = textRef.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const left = value.slice(0, start);
    const right = value.slice(end);
    const insert = `${left !== "" && !/\s$/.test(left) ? " " : ""}${transcript}${right !== "" && !/^\s/.test(right) ? " " : ""}`;

    setDraftText(left + insert + right);
    setCaret(start + insert.length);
    placeCaret(start + insert.length);
  }

  // The fold and the focus hotkey live in Panel; the textarea keeps the actual caret.
  useImperativeHandle(props.handle, () => ({
    focus() {
      wantFocus.current = true;
      textarea.current?.focus();
      const end = textRef.current.length;
      textarea.current?.setSelectionRange(end, end);
    },
    edit(value) {
      wantFocus.current = true;
      setDraftText(value);
      setCaret(value.length);
      placeCaret(value.length);
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

  async function submit() {
    const value = textRef.current.trim();

    const uploaded = attachments.flatMap((attachment): PanelAttachment[] =>
      attachment.id === null || attachment.status !== "ready"
        ? []
        : [
            {
              id: attachment.id,
              type: attachment.type,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          ],
    );

    if (sending || (value === "" && uploaded.length === 0) || uploaded.length !== attachments.length) return;
    setSending(true);
    setError(null);
    setRefusal(null);

    // The send owns these uploads before it leaves: a thread switch while it is in flight must not
    // delete what the message is about to reference. A failure puts them back in the draft's hands.
    const claimed = draft.markSent();

    // T3 clears the box as it dispatches; a failure puts the draft back.
    const snapshot = textRef.current;
    setDraftText("");

    let reply: PanelAttachmentReply | PanelReply;

    try {
      reply =
        props.editingQueued && props.onSaveQueuedEdit !== undefined
          ? await props.onSaveQueuedEdit(value, uploaded)
          : await props.onSend(value, uploaded, props.running !== null);
    } catch (sendError) {
      reply = { ok: false as const, error: sendError instanceof Error ? sendError.message : String(sendError) };
    }

    setSending(false);

    if (!reply.ok) {
      draft.unmarkSent(claimed);

      // A remote action T3 turned down is answered in T3, so the card carries T3's own message.
      if (reply.refusal === true && props.onOpenInT3 !== null) setRefusal({ error: reply.error, grant: reply.grant === true });
      else setError(reply.error);
      setDraftText(snapshot);

      return;
    }

    draft.clear();
    // An edit stays in the panel; only a sent message can close it.

    if (!props.editingQueued) props.onSent();
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
      className="relative -mt-4 flex shrink-0 flex-col rounded-2xl border border-[var(--t3-border)] bg-[color-mix(in_srgb,var(--t3-popover)_92%,transparent)] backdrop-blur-sm"
      onFocus={() => props.onFocusChange(true)}
      onBlur={(event) => {
        const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;

        if (!event.currentTarget.contains(next)) props.onFocusChange(false);
      }}
      onDragOver={(event) => {
        if (!attachable) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!attachable) return;
        event.preventDefault();
        draft.addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {props.title !== null && <p className="truncate px-[14px] pt-2 pb-0.5 text-[12px] font-semibold text-t3-fg">{props.title}</p>}
      <div className="flex items-center justify-between gap-2 px-4 pt-2 pb-1 text-[11px] text-t3-muted">
        <span className="flex min-w-0 items-center">{props.context}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {/* T3 puts the permission picker on the draft's context strip; the thread's status row has room for it. */}
          {props.runtimeMode !== null && named !== null && (
            <RuntimeModePicker
              current={props.runtimeMode}
              supported={named.provider.supportedRuntimeModes}
              policy={catalog.policy}
              onPick={props.onPickRuntimeMode}
            />
          )}
          {props.statusLabel !== "" && <span>{props.statusLabel}</span>}
        </span>
      </div>

      {menu.kind !== null && <ComposerMenu menu={menu} onPick={pickSuggestion} />}

      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-1 pb-0.5">
          {attachments.map((attachment) =>
            attachment.preview !== null ? (
              <div
                key={attachment.key}
                className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--t3-border)_100%,transparent)] bg-[var(--t3-message-surface)]"
              >
                <img src={attachment.preview} alt={attachment.name} className="size-full object-cover" />
                {attachment.status !== "ready" && (
                  <span
                    className={`absolute inset-x-0 bottom-0 bg-black/65 px-1 text-center text-[9px] leading-4 ${
                      attachment.status === "failed" ? "text-[var(--t3-error-foreground)]" : "text-white"
                    }`}
                  >
                    {attachment.status === "failed" ? "Failed" : "Uploading"}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  title={`Remove ${attachment.name}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => draft.remove(attachment)}
                  className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-white/90 transition-colors hover:bg-black/85"
                >
                  <X size={10} />
                </button>
              </div>
            ) : (
              <div
                key={attachment.key}
                className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--t3-border)_100%,transparent)] bg-[color-mix(in_srgb,var(--t3-foreground)_4%,transparent)] py-1 ps-2 pe-1 text-[11px] text-t3-fg"
              >
                <FileText size={12} className="shrink-0 text-t3-muted" />
                <span className="min-w-0 flex-1 truncate" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className={`shrink-0 ${attachment.status === "failed" ? "text-[var(--t3-error-foreground)]" : "text-t3-muted"}`}>
                  {attachment.status === "uploading"
                    ? "Uploading…"
                    : attachment.status === "failed"
                      ? "Failed"
                      : formatAttachmentSize(attachment.sizeBytes)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  title={`Remove ${attachment.name}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => draft.remove(attachment)}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-t3-muted transition-colors hover:text-t3-fg"
                >
                  <X size={11} />
                </button>
              </div>
            ),
          )}
        </div>
      )}

      <textarea
        ref={textarea}
        rows={1}
        value={text}
        onChange={(event) => {
          const value = event.target.value;

          setDraftText(value);
          setCaret(event.target.selectionStart ?? value.length);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? textRef.current.length)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart ?? textRef.current.length)}
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? textRef.current.length)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);

          // An image paste attaches the image; a file with text keeps the text as text, as T3 does.
          if (!attachable || files.length === 0) return;

          if (!files.some((file) => file.type.startsWith("image/")) && event.clipboardData.getData("text/plain") !== "") return;
          event.preventDefault();
          draft.addFiles(files);
        }}
        onKeyDown={(event) => {
          // An IME's Enter confirms the candidate, not the message.
          if (event.nativeEvent.isComposing) return;

          // An open menu takes the keys it needs: arrows move its highlight while it lists rows, Enter
          // or Tab picks the highlighted row, and Escape closes it alone rather than the panel behind it.
          // With nothing highlighted, Enter and Tab fall through to the send below.
          if (menu.kind !== null) {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && menu.items.length > 0) {
              event.preventDefault();
              menu.move(event.key === "ArrowDown" ? 1 : -1);

              return;
            }

            if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
              const item = menu.chosen();

              if (item !== null) {
                event.preventDefault();
                pickSuggestion(item);

                return;
              }
            }

            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              menu.dismiss();

              return;
            }
          }

          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={props.editingQueued ? "Edit the queued message" : props.running === null ? "Write a message" : "Queue a message"}
        className="mx-4 max-h-40 min-h-[22px] resize-none bg-transparent py-1.5 text-[length:var(--t3-font-size-prompt)] leading-relaxed text-t3-fg outline-none select-text placeholder:text-t3-muted"
      />

      {refusal !== null && (
        <div className="mx-4 mt-1 mb-1 rounded-lg border border-[color-mix(in_srgb,var(--t3-border)_100%,transparent)] bg-[var(--t3-code-background)] p-2">
          <p className="text-[11px] leading-relaxed text-t3-muted">T3 Code did not take this from the overlay.</p>
          <p className="mt-0.5 text-[12px] leading-relaxed whitespace-pre-wrap text-t3-fg">{refusal.error}</p>
          {refusal.grant && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-t3-muted">
              Grant remote control from the tray to allow this from the overlay.
            </p>
          )}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onOpenInT3?.()}
            className="mt-1.5 flex items-center gap-1 rounded-md text-[11px] font-medium text-t3-muted transition-colors hover:text-t3-fg"
          >
            <ExternalLink size={11} />
            Open in T3
          </button>
        </div>
      )}

      {error !== null && (
        <div className="flex items-start gap-1.5 px-4 pt-1 pb-1 text-[11px] text-[var(--t3-error-foreground)]">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
        </div>
      )}

      <div className="flex h-9 items-center gap-1 px-4 pb-1">
        {attachable && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                draft.addFiles(files);
              }}
            />
            <button
              type="button"
              title="Attach files"
              aria-label="Attach files"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => picker.current?.click()}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg"
            >
              <Paperclip size={15} />
            </button>
          </>
        )}
        {props.modelSelection !== null && (
          <ModelPicker
            catalog={catalog}
            current={props.modelSelection}
            open={modelPickerOpen}
            onOpenChange={setModelPickerOpen}
            onPick={props.onPickModel}
          />
        )}
        {props.modelTraits && props.modelSelection !== null && (
          <TraitsPicker
            threadKey={props.threadKey}
            model={named?.model ?? null}
            current={props.modelSelection}
            onPick={props.onPickModelOptions}
          />
        )}
        {planAllowed && (
          <button
            type="button"
            title={planOn ? "Plan mode: on" : "Plan mode: off"}
            aria-label={planOn ? "Turn plan mode off" : "Turn plan mode on"}
            aria-pressed={planOn}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void togglePlan()}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] transition-colors ${
              planOn ? "bg-t3-accent text-t3-fg" : "text-t3-muted hover:bg-t3-accent hover:text-t3-fg"
            }`}
          >
            <ListChecks size={12} className="shrink-0" />
            <span className="shrink-0">Plan</span>
          </button>
        )}
        {voice.phase === "recording" ? (
          <div
            role="status"
            aria-label="Recording"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--t3-error-foreground)_18%,transparent)] ps-2 pe-1"
          >
            <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--t3-error-foreground)]" />
            <span className="shrink-0 text-[11px] text-t3-fg tabular-nums">{clock(voice.seconds)}</span>
            <button
              type="button"
              title="Finish voice input"
              aria-label="Finish voice input"
              onMouseDown={(event) => event.preventDefault()}
              onClick={voice.toggle}
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--t3-error-foreground)_85%,transparent)] text-white transition-colors hover:bg-[var(--t3-error-foreground)]"
            >
              <Square size={9} fill="currentColor" />
            </button>
          </div>
        ) : voice.phase === "preparing" || voice.phase === "transcribing" ? (
          <div role="status" className="flex h-8 shrink-0 items-center gap-1.5 px-1 text-[11px] text-t3-muted">
            <LoaderCircle size={12} className="shrink-0 animate-spin" />
            <span className="shrink-0">{voice.phase === "preparing" ? "Starting…" : "Transcribing…"}</span>
          </div>
        ) : (
          props.voiceTranscription && (
            <button
              type="button"
              title="Start voice input"
              aria-label="Start voice input"
              onMouseDown={(event) => event.preventDefault()}
              onClick={voice.toggle}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg"
            >
              <Mic size={15} />
            </button>
          )
        )}
        {props.running !== null && (
          <button
            type="button"
            title="Stop"
            aria-label="Stop"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              void window.overlay.panel({ type: "stop" });
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
          title={
            uploading
              ? "Waiting for the upload"
              : props.editingQueued
                ? "Update queued message"
                : props.running === null
                  ? "Send"
                  : "Queue message"
          }
          aria-label={props.editingQueued ? "Update queued message" : props.running === null ? "Send" : "Queue message"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void submit()}
          disabled={sending || uploading || (text.trim() === "" && attachments.length === 0)}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--t3-primary)] text-white shadow-[inset_0_1px_#ffffff29,0_1px_2px_0_color-mix(in_oklab,var(--t3-primary)_24%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--t3-primary)_90%,#000)] disabled:pointer-events-none disabled:bg-[color-mix(in_srgb,var(--t3-foreground)_12%,transparent)] disabled:text-t3-muted disabled:shadow-none"
        >
          <ArrowUp size={15} />
        </button>
      </div>
    </div>
  );
}

/** "0:07", as T3's recording pill counts (apps/web/src/components/chat/ComposerSpeechButton.tsx, formatElapsed). */
function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
