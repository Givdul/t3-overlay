import type { DraftProject } from "../../../shared/panel";
import { ProjectGlyph } from "../ThreadIcon";

// The `+` panel's body: one row per local project. A worktree-default project cannot start a thread
// from here (a worktree needs a base ref), so it says so instead of launching.

export function DraftProjects({
  projects,
  selected,
  onSelect,
}: {
  projects: DraftProject[];
  selected: string | null;
  onSelect: (projectId: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="px-1 pb-1 text-[11px] text-t3-muted">Start a thread in</p>
      {projects.length === 0 && <p className="px-1 py-1 text-[12px] text-t3-muted">No projects yet. Add one in T3 Code.</p>}
      {projects.map((project) => {
        const active = project.projectId === selected;

        return (
          <button
            key={project.projectId}
            type="button"
            disabled={project.worktree}
            onClick={() => onSelect(project.projectId)}
            title={project.worktree ? "Starts threads in worktrees; open T3 to start one" : project.workspaceRoot}
            className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
              active ? "bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_9%,transparent)]" : "hover:bg-t3-accent"
            } ${project.worktree ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <ProjectGlyph icon={project.icon} size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-t3-fg">{project.title}</span>
            {project.worktree && <span className="shrink-0 text-[11px] text-t3-muted">worktrees</span>}
          </button>
        );
      })}
    </div>
  );
}
