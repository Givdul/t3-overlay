import { ArrowUp, Eraser, File as FileIcon, Folder, Paperclip, PenLine, Slash, X } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode, type RefObject } from "react";
import { ATTACHMENT_LIMITS, isImageAttachment, type ComposeAttachment, type ComposeCommand, type ComposeFile, type FileScope } from "../../../shared/compose";
import type { PanelRun } from "../../../shared/panel";

// The panel's composer: Enter sends, Shift+Enter is a newline, Stop while a turn runs. Enter queues behind
// the active run instead of starting one; T3 draws the queued message in the timeline until it starts.
// `@` searches the checkout for files and `/` lists the provider's commands, as in T3's composer, and
// files can be pasted, dropped or picked. The new-thread composer adds its pickers through the slots.

export interface ComposerHandle {
  focus(): void;
}

export interface ComposerMessage {
  text: string;
  attachments: ComposeAttachment[];
  /** `/clear`: the turn starts without the thread's earlier context. */
  freshContext: boolean;
}

interface ComposerProps {
  side: "left" | "right";
  running: PanelRun | null;
  /** The card's first row: the thread's project, machine and status, or the new thread's machine and project. */
  header: ReactNode;
  /** Drawn inside the card when the title-in-composer setting is on. */
  title: string | null;
  folded: boolean;
  placeholder: string;
  /** Chips between the attach button and Send, such as the new thread's model and mode. */
  toolbar?: ReactNode;
  /** A row under the buttons, such as the new thread's branch toolbar. */
  footer?: ReactNode;
  /** Where `@` searches, or null when there is nowhere to search yet. */
  files: FileScope | null;
  /** The provider's commands and skills for the `/` menu. */
  commands: ComposeCommand[];
  /** Whether T3's own `/clear` applies: only to an existing thread. */
  allowClear: boolean;
  /** False while the message cannot go yet, such as before the new thread has a model. */
  ready: boolean;
  onSubmit(message: ComposerMessage): Promise<{ ok: true } | { ok: false; error: string }>;
  onTextChange(text: string): void;
  onFocusChange(focused: boolean): void;
  onBusyChange(busy: boolean): void;
  onUnfold(): void;
  onSent(): void;
  handle: RefObject<ComposerHandle | null>;
}

interface Attached extends ComposeAttachment {
  key: string;
  /** An object URL for an image's thumbnail, revoked when it leaves the card. */
  preview: string | null;
}

/** An open `@` or `/` menu: what was typed after the trigger, and where the trigger sits in the text. */
interface Trigger {
  kind: "file" | "command";
  query: string;
  start: number;
}

type MenuItem =
  | { kind: "file"; key: string; file: ComposeFile }
  | { kind: "command"; key: string; command: ComposeCommand }
  | { kind: "clear"; key: string };

