import { useEffect, useState } from "react";

// The ticking clock T3 puts beside a Stop and the timeline's running work. It lives in a hook because
// the interval is the one thing here that belongs to the browser, not to a component's render.

/**
 * A duration that counts up from `at`, in T3's wording (packages/shared/src/orchestrationTiming.ts,
 * formatDuration). Null when the start time is missing, so the caller draws nothing.
 */
export function useElapsed(at: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  const since = at === null ? Number.NaN : Date.parse(at);
  const ticking = !Number.isNaN(since);

  useEffect(() => {
    if (!ticking) return;

    const timer = window.setInterval(() => setNow(Date.now()), 1_000);

    return () => window.clearInterval(timer);
  }, [ticking]);

  if (!ticking) return null;

  return formatDuration(Math.max(1_000, now - since));
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";

  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;

  if (durationMs < 10_000) return `${Math.round(durationMs / 100) / 10}s`;

  const totalSeconds = Math.round(durationMs / 1_000);

  // Choose the unit after rounding so 59.5 seconds never renders as "60s".
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);

  if (minutes > 0) parts.push(`${minutes}m`);

  if (seconds > 0 || minutes > 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}
