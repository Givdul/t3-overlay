import { Check, Loader2, X } from "lucide-react";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import type { ProjectIcon, SidebarThread } from "../../shared/types";

const COLORS: Record<string, string> = {
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

export function ProjectGlyph({ icon, size = 18 }: { icon: ProjectIcon; size?: number }) {
  const color = icon.color ? (COLORS[icon.color] ?? icon.color) : "var(--t3-muted-foreground)";
  if (icon.url) return <img src={icon.url} alt="" className="rounded-[4px]" style={{ width: size, height: size }} />;
  if (icon.lucide) return <DynamicIcon name={icon.lucide as IconName} size={size} color={color} />;
  return (
    <span className="font-semibold" style={{ color, fontSize: size * 0.8, lineHeight: 1 }}>
      {icon.letter}
    </span>
  );
}

export function StateBadge({ state }: { state: SidebarThread["state"] }) {
  const ring = "absolute -right-1 -bottom-1 flex size-[15px] items-center justify-center rounded-full ring-2 ring-t3-sidebar";
  switch (state) {
    case "working":
      return (
        <span className={`${ring} bg-t3-sidebar`}>
          <Loader2 size={12} className="animate-spin text-sky-300" />
        </span>
      );
    case "approval":
      return <span className={`${ring} bg-amber-300`} title="Pending approval" />;
    case "input":
      return <span className={`${ring} bg-indigo-300`} title="Awaiting input" />;
    case "completed":
      return (
        <span className={`${ring} bg-emerald-400`}>
          <Check size={10} strokeWidth={3.5} className="text-black/80" />
        </span>
      );
    case "failed":
      return (
        <span className={`${ring} bg-red-400`}>
          <X size={10} strokeWidth={3.5} className="text-black/80" />
        </span>
      );
    default:
      return null;
  }
}

export function threadTooltip(thread: SidebarThread): string {
  const where = [thread.projectName, thread.environmentLabel].filter(Boolean).join(" · ");
  return where ? `${thread.title}\n${where}` : thread.title;
}
