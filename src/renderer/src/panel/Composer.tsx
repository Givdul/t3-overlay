import { ArrowUp, Check, LoaderCircle, Mic, PenLine, SlidersHorizontal, X } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  PanelCommand,
  PanelConfig,
  PanelModelSelection,
  PanelRun,
  PanelUpload,
  PanelView,
} from "../../../shared/panel";
import {
  ComposerMenu,
  detectTrigger,
  directoryOf,
  extendRangeForTrailingSpace,
  replaceTextRange,
  serializeFileLink,
  type MenuRow,
} from "./ComposerMenu";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker, permissionIcon } from "./PermissionPicker";
import { startPcmRecording, type PcmRecording } from "./dictation";
import {
  catalogFor,
  filterSlashItems,
  modelSuffix,
  providerFor,
  runtimeModeInfo,
  runtimeModeLabel,
  runtimeModes,
  slashItems,
} from "./config";

// The composer card: textarea, pasted images, T3's two chips, the microphone and send/stop. Enter sends;
// while a turn runs Enter queues. `/` and `@` open the same menu; dictation streams into the textarea.

export interface ComposerPicks {
  model: PanelModelSelection | null;
  runtimeMode: string | null;
}

export interface ComposerHandle {
  focus(): void;
}

type Menu = "none" | "slash" | "paths" | "model" | "permission";

type DictationPhase = "idle" | "starting" | "recording" | "finishing";

interface Dictation {
  phase: DictationPhase;
  error: string | null;
  committed: string;
  tentative: string;
  /** Remounts the pill's timer for each recording. */
  startedAt: number;
}

const IDLE_DICTATION: Dictation = { phase: "idle", error: null, committed: "", tentative: "", startedAt: 0 };

interface ImageDraft {
  upload: PanelUpload;
  url: string;
}

/** T3's composer limits (apps/web/src/lib/imageCompression.ts and the attachment contract). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;

interface ComposerProps {
  draft: boolean;
  side: "left" | "right";
  view: PanelView | null;
  config: PanelConfig | null;
  /** The draft's chosen project; unused for a thread. */
  projectId: string | null;
  /** The thread's checkout, or the draft project's root. */
  cwd: string | null;
  running: PanelRun | null;
  contextLabel: string;
  statusLabel: string;
  /** Drawn inside the card when the title-in-composer setting is on. */
  title: string | null;
  folded: boolean;
  picks: ComposerPicks;
  onPicks: (picks: ComposerPicks) => void;
  onTextChange: (text: string) => void;
  onFocusChange: (focused: boolean) => void;
  onMenuChange: (open: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onUnfold: () => void;
  onSent: () => void;
  handle: RefObject<ComposerHandle | null>;
}

