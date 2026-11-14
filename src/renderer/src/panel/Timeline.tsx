import {
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Copy,
  FilePenLine,
  Globe,
  LoaderCircle,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PanelItem, PanelView } from "../../../shared/panel";
import { Markdown } from "../markdown";
import type { PendingRequests } from "./model";
import { ApprovalCard, QuestionCard } from "./Requests";

// One line per turn item, expanded on click. Every row keeps T3's own labels and muted tone, so the
// timeline reads like the one in T3.

type LinkHandler = (url: string) => void;

// T3's chat clock (apps/web/src/timestampFormat.ts): locale time with minutes, a day-aware short date
// for older messages, and the full date in the tooltip. The overlay ignores T3's timestampFormat setting.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long" });
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });
const DATE_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", year: "numeric" });

const mono = "font-mono text-[length:var(--t3-font-size-code)]";

/** T3's turn-item statuses that mean the item is still going (OrchestrationV2TurnItemStatus). */
const IN_PROGRESS_STATUSES = new Set(["pending", "running", "waiting"]);

interface TimelineProps {
  view: PanelView;
  pending: PendingRequests;
  onLink: LinkHandler;
}

export function Timeline({ view, pending, onLink }: TimelineProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {view.rows.map((row) => (
        <TimelineRow key={row.sourceItemId} item={row.item} pending={pending} onLink={onLink} />
      ))}
      {view.queued.map((message) => (
        <div key={message.id} className="flex min-w-0 flex-col items-end gap-1">
          <span className="me-1 text-[11px] text-t3-muted">Queued</span>
          <div
            className="max-w-[80%] min-w-0 rounded-2xl p-3 text-[length:var(--t3-font-size-prompt)] text-[var(--t3-foreground)]"
            style={{ backgroundColor: "color-mix(in srgb, var(--t3-message-surface) var(--t3-bubble-opacity), transparent)" }}
          >
            <Markdown text={message.text} onLink={onLink} />
          </div>
        </div>
      ))}
    </div>
  );
}

function TimelineRow({ item, pending, onLink }: Omit<TimelineProps, "view"> & { item: PanelItem }) {
  switch (item.type) {
    case "user_message":
      return <UserMessageRow item={item} onLink={onLink} />;
    case "assistant_message":
      return <AssistantMessageRow item={item} onLink={onLink} />;
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "command_execution":
      return <CommandRow item={item} />;
    case "dynamic_tool":
      return <ToolRow item={item} />;
    case "file_change":
      return <FileChangeRow item={item} />;
    case "file_search":
      return <FileSearchRow item={item} />;
    case "web_search":
      return <WebSearchRow item={item} />;
    case "todo_list":
      return <TodoRow item={item} />;
    case "proposed_plan":
      return <PlanRow item={item} onLink={onLink} />;
    case "error":
      return <ErrorRow item={item} />;
    case "system_notice":
    case "compaction":
      return <NoticeRow item={item} />;
    case "subagent":
      return <SubagentRow item={item} />;
    case "run_interrupt_request":
    case "run_interrupt_result":
      return <NoticeRow item={item} />;
    case "approval_request": {
      const request = pending.approvals.find((candidate) => candidate.id === item.requestId);

      // A resolved approval was answered in T3 or here; its card is gone and leaves no row behind.
      return request === undefined ? null : <ApprovalCard request={request} />;
    }

    case "user_input_request": {
      const request = pending.questions.find((candidate) => candidate.id === item.requestId);

      return request === undefined ? <MutedLine text="Asked a question" /> : <QuestionCard request={request} />;
    }

    default:
      // A nightly's new item type: T3 would draw it, the panel skips it rather than guessing.
      return null;
  }
}

// ---------------------------------------------------------------- messages

