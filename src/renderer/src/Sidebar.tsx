import { CircleDashed, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SIDEBAR_WIDTH, sameThread, threadKey, type OverlayState } from "../../shared/types";
import { ProjectGlyph, StateBadge, threadTooltip } from "./ThreadIcon";

const VISIBLE_THREADS = 5;

/** A 36px button and one 6px gap. Each item's slot owns its gap, so a slot opening or closing never jumps. */
const SLOT_HEIGHT = 42;

const DIVIDER_HEIGHT = 5;

/** Border, padding, the logo and the new-thread button with their gaps. */
const FIXED_HEIGHT = 2 + 8 + 36 + 6 + 36 + 6 + 8;

/** Matches the slots' duration-220. */
const SLIDE_MS = 220;

const button = "relative flex size-9 shrink-0 items-center justify-center rounded-lg text-t3-muted hover:bg-t3-accent hover:text-t3-fg";

const pressable =
  "[transition:color_150ms_var(--default-transition-timing-function),background-color_150ms_var(--default-transition-timing-function),scale_160ms_var(--ease-out)] motion-safe:active:scale-96";

// The clip margin leaves room for the state badges, which hang 4px outside the button plus a 2px ring.
const slot =
  "flex shrink-0 flex-col overflow-clip [overflow-clip-margin:6px] transition-[height,opacity] duration-220 ease-out starting:h-0 starting:opacity-0 motion-reduce:transition-opacity";

const closing = "pointer-events-none h-0 opacity-0";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Presence<T> {
  key: string;
  item: T;
  /** Order of first appearance, the order the slots sit in the DOM. */
  seq: number;
  leftAt: number | null;
}

/**
 * Keeps an item that left mounted for one slide, at its old place, so its slot can close.
 * Slots stay in the DOM in the order they appeared and take their place through CSS `order`:
 * moving a node in the DOM would start its @starting-style entrance again.
 * `departedAt` is when the latest item left. It only moves forward, so unmounting a closed slot never changes it.
 */
function usePresence<T>(items: T[], keyOf: (item: T) => string) {
  const [seen, setSeen] = useState(items);
  const [departedAt, setDepartedAt] = useState(0);

  const [present, setPresent] = useState<Presence<T>[]>(() =>
    items.map((item, seq) => ({ key: keyOf(item), item, seq, leftAt: null })),
  );

  if (items.length !== seen.length || items.some((item, index) => item !== seen[index])) {
    const now = performance.now();
    const next = arrive(present, items, keyOf, reducedMotion() ? null : now);

    setSeen(items);
    setPresent(next);

    if (next.some(({ leftAt }) => leftAt === now)) setDepartedAt(now);
  }

  useEffect(() => {
    const left = present.flatMap(({ leftAt }) => (leftAt === null ? [] : [leftAt]));

    if (left.length === 0) return;

    const timer = setTimeout(
      () => setPresent((list) => list.filter(({ leftAt }) => leftAt === null || performance.now() - leftAt < SLIDE_MS)),
      Math.min(...left) + SLIDE_MS - performance.now(),
    );

    return () => clearTimeout(timer);
  }, [present]);

  const slots = present
    .map(({ key, item, seq, leftAt }, order) => ({ key, item, seq, order, leaving: leftAt !== null }))
    .toSorted((a, b) => a.seq - b.seq);

  return { slots, departedAt };
}

