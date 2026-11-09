import { Loader2, Plus } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { SIDEBAR_WIDTH, sameThread, type OverlayState } from "../../shared/types";
import { ProjectGlyph, StateBadge, threadTooltip } from "./ThreadIcon";

const VISIBLE_THREADS = 5;

const button =
  "relative flex size-9 shrink-0 items-center justify-center rounded-lg text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg";

export function Sidebar({ state }: { state: OverlayState }) {
  const content = useRef<HTMLDivElement>(null);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const moreBelow = state.threads.length > VISIBLE_THREADS && !scrolledToEnd;
  const left = state.side === "left" ? 0 : undefined;
  const right = state.side === "right" ? 0 : undefined;

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const report = () => window.overlay.setExtent({ sidebarHeight: element.scrollHeight + 2 });
    const observer = new ResizeObserver(report);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    report();
    return () => observer.disconnect();
  });

  const warnings = [
    state.t3 === "offline" ? "T3 Code is not running" : null,
    state.source === "local" ? "Only this PC: T3 is running without overlay support (see tray)" : null,
    state.layoutChanged ? "T3 layout changed: some chrome may show in the panel" : null,
    state.hotkeyFailed.length > 0 ? `Hotkey taken by another app: ${state.hotkeyFailed.join(", ")}` : null,
  ].filter(Boolean);

  return (
    <div
      className="absolute flex flex-col rounded-2xl border border-t3-border bg-t3-sidebar shadow-lg shadow-black/40"
      style={{ top: state.sidebarOffsetY, left, right, width: SIDEBAR_WIDTH, maxHeight: `calc(100% - ${state.sidebarOffsetY}px)` }}
    >
      <div ref={content} className="flex min-h-0 flex-col items-center gap-1.5 overflow-y-auto px-2 py-2 [scrollbar-width:none]">
        <button
          type="button"
          className={`${button} font-bold tracking-tight ${state.t3 === "connected" ? "text-t3-fg" : "opacity-40"} ${state.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
          title={["T3 overlay: drag to move, right-click for settings", ...warnings].join("\n")}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            window.overlay.dragStart("move");
            window.addEventListener("mouseup", () => window.overlay.dragEnd(), { once: true });
          }}
          onContextMenu={() => window.overlay.setPopover(state.popover === "settings" ? null : "settings")}
        >
          T3
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

        {state.working.length > 0 && (
          <button
            type="button"
            className={`${button} h-7 gap-1 text-xs text-sky-300 ${state.popover === "working" ? "bg-t3-accent" : ""}`}
            title={`${state.working.length} working`}
            onClick={() => window.overlay.setPopover(state.popover === "working" ? null : "working")}
          >
            <Loader2 size={12} className="animate-spin" />
            {state.working.length}
          </button>
        )}

        {state.threads.length > 0 && <div className="my-0.5 h-px w-6 shrink-0 bg-t3-border" />}

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
              className={`${button} bg-t3-accent/40 ${sameThread(state.panel, thread) ? "bg-t3-accent ring-1 ring-t3-fg/30" : ""}`}
              title={threadTooltip(thread)}
              onClick={() => window.overlay.open(sameThread(state.panel, thread) ? null : thread)}
              onContextMenu={() => window.overlay.threadMenu(thread)}
            >
              <ProjectGlyph icon={thread.icon} />
              <StateBadge state={thread.state} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
