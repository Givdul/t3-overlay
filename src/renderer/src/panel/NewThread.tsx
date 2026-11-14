import { GitBranch, Laptop, Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  RUNTIME_MODE_LABELS,
  type ComposeBranch,
  type ComposeBranches,
  type ComposeContext,
  type ComposeOption,
  type ComposeProvider,
  type EnvMode,
  type ModelChoice,
  type RuntimeMode,
} from "../../../shared/compose";
import type { OverlayState } from "../../../shared/types";
import { Composer, type ComposerHandle } from "./Composer";
import { History, TitleRow } from "./Frame";
import { Picker, type PickerItem } from "./Picker";

// The new-thread composer: T3's own choices for a first message, laid out as its composer and branch
// toolbar are, condensed. Defaults come from the project's settings on that machine, as in T3, and the
// last new thread's machine, project and model. Main starts the thread and opens the panel on it.

/** The choices for the thread, reset from the project's defaults whenever the project changes. */
interface Choice {
  model: ModelChoice | null;
  runtimeMode: RuntimeMode;
  envMode: EnvMode;
  startFromOrigin: boolean;
  /** Null until the project's branches load; stays null outside a git repository. */
  branch: ComposeBranch | null;
}

type Loaded = { status: "loading" } | { status: "ready"; context: ComposeContext } | { status: "failed"; error: string };

/** An on/off chip, such as a model's fast mode: muted while off, filled while on. */
const toggle = "flex h-7 shrink-0 items-center rounded-full px-2 text-[12px] text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg";
const toggleOn = "bg-t3-accent text-t3-fg";

