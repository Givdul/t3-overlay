import { Check, CircleDashed, X, createLucideIcon } from "lucide-react";
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

// Lucide only has these glyphs inside a shape, which would draw a second ring in the badge.
const QuestionMark = createLucideIcon("question-mark", [
  ["path", { d: "M7.64 7.5a4.5 4.5 0 0 1 8.74 1.5c0 3-4.5 4.5-4.5 4.5", key: "stem" }],
  ["path", { d: "M12 19.5h.01", key: "dot" }],
]);

const ExclamationPoint = createLucideIcon("exclamation-point", [
  ["path", { d: "M12 4.5v9", key: "stem" }],
  ["path", { d: "M12 19.5h.01", key: "dot" }],
]);

/** The states that ask for the user. Each badge draws in its `color` through currentColor. */
const ATTENTION_BADGES = {
  approval: { color: "text-amber-300", title: "Pending approval", Icon: ExclamationPoint },
  input: { color: "text-indigo-300", title: "Awaiting input", Icon: QuestionMark },
  completed: { color: "text-emerald-400", title: undefined, Icon: Check },
  failed: { color: "text-red-400", title: undefined, Icon: X },
} as const;

/** An unread badge is filled and blinks a few times as it arrives; once opened it is an outline. */
export function StateBadge({ state, unread }: { state: SidebarThread["state"]; unread: boolean }) {
  const ring = "absolute -right-1 -bottom-1 flex size-[15px] items-center justify-center rounded-full ring-2 ring-t3-sidebar";

  if (state === "idle") return null;

  if (state === "working") {
    return (
      <span className={`${ring} bg-t3-sidebar`}>
        <CircleDashed size={12} className="text-t3-info" />
      </span>
    );
  }

  const { color, title, Icon } = ATTENTION_BADGES[state];
  const popIn = "transition-[opacity,scale,background-color] duration-250 ease-out starting:opacity-0 motion-safe:starting:scale-60";
  const look = unread ? "unread-blink bg-current" : "border-[1.5px] border-current bg-t3-sidebar";

  return (
    <span className={`${ring} ${popIn} ${color} ${look}`} title={title}>
      <Icon size={unread ? 10 : 9} strokeWidth={3.5} className={unread ? "text-black/80" : undefined} />
    </span>
  );
}

export function threadTooltip(thread: SidebarThread): string {
  const where = [thread.projectName, thread.environmentLabel].filter(Boolean).join(" · ");
  return where ? `${thread.title}\n${where}` : thread.title;
}
