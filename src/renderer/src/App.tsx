import { useEffect, useRef, useState, type CSSProperties } from "react";
import { POPOVER_SIZE, popoverLeft, slotLeft, type OverlayState, type Popover } from "../../shared/types";
import { Panel } from "./Panel";
import { SettingsPopover, WorkingPopover } from "./Popovers";
import { Sidebar } from "./Sidebar";

export function App() {
  const [state, setState] = useState<OverlayState | null>(null);
  const lastHover = useRef(0);

  useEffect(() => {
    void window.overlay.init().then(({ state }) => setState(state));
    return window.overlay.onState(setState);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.overlay.escape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // T3's theme arrives resolved from main; the sidebar and the panel both read these variables.
  useEffect(() => {
    if (state === null) return;
    const root = document.documentElement;
    const { theme } = state;

    for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(`--t3-${name}`, value);
    root.style.setProperty("--t3-font-size-prompt", `${theme.fontSizePrompt}px`);
    root.style.setProperty("--t3-font-size-code", `${theme.fontSizeCode}px`);
    root.style.setProperty("--t3-glass-opacity", `${theme.glassOpacity}%`);
    root.style.setProperty("--t3-glass-blur", theme.glassBlur);
    root.style.setProperty("--t3-glass-saturation", theme.glassSaturation);

    if (theme.fontSans === null) root.style.removeProperty("--t3-font-sans");
    else root.style.setProperty("--t3-font-sans", theme.fontSans);

    if (theme.fontCode === null) root.style.removeProperty("--t3-font-mono");
    else root.style.setProperty("--t3-font-mono", theme.fontCode);
  }, [state?.theme]);

  if (state === null) return null;

  // The window is shaped to its surfaces (main/index.ts), so the game gets clicks everywhere else and
  // every mouse move here is over a surface. Hovering one remembers the game's window for returning focus.
  const onMouseMove = () => {
    if (!document.hasFocus() && Date.now() - lastHover.current > 500) {
      lastHover.current = Date.now();
      window.overlay.hover();
    }
  };

  const slot = (width: number, height: number): CSSProperties => ({
    position: "absolute",
    top: state.panel ? 0 : state.sidebarOffsetY,
    left: slotLeft(state.side),
    width,
    height,
  });

  return (
    <div className="relative h-full w-full" onMouseMove={onMouseMove} onMouseLeave={() => (lastHover.current = 0)}>
      <Sidebar state={state} />
      <Panel state={state} style={slot(state.panelSize.width, state.panelSize.height)} />
      {state.popover === "working" && <WorkingPopover state={state} style={popoverStyle(state, "working")} />}
      {state.popover === "settings" && <SettingsPopover state={state} style={popoverStyle(state, "settings")} />}
    </div>
  );
}

function popoverStyle(state: OverlayState, popover: Popover): CSSProperties {
  const { width, height } = POPOVER_SIZE[popover];
  return { position: "absolute", top: state.sidebarOffsetY, left: popoverLeft(state, popover), width, maxHeight: height, zIndex: 10 };
}
