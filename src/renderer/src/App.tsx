import { useEffect, useRef, useState, type CSSProperties } from "react";
import { PANEL_GAP, POPOVER_SIZE, SIDEBAR_WIDTH, type OverlayState } from "../../shared/types";
import { Panel } from "./Panel";
import { SettingsPopover, WorkingPopover } from "./Popovers";
import { Sidebar } from "./Sidebar";

export function App() {
  const [state, setState] = useState<OverlayState | null>(null);
  const ignoring = useRef(false);
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

  if (state === null) return null;

  // Transparent parts of the window pass clicks through to the game behind it.
  // Electron keeps forwarding mouse moves while ignoring, so hovering a real surface turns clicks back on.
  const onMouseMove = (event: React.MouseEvent) => {
    const ignore = event.target === event.currentTarget;
    if (ignore !== ignoring.current) {
      ignoring.current = ignore;
      window.overlay.setIgnoreMouse(ignore);
    }
    if (!ignore && !document.hasFocus() && Date.now() - lastHover.current > 500) {
      lastHover.current = Date.now();
      window.overlay.hover();
    }
  };

  const slotLeft = state.side === "left" ? SIDEBAR_WIDTH + PANEL_GAP : 0;
  const slot = (width: number, height: number): CSSProperties => ({
    position: "absolute",
    top: state.panel ? 0 : state.sidebarOffsetY,
    left: slotLeft,
    width,
    height,
  });

  return (
    <div className="relative h-full w-full" onMouseMove={onMouseMove} onMouseLeave={() => (lastHover.current = 0)}>
      <Sidebar state={state} />
      <Panel state={state} style={slot(state.panelSize.width, state.panelSize.height)} />
      {state.popover === "working" && (
        <WorkingPopover state={state} style={popoverStyle(state, slotLeft, POPOVER_SIZE.working)} />
      )}
      {state.popover === "settings" && (
        <SettingsPopover state={state} style={popoverStyle(state, slotLeft, POPOVER_SIZE.settings)} />
      )}
    </div>
  );
}

function popoverStyle(state: OverlayState, slotLeft: number, size: { width: number; height: number }): CSSProperties {
  // Over an open panel, the popover sits on the edge next to the sidebar.
  const left = state.panel && state.side === "right" ? state.panelSize.width - size.width : slotLeft;
  return { position: "absolute", top: state.sidebarOffsetY, left, width: size.width, maxHeight: size.height, zIndex: 10 };
}