function UserMessageRow({ item, onLink }: { item: PanelItem; onLink: LinkHandler }) {
  const text = item.text ?? "";
  const queued = item.inputIntent === "queued_turn" && item.status !== "completed";

  return (
    <div className="group/msg flex min-w-0 flex-col items-end gap-1">
      <div
        className="max-w-[80%] min-w-0 rounded-2xl p-3 text-[length:var(--t3-font-size-prompt)] text-[var(--t3-foreground)]"
        style={{ backgroundColor: "color-mix(in srgb, var(--t3-message-surface) var(--t3-bubble-opacity), transparent)" }}
      >
        <Markdown text={text} onLink={onLink} />
      </div>
      <div className="flex min-h-5 items-center gap-2 pe-1">
        {queued && <span className="text-[11px] text-t3-muted">Queued</span>}
        <MessageMeta text={text} at={item.startedAt ?? item.completedAt} timeFirst />
      </div>
    </div>
  );
}

function AssistantMessageRow({ item, onLink }: { item: PanelItem; onLink: LinkHandler }) {
  const text = item.text ?? "";

  return (
    <div className="group/msg min-w-0 px-1 py-0.5 text-[length:var(--t3-font-size-prompt)] leading-relaxed text-[color-mix(in_oklab,var(--t3-foreground)_90%,transparent)]">
      <Markdown text={text} onLink={onLink} />
      <div className="flex min-h-5 items-center">
        <MessageMeta text={text} at={item.completedAt ?? item.startedAt} />
      </div>
    </div>
  );
}

/** T3's hover chrome under a message: its time, and a button that copies the message's text. */
function MessageMeta({ text, at, timeFirst = false }: { text: string; at: string | undefined; timeFirst?: boolean }) {
  const time = messageTimestamp(at);

  return (
    <div className="flex items-center gap-1 text-[11px] text-t3-muted opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/msg:opacity-100">
      {timeFirst && time}
      <CopyButton text={text} />
      {!timeFirst && time}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      title="Copy message"
      aria-label="Copy message"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => undefined);
      }}
      className="flex size-5 shrink-0 items-center justify-center rounded text-t3-muted transition-colors hover:text-t3-fg"
    >
      {copied ? <Check size={12} className="text-[var(--t3-primary)]" /> : <Copy size={12} />}
    </button>
  );
}

/** T3's `formatDayAwareTimestamp` and `formatChatTimestampTooltip` for one item. */
function messageTimestamp(iso: string | undefined): ReactNode {
  if (iso === undefined) return null;
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return null;
  const time = TIME_FORMAT.format(date);
  const today = new Date();
  const days = dayIndex(today) - dayIndex(date);
  const dateFormat = date.getFullYear() === today.getFullYear() ? DATE_FORMAT : DATE_YEAR_FORMAT;
  const label = days <= 0 ? time : days === 1 ? `yesterday at ${time}` : `${dateFormat.format(date)} ${time}`;
  const day = date.getDate();
  const title = `${time}, ${day}${ordinal(day)} ${MONTH_FORMAT.format(date)} ${date.getFullYear()}`;

  return (
    <span title={title} className="shrink-0 tabular-nums">
      {label}
    </span>
  );
}

/** Days since the epoch by local calendar day, so a comparison across a DST change still counts days. */
function dayIndex(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function ordinal(day: number): string {
  const lastTwo = day % 100;

  if (lastTwo >= 11 && lastTwo <= 13) return "th";

  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

// ---------------------------------------------------------------- expandable rows

/** A row that opens on click. `detail` is the one-line summary; `children` is what it opens into. */
function Expandable({
  icon,
  label,
  detail,
  badge,
  children,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-[12px] text-t3-muted transition-colors hover:text-t3-fg"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
        <span className="shrink-0">{label}</span>
        {detail !== undefined && detail !== "" && <span className={`min-w-0 flex-1 truncate ${mono} text-[11px]`}>{detail}</span>}
        {badge}
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="mt-1 min-w-0">{children}</div>}
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className={`max-h-64 overflow-auto rounded-lg border border-[color-mix(in_srgb,var(--t3-border)_100%,transparent)] bg-[var(--t3-code-background)] p-2 ${mono} whitespace-pre-wrap select-text`}>
      {text}
    </pre>
  );
}

function ReasoningRow({ item }: { item: PanelItem }) {
  return (
    <Expandable icon={<CircleDashed size={13} />} label={item.title ?? "Thought"}>
      <p className="max-h-64 overflow-auto text-[12px] leading-relaxed whitespace-pre-wrap text-t3-muted">{item.text ?? ""}</p>
    </Expandable>
  );
}

/** T3 sends long tool output truncated; the full body comes from `getTurnItem` when the row opens. */
function useFullItem(item: PanelItem, open: boolean) {
  const [full, setFull] = useState<PanelItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || item.outputOmitted !== true || full !== null || error !== null) return;
    let cancelled = false;
    void window.overlay.panel({ type: "turnItem", itemId: item.id }).then((reply) => {
      if (cancelled) return;

      if (reply.ok && "item" in reply) setFull(reply.item);
      else if (!reply.ok) setError(reply.error);
    });

    return () => {
      cancelled = true;
    };
  }, [open, item, full, error]);

  return { full, error };
}

