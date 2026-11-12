import { CircleAlert, CircleHelp, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { PanelQuestion, PanelRuntimeRequest } from "../../../shared/panel";
import type { PendingRequests } from "./model";

// A thread waiting on an approval or a question. Answering dispatches T3's own command, so the card
// disappears on the next `runtime-request.updated` event instead of being hidden locally.

const card =
  "rounded-xl border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] bg-[var(--t3-surface-raised)] p-3";

const action =
  "flex items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] px-2.5 py-1 text-[12px] text-t3-fg hover:bg-t3-accent disabled:cursor-default disabled:opacity-40";

export function ApprovalCard({ request }: { request: PendingRequests["approvals"][number] }) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = request.responseCapability.type === "live";

  async function respond(decision: "accept" | "decline") {
    setBusy(decision);
    setError(null);

    const reply = await window.overlay.panel({ type: "respond", requestId: request.id, decision });

    if (!reply.ok) {
      setError(reply.error);
      setBusy(null);

      return;
    }

    // The resolved request leaves on its own event, but a re-read makes the card go even if one is missed.
    void window.overlay.panel({ type: "reload" });
  }

  return (
    <div className={card}>
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-t3-fg">
        <CircleAlert size={13} className="text-[var(--t3-warning-foreground)]" />
        {approvalTitle(request)}
      </p>
      {request.prompt !== null && (
        <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--t3-contrast-foreground)]">{request.prompt}</p>
      )}
      {request.reason !== null && <p className="mt-1 text-[11px] text-t3-muted">{request.reason}</p>}
      {live ? (
        <div className="mt-2 flex items-center gap-2">
          <button type="button" disabled={busy !== null} className={action} onClick={() => void respond("accept")}>
            {busy === "accept" && <LoaderCircle size={11} className="animate-spin" />}
            Approve
          </button>
          <button type="button" disabled={busy !== null} className={action} onClick={() => void respond("decline")}>
            {busy === "decline" && <LoaderCircle size={11} className="animate-spin" />}
            Deny
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-t3-muted">This approval can only be answered in T3 Code.</p>
      )}
      {error !== null && <p className="mt-1 text-[11px] text-[var(--t3-error-foreground)]">{error}</p>}
    </div>
  );
}

/** T3's approval request kinds (packages/contracts/src/providerPolicy.ts, ProviderRequestKind). */
function approvalTitle(request: PanelRuntimeRequest & { prompt: string | null }) {
  switch (request.kind) {
    case "command":
      return "Run a command?";
    case "file-change":
      return "Change files?";
    case "file-read":
      return "Read a file?";
    case "permission":
      return "Approve this action?";
    case "mcp-elicitation":
      return "The agent needs input";
    default:
      return "Approval requested";
  }
}

interface AnswerDraft {
  selected: string[];
  custom: string;
}