export function Composer(props: ComposerProps) {
  const { draft, config, cwd, picks, view, running, folded } = props;
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [images, setImages] = useState<ImageDraft[]>([]);
  const [menu, setMenu] = useState<Menu>("none");
  const [activeIndex, setActiveIndex] = useState(0);
  const [paths, setPaths] = useState<{ rows: MenuRow[]; truncated: boolean }>({ rows: [], truncated: false });
  const [pathsLoading, setPathsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [freshContext, setFreshContext] = useState(false);
  const [dictation, setDictation] = useState<Dictation>(IDLE_DICTATION);
  const root = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const wantFocus = useRef(false);
  const dictationGeneration = useRef(0);
  const textRef = useRef("");
  const imagesRef = useRef<ImageDraft[]>([]);
  const recording = useRef<PcmRecording | null>(null);
  const dictationCaret = useRef(0);
  const imageUrls = useRef<string[]>([]);
  textRef.current = text;
  imagesRef.current = images;

  const threadSelection = view?.thread.modelSelection ?? null;
  const model = picks.model ?? (draft ? (config?.defaultModel ?? null) : threadSelection);
  const provider = providerFor(config, model?.instanceId);
  const modes = runtimeModes(provider);
  const runtimeMode = picks.runtimeMode ?? (draft ? (config?.defaultRuntimeMode ?? "full-access") : (view?.thread.runtimeMode ?? "full-access"));
  const modelInfo = catalogFor(config, model?.instanceId, cwd)?.models.find((candidate) => candidate.slug === model?.model) ?? null;
  const modelSuffixLabel = modelSuffix(modelInfo, model);
  const modelChip = model === null ? "Model" : `${modelInfo?.name ?? model.model}${modelSuffixLabel === null ? "" : ` · ${modelSuffixLabel}`}`;
  const busy = dictation.phase !== "idle";
  const dictating = dictation.phase === "recording" || dictation.phase === "starting";
  const liveTranscript = `${dictation.committed}${dictation.tentative}`;
  const displayText = dictating || dictation.phase === "finishing" ? joinTranscript(text, liveTranscript) : text;

  /** The composer's text and Panel's copy change together; the fold keys off the latter. */
  const notify = useRef(props);
  notify.current = props;

  const setDraftText = (value: string, caret: number) => {
    setText(value);
    setCursor(caret);
    props.onTextChange(value);
  };

  // The fold and the focus hotkey live in Panel; the textarea keeps the actual caret.
  useImperativeHandle(props.handle, () => ({
    focus() {
      wantFocus.current = true;
      textarea.current?.focus();
      const end = textRef.current.length;
      textarea.current?.setSelectionRange(end, end);
      setCursor(end);
    },
  }));

  useEffect(() => {
    if (folded || !wantFocus.current) return;
    wantFocus.current = false;
    textarea.current?.focus();
  }, [folded]);

  // Auto-grow up to eight lines, then scroll.
  useEffect(() => {
    const element = textarea.current;

    if (element === null) return;
    element.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
    element.style.height = `${Math.min(element.scrollHeight, lineHeight * 8)}px`;
  }, [displayText]);

  useEffect(() => notify.current.onBusyChange(busy || dictation.error !== null), [busy, dictation.error]);
  useEffect(() => notify.current.onMenuChange(menu !== "none"), [menu]);

  // Voice events come from main: live text, then the final transcript on finish.
  useEffect(
    () =>
      window.overlay.onVoiceEvent((event) => {
        if (event.kind === "text") {
          setDictation((current) => (current.phase === "idle" ? current : { ...current, committed: event.committed, tentative: event.tentative }));

          return;
        }

        void stopRecording();
        setDictation({ ...IDLE_DICTATION, error: event.message });
      }),
    [],
  );

  // A dead socket or the panel closing must release the microphone.
  useEffect(
    () => () => {
      for (const url of imageUrls.current) URL.revokeObjectURL(url);
      imageUrls.current = [];
      void stopRecording();
    },
    [],
  );

  async function stopRecording() {
    const active = recording.current;

    recording.current = null;

    if (active !== null) await active.stop().catch(() => undefined);
  }

  async function startDictation() {
    if (busy) return;
    const generation = ++dictationGeneration.current;

    setError(null);
    setDictation({ ...IDLE_DICTATION, phase: "starting" });
    dictationCaret.current = textarea.current?.selectionStart ?? textRef.current.length;

    const started = await window.overlay.voiceStart();

    // Cancelled while the ticket was being made: the session is already gone.
    if (generation !== dictationGeneration.current) return;

    if (!started.ok) {
      setDictation({ ...IDLE_DICTATION, error: started.error });

      return;
    }

    try {
      recording.current = await startPcmRecording((pcm) => window.overlay.voiceAudio(pcm));
    } catch (captureError) {
      window.overlay.voiceCancel();
      setDictation({ ...IDLE_DICTATION, error: captureError instanceof Error ? captureError.message : "Could not start the microphone." });

      return;
    }

    setDictation({ ...IDLE_DICTATION, phase: "recording", startedAt: Date.now() });
  }

  async function finishDictation(thenSend: boolean) {
    if (dictation.phase !== "recording" && dictation.phase !== "starting") return;
    const generation = dictationGeneration.current;

    setDictation((current) => ({ ...current, phase: "finishing" }));

    const reply = await window.overlay.voiceFinish();

    await stopRecording();

    if (generation !== dictationGeneration.current) return;

    if (!reply.ok) {
      setDictation({ ...IDLE_DICTATION, error: reply.error });

      return;
    }

    const inserted = insertTranscript(textRef.current, dictationCaret.current, reply.text);

    setDictation(IDLE_DICTATION);
    setDraftText(inserted.text, inserted.cursor);

    if (thenSend) await submit(inserted.text);
  }

  async function cancelDictation() {
    if (dictation.phase === "idle") return;
    dictationGeneration.current += 1;
    window.overlay.voiceCancel();
    await stopRecording();
    setDictation(IDLE_DICTATION);
  }

  // Escape closes the open menu first, then cancels a recording; only then does it close the panel.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;

      if (menu !== "none") {
        event.preventDefault();
        event.stopPropagation();
        setMenu("none");

        return;
      }

      if (dictation.phase !== "idle") {
        event.preventDefault();
        event.stopPropagation();
        void cancelDictation();
      }
    };

    window.addEventListener("keydown", onKey, true);

    return () => window.removeEventListener("keydown", onKey, true);
  });

  // T3's dictation shortcut (packages/shared/src/keybindings.ts, mod+shift+d).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "d") return;

      if (!document.hasFocus()) return;

      event.preventDefault();

      if (dictation.phase === "idle") void startDictation();
      else if (dictation.phase === "recording") void finishDictation(false);
      else if (dictation.phase === "starting") void cancelDictation();
    };

    window.addEventListener("keydown", onKey, true);

    return () => window.removeEventListener("keydown", onKey, true);
  });

  // `@` search: debounced, with the stale reply guard on the query that is actually current.
  const trigger = menu === "slash" || menu === "paths" ? detectTrigger(text, cursor) : null;
  const triggerKey = trigger === null ? "" : `${trigger.kind}:${trigger.query}:${trigger.rangeStart}:${trigger.rangeEnd}`;
  const triggerQuery = trigger?.query ?? "";

  useEffect(() => {
    if (menu !== "paths" || cwd === null) {
      setPaths({ rows: [], truncated: false });
      setPathsLoading(false);

      return;
    }

    let cancelled = false;
    // One search at a time: an answer for an older query is dropped by the effect's cleanup.
    setPathsLoading(true);

    const timer = setTimeout(() => {
      void window.overlay
        .panel({ type: "searchPaths", cwd, query: triggerQuery })
        .then((reply) => {
          if (cancelled) return;
          setPathsLoading(false);
          setPaths(
            reply.ok && "entries" in reply
              ? {
                  rows: reply.entries.map((entry) => ({
                    id: entry.path,
                    label: basename(entry.path),
                    description: directoryOf(entry.path),
                    kind: entry.kind,
                  })),
                  truncated: reply.truncated,
                }
              : { rows: [], truncated: false },
          );
          setActiveIndex(0);
        });
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [menu, triggerKey, triggerQuery, cwd]);

  // A click anywhere outside the card closes a menu, as T3's palettes do.
  useEffect(() => {
    if (menu === "none") return;

    const onPointerDown = (event: PointerEvent) => {
      if (root.current?.contains(event.target instanceof Node ? event.target : null)) return;
      setMenu("none");
    };

    document.addEventListener("pointerdown", onPointerDown, true);

    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menu]);

  // Reset the highlight whenever the list's contents change underneath it.
  const slashRows =
    trigger?.kind === "slash"
      ? filterSlashItems(slashItems(config, model?.instanceId, cwd), trigger.query)
          // A draft has no provider session to clear.
          .filter((item) => !draft || item.kind !== "clear")
          .map(toMenuRow)
      : [];

  const rows = menu === "paths" ? paths.rows : menu === "slash" ? slashRows : [];
  const active = rows.length === 0 ? 0 : Math.min(activeIndex, rows.length - 1);

  useEffect(() => setActiveIndex(0), [triggerKey, menu]);

  async function submit(explicit?: string) {
    const value = (explicit ?? textRef.current).trim();

    if (!draft) {
      if (/^\/clear\s*$/i.test(value)) {
        setDraftText("", 0);
        setFreshContext(true);
        textarea.current?.focus();

        return;
      }

      if (/^\/model\s*$/i.test(value)) {
        setDraftText("", 0);
        setMenu("model");

        return;
      }
    }

    if (value === "" && imagesRef.current.length === 0) return;
    await send(value, imagesRef.current);
  }

  async function send(value: string, attachments: ImageDraft[]) {
    if (sending) return;
    setSending(true);
    setError(null);
    setMenu("none");

    const snapshot = { text: textRef.current, images: attachments, cursor };
    const fresh = freshContext;
    const uploads = attachments.map((image) => image.upload);

    // T3 clears the box as it dispatches; a failure puts the draft back.
    setDraftText("", 0);
    setImages([]);

    let reply;

    try {
      if (draft) {
        reply = await window.overlay.panel({ type: "start", projectId: props.projectId ?? "", text: value, model, runtimeMode });
      } else {
        const action: Extract<PanelCommand, { type: "send" }> = {
          type: "send",
          text: value,
          images: uploads,
          queue: running !== null,
          model,
          runtimeMode,
        };

        if (fresh) action.freshContext = true;
        reply = await window.overlay.panel(action);
      }
    } catch (sendError) {
      reply = { ok: false as const, error: sendError instanceof Error ? sendError.message : String(sendError) };
    }

    setSending(false);

    if (!reply.ok) {
      setError(reply.error);
      setDraftText(snapshot.text, snapshot.cursor);
      setImages(snapshot.images);

      return;
    }

    for (const image of snapshot.images) {
      URL.revokeObjectURL(image.url);
      imageUrls.current = imageUrls.current.filter((url) => url !== image.url);
    }

    if (fresh) setFreshContext(false);
    props.onSent();
    textarea.current?.focus();
  }

  async function addImages(files: File[]) {
    const existing = imagesRef.current.reduce((sum, image) => sum + image.upload.sizeBytes, 0);
    const accepted: ImageDraft[] = [];
    let total = existing;

    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) {
        setError("Images are limited to 10 MB each and 80 MB in total.");

        return;
      }

      total += file.size;

      if (total > MAX_TOTAL_IMAGE_BYTES) {
        setError("Images are limited to 10 MB each and 80 MB in total.");

        return;
      }
    }

    try {
      for (const file of files) {
        const dataUrl = await readDataUrl(file);
        const url = URL.createObjectURL(file);

        imageUrls.current.push(url);
        accepted.push({
          upload: {
            type: "image",
            name: file.name === "" ? "screenshot.png" : file.name,
            mimeType: file.type.toLowerCase(),
            sizeBytes: file.size,
            dataUrl,
          },
          url,
        });
      }
    } catch {
      setError("Could not read that image.");

      return;
    }

    setImages([...imagesRef.current, ...accepted]);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));

    if (files.length === 0) return;
    event.preventDefault();

    if (draft) {
      setError("Images work once the thread starts.");

      return;
    }

    void addImages(files);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;

    if (menu === "slash" || menu === "paths") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();

        if (rows.length > 0) setActiveIndex((index) => (event.key === "ArrowDown" ? (index + 1) % rows.length : (index + rows.length - 1) % rows.length));

        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        const row = rows[active];

        if (row !== undefined) {
          event.preventDefault();
          pick(row);
        }

        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (dictation.phase === "recording") {
        void finishDictation(true);

        return;
      }

      if (dictation.phase === "idle") void submit();
    }
  }

  function pick(row: MenuRow) {
    // The trigger can have moved while the menu was open; recompute it against the caret.
    const current = detectTrigger(textRef.current, textarea.current?.selectionStart ?? cursor);

    if (current === null) {
      setMenu("none");

      return;
    }

    if (row.kind === "model") {
      const applied = replaceTextRange(textRef.current, current.rangeStart, current.rangeEnd, "");

      setDraftText(applied.text, applied.cursor);
      setMenu("model");
      textarea.current?.focus();

      return;
    }

    if (row.kind === "clear") {
      const applied = replaceTextRange(textRef.current, current.rangeStart, current.rangeEnd, "");

      setDraftText(applied.text, applied.cursor);
      setFreshContext(true);
      setMenu("none");
      textarea.current?.focus();

      return;
    }

    const replacement = row.kind === "file" || row.kind === "directory" ? `${serializeFileLink(row.id)} ` : `${row.label} `;

    const rangeEnd = extendRangeForTrailingSpace(textRef.current, current.rangeEnd, replacement);
    const applied = replaceTextRange(textRef.current, current.rangeStart, rangeEnd, replacement);

    setDraftText(applied.text, applied.cursor);
    setMenu("none");
    textarea.current?.focus();
    textarea.current?.setSelectionRange(applied.cursor, applied.cursor);
  }

  const toggleMenu = (next: Menu) => {
    setError(null);
    setMenu((current) => (current === next ? "none" : next));
  };

  const preventFocusLoss = (event: { preventDefault(): void }) => event.preventDefault();

  if (folded) {
    return (
      <button
        type="button"
        title="Write"
        onClick={props.onUnfold}
        className={`mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--t3-message-action)] text-[var(--t3-message-action-foreground)] shadow-[inset_0_1px_#ffffff29,0_1px_2px_0_color-mix(in_oklab,var(--t3-message-action)_24%,transparent)] transition-colors hover:bg-[var(--t3-message-action-hover)] ${
          props.side === "left" ? "self-start" : "self-end"
        }`}
      >
        <PenLine size={14} />
      </button>
    );
  }

  return (
    <div
      ref={root}
      className="-mt-4 flex shrink-0 flex-col rounded-2xl border glass-card"
      style={{ borderColor: "color-mix(in srgb, var(--t3-contrast-foreground) 8%, transparent)" }}
      onFocus={() => props.onFocusChange(true)}
      onBlur={(event) => {
        const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;

        if (!event.currentTarget.contains(next)) props.onFocusChange(false);
      }}
    >
      {props.title !== null && <p className="truncate px-[14px] pt-2 pb-0.5 text-[12px] font-semibold text-t3-fg">{props.title}</p>}
      <div className="px-4 pt-3.5 pb-2">
        <div className="flex items-center justify-between gap-2 text-[11px] text-t3-muted">
          <span className="min-w-0 truncate">{props.contextLabel}</span>
          <span className="shrink-0">{props.statusLabel}</span>
        </div>
      </div>

      {menu === "slash" && (
        <ComposerMenu
          trigger="slash"
          rows={rows}
          activeIndex={active}
          loading={false}
          truncated={false}
          emptyText="No matching command."
          onHover={setActiveIndex}
          onPick={pick}
        />
      )}
      {menu === "paths" && (
        <ComposerMenu
          trigger="path"
          rows={rows}
          activeIndex={active}
          loading={pathsLoading}
          truncated={paths.truncated}
          emptyText="No matching files or folders."
          onHover={setActiveIndex}
          onPick={pick}
        />
      )}
      {menu === "model" && (
        <ModelPicker
          config={config}
          cwd={cwd}
          value={model}
          onChange={(selection) => {
            props.onPicks({ ...picks, model: selection });
            setMenu("none");
            textarea.current?.focus();
          }}
        />
      )}
      {menu === "permission" && (
        <PermissionPicker
          value={runtimeMode}
          modes={modes}
          onChange={(mode) => {
            props.onPicks({ ...picks, runtimeMode: mode });
            setMenu("none");
            textarea.current?.focus();
          }}
        />
      )}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {images.map((image, index) => (
            <span key={`${image.url}:${index}`} className="relative">
              <img
                src={image.url}
                alt={image.upload.name}
                className="size-11 rounded-md border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] object-cover"
              />
              <button
                type="button"
                aria-label="Remove image"
                onMouseDown={preventFocusLoss}
                onClick={() => {
                  URL.revokeObjectURL(image.url);
                  imageUrls.current = imageUrls.current.filter((url) => url !== image.url);
                  setImages(imagesRef.current.filter((candidate) => candidate !== image));
                }}
                className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-[var(--t3-popover)] text-t3-fg shadow"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={textarea}
        rows={1}
        value={displayText}
        readOnly={busy}
        placeholder={busy ? "" : "Ask anything. @ files, $ skills, / commands"}
        onChange={(event) => {
          const value = event.target.value;
          const caret = event.target.selectionStart ?? value.length;
          const next = detectTrigger(value, caret);

          setDraftText(value, caret);
          setMenu((current) =>
            next === null ? (current === "slash" || current === "paths" ? "none" : current) : next.kind === "slash" ? "slash" : "paths",
          );
        }}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="mx-4 max-h-40 min-h-[22px] resize-none bg-transparent py-1.5 text-[length:var(--t3-font-size-prompt)] leading-relaxed text-t3-fg outline-none placeholder:text-t3-muted"
      />

      {freshContext && (
        <p className="px-4 pt-1 text-[11px] text-t3-muted">
          Fresh session on the next message
          <button type="button" className="ml-1.5 underline underline-offset-2 hover:text-t3-fg" onClick={() => setFreshContext(false)}>
            Undo
          </button>
        </p>
      )}

      {error !== null && (
        <div className="flex items-start gap-1.5 px-4 pt-1 text-[11px] text-[var(--t3-error-foreground)]">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)} className="shrink-0 text-t3-muted hover:text-t3-fg">
            <X size={11} />
          </button>
        </div>
      )}

      {dictation.error !== null && (
        <div className="flex items-start gap-1.5 px-4 pt-1 text-[11px] text-[var(--t3-error-foreground)]">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{dictation.error}</span>
          <button
            type="button"
            aria-label="Dismiss voice input error"
            onClick={() => setDictation((current) => ({ ...current, error: null }))}
            className="shrink-0 text-t3-muted hover:text-t3-fg"
          >
            <X size={11} />
          </button>
        </div>
      )}

      <div className="px-4 pb-2">
        <div className="flex h-8 items-center gap-1">
        <Chip label={modelChip} icon={<SlidersHorizontal size={12} />} open={menu === "model"} onMouseDown={preventFocusLoss} onClick={() => toggleMenu("model")} title="Model" />
        <Chip
          label={runtimeModeLabel(runtimeMode)}
          icon={permissionIcon(runtimeMode)}
          open={menu === "permission"}
          onMouseDown={preventFocusLoss}
          onClick={() => toggleMenu("permission")}
          title={`Permissions: ${runtimeModeLabel(runtimeMode)}. ${runtimeModeInfo(runtimeMode).description}`}
        />
        {!busy && <div className="min-w-0 flex-1" />}
        {busy ? (
          <DictationPill
            phase={dictation.phase}
            startedAt={dictation.startedAt}
            onCancel={() => void cancelDictation()}
            onFinish={() => void finishDictation(false)}
          />
        ) : (
          <button
            type="button"
            title="Start voice input (⌘⇧D)"
            aria-label="Start voice input"
            onMouseDown={preventFocusLoss}
            onClick={() => void startDictation()}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-t3-muted hover:bg-t3-accent hover:text-t3-fg"
          >
            <Mic size={14} />
          </button>
        )}
        {running !== null && (
          <button
            type="button"
            title="Stop"
            aria-label="Stop"
            onMouseDown={preventFocusLoss}
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
        {(!busy || dictation.phase === "recording") && (
          <button
            type="button"
            title={dictation.phase === "recording" ? "Send the transcript" : running === null ? "Send" : "Queue message"}
            aria-label={dictation.phase === "recording" ? "Send the transcript" : running === null ? "Send" : "Queue message"}
            onMouseDown={preventFocusLoss}
            onClick={() => {
              if (dictation.phase === "recording") void finishDictation(true);
              else void submit();
            }}
            disabled={sending || (dictation.phase !== "recording" && text.trim() === "" && images.length === 0)}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--t3-message-action)] text-[var(--t3-message-action-foreground)] shadow-[inset_0_1px_#ffffff29,0_1px_2px_0_color-mix(in_oklab,var(--t3-message-action)_24%,transparent)] transition-colors hover:bg-[var(--t3-message-action-hover)] disabled:pointer-events-none disabled:bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_12%,transparent)] disabled:text-t3-muted disabled:shadow-none"
          >
            <ArrowUp size={15} />
          </button>
        )}
        </div>
      </div>
    </div>
  );
}

function Chip({
  label,
  icon,
  open,
  title,
  onClick,
  onMouseDown,
}: {
  label: string;
  icon: ReactNode;
  open: boolean;
  title: string;
  onClick: () => void;
  onMouseDown: (event: { preventDefault(): void }) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-haspopup="menu"
      aria-expanded={open}
      onMouseDown={onMouseDown}
      onClick={onClick}
      className={`flex h-6 min-w-0 max-w-[45%] items-center gap-1 rounded-md px-1.5 text-[11px] ${
        open ? "bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_9%,transparent)] text-t3-fg" : "text-t3-muted hover:bg-t3-accent hover:text-t3-fg"
      }`}
    >
      <span className="flex shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The recording pill: a cancel, a red dot with the elapsed time, and the finish check. */
function DictationPill({
  phase,
  startedAt,
  onCancel,
  onFinish,
}: {
  phase: DictationPhase;
  startedAt: number;
  onCancel: () => void;
  onFinish: () => void;
}) {
  const label = phase === "starting" ? "Starting…" : phase === "finishing" ? "Transcribing…" : null;

  return (
    <div
      role="status"
      aria-label={label ?? "Recording"}
      className="flex flex-1 items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] bg-[var(--t3-surface-raised)] px-1.5 py-1"
    >
      <button
        type="button"
        title="Cancel voice input"
        aria-label="Cancel voice input"
        onClick={onCancel}
        className="flex size-5 shrink-0 items-center justify-center rounded text-t3-muted hover:text-t3-fg"
      >
        <X size={12} />
      </button>
      {label === null ? (
        <>
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--t3-error-foreground)]" />
          <RecordingTime startedAt={startedAt} />
        </>
      ) : (
        <>
          <LoaderCircle size={12} className="shrink-0 animate-spin text-t3-muted" />
          <span className="min-w-0 truncate text-[11px] text-t3-muted">{label}</span>
        </>
      )}
      <div className="min-w-0 flex-1" />
      <button
        type="button"
        title="Finish voice input"
        aria-label="Finish voice input"
        onClick={onFinish}
        disabled={phase !== "recording"}
        className="flex size-5 shrink-0 items-center justify-center rounded text-t3-muted hover:text-t3-fg disabled:opacity-40"
      >
        <Check size={12} />
      </button>
    </div>
  );
}

function RecordingTime({ startedAt }: { startedAt: number }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setSeconds(0);
    const timer = window.setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 250);

    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <span className="shrink-0 text-[11px] text-t3-muted tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

function toMenuRow(item: { kind: "model" | "clear" | "command" | "skill"; name: string; label: string; description: string }): MenuRow {
  return { id: `${item.kind}:${item.name}`, label: item.label, description: item.description, kind: item.kind };
}

function basename(path: string): string {
  const separator = path.lastIndexOf("/");

  return separator >= 0 ? path.slice(separator + 1) : path;
}

/** The draft and a live transcript share one box; a boundary keeps them apart. */
function joinTranscript(text: string, transcript: string): string {
  const piece = transcript.trimStart();

  if (piece === "") return text;

  if (text === "") return piece;

  return `${text}${/\s$/.test(text) ? "" : " "}${piece}`;
}

interface InsertedText {
  text: string;
  cursor: number;
}

/** T3's transcript insertion (packages/client-runtime/src/voice-input/controller.ts, resolveTranscriptCommit). */
function insertTranscript(text: string, caret: number, transcript: string): InsertedText {
  const piece = transcript.trim();

  if (piece === "") return { text, cursor: caret };

  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^\s/.test(after) ? " " : "";
  const insertion = `${lead}${piece}${trail}`;

  return { text: `${before}${insertion}${after}`, cursor: caret + insertion.length };
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read the image")));
    reader.readAsDataURL(file);
  });
}

/** The draft's seeds once the catalog arrives: the server's model and runtime defaults. */
export function draftPicks(config: PanelConfig | null): ComposerPicks {
  return {
    model: config?.defaultModel ?? null,
    runtimeMode: config?.defaultRuntimeMode ?? null,
  };
}
