import { useEffect, useState, type RefObject } from "react";
import type {
  PanelAttachment,
  PanelCreateReply,
  PanelDraft,
  PanelModelOption,
  PanelModelSelection,
  PanelProject,
  PanelReply,
} from "../../../shared/panel";

// The new-thread draft: the projects T3's shell knows, and the picks the composer makes before a thread
// exists. Main creates the thread and opens the panel on it; this holds only the draft, so closing the
// panel abandons it without anything reaching T3.

export interface NewThreadDraft {
  /** Null until the server's answer arrives. */
  info: PanelDraft | null;
  error: string | null;
  project: PanelProject | null;
  model: PanelModelSelection | null;
  /** The permission mode the new thread starts in; the project's own default until the draft picks one. */
  runtimeMode: string | null;
  /** "default", or "plan" while the draft's plan toggle is on. */
  interactionMode: string;
  selectProject(project: PanelProject): void;
  selectModel(model: PanelModelSelection): void;
  /** Keeps the model's options, e.g. a reasoning effort, for the thread the draft creates. */
  selectModelOptions(options: PanelModelOption[]): void;
  selectRuntimeMode(mode: string): void;
  setPlanMode(plan: boolean): void;
  /** Creates the thread with its first turn, through main. */
  create(text: string, attachments: PanelAttachment[]): Promise<PanelCreateReply | PanelReply>;
  retry(): void;
}

/** Puts the caret in the draft's composer as soon as T3's answer has drawn it. */
export function useDraftFocus(ready: boolean, handle: RefObject<{ focus(): void } | null>) {
  useEffect(() => {
    if (!ready) return;

    handle.current?.focus();
  }, [ready, handle]);
}

export function useNewThreadDraft(active: boolean): NewThreadDraft {
  const [info, setInfo] = useState<PanelDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [picked, setPicked] = useState<PanelModelSelection | null>(null);
  const [pickedRuntimeMode, setPickedRuntimeMode] = useState<string | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A draft opened again starts from the newest thread's project, not the last draft's pick.
  useEffect(() => {
    if (!active) return;

    let live = true;
    setInfo(null);
    setError(null);
    setProjectId(null);
    setPicked(null);
    setPickedRuntimeMode(null);
    setPlanMode(false);

    void window.overlay.panel({ type: "draft" }).then((reply) => {
      if (!live) return;

      if (!reply.ok || !("draft" in reply)) {
        setError(reply.ok ? "T3 did not return the projects" : reply.error);

        return;
      }

      setInfo(reply.draft);
      setProjectId(reply.draft.defaultProjectId);
    });

    return () => {
      live = false;
    };
  }, [active, attempt]);

  const project = info?.projects.find((candidate) => candidate.projectId === projectId) ?? info?.projects[0] ?? null;

  // The project's own default leads, then T3's, as its web draft seeds a new thread's model
  // (apps/web/src/lib/seedDraftModelSelection.ts); a pick holds until another project is chosen.
  const model = picked ?? project?.defaultModelSelection ?? info?.defaultModelSelection ?? null;

  // The permission mode follows the project the same way, starting from its own default; plan mode is the
  // draft's toggle, and T3 starts a thread in default mode (providerPolicy.ts, DEFAULT_PROVIDER_INTERACTION_MODE).
  const runtimeMode = pickedRuntimeMode ?? project?.defaultRuntimeMode ?? info?.defaultRuntimeMode ?? null;
  const interactionMode = planMode ? "plan" : "default";

  async function create(text: string, attachments: PanelAttachment[]): Promise<PanelCreateReply | PanelReply> {
    if (project === null) return { ok: false, error: "T3 has no project to start a thread in" };

    if (model === null) return { ok: false, error: "T3 has no model to start a thread on" };

    if (runtimeMode === null) return { ok: false, error: "T3 has no permission mode to start a thread in" };

    return window.overlay.panel({
      type: "create",
      projectId: project.projectId,
      modelSelection: model,
      runtimeMode,
      interactionMode,
      text,
      attachments,
    });
  }

  return {
    info,
    error,
    project,
    model,
    runtimeMode,
    interactionMode,
    selectProject(next) {
      setProjectId(next.projectId);
      // The new project's own defaults apply until the user picks a model or a mode again.
      setPicked(null);
      setPickedRuntimeMode(null);
    },
    selectModel: setPicked,
    selectModelOptions(options) {
      if (model === null) return;

      setPicked({ ...model, options });
    },
    selectRuntimeMode: setPickedRuntimeMode,
    setPlanMode,
    create,
    retry() {
      setAttempt((value) => value + 1);
    },
  };
}
