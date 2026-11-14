import { ArrowDown, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MachineStatus, ThreadRef } from "../../../shared/types";

// The pieces the thread view and the new-thread composer share: the title row, the scrolling history
// and the placeholder card.

/** What a machine that is not connected needs, for its placeholder and the logo's tooltip. */
export function machineNote(status: MachineStatus): string {
  switch (status) {
    case "expired":
      return "Its session ended. Pair it again from the tray with a fresh pairing link.";
    case "offline":
      return "It does not answer. The overlay keeps trying.";
    default:
      return "Connecting…";
  }
}

/**
 * The chat history: it follows new rows while the reader is at the end, and holds the position while
 * they read further up. `open` leaves room under the last row for the composer card's overlap.
 */
export function History({ side, titleInCard, open, children }: { side: "left" | "right"; titleInCard: boolean; open: boolean; children: ReactNode }) {
  const [showToEnd, setShowToEnd] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastScrollTop = useRef(0);

  useEffect(() => {
    const element = scroller.current;

    if (element === null || !follow.current) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTop.current = element.scrollTop;
  });

  const historyClass = [
    "panel-scroll h-full w-full overflow-y-auto rounded-b-[12px] border bg-[var(--t3-chat-bg)] border-[var(--t3-chat-border)]",
    titleInCard ? "rounded-t-[12px] border-t" : "border-t-0",
    open ? "rounded-b-none border-b-0" : "",
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

  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className={historyClass} style={{ direction: side === "left" ? "rtl" : "ltr" }}>
        {/* The inner lane flips back to LTR, and its tail leaves room for the composer's overlap. */}
        <div style={{ direction: "ltr" }} className="px-3 pt-3">
          {children}
        </div>
        <div aria-hidden style={{ height: open ? "28px" : "12px" }} />
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
  );
}

export function TitleRow({ title, target, machine }: { title: string; target: ThreadRef | null; machine: string | null }) {
  return (
    <div
      className="flex h-[34px] shrink-0 items-center gap-2 truncate rounded-t-[12px] border border-[var(--t3-chat-border)] bg-[var(--t3-chat-bg)] pr-1.5 pl-3 text-[13px] font-semibold text-t3-fg"
      style={{ borderBottomColor: "color-mix(in srgb, var(--t3-border) 50%, transparent)" }}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {machine !== null && <span className="max-w-[45%] shrink-0 truncate text-[11px] font-normal text-t3-muted">{machine}</span>}
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

export function PlaceholderCard({ title, text, target }: { title: string; text: string; target: ThreadRef | null }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] p-4 text-center">
      <p className="text-[13px] text-t3-fg">{title}</p>
      <p className="text-[11px] text-t3-muted">{text}</p>
      {target !== null && <OpenInT3 target={target} />}
    </div>
  );
}