export function NewThread({ state }: { state: OverlayState }) {
  const connected = state.machines.filter((machine) => machine.status === "connected");
  const [picked, setPicked] = useState<string | null>(state.lastLaunch?.environmentId ?? null);
  // A machine that went away falls back to this PC, then to any connected one.
  const environmentId =
    connected.find((machine) => machine.environmentId === picked)?.environmentId ??
    connected.find((machine) => machine.local)?.environmentId ??
    connected[0]?.environmentId ??
    null;

  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [baseline, setBaseline] = useState<ComposeBranches | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [branches, setBranches] = useState<ComposeBranch[]>([]);
  const composer = useRef<ComposerHandle | null>(null);

  // Each machine's providers and project defaults are read when the composer opens on it.
  useEffect(() => {
    setLoaded({ status: "loading" });
    setProjectId(null);
    setChoice(null);

    if (environmentId === null) return;

    let current = true;
    window.overlay.composeContext(environmentId).then(
      (context) => {
        if (!current) return;

        const last = state.lastLaunch;
        const start = context.projects.find((project) => last?.environmentId === environmentId && project.id === last.projectId) ?? context.projects[0];

        setLoaded({ status: "ready", context });
        setProjectId(start?.id ?? null);
      },
      (error: unknown) => current && setLoaded({ status: "failed", error: error instanceof Error ? error.message : String(error) }),
    );

    return () => {
      current = false;
    };
    // Read again only for another machine; the last launch is read once, as the starting point.
  }, [environmentId]);

  const context = loaded.status === "ready" ? loaded.context : null;
  const project = context?.projects.find((candidate) => candidate.id === projectId) ?? null;

  // A project's defaults replace every choice, as a fresh draft in T3 starts from them.
  useEffect(() => {
    setBaseline(null);
    setBranches([]);
    setChoice(project === null ? null : { ...project.defaults, branch: null });

    if (environmentId === null || project === null) return;

    let current = true;
    window.overlay.composeBranches(environmentId, project.id, "").then(
      (found) => {
        if (!current) return;

        setBaseline(found);
        setBranches(found.branches);
        setChoice((choice) => (choice === null ? null : withDefaultBranch(choice, found)));
      },
      () => current && setBaseline({ isRepo: false, branches: [] }),
    );

    return () => {
      current = false;
    };
  }, [environmentId, project]);

  // The branch picker searches T3's refs as it is typed into, as T3's own branch picker does.
  useEffect(() => {
    if (environmentId === null || project === null || branchQuery === "") {
      if (baseline !== null) setBranches(baseline.branches);

      return;
    }

    let current = true;
    const timer = setTimeout(() => {
      window.overlay.composeBranches(environmentId, project.id, branchQuery).then(
        (found) => current && setBranches(found.branches),
        () => undefined,
      );
    }, 150);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [environmentId, project, branchQuery, baseline]);

  useEffect(() => window.overlay.onFocusComposer(() => composer.current?.focus()), []);

  // The composer opens ready to type.
  useEffect(() => {
    if (choice !== null) composer.current?.focus();
  }, [choice !== null]);

  const providers = context?.providers ?? [];
  const provider = providers.find((candidate) => candidate.instanceId === choice?.model?.instanceId) ?? null;
  const model = provider?.models.find((candidate) => candidate.slug === choice?.model?.model) ?? null;
  const isRepo = baseline?.isRepo !== false;
  const machineLabel = connected.find((machine) => machine.environmentId === environmentId)?.label ?? "";

  const ready =
    choice !== null && choice.model !== null && project !== null && (choice.envMode === "local" || choice.branch !== null || !isRepo);

  const update = (patch: Partial<Choice>) => setChoice((current) => (current === null ? null : { ...current, ...patch }));

  const hint =
    environmentId === null
      ? "No machine is connected. Start T3 Code, or pair a machine from the tray."
      : loaded.status === "failed"
        ? loaded.error
        : loaded.status === "loading"
          ? "Reading the machine's projects and models…"
          : project === null
            ? `${machineLabel} has no projects. Add one in T3 Code first.`
            : providers.length === 0
              ? `${machineLabel} has no provider ready to start a turn.`
              : `A new thread on ${machineLabel}, in ${project.title}.`;

  return (
    <>
      <TitleRow title="New thread" target={null} machine={null} />

      <History side={state.side} titleInCard={false} open>
        <p className="py-2 text-center text-[11px] text-t3-muted">{hint}</p>
      </History>

      <div className="flex shrink-0 flex-col pb-4">
        <Composer
          side={state.side}
          running={null}
          title={null}
          folded={false}
          placeholder="Ask anything, @ for files, / for commands"
          header={
            <div className="-ml-2 flex min-w-0 items-center gap-0.5">
              <Picker
                title="Machine"
                label={
                  <span className="flex items-center gap-1">
                    <Monitor size={12} />
                    {machineLabel || "No machine"}
                  </span>
                }
                items={connected.map((machine) => ({ key: machine.environmentId, label: machine.label, detail: machine.local ? "This PC" : undefined, selected: machine.environmentId === environmentId }))}
                onPick={setPicked}
              />
              <Picker
                title="Project"
                label={project?.title ?? "No project"}
                items={(context?.projects ?? []).map((candidate) => ({ key: candidate.id, label: candidate.title, selected: candidate.id === projectId }))}
                onPick={setProjectId}
                empty="No projects on this machine"
              />
            </div>
          }
          toolbar={
            choice !== null && (
              <>
                <Picker
                  title="Model"
                  label={model?.name ?? "No model"}
                  items={modelItems(providers, choice.model)}
                  onPick={(key) => {
                    const [instanceId = "", slug = ""] = key.split("\n");
                    const next = providers.find((candidate) => candidate.instanceId === instanceId);

                    update({
                      model: { instanceId, model: slug, options: [] },
                      // A mode the new provider does not run in falls back to the last mode it lists.
                      runtimeMode: next?.runtimeModes.includes(choice.runtimeMode) === false ? (next.runtimeModes.at(-1) ?? choice.runtimeMode) : choice.runtimeMode,
                    });
                  }}
                />
                {model?.options.map((option) => (
                  <OptionChip key={option.id} option={option} choice={choice.model} onChange={(model) => update({ model })} />
                ))}
                <Picker
                  title="Permissions"
                  label={RUNTIME_MODE_LABELS[choice.runtimeMode]}
                  items={(provider?.runtimeModes ?? []).map((mode) => ({ key: mode, label: RUNTIME_MODE_LABELS[mode], selected: mode === choice.runtimeMode }))}
                  onPick={(key) => update({ runtimeMode: key as RuntimeMode })}
                  align="end"
                />
              </>
            )
          }
          footer={
            choice !== null && isRepo ? (
              <>
                <Picker
                  title="Where the thread works"
                  label={
                    <span className="flex items-center gap-1">
                      <Laptop size={12} />
                      {choice.envMode === "worktree" ? "New worktree" : "Local"}
                    </span>
                  }
                  items={[
                    { key: "local", label: "Local", detail: "In the project's checkout", selected: choice.envMode === "local" },
                    { key: "worktree", label: "New worktree", detail: "On a new branch", selected: choice.envMode === "worktree" },
                  ]}
                  onPick={(key) => setChoice((current) => (current === null || baseline === null ? current : withDefaultBranch({ ...current, envMode: key as EnvMode, branch: null }, baseline)))}
                />
                <Picker
                  title={choice.envMode === "worktree" ? "Base branch" : "Branch"}
                  label={
                    <span className="flex items-center gap-1">
                      <GitBranch size={12} />
                      {choice.branch === null ? "Loading branches…" : `${choice.envMode === "worktree" ? "from " : ""}${choice.branch.name}`}
                    </span>
                  }
                  items={branches.map((branch) => branchItem(branch, choice))}
                  onPick={(key) => update({ branch: branches.find((branch) => branch.name === key) ?? choice.branch })}
                  search={{ placeholder: "Search branches", onQuery: setBranchQuery }}
                  empty="No branch matches"
                />
                {choice.envMode === "worktree" && (
                  <button
                    type="button"
                    aria-pressed={choice.startFromOrigin}
                    title="Fetch the base branch from origin first, so the worktree starts from its latest commit"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => update({ startFromOrigin: !choice.startFromOrigin })}
                    className={`${toggle} ${choice.startFromOrigin ? toggleOn : ""}`}
                  >
                    From origin
                  </button>
                )}
              </>
            ) : undefined
          }
          files={
            environmentId === null || project === null
              ? null
              : {
                  kind: "project",
                  environmentId,
                  projectId: project.id,
                  worktreePath: choice?.envMode === "local" ? (choice.branch?.worktreePath ?? null) : null,
                }
          }
          commands={provider?.commands ?? []}
          allowClear={false}
          ready={ready}
          onSubmit={async (message) => {
            if (environmentId === null || project === null || choice === null || choice.model === null) return { ok: false, error: "Pick a project and a model first" };

            return window.overlay.launch({
              environmentId,
              projectId: project.id,
              text: message.text,
              attachments: message.attachments,
              model: choice.model,
              runtimeMode: choice.runtimeMode,
              envMode: isRepo ? choice.envMode : "local",
              branch: isRepo ? choice.branch : null,
              startFromOrigin: choice.startFromOrigin,
            });
          }}
          onTextChange={() => undefined}
          onFocusChange={() => undefined}
          onBusyChange={() => undefined}
          onUnfold={() => undefined}
          onSent={() => window.overlay.sent()}
          handle={composer}
        />
      </div>
    </>
  );
}

