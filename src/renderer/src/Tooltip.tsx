import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { PANEL_GAP, SIDEBAR_WIDTH, type OverlayState } from "../../shared/types";

export interface TooltipContent {
  title: string;
  detail?: string;
  /** Colored lines under the detail, such as a thread's state or the overlay's warnings. */
  notes?: { text: string; color: string }[];
}

const OPEN_DELAY_MS = 300;

/** Moving to another icon within this long after a tooltip closed shows the next one at once, without an entrance. */
const SKIP_DELAY_MS = 400;

/** Matches the card's exit duration-100. */
const EXIT_MS = 100;

interface Shown {
  id: string;
  centerY: number;
  open: boolean;
  entrance: boolean;
}

/** Hover state for the sidebar's tooltips. Spread `anchor(id)` on each button that has one. */
export function useTooltip() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closedAt = useRef(-Infinity);

  useEffect(() => () => clearTimeout(timer.current), []);

  const show = (id: string, anchor: HTMLElement, entrance: boolean) => {
    const { top, height } = anchor.getBoundingClientRect();
    setShown({ id, centerY: top + height / 2, open: true, entrance });
  };

  const enter = (id: string, anchor: HTMLElement) => {
    clearTimeout(timer.current);

    if (shown !== null || performance.now() - closedAt.current < SKIP_DELAY_MS) {
      show(id, anchor, false);

      return;
    }

    timer.current = setTimeout(() => show(id, anchor, true), OPEN_DELAY_MS);
  };

  const close = () => {
    if (shown === null) {
      clearTimeout(timer.current);

      return;
    }

    if (!shown.open) return;

    clearTimeout(timer.current);
    closedAt.current = performance.now();
    setShown({ ...shown, open: false });
    timer.current = setTimeout(() => setShown(null), EXIT_MS);
  };

  const anchor = (id: string) => ({
    onPointerEnter: (event: PointerEvent<HTMLElement>) => enter(id, event.currentTarget),
    onPointerLeave: close,
    // Pressing a button acts on it, so its label has done its job.
    onPointerDown: close,
  });

  return { shown, anchor };
}

const MOTION = {
  left: { origin: "origin-left", enter: "motion-safe:starting:-translate-x-2", exit: "motion-safe:-translate-x-1" },
  right: { origin: "origin-right", enter: "motion-safe:starting:translate-x-2", exit: "motion-safe:translate-x-1" },
} as const;

/** Sits beside the sidebar, on the chat's side, centered on its icon and kept inside the window. */
export function Tooltip({ side, shown, content }: { side: OverlayState["side"]; shown: Shown; content: TooltipContent }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // The outer box is never transformed, so its rect is the card's resting size, which the window's shape needs.
  useLayoutEffect(() => {
    const element = ref.current;

    if (!element) return;

    const { width, height } = element.getBoundingClientRect();
    setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
  });

  const top = Math.max(0, Math.min(shown.centerY - size.height / 2, window.innerHeight - size.height));

  useLayoutEffect(() => {
    // Before the first measurement lands.
    if (size.width === 0) return;

    const pixelTop = Math.floor(top);
    window.overlay.setExtent({
      tooltip: { top: pixelTop, width: Math.ceil(size.width), height: Math.ceil(top + size.height) - pixelTop },
    });
  }, [top, size]);

  useEffect(() => () => window.overlay.setExtent({ tooltip: null }), []);

  const motion = MOTION[side];

  const state = shown.open
    ? `duration-160 ${shown.entrance ? `starting:opacity-0 motion-safe:starting:scale-90 ${motion.enter}` : ""}`
    : `duration-100 opacity-0 motion-safe:scale-96 ${motion.exit}`;

  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none absolute z-20 w-max max-w-60"
      style={{ top, ...(side === "left" ? { left: SIDEBAR_WIDTH + PANEL_GAP } : { right: SIDEBAR_WIDTH + PANEL_GAP }) }}
    >
      <div
        className={`rounded-lg border border-t3-border bg-t3-popover px-2.5 py-1.5 shadow-lg shadow-black/40 transition-[opacity,translate,scale] ease-out ${motion.origin} ${state}`}
      >
        <div className="line-clamp-2 text-xs font-medium text-t3-fg">{content.title}</div>
        {content.detail && <div className="truncate text-[11px] text-t3-muted">{content.detail}</div>}
        {content.notes?.map(({ text, color }) => (
          <div key={text} className={`text-[11px] ${color}`}>
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}
