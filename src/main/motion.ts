import type { WebContents } from "electron";

// Each frame of the transparent overlay costs the GPU process 4 to 15 ms of CPU, so the overlay's own UI
// never loops an animation. T3's panel does (live-tool-shine and spinners on a running thread, ~0.3 of a core),
// so while the overlay is unfocused T3's page sees prefers-reduced-motion, which pauses them.

const pages = new Set<WebContents>();
let reduce = true;

function apply(contents: WebContents) {
  const value = reduce ? "reduce" : "";
  void contents.debugger
    .sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] })
    .catch((error) => console.warn("[motion] emulation failed", error));
}

/** `contents` must have its debugger attached. */
export function trackMotion(contents: WebContents) {
  pages.add(contents);
  contents.once("destroyed", () => pages.delete(contents));
  apply(contents);
}

/** Off while the overlay has focus. The system's own reduced-motion setting still applies then. */
export function setReducedMotion(next: boolean) {
  if (next === reduce) return;
  reduce = next;
  for (const contents of pages) apply(contents);
}
