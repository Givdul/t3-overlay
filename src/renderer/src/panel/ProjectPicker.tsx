import { Check, ChevronUp, CircleDashed } from "lucide-react";
import { useState } from "react";
import type { PanelProject } from "../../../shared/panel";
import { ProjectGlyph } from "../ThreadIcon";
import { usePopoverDismiss } from "./usePopoverDismiss";

// The draft composer's project control, in the status row where an open thread's project and machine
// show: the project T3 will start the new thread in, and the projects its shell knows. T3's own draft
// leads with the same choice above its composer (apps/web/src/components/chat/DraftHeroHeadline.tsx).

interface ProjectPickerProps {
  projects: PanelProject[];
  /** Null while the server's answer is on its way. */
  current: PanelProject | null;
  onSelect(project: PanelProject): void;
}

export function ProjectPicker({ projects, current, onSelect }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const anchor = usePopoverDismiss(open, () => setOpen(false));

  return (
    <div ref={anchor} className="relative flex min-w-0">
      <button
        type="button"
        title={current === null ? "Choose a project" : `New thread in ${projectName(current)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 min-w-0 items-center gap-1 rounded-full px-1.5 text-[11px] transition-colors hover:bg-t3-accent"
      >
        <ProjectMark project={current} size={13} />
        <span className="min-w-0 truncate text-t3-fg">{current === null ? "Choose a project" : projectName(current)}</span>
        <ChevronUp size={11} className="shrink-0 text-t3-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Project"
          className="absolute bottom-full left-0 z-20 mb-1 w-[230px] overflow-hidden rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] shadow-xl shadow-black/40"
        >
          <div className="panel-scroll max-h-[min(16rem,55vh)] overflow-y-auto p-1">
            {projects.map((project) => {
              const selected = project.projectId === current?.projectId;

              return (
                <button
                  key={project.projectId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelect(project);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-t3-fg transition-colors hover:bg-t3-accent"
                >
                  <ProjectMark project={project} size={16} />
                  <span className="min-w-0 flex-1 truncate">{projectName(project)}</span>
                  {selected && <Check size={13} className="shrink-0 text-t3-fg" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** T3's scratch workspace is the picker's "No project"; it has no project glyph to draw. */
function projectName(project: PanelProject): string {
  return project.scratch ? "No project" : project.title;
}

function ProjectMark({ project, size }: { project: PanelProject | null; size: number }) {
  if (project === null || project.scratch) return <CircleDashed size={size} className="shrink-0 text-t3-muted" />;

  return <ProjectGlyph icon={project.icon} size={size} />;
}
