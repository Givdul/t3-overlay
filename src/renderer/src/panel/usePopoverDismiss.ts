import { useEffect, useRef, type RefObject } from "react";

/**
 * Closes an open list on Escape or on a press outside `anchor`. Escape is taken in the capture phase, so
 * the overlay's own Escape handler never sees it and the panel stays open behind the list.
 */
export function usePopoverDismiss(open: boolean, close: () => void): RefObject<HTMLDivElement | null> {
  const anchor = useRef<HTMLDivElement>(null);
  const dismiss = useRef(close);
  dismiss.current = close;

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      event.stopPropagation();
      dismiss.current();
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && anchor.current?.contains(event.target) === true) return;
      dismiss.current();
    };

    document.addEventListener("pointerdown", onPointerDown, true);

    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  return anchor;
}
