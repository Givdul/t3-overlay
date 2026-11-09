import type { ProjectIcon } from "./types";

// T3's project icon palette (apps/web/src/components/ProjectMonogram.tsx), dark-theme shades.
// The order matters: generated icons pick a color by hashing the project name into this list.
export const PROJECT_COLORS: Record<string, string> = {
  gray: "#a1a1aa",
  red: "#f87171",
  orange: "#fb923c",
  amber: "#fbbf24",
  yellow: "#facc15",
  lime: "#a3e635",
  green: "#4ade80",
  emerald: "#34d399",
  teal: "#2dd4bf",
  cyan: "#22d3ee",
  sky: "#38bdf8",
  blue: "#60a5fa",
  indigo: "#818cf8",
  violet: "#a78bfa",
  purple: "#c084fc",
  fuchsia: "#e879f9",
  pink: "#f472b6",
  rose: "#fb7185",
};

/** The monogram T3 shows for a project with no icon set and no favicon. */
export function generatedIcon(projectName: string): ProjectIcon {
  const name = projectName.normalize("NFKC").trim();
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const colors = Object.keys(PROJECT_COLORS);
  let hash = 0;
  for (const char of name.toLocaleLowerCase("en-US") || "project") hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % colors.length;
  return { kind: "monogram", text: monogram(words), color: colors[hash] ?? "blue" };
}

function monogram(words: string[]): string {
  const first = words[0];
  if (!first) return "PR";
  const chars = Array.from(first);
  const lead = chars[0] ?? "P";
  const second =
    chars.slice(1).find((char) => /\p{N}/u.test(char)) ?? (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : chars.at(-1)) ?? lead;
  return Array.from(`${lead}${second}`.toUpperCase()).slice(0, 2).join("");
}