function CommandRow({ item }: { item: PanelItem }) {
  const [open, setOpen] = useState(false);
  const { full, error } = useFullItem(item, open);
  const input = firstLine(item.input ?? "");
  const output = (full ?? item).output ?? null;
  const exitCode = item.exitCode ?? null;
  const running = IN_PROGRESS_STATUSES.has(item.status ?? "");
  const failed = item.status === "failed";

  const badge = running ? (
    <LoaderCircle size={12} className="shrink-0 animate-spin" />
  ) : exitCode === null ? (
    failed && <CircleAlert size={12} className="shrink-0 text-[var(--t3-error-foreground)]" />
  ) : (
    <span className={`shrink-0 text-[11px] tabular-nums ${exitCode === 0 ? "text-[var(--t3-success-foreground)]" : "text-[var(--t3-error-foreground)]"}`}>{exitCode}</span>
  );

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-[12px] text-t3-muted transition-colors hover:text-t3-fg"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <Terminal size={13} />
        </span>
        <span className="shrink-0">Ran</span>
        <span className={`min-w-0 flex-1 truncate ${mono} text-[11px]`}>{input}</span>
        {badge}
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-1 flex min-w-0 flex-col gap-1.5">
          <CodeBlock text={`$ ${item.input ?? ""}`} />
          {error !== null ? (
            <p className="text-[11px] text-t3-muted">Could not load the output: {error}</p>
          ) : output === null ? (
            <p className="text-[11px] text-t3-muted">No output</p>
          ) : (
            <CodeBlock text={output} />
          )}
        </div>
      )}
    </div>
  );
}

function ToolRow({ item }: { item: PanelItem }) {
  const [open, setOpen] = useState(false);
  const { full, error } = useFullItem(item, open);
  const output = (full ?? item).output ?? null;
  const input = item.toolInput;

  return (
    <Expandable icon={<Wrench size={13} />} label="Called" detail={item.toolName ?? ""}>
      {input !== undefined && <CodeBlock text={input} />}
      {error !== null ? (
        <p className="text-[11px] text-t3-muted">Could not load the output: {error}</p>
      ) : output !== null ? (
        <CodeBlock text={output} />
      ) : null}
    </Expandable>
  );
}

function FileChangeRow({ item }: { item: PanelItem }) {
  const changes = item.changes ?? [];
  const additions = item.additions ?? null;
  const deletions = item.deletions ?? null;

  return (
    <Expandable
      icon={<FilePenLine size={13} />}
      label="Edited"
      detail={String(item.fileName ?? "")}
      badge={
        additions === null && deletions === null ? undefined : (
          <span className="shrink-0 text-[11px] tabular-nums">
            <span className="text-[var(--t3-success-foreground)]">+{additions ?? 0}</span>{" "}
            <span className="text-[var(--t3-error-foreground)]">−{deletions ?? 0}</span>
          </span>
        )
      }
    >
      <div className="flex flex-col gap-1 text-[11px] text-t3-muted">
        {changes.length === 0 && <p>No file details</p>}
        {changes.map((change, index) => (
          <p key={index} className="flex min-w-0 gap-2">
            <span className="min-w-0 flex-1 truncate font-mono">{change.path ?? change.fileName ?? ""}</span>
            <span className="shrink-0 tabular-nums">
              +{change.additions ?? 0} −{change.deletions ?? 0}
            </span>
          </p>
        ))}
      </div>
    </Expandable>
  );
}

