import { useEffect, useState } from "react";

// T3 reports a force stop's outcome in a toast. The overlay has no toasts, so it holds the same words
// on a line of the timeline for a moment and then lets them go.

/** About as long as T3's toast stays readable. */
const NOTICE_MS = 8_000;

export interface StopNotice {
  notice: string | null;
  show(notice: string): void;
}

/** The last force stop's wording, cleared when the panel moves to another target. */
export function useStopNotice(targetKey: string): StopNotice {
  const [notice, setNotice] = useState<string | null>(null);

  // A new thread starts clean, like the panel's other per-target state.
  useEffect(() => {
    setNotice(null);
  }, [targetKey]);

  useEffect(() => {
    if (notice === null) return;

    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);

    return () => window.clearTimeout(timer);
  }, [notice]);

  return { notice, show: setNotice };
}
