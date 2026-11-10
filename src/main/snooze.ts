// T3's default snooze presets and their menu labels, as its sidebar shows them
// (apps/web/src/components/Sidebar.logic.ts). A preset whose time has passed is left out.

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

type SnoozePreset = { kind: "after"; minutes: number } | { kind: "at"; day: "today" | "tomorrow" | Weekday; time: string };

const PRESETS: SnoozePreset[] = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

const WEEKDAYS: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface SnoozeChoice {
  /** "Tomorrow (9:00 AM)" */
  label: string;
  until: Date;
}

const formatTime = (date: Date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const count = (amount: number, unit: string) => `${amount} ${unit}${amount === 1 ? "" : "s"}`;

function duration(minutes: number): string {
  if (minutes % 1440 === 0) return count(minutes / 1440, "day");

  return minutes % 60 === 0 ? count(minutes / 60, "hour") : count(minutes, "minute");
}

function daysAhead(day: "today" | "tomorrow" | Weekday, now: Date): number {
  if (day === "today") return 0;

  if (day === "tomorrow") return 1;

  return (WEEKDAYS.indexOf(day) - now.getDay() + 7) % 7 || 7;
}

function presetName(preset: SnoozePreset, days: number): string {
  if (preset.kind === "after") return `In ${duration(preset.minutes)}`;

  if (days === 0) {
    const hour = Number(preset.time.slice(0, 2));

    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }

  if (days === 1) return "Tomorrow";

  if (preset.day === "monday") return "Next week";

  return days === 7 ? `Next ${capitalize(preset.day)}` : capitalize(preset.day);
}

function choiceFor(preset: SnoozePreset, now: Date): SnoozeChoice | null {
  const until = new Date(now);
  let days = 0;

  if (preset.kind === "after") {
    until.setTime(now.getTime() + preset.minutes * 60_000);
    until.setSeconds(0, 0);
  } else {
    days = daysAhead(preset.day, now);
    until.setDate(until.getDate() + days);
    until.setHours(Number(preset.time.slice(0, 2)), Number(preset.time.slice(3)), 0, 0);

    if (until <= now) return null;
  }

  const name = presetName(preset, days);
  const timeOnly = (preset.kind === "at" && name !== "Next week") || until.toDateString() === now.toDateString();
  const when = timeOnly ? formatTime(until) : `${until.toLocaleDateString(undefined, { weekday: "short" })} ${formatTime(until)}`;

  return { label: `${name} (${when})`, until };
}

/** The presets still ahead of `now`, soonest first, one per minute. */
export function snoozeChoices(now: Date): SnoozeChoice[] {
  const minute = (choice: SnoozeChoice) => Math.floor(choice.until.getTime() / 60_000);
  const choices = PRESETS.flatMap((preset) => choiceFor(preset, now) ?? []).sort((a, b) => minute(a) - minute(b));

  return choices.filter((choice, index) => choices.findIndex((other) => minute(other) === minute(choice)) === index);
}