/** T3's default branch for a mode: a worktree starts from the default branch, a local thread runs on the current one. */
function withDefaultBranch(choice: Choice, refs: ComposeBranches): Choice {
  if (!refs.isRepo) return { ...choice, envMode: "local", branch: null };

  const local = refs.branches.filter((branch) => !branch.isRemote);
  const current = local.find((branch) => branch.current) ?? null;
  const fallback = choice.envMode === "worktree" ? (local.find((branch) => branch.isDefault) ?? current) : current;

  return { ...choice, branch: fallback ?? local[0] ?? refs.branches[0] ?? null };
}

function branchItem(branch: ComposeBranch, choice: Choice): PickerItem {
  const detail = branch.current ? "current" : branch.isDefault ? "default" : branch.worktreePath !== null ? "worktree" : branch.isRemote ? "remote" : undefined;

  return { key: branch.name, label: branch.name, detail, selected: branch.name === choice.branch?.name };
}

function modelItems(providers: ComposeProvider[], selected: ModelChoice | null): PickerItem[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: `${provider.instanceId}\n${model.slug}`,
      label: model.name,
      group: provider.name,
      selected: provider.instanceId === selected?.instanceId && model.slug === selected.model,
    })),
  );
}

/** One model option: a select is a picker, a boolean a toggle chip. Unset options show the model's default. */
function OptionChip({ option, choice, onChange }: { option: ComposeOption; choice: ModelChoice | null; onChange(model: ModelChoice): void }) {
  if (choice === null) return null;

  const set = choice.options.find((entry) => entry.id === option.id)?.value;

  const write = (value: string | boolean) =>
    onChange({ ...choice, options: [...choice.options.filter((entry) => entry.id !== option.id), { id: option.id, value }] });

  if (option.type === "boolean") {
    const on = typeof set === "boolean" ? set : option.defaultValue;

    return (
      <button
        type="button"
        aria-pressed={on}
        title={option.label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => write(!on)}
        className={`${toggle} ${on ? toggleOn : ""}`}
      >
        {option.label}
      </button>
    );
  }

  const value = typeof set === "string" ? set : option.defaultValue;

  return (
    <Picker
      title={option.label}
      label={option.choices.find((candidate) => candidate.id === value)?.label ?? option.label}
      items={option.choices.map((candidate) => ({ key: candidate.id, label: candidate.label, selected: candidate.id === value }))}
      onPick={write}
    />
  );
}
