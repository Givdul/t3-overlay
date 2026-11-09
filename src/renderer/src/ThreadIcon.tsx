import { Check, CircleDashed, X } from "lucide-react";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { PROJECT_COLORS } from "../../shared/projectIcon";
import type { ProjectIcon, SidebarThread } from "../../shared/types";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Draws a project icon as T3 does (apps/web/src/components/ProjectFavicon.tsx), `size` pixels square. */
export function ProjectGlyph({ icon, size }: { icon: ProjectIcon; size: number }) {
  const box = { width: size, height: size };
  const color = "color" in icon && icon.color ? (PROJECT_COLORS[icon.color] ?? icon.color) : "var(--t3-muted-foreground)";
  switch (icon.kind) {
    case "image":
      return <img src={icon.url} alt="" className="shrink-0 rounded-[25%] object-cover" style={box} />;
    case "monogram":
      return (
        <svg
          viewBox="0 0 16 16"
          className="shrink-0 rounded-[25%] font-mono select-none"
          style={{ ...box, color, backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}
        >
          <text
            x="8"
            y="10.8"
            textAnchor="middle"
            fill="currentColor"
            fontSize="8.25"
            fontWeight="700"
            textLength={Array.from(graphemes.segment(icon.text)).length === 1 ? 6 : 12}
            lengthAdjust="spacingAndGlyphs"
            textRendering="geometricPrecision"
          >
            {icon.text}
          </text>
        </svg>
      );
    case "emoji":
      return (
        <span className="flex shrink-0 items-center justify-center leading-none" style={{ ...box, fontSize: size * 0.8 }}>
          {icon.emoji}
        </span>
      );
    case "lucide":
      return <DynamicIcon name={icon.name as IconName} size={size} color={color} className="shrink-0" />;
  }
}

export function StateBadge({ state }: { state: SidebarThread["state"] }) {
  const ring = "absolute -right-1 -bottom-1 flex size-[15px] items-center justify-center rounded-full ring-2 ring-t3-sidebar";
  switch (state) {
    case "working":
      return (
        <span className={`${ring} bg-t3-sidebar`}>
          <CircleDashed size={12} className="text-t3-info" />
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
