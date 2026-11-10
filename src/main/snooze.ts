// T3's default snooze presets and their menu labels, as its sidebar shows them
// (apps/web/src/components/Sidebar.logic.ts). A preset whose time has passed is left out.

export interface SnoozeChoice {
  /** "Tomorrow (9:00 AM)" */
  label: string;
  until: Date;
}

const formatTime = (date: Date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const formatDayAndTime = (date: Date) => `${date.toLocaleDateString(undefined, { weekday: "short" })} ${formatTime(date)}`;

function inMinutes(name: string, minutes: number, now: Date): SnoozeChoice {
  const until = new Date(now.getTime() + minutes * 60_000);
  until.setSeconds(0, 0);
  const when = until.toDateString() === now.toDateString() ? formatTime(until) : formatDayAndTime(until);

  return { label: `${name} (${when})`, until };
}

/** `days` from today at `hour`:00, or null once that has passed. */
function atHour(name: string, days: number, hour: number, now: Date, showDay = false): SnoozeChoice | null {
  const until = new Date(now);
  until.setDate(until.getDate() + days);
  until.setHours(hour, 0, 0, 0);

  if (until <= now) return null;

  return { label: `${name} (${showDay ? formatDayAndTime(until) : formatTime(until)})`, until };
}

/** The presets still ahead of `now`, soonest first, one per minute. */
export function snoozeChoices(now: Date): SnoozeChoice[] {
  const daysToMonday = (8 - now.getDay()) % 7 || 7;

  const choices = [
    inMinutes("In 1 hour", 60, now),
    inMinutes("In 3 hours", 180, now),
    atHour("This evening", 0, 18, now),
    atHour("Tomorrow", 1, 9, now),
    atHour("Next week", daysToMonday, 9, now, true),
  ]
    .filter((choice) => choice !== null)
    .sort((a, b) => a.until.getTime() - b.until.getTime());

  return choices.filter((choice, index) => choices.findIndex((other) => other.until.getTime() === choice.until.getTime()) === index);
}
