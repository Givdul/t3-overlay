import { CircleDashed, Plus } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { SIDEBAR_WIDTH, sameThread, type OverlayState } from "../../shared/types";
import { ProjectGlyph, StateBadge, threadTooltip } from "./ThreadIcon";

const VISIBLE_THREADS = 5;

const button =
  "relative flex size-9 shrink-0 items-center justify-center rounded-lg text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg";

/** T3 Code's wordmark, copied from its apps/web/src/components/T3Wordmark.tsx. */
function T3Wordmark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="15.5309 37 94.3941 56.96" xmlns="http://www.w3.org/2000/svg" aria-label="T3">
      <path
        fill="currentColor"
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
      />
    </svg>
  );
}

export function Sidebar({ state }: { state: OverlayState }) {
  const content = useRef<HTMLDivElement>(null);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const moreBelow = state.threads.length > VISIBLE_THREADS && !scrolledToEnd;
  const left = state.side === "left" ? 0 : undefined;
  const right = state.side === "right" ? 0 : undefined;
  const hasWorking = state.working.length > 0;
  const hasThreads = state.threads.length > 0;

  // Observes the content and each of its children, so it re-observes only when a child mounts or unmounts.
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(() => window.overlay.setExtent({ sidebarHeight: element.scrollHeight + 2 }));
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [hasWorking, hasThreads]);

  const warnings = [
    state.t3 === "offline" ? "T3 Code is not running" : null,
    state.source === "local" ? "Only this PC: T3 is running without overlay support (see tray)" : null,
    state.layoutChanged ? "T3 layout changed: some chrome may show in the panel" : null,
    state.hotkeyFailed.length > 0 ? `Hotkey taken by another app: ${state.hotkeyFailed.join(", ")}` : null,
  ].filter(Boolean);

  return (
    <div
      className="absolute flex flex-col rounded-2xl border border-t3-border bg-t3-sidebar"
      style={{ top: state.sidebarOffsetY, left, right, width: SIDEBAR_WIDTH, maxHeight: `calc(100% - ${state.sidebarOffsetY}px)` }}
    >
      <div ref={content} className="flex min-h-0 flex-col items-center gap-1.5 overflow-y-auto px-2 py-2 [scrollbar-width:none]">
        <button
          type="button"
          className={`${button} ${state.t3 === "connected" ? "text-t3-fg" : "opacity-40"} ${state.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
          title={["T3 overlay: drag to move, right-click for settings", ...warnings].join("\n")}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            window.overlay.dragStart("move");
            window.addEventListener("mouseup", () => window.overlay.dragEnd(), { once: true });
          }}
          onContextMenu={() => window.overlay.setPopover(state.popover === "settings" ? null : "settings")}
        >
          <T3Wordmark className="h-3.5 w-auto" />
          {warnings.length > 0 && <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-amber-300 ring-2 ring-t3-sidebar" />}
        </button>

        <button
          type="button"
          className={`${button} ${state.panel === "draft" ? "bg-t3-accent text-t3-fg" : ""}`}
          title="New thread"
          disabled={state.t3 !== "connected"}
          onClick={() => window.overlay.open(state.panel === "draft" ? null : "draft")}
        >
          <Plus size={18} />
        </button>

        {hasWorking && (
          <button
            type="button"
            className={`${button} text-t3-info! ${state.popover === "working" ? "bg-t3-accent" : ""}`}
            title={`${state.working.length} working`}
            onClick={() => window.overlay.setPopover(state.popover === "working" ? null : "working")}
          >
            <CircleDashed size={30} strokeWidth={1.5} />
            <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums">
              {state.working.length > 9 ? "9+" : state.working.length}
            </span>
          </button>
        )}

        {hasThreads && <div className="my-0.5 h-px w-6 shrink-0 bg-t3-border" />}

        {/* Five icons fit; the rest scroll. The padding keeps state badges from being clipped. */}
        <div
          className="-m-1 flex shrink-0 flex-col gap-1.5 overflow-y-auto p-1 [scrollbar-width:none]"
          style={{
            maxHeight: VISIBLE_THREADS * 36 + (VISIBLE_THREADS - 1) * 6 + 8,
            maskImage: moreBelow ? "linear-gradient(to bottom, black calc(100% - 18px), transparent)" : undefined,
          }}
          onScroll={(event) => {
            const list = event.currentTarget;
            setScrolledToEnd(list.scrollTop + list.clientHeight >= list.scrollHeight - 2);
          }}
        >
          {state.threads.map((thread) => (
            <button
              key={`${thread.environmentId}:${thread.threadId}`}
              type="button"
              className={`${button} ${sameThread(state.panel, thread) ? "bg-t3-accent ring-1 ring-t3-fg/30" : ""}`}
              title={threadTooltip(thread)}
              onClick={() => window.overlay.open(sameThread(state.panel, thread) ? null : thread)}
              onContextMenu={() => window.overlay.threadMenu(thread)}
            >
              <ProjectGlyph icon={thread.icon} size={26} />
              <StateBadge state={thread.state} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
