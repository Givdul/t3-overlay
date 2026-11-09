import type { CSSProperties } from "react";
import type { OverlayState } from "../../shared/types";
import { ProjectGlyph } from "./ThreadIcon";

const surface = "overflow-hidden rounded-xl border border-t3-border bg-t3-popover shadow-xl shadow-black/40";

export function WorkingPopover({ state, style }: { state: OverlayState; style: CSSProperties }) {
  return (
    <div className={`${surface} flex flex-col`} style={style}>
      <div className="px-3 pt-2.5 pb-1 text-[11px] font-medium text-t3-muted">Working</div>
      <div className="flex min-h-0 flex-col overflow-y-auto p-1">
        {state.working.map((thread) => (
          <button
            key={`${thread.environmentId}:${thread.threadId}`}
            type="button"
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-t3-accent"
            onClick={() => window.overlay.open(thread)}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <ProjectGlyph icon={thread.icon} size={16} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] text-t3-fg">{thread.title}</span>
              <span className="block truncate text-[11px] text-t3-muted">
                {[thread.projectName, thread.environmentLabel].filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className="group inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-white/15 p-0.5 transition-colors aria-checked:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        onClick={() => onChange(!checked)}
      >
        <span className="size-3.5 rounded-full bg-white shadow-sm transition-transform group-aria-checked:translate-x-3.5" />
      </button>
    </label>
  );
}

export function SettingsPopover({ state, style }: { state: OverlayState; style: CSSProperties }) {
  const { settings } = state;
  return (
    <div className={`${surface} flex flex-col gap-3 p-3`} style={style}>
      <Toggle label="Lock position" checked={state.locked} onChange={(locked) => window.overlay.setLocked(locked)} />
      <Toggle
        label="Title in composer"
        checked={settings.titleInComposer}
        onChange={(titleInComposer) => window.overlay.setSettings({ titleInComposer })}
      />
      <Toggle
        label="Text outline"
        checked={settings.textOutline}
        onChange={(textOutline) => window.overlay.setSettings({ textOutline })}
      />
      <Toggle
        label="Compact composer"
        checked={settings.compactComposer}
        onChange={(compactComposer) => window.overlay.setSettings({ compactComposer })}
      />
      <Toggle
        label="Custom theme"
        checked={settings.customTheme}
        onChange={(customTheme) => window.overlay.setSettings({ customTheme })}
      />
      <Toggle
        label="Close after sending"
        checked={settings.closeOnSend}
        onChange={(closeOnSend) => window.overlay.setSettings({ closeOnSend })}
      />
      <Toggle
        label="Open threads when done"
        checked={settings.openWhenDone}
        onChange={(openWhenDone) => window.overlay.setSettings({ openWhenDone })}
      />
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="flex justify-between">
          Chat background
          <span className="text-t3-muted tabular-nums">{Math.round(state.opacity * 100)}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          className="accent-sky-400"
          value={state.opacity}
          onChange={(event) => window.overlay.setOpacity(Number(event.target.value))}
        />
      </label>
    </div>
  );
}
