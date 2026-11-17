import { Check, ChevronUp, Lock, LoaderCircle, PenLine, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import type { PanelManagedPolicy } from "../../../shared/panel";
import { usePopoverDismiss } from "./usePopoverDismiss";

// The composer's permission control: the thread's runtime mode with T3's own labels, and the modes its
// provider supports (apps/web/src/components/ComposerContextPermissions.tsx,
// apps/web/src/components/chat/runtimeModeConfig.ts). A pick dispatches `thread.runtime-mode.set`.

/** T3's labels, descriptions and icons for its runtime modes (providerPolicy.ts, RuntimeMode). */
export const RUNTIME_MODES = [
  { mode: "approval-required", label: "Supervised", description: "Ask before commands and file changes.", icon: Lock },
  { mode: "auto-accept-edits", label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions.", icon: PenLine },
  { mode: "auto", label: "Auto", description: "Supported providers approve routine actions; others still ask.", icon: ShieldCheck },
  { mode: "full-access", label: "Full access", description: "Allow commands and edits without prompts.", icon: ShieldOff },
] as const;

/** A mode's rank in T3's order, narrowest first; a policy's ceiling caps what a thread may run. */
function rank(mode: string): number {
  return RUNTIME_MODES.findIndex((option) => option.mode === mode);
}

/** T3's message for a mode an administrator's policy does not allow (managedPolicy.ts, managedRuntimeModeDenial). */
function policyDenial(policy: PanelManagedPolicy | null, mode: string): string | undefined {
  if (policy === null || policy.maxRuntimeMode === null) return undefined;

  if (rank(mode) <= rank(policy.maxRuntimeMode)) return undefined;

  const allowed = RUNTIME_MODES.find((option) => option.mode === policy.maxRuntimeMode);

  return `${policy.organization} limits threads to ${allowed?.label ?? policy.maxRuntimeMode}.`;
}

/** The modes a provider supports (all when it names none) and the one a thread really runs. */
export function compatibleRuntimeModes(runtimeMode: string, supported: string[]) {
  const all: string[] = RUNTIME_MODES.map((option) => option.mode);
  const modes = supported.length > 0 ? all.filter((mode) => supported.includes(mode)) : all;

  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}

interface RuntimeModePickerProps {
  /** The thread's permission mode, from its projection. */
  current: string;
  /** The modes the selected model's provider supports. */
  supported: string[];
  /** The administrator's cap on modes, when one applies. */
  policy: PanelManagedPolicy | null;
  /** The draft composer keeps its pick for the thread it creates; an open thread writes through main. */
  onPick?: (mode: string) => void;
}

export function RuntimeModePicker({ current, supported, policy, onPick }: RuntimeModePickerProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchor = usePopoverDismiss(open, () => setOpen(false));

  const { modes, mode } = compatibleRuntimeModes(current, supported);
  const choices = RUNTIME_MODES.filter((option) => modes.includes(option.mode));
  const shown = RUNTIME_MODES.find((option) => option.mode === mode) ?? RUNTIME_MODES[0];
  const Icon = shown.icon;
  // A thread already above a policy's ceiling is refused; the menu offers the broadest mode left.
  const ceiling = policy === null ? undefined : policyDenial(policy, mode);
  const fallback = ceiling === undefined ? undefined : [...modes].reverse().find((candidate) => policyDenial(policy, candidate) === undefined);
  const fallbackLabel = RUNTIME_MODES.find((option) => option.mode === fallback)?.label ?? fallback;

  async function pick(next: string) {
    if (saving !== null || next === mode) {
      setOpen(false);

      return;
    }

    if (onPick !== undefined) {
      onPick(next);
      setOpen(false);

      return;
    }

    setSaving(next);
    setError(null);

    const reply = await window.overlay.panel({ type: "setRuntimeMode", runtimeMode: next });

    setSaving(null);

    if (!reply.ok) {
      setError(reply.error);

      return;
    }

    setOpen(false);
  }

  return (
    <div ref={anchor} className="relative flex min-w-0">
      <button
        type="button"
        title={`Permissions: ${shown.label}`}
        aria-label={`Permissions: ${shown.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setError(null);
          setOpen((value) => !value);
        }}
        className="flex h-6 min-w-0 items-center gap-1 rounded-full px-1.5 text-[11px] text-t3-muted transition-colors hover:bg-t3-accent hover:text-t3-fg"
      >
        <Icon size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{shown.label}</span>
        <ChevronUp size={10} className="shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Permissions"
          className="absolute bottom-full right-0 z-20 mb-1 w-[248px] overflow-hidden rounded-xl border border-[var(--t3-border)] bg-[var(--t3-popover)] shadow-xl shadow-black/40"
        >
          <div className="p-1">
            <p className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-t3-muted uppercase">Permissions</p>
            {choices.map((option) => {
              const denial = policyDenial(policy, option.mode);
              const OptionIcon = option.icon;

              return (
                <button
                  key={option.mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.mode === mode}
                  disabled={denial !== undefined || saving !== null}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void pick(option.mode)}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-t3-accent disabled:pointer-events-none disabled:opacity-50"
                >
                  <OptionIcon size={13} className="mt-0.5 shrink-0 text-t3-muted" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[12px] text-t3-fg">{option.label}</span>
                    <span className="text-[11px] leading-snug text-t3-muted">{denial ?? option.description}</span>
                  </span>
                  {saving === option.mode ? (
                    <LoaderCircle size={12} className="mt-0.5 shrink-0 animate-spin text-t3-muted" />
                  ) : (
                    option.mode === mode && <Check size={13} className="mt-0.5 shrink-0 text-t3-fg" />
                  )}
                </button>
              );
            })}

            {/* T3 offers the broadest mode left when a thread already runs above the policy's ceiling. */}
            {ceiling !== undefined && fallback !== undefined && (
              <div className="mt-1 border-t border-[var(--t3-border)] px-2 pt-1.5 pb-1">
                <p className="text-[11px] leading-relaxed text-t3-muted">{ceiling}</p>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void pick(fallback)}
                  className="mt-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-t3-fg transition-colors hover:bg-t3-accent"
                >
                  Switch to {fallbackLabel}
                </button>
              </div>
            )}
          </div>
          {error !== null && (
            <p className="border-t border-[var(--t3-border)] px-2 py-1.5 text-[11px] whitespace-pre-wrap text-[var(--t3-error-foreground)]">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