export function QuestionCard({ request }: { request: PendingRequests["questions"][number] }) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>(() =>
    Object.fromEntries(
      request.questions.map((question) => [
        question.id ?? "",
        { selected: [], custom: question.initialAnswer ?? "" },
      ]),
    ),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = request.responseCapability.type === "live" || request.responseCapability.type === "message";

  const answers = request.questions.flatMap<{ id: string; answer: string | string[] }>((question) => {
    const id = question.id ?? "";
    const draft = drafts[id] ?? { selected: [], custom: "" };
    const custom = question.allowCustomAnswer === false ? "" : draft.custom.trim();

    if (custom !== "") return [{ id, answer: custom }];

    if (question.multiSelect === true) return draft.selected.length > 0 ? [{ id, answer: draft.selected }] : [];

    return draft.selected[0] === undefined ? [] : [{ id, answer: draft.selected[0] }];
  });

  const complete = answers.length === request.questions.length;

  function update(id: string, change: (draft: AnswerDraft) => AnswerDraft) {
    setDrafts((current) => ({ ...current, [id]: change(current[id] ?? { selected: [], custom: "" }) }));
  }

  async function send() {
    setBusy(true);
    setError(null);

    const reply = await window.overlay.panel({
      type: "answer",
      requestId: request.id,
      answers: Object.fromEntries(answers.map((entry) => [entry.id, entry.answer])),
    });

    if (!reply.ok) {
      setError(reply.error);
      setBusy(false);

      return;
    }

    void window.overlay.panel({ type: "reload" });
  }

  async function dismiss() {
    setBusy(true);
    setError(null);

    const reply = await window.overlay.panel({ type: "dismissInput", requestId: request.id });

    if (!reply.ok) {
      setError(reply.error);
      setBusy(false);

      return;
    }

    void window.overlay.panel({ type: "reload" });
  }

  return (
    <div className={card}>
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-t3-fg">
        <CircleHelp size={13} className="text-[var(--t3-info-foreground)]" />
        The agent asked a question
      </p>
      <div className="mt-1 flex flex-col gap-2">
        {request.questions.map((question, index) => {
          const id = question.id ?? String(index);
          const draft = drafts[id] ?? { selected: [], custom: "" };

          return (
            <QuestionBody
              key={id}
              question={question}
              draft={draft}
              onSelect={(value) =>
                update(id, (current) => ({
                  ...current,
                  selected:
                    question.multiSelect === true
                      ? current.selected.includes(value)
                        ? current.selected.filter((candidate) => candidate !== value)
                        : [...current.selected, value]
                      : current.selected.includes(value)
                        ? []
                        : [value],
                }))
              }
              onCustom={(value) => update(id, (current) => ({ ...current, custom: value }))}
            />
          );
        })}
      </div>
      {live ? (
        <div className="mt-2 flex items-center gap-2">
          <button type="button" disabled={busy || !complete} className={action} onClick={() => void send()}>
            {busy && <LoaderCircle size={11} className="animate-spin" />}
            Send
          </button>
          {request.dismissible && (
            <button type="button" disabled={busy} className={action} onClick={() => void dismiss()}>
              Dismiss
            </button>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-t3-muted">This question can only be answered in T3 Code.</p>
      )}
      {error !== null && <p className="mt-1 text-[11px] text-[var(--t3-error-foreground)]">{error}</p>}
    </div>
  );
}

function QuestionBody({
  question,
  draft,
  onSelect,
  onCustom,
}: {
  question: PanelQuestion;
  draft: AnswerDraft;
  onSelect: (value: string) => void;
  onCustom: (value: string) => void;
}) {
  const custom = question.allowCustomAnswer !== false;

  return (
    <div className="flex flex-col gap-1 text-[13px] leading-relaxed text-[var(--t3-contrast-foreground)]">
      <p>{question.question ?? question.header ?? ""}</p>
      {(question.options ?? []).length > 0 && (
        <div role="group" className="flex flex-col gap-0.5">
          {(question.options ?? []).map((option, index) => {
            const value = option.value ?? option.label ?? String(index);
            const selected = draft.selected.includes(value);
            const disabledByCustom = custom && draft.custom.trim() !== "";

            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                disabled={disabledByCustom}
                onClick={() => onSelect(value)}
                className={`flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[12px] disabled:opacity-50 ${
                  selected ? "bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_9%,transparent)] text-t3-fg" : "text-t3-muted hover:text-t3-fg"
                }`}
              >
                <span
                  className={`flex size-3 shrink-0 items-center justify-center border ${
                    question.multiSelect === true ? "rounded-[3px]" : "rounded-full"
                  } ${selected ? "border-[var(--t3-contrast-foreground)] bg-[var(--t3-contrast-foreground)]" : "border-[var(--t3-contrast-border)]"}`}
                >
                  {selected && <span className="size-1 rounded-full bg-[var(--t3-background)]" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label ?? value}</span>
                {option.description !== undefined && option.description !== "" && (
                  <span className="min-w-0 max-w-[45%] truncate text-[11px] opacity-70">{option.description}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {custom && (
        <input
          value={draft.custom}
          onChange={(event) => onCustom(event.target.value)}
          placeholder="Or write an answer"
          className="w-full rounded-md border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] bg-[var(--t3-code-background)] px-2 py-1 text-[12px] text-t3-fg outline-none placeholder:text-t3-muted"
        />
      )}
    </div>
  );
}