/** T3's `@` debounce (apps/web state/queries.ts). */
const FILE_SEARCH_DELAY_MS = 120;

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attached[]>([]);
  const [freshContext, setFreshContext] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [files, setFiles] = useState<ComposeFile[]>([]);
  const [highlight, setHighlight] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
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

  // The `@` menu asks T3 once typing pauses; a later answer replaces an earlier one only if it is still current.
  const fileQuery = trigger?.kind === "file" ? trigger.query : null;
  const fileScope = props.files;

  useEffect(() => {
    if (fileQuery === null || fileScope === null) {
      setFiles([]);

      return;
    }

    let current = true;
    const timer = setTimeout(() => {
      window.overlay.composeFiles(fileScope, fileQuery).then(
        (found) => current && setFiles(found),
        () => current && setFiles([]),
      );
    }, FILE_SEARCH_DELAY_MS);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [fileQuery, fileScope]);

  // Previews are object URLs; the card revokes them when it unmounts.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => attachmentsRef.current.forEach((attachment) => attachment.preview && URL.revokeObjectURL(attachment.preview)), []);

  const menu: MenuItem[] =
    trigger === null
      ? []
      : trigger.kind === "file"
        ? files.map((file) => ({ kind: "file", key: `file:${file.path}`, file }))
        : [
            ...(props.allowClear && "clear".startsWith(trigger.query.toLowerCase()) ? [{ kind: "clear" as const, key: "clear" }] : []),
            ...props.commands
              .filter((command) => command.name.toLowerCase().includes(trigger.query.toLowerCase()))
              // Names that start with the query come first, as a typed prefix is the usual intent.
              .toSorted(
                (left, right) =>
                  Number(!left.name.toLowerCase().startsWith(trigger.query.toLowerCase())) -
                  Number(!right.name.toLowerCase().startsWith(trigger.query.toLowerCase())),
              )
              .slice(0, 50)
              .map((command) => ({ kind: "command" as const, key: `command:${command.insert}`, command })),
          ];

  /** Reads the trigger at the caret: `/` only at the very start of the message, `@` after a space or at the start. */
  function readTrigger(value: string, caret: number) {
    const before = value.slice(0, caret);
    const slash = /^\/(\S*)$/.exec(before);
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
    const next: Trigger | null = slash
      ? { kind: "command", query: slash[1] ?? "", start: 0 }
      : at
        ? { kind: "file", query: at[1] ?? "", start: before.length - (at[1] ?? "").length - 1 }
        : null;

    setTrigger((current) => (current?.kind === next?.kind && current?.query === next?.query && current?.start === next?.start ? current : next));
    setHighlight(0);
  }

  /** Replaces the trigger and what was typed after it with `insert`, and puts the caret after it. */
  function replaceTrigger(active: Trigger, insert: string) {
    const caret = textarea.current?.selectionStart ?? textRef.current.length;
    const next = textRef.current.slice(0, active.start) + insert + textRef.current.slice(caret);
    const at = active.start + insert.length;

    setDraftText(next);
    setTrigger(null);
    requestAnimationFrame(() => textarea.current?.setSelectionRange(at, at));
  }

  function pick(item: MenuItem) {
    if (trigger === null) return;

    switch (item.kind) {
      case "file":
        replaceTrigger(trigger, `${fileLink(item.file.path)} `);
        break;
      case "command":
        replaceTrigger(trigger, item.command.insert);
        break;
      case "clear":
        replaceTrigger(trigger, "");
        setFreshContext(true);
        break;
    }
  }

  async function addFiles(list: FileList | File[]) {
    const next: Attached[] = [];

    for (const file of Array.from(list)) {
      const image = isImageAttachment(file.type);
      const limit = image ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;

      if (file.size === 0 || file.size > limit) {
        setError(`${file.name} is ${file.size === 0 ? "empty" : `over T3's ${limit / 1024 / 1024} MB limit`}`);
        continue;
      }

      next.push({
        key: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        preview: image ? URL.createObjectURL(file) : null,
      });
    }

    setAttachments((current) => [...current, ...next].slice(0, ATTACHMENT_LIMITS.perMessage));
  }

  function removeAttachment(key: string) {
    setAttachments((current) =>
      current.filter((attachment) => {
        if (attachment.key !== key) return true;
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);

        return false;
      }),
    );
  }

  async function submit() {
    const value = textRef.current.trim();

    if (sending || !props.ready) return;

    // T3's own `/clear`, typed out as the whole message, marks the next message instead of sending.
    if (props.allowClear && value === "/clear") {
      setDraftText("");
      setFreshContext(true);

      return;
    }

    if (value === "" && attachments.length === 0) return;

    setSending(true);
    setError(null);

    // T3 clears the box as it dispatches; a failure puts the draft back.
    const snapshot = textRef.current;
    const sent = attachments;
    setDraftText("");
    setAttachments([]);

    let reply;

    try {
      reply = await props.onSubmit({
        text: value,
        attachments: sent.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes })),
        freshContext,
      });
    } catch (sendError) {
      reply = { ok: false as const, error: sendError instanceof Error ? sendError.message : String(sendError) };
    }

    setSending(false);

    if (!reply.ok) {
      setError(reply.error);
      setDraftText(snapshot);
      setAttachments(sent);

      return;
    }

    sent.forEach((attachment) => attachment.preview && URL.revokeObjectURL(attachment.preview));
    setFreshContext(false);
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

  const canSend = props.ready && !sending && (text.trim() !== "" || attachments.length > 0);

  return (
    <div
      className="-mt-4 flex shrink-0 flex-col rounded-2xl border border-[var(--t3-border)] bg-[color-mix(in_srgb,var(--t3-popover)_92%,transparent)] backdrop-blur-sm"
      onFocus={() => props.onFocusChange(true)}
      onBlur={(event) => {
        const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;

        if (!event.currentTarget.contains(next)) props.onFocusChange(false);
      }}
      onDragOver={(event: DragEvent) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event: DragEvent) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        void addFiles(event.dataTransfer.files);
      }}
    >
      {props.title !== null && <p className="truncate px-[14px] pt-2 pb-0.5 text-[12px] font-semibold text-t3-fg">{props.title}</p>}
      <div className="flex min-w-0 items-center justify-between gap-2 px-4 pt-2 pb-1 text-[11px] text-t3-muted">{props.header}</div>

      {(attachments.length > 0 || freshContext) && (
        <div className="mx-4 mt-1 flex flex-wrap gap-1.5">
          {freshContext && (
            <Chip icon={<Eraser size={12} />} label="Fresh context" title="The next message starts without this thread's earlier context" onRemove={() => setFreshContext(false)} />
          )}
          {attachments.map((attachment) => (
            <Chip
              key={attachment.key}
              icon={
                attachment.preview === null ? (
                  <FileIcon size={12} />
                ) : (
                  <img src={attachment.preview} alt="" className="size-5 rounded object-cover" />
                )
              }
              label={attachment.name}
              title={attachment.name}
              onRemove={() => removeAttachment(attachment.key)}
            />
          ))}
        </div>
      )}

      <div className="relative flex flex-col">
        {trigger !== null && menu.length > 0 && (
          <div className="absolute right-3 bottom-full left-3 z-30 mb-1 flex max-h-56 flex-col overflow-y-auto rounded-xl border border-t3-border bg-t3-popover p-1 shadow-xl shadow-black/40">
            {menu.map((item, index) => (
              <button
                key={item.key}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pick(item)}
                className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] text-t3-fg ${index === highlight ? "bg-t3-accent" : ""}`}
              >
                <MenuRow item={item} />
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={textarea}
          rows={1}
          value={text}
          onChange={(event) => {
            setDraftText(event.target.value);
            readTrigger(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) => readTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
          onPaste={(event: ClipboardEvent) => {
            if (event.clipboardData.files.length === 0) return;
            event.preventDefault();
            void addFiles(event.clipboardData.files);
          }}
          onKeyDown={(event) => {
            // An IME's Enter confirms the candidate, not the message.
            if (event.nativeEvent.isComposing) return;

            if (trigger !== null && menu.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((current) => (current + (event.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length);

                return;
              }

              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const item = menu[highlight] ?? menu[0];

                if (item !== undefined) pick(item);

                return;
              }

              if (event.key === "Escape") {
                // Closes the menu, not the panel.
                event.stopPropagation();
                setTrigger(null);

                return;
              }
            }

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={props.placeholder}
          className="mx-4 max-h-40 min-h-[22px] resize-none bg-transparent py-1.5 text-[length:var(--t3-font-size-prompt)] leading-relaxed text-t3-fg outline-none select-text placeholder:text-t3-muted"
        />
      </div>

      {error !== null && (
        <div className="flex items-start gap-1.5 px-4 pt-1 pb-1 text-[11px] text-[var(--t3-error-foreground)]">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
        </div>
      )}

      <div className="flex h-9 min-w-0 items-center gap-1 px-3 pb-1">
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files !== null) void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          title="Attach files"
          aria-label="Attach files"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => filePicker.current?.click()}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg"
        >
          <Paperclip size={14} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5">{props.toolbar}</div>
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
        <button
          type="button"
          title={props.running === null ? "Send" : "Queue message"}
          aria-label={props.running === null ? "Send" : "Queue message"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void submit()}
          disabled={!canSend}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--t3-primary)] text-white shadow-[inset_0_1px_#ffffff29,0_1px_2px_0_color-mix(in_oklab,var(--t3-primary)_24%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--t3-primary)_90%,#000)] disabled:pointer-events-none disabled:bg-[color-mix(in_srgb,var(--t3-foreground)_12%,transparent)] disabled:text-t3-muted disabled:shadow-none"
        >
          <ArrowUp size={15} />
        </button>
      </div>

      {props.footer !== undefined && <div className="flex min-w-0 items-center gap-0.5 border-t border-[var(--t3-border)] px-3 py-1">{props.footer}</div>}
    </div>
  );
}

function MenuRow({ item }: { item: MenuItem }) {
  switch (item.kind) {
    case "file": {
      const slash = item.file.path.lastIndexOf("/");

      return (
        <>
          {item.file.kind === "directory" ? <Folder size={12} className="shrink-0 text-t3-muted" /> : <FileIcon size={12} className="shrink-0 text-t3-muted" />}
          <span className="shrink-0 truncate">{item.file.path.slice(slash + 1)}</span>
          <span className="min-w-0 truncate text-[11px] text-t3-muted">{slash > 0 ? item.file.path.slice(0, slash) : ""}</span>
        </>
      );
    }

    case "command":
      return (
        <>
          <Slash size={12} className="shrink-0 text-t3-muted" />
          <span className="shrink-0">{item.command.name}</span>
          <span className="min-w-0 truncate text-[11px] text-t3-muted">{item.command.description}</span>
        </>
      );
    case "clear":
      return (
        <>
          <Eraser size={12} className="shrink-0 text-t3-muted" />
          <span className="shrink-0">clear</span>
          <span className="min-w-0 truncate text-[11px] text-t3-muted">Start the next message without this thread's context</span>
        </>
      );
  }
}

function Chip({ icon, label, title, onRemove }: { icon: ReactNode; label: string; title: string; onRemove(): void }) {
  return (
    <span
      title={title}
      className="flex h-7 max-w-[12rem] min-w-0 items-center gap-1.5 rounded-lg border border-[var(--t3-border)] bg-[var(--t3-code-background)] pr-1 pl-1.5 text-[11px] text-t3-fg"
    >
      <span className="flex shrink-0 items-center text-t3-muted">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="flex size-4 shrink-0 items-center justify-center rounded text-t3-muted hover:text-t3-fg"
      >
        <X size={11} />
      </button>
    </span>
  );
}

/** A picked file as T3's composer writes it into the message (packages/shared composerTrigger.ts, serializeComposerFileLink). */
function fileLink(path: string): string {
  const name = (path.slice(path.lastIndexOf("/") + 1) || path).replace(/[\\[\]]/g, (character) => `\\${character}`);
  const target = encodeURI(path).replace(/[()#?\\]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

  return `[${name}](${target})`;
}
