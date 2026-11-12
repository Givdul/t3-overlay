import { Check, Lock, PenLine, ShieldCheck, ShieldOff } from "lucide-react";
import type { ReactNode } from "react";
import { runtimeModeInfo } from "./config";

// T3's permissions radio group: four fixed modes with its own labels and descriptions
// (apps/web/src/components/chat/runtimeModeConfig.ts). A pick stays pending until the send.

export function permissionIcon(mode: string, size = 12): ReactNode {
  switch (mode) {
    case "approval-required":
      return <Lock size={size} />;
    case "auto-accept-edits":
      return <PenLine size={size} />;
    case "auto":
      return <ShieldCheck size={size} />;
    default:
      return <ShieldOff size={size} />;
  }
}

export function PermissionPicker({
  value,
  modes,
  onChange,
}: {
  value: string;
  modes: string[];
  onChange: (mode: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Permissions"
      className="mx-2 mt-2 mb-1 flex flex-col rounded-lg border border-[color-mix(in_srgb,var(--t3-contrast-border)_100%,transparent)] bg-[var(--t3-popover)] p-1"
    >
      <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-t3-muted">Permissions</p>
      {modes.map((mode) => {
        const info = runtimeModeInfo(mode);
        const selected = mode === value;

        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(mode)}
            className={`flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left ${
              selected ? "bg-[color-mix(in_srgb,var(--t3-contrast-foreground)_9%,transparent)]" : ""
            }`}
          >
            <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-t3-muted">{permissionIcon(mode)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-t3-fg">{info.label}</span>
              <span className="block text-[11px] leading-4 text-t3-muted">{info.description}</span>
            </span>
            <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center text-t3-fg">{selected && <Check size={12} />}</span>
          </button>
        );
      })}
    </div>
  );
}