function FileSearchRow({ item }: { item: PanelItem }) {
  const results = item.results ?? [];

  return (
    <Expandable icon={<Search size={13} />} label="Searched files" detail={String(item.pattern ?? "")}>
      <div className="flex max-h-64 flex-col gap-0.5 overflow-auto font-mono text-[11px] text-t3-muted">
        {results.length === 0 && <p>No matches</p>}
        {results.map((path, index) => (
          <p key={index} className="truncate">
            {path}
          </p>
        ))}
      </div>
    </Expandable>
  );
}

function WebSearchRow({ item }: { item: PanelItem }) {
  const patterns = (item.patterns ?? []).join(" · ");

  return (
    <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-[12px] text-t3-muted">
      <Globe size={13} className="shrink-0" />
      <span className="shrink-0">Searched the web</span>
      <span className="min-w-0 flex-1 truncate text-[11px]">{patterns}</span>
    </div>
  );
}

// ---------------------------------------------------------------- static rows

function TodoRow({ item }: { item: PanelItem }) {
  const steps = item.steps ?? [];

  return (
    <div className="flex flex-col gap-0.5 py-0.5 text-[12px]">
      {steps.map((step, index) => {
        const done = step.status === "completed" || step.status === "done";

        return (
          <p key={step.id ?? index} className="flex min-w-0 items-center gap-1.5">
            {done ? (
              <CircleCheck size={12} className="shrink-0 text-[var(--t3-success-foreground)]" />
            ) : step.status === "in_progress" || step.status === "running" ? (
              <CircleDashed size={12} className="shrink-0 text-t3-muted" />
            ) : (
              <Circle size={12} className="shrink-0 text-t3-muted" />
            )}
            <span className={done ? "min-w-0 truncate text-t3-muted line-through" : "min-w-0 truncate"}>{step.text ?? ""}</span>
          </p>
        );
      })}
    </div>
  );
}

function PlanRow({ item, onLink }: { item: PanelItem; onLink: LinkHandler }) {
  return (
    <div className="min-w-0 rounded-xl border border-[color-mix(in_srgb,var(--t3-border)_100%,transparent)] p-3">
      <p className="mb-1 text-[11px] text-t3-muted">Plan</p>
      <div className="text-[length:var(--t3-font-size-prompt)] leading-relaxed">
        <Markdown text={item.markdown ?? ""} onLink={onLink} />
      </div>
    </div>
  );
}

function ErrorRow({ item }: { item: PanelItem }) {
  return (
    <div className="flex min-w-0 items-start gap-1.5 py-0.5 text-[12px] text-[var(--t3-error-foreground)]">
      <CircleAlert size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap">{item.failure?.message ?? item.title ?? "The turn failed"}</span>
    </div>
  );
}

function NoticeRow({ item }: { item: PanelItem }) {
  const text = item.message ?? item.summary ?? "";

  return <p className="py-0.5 text-center text-[11px] text-t3-muted">{text}</p>;
}

function SubagentRow({ item }: { item: PanelItem }) {
  const detail = item.progress === undefined || item.progress === "" ? item.status ?? "" : item.progress;

  return (
    <p className="flex min-w-0 items-center gap-1.5 py-0.5 text-[12px] text-t3-muted">
      <CircleDashed size={13} className="shrink-0" />
      <span className="shrink-0">Subagent</span>
      <span className="min-w-0 flex-1 truncate text-[11px]">{detail}</span>
    </p>
  );
}

function MutedLine({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-1.5 py-0.5 text-[12px] text-t3-muted">
      <CircleHelp size={13} className="shrink-0" />
      {text}
    </p>
  );
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";

  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
