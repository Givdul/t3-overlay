import { CircleAlert, CircleHelp } from "lucide-react";
import type { PanelRuntimeRequest } from "../../../shared/panel";
import type { PendingRequests } from "./model";

// A thread waiting on an approval or a question. Read-only for now: answering lands with the composer,
// so the buttons say so instead of pretending.

const card =
  "rounded-xl border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] bg-[var(--t3-surface-raised)] p-3";

const action =
  "rounded-lg border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] px-2.5 py-1 text-[12px] text-t3-fg opacity-50";

export function ApprovalCard({ request }: { request: PendingRequests["approvals"][number] }) {
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
      <div className="mt-2 flex items-center gap-2">
        <button type="button" disabled className={action}>
          Approve
        </button>
        <button type="button" disabled className={action}>
          Deny
        </button>
      </div>
      <p className="mt-2 text-[11px] text-t3-muted">Approvals work once sending lands.</p>
    </div>
  );
}

function approvalTitle(request: PanelRuntimeRequest & { prompt: string | null }) {
  switch (request.kind) {
    case "command_execution":
      return "Run a command?";
    case "file_change":
      return "Change files?";
    case "web_access":
      return "Use the web?";
    default:
      return "Approval requested";
  }
}

export function QuestionCard({ request }: { request: PendingRequests["questions"][number] }) {
  return (
    <div className={card}>
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-t3-fg">
        <CircleHelp size={13} className="text-[var(--t3-info-foreground)]" />
        The agent asked a question
      </p>
      <div className="mt-1 flex flex-col gap-1.5">
        {request.questions.map((question, index) => (
          <div key={question.id ?? index} className="text-[13px] leading-relaxed text-[var(--t3-contrast-foreground)]">
            <p>{question.question ?? question.header ?? ""}</p>
            {question.options !== undefined && (
              <ul className="mt-1 flex flex-col gap-0.5">
                {question.options.map((option, optionIndex) => (
                  <li key={optionIndex} className="text-[12px] text-t3-muted">
                    · {option.label ?? ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-t3-muted">Answering works once sending lands.</p>
    </div>
  );
}