/** @param now Null drops items that left at once. */
function arrive<T>(present: Presence<T>[], items: T[], keyOf: (item: T) => string, now: number | null): Presence<T>[] {
  const previous = new Map(present.map((entry) => [entry.key, entry]));
  let seq = Math.max(-1, ...present.map((entry) => entry.seq)) + 1;

  const next: Presence<T>[] = items.map((item) => {
    const key = keyOf(item);

    return { key, item, seq: previous.get(key)?.seq ?? seq++, leftAt: null };
  });

  if (now === null) return next;
  const has = (key: string) => next.some((entry) => entry.key === key);
  present.forEach((entry, index) => {
    if (has(entry.key)) return;
    const before = present.slice(0, index).findLast((earlier) => has(earlier.key));
    const at = before ? next.findIndex((other) => other.key === before.key) + 1 : 0;
    next.splice(at, 0, { ...entry, leftAt: entry.leftAt ?? now });
  });

  return next;
}

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
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const moreBelow = state.threads.length > VISIBLE_THREADS && !scrolledToEnd;
  const left = state.side === "left" ? 0 : undefined;
  const right = state.side === "right" ? 0 : undefined;
  const threads = usePresence(state.threads, threadKey);
  const working = usePresence(state.working.length > 0 ? [state.working.length] : [], () => "working");
  const divider = usePresence(state.threads.length > 0 ? [true] : [], () => "divider");

  // The height once every slot has settled. Main sizes the window by it, and on Windows the window's shape
  // also clips drawing: a growing sidebar reports at once, a shrinking one after its last slide ends.
  const sidebarHeight =
    FIXED_HEIGHT +
    (state.working.length > 0 ? SLOT_HEIGHT : 0) +
    (state.threads.length > 0 ? DIVIDER_HEIGHT : 0) +
    Math.min(state.threads.length, VISIBLE_THREADS) * SLOT_HEIGHT;

  const departedAt = Math.max(working.departedAt, divider.departedAt, threads.departedAt);
  const reported = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (sidebarHeight === reported.current) return;

    const report = () => {
      reported.current = sidebarHeight;
      window.overlay.setExtent({ sidebarHeight });
    };

    if (reported.current === null || sidebarHeight > reported.current || reducedMotion()) {
      report();

      return;
    }

    const timer = setTimeout(report, Math.max(0, departedAt + SLIDE_MS - performance.now()));

    return () => clearTimeout(timer);
  }, [sidebarHeight, departedAt]);

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
      <div className="flex min-h-0 flex-col items-center overflow-y-auto px-2 py-2 [scrollbar-width:none]">
        <button
          type="button"
          className={`${button} transition-colors ${state.t3 === "connected" ? "text-t3-fg" : "opacity-40"} ${state.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
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
          className={`${button} ${pressable} my-1.5 ${state.panel === "draft" ? "bg-t3-accent text-t3-fg" : ""}`}
          title="New thread"
          disabled={state.t3 !== "connected"}
          onClick={() => window.overlay.open(state.panel === "draft" ? null : "draft")}
        >
          <Plus size={18} />
        </button>

        {working.slots.map(({ key, item: count, leaving }) => (
          <div key={key} className={`${slot} ${leaving ? closing : "h-[42px]"}`}>
            <button
              type="button"
              className={`${button} ${pressable} text-t3-info! ${state.popover === "working" ? "bg-t3-accent" : ""}`}
              title={`${count} working`}
              onClick={() => window.overlay.setPopover(state.popover === "working" ? null : "working")}
            >
              <CircleDashed size={24} strokeWidth={1.5} />
              {/* pb-0.5 lifts the 9px-tall digits 1px, so they sit 0.5px above the ring's center instead of 0.5px below. */}
              <span className="absolute inset-0 flex items-center justify-center pb-0.5 text-xs font-bold tabular-nums">{count}</span>
            </button>
          </div>
        ))}

        {divider.slots.map(({ key, leaving }) => (
          <div key={key} className={`${slot} ${leaving ? closing : "h-[5px]"}`}>
            <div className="my-0.5 h-px w-6 shrink-0 bg-t3-border" />
          </div>
        ))}

        {/* Five icons fit; the rest scroll. The side and bottom padding keep state badges from being clipped.
            Each slot holds the gap above its icon, so the list starts at the divider and clips its top 2px,
            where it started when the gap sat outside it. */}
        <div
          className="-mx-1 -mb-1 flex shrink-0 flex-col overflow-y-auto px-1 pb-1 [clip-path:inset(2px_0_0)] [scrollbar-width:none]"
          style={{
            maxHeight: VISIBLE_THREADS * SLOT_HEIGHT + 4,
            maskImage: moreBelow ? "linear-gradient(to bottom, black calc(100% - 18px), transparent)" : undefined,
          }}
          onScroll={(event) => {
            const list = event.currentTarget;
            setScrolledToEnd(list.scrollTop + list.clientHeight >= list.scrollHeight - 2);
          }}
        >
          {threads.slots.map(({ key, item: thread, order, leaving }) => (
            <div key={key} className={`${slot} justify-end ${leaving ? closing : "h-[42px]"}`} style={{ order }}>
              <button
                type="button"
                className={`${button} ${pressable} ${sameThread(state.panel, thread) ? "bg-t3-accent ring-1 ring-t3-fg/30" : ""}`}
                title={threadTooltip(thread)}
                onClick={() => window.overlay.open(sameThread(state.panel, thread) ? null : thread)}
                onContextMenu={() => window.overlay.threadMenu(thread)}
              >
                <ProjectGlyph icon={thread.icon} size={26} />
                <StateBadge key={thread.state} state={thread.state} unread={state.unread.some((ref) => sameThread(ref, thread))} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
