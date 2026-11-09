// Every selector here is a T3 hook. When a T3 nightly renames one, update it here.

/** Hooks a thread page must have. A missing one shows the "T3 layout changed" badge. */
export const REQUIRED_HOOKS = [
  "[data-chat-canvas]",
  '[data-workspace-area="conversation"]',
  "[data-chat-composer-overlay]",
  '[data-chat-composer-form="true"]',
];

// Layout: T3's chat canvas becomes a column of title, history and composer. The title is a
// pseudo-element whose text comes from --overlay-title, so it can sit above or below the history.
// The chat window (title and history) fades with --overlay-opacity, borders included. The composer keeps T3's own look.
export const GUEST_CSS = `
:root {
  --overlay-opacity: 0.85;
  --overlay-title: "";
  --overlay-bg: color-mix(in srgb, var(--background) calc(var(--overlay-opacity) * 100%), transparent);
  --overlay-border: color-mix(in srgb, var(--border) calc(var(--overlay-opacity) * 100%), transparent);
  --overlay-radius: 12px;
}

[data-app-sidebar],
[data-slot="sidebar"],
[data-slot="sidebar-gap"],
[data-sidebar-control],
[data-chat-header],
[data-right-panel-tabbar],
[data-right-panel-surface-content],
[data-right-panel-toggle] {
  display: none !important;
}

html,
body,
#root,
[data-slot="sidebar-wrapper"],
[data-slot="sidebar-inset"],
:has(> [data-chat-column]),
[data-chat-column],
[data-chat-canvas],
[data-timeline-loading] {
  background: transparent !important;
}

[data-workspace-area="conversation"] {
  background: var(--overlay-bg) !important;
}

html[data-overlay-route="thread"] [data-chat-canvas] {
  display: flex !important;
  flex-direction: column !important;
}

html[data-overlay-route="thread"] [data-chat-canvas]::before {
  content: var(--overlay-title);
  order: 0;
  flex: none;
  display: block;
  height: 34px;
  line-height: 32px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: var(--overlay-bg);
  border: 1px solid var(--overlay-border);
  border-bottom-color: color-mix(in srgb, var(--border) calc(var(--overlay-opacity) * 50%), transparent);
  border-radius: var(--overlay-radius) var(--overlay-radius) 0 0;
}

html[data-overlay-route="thread"] [data-workspace-area="conversation"] {
  order: 1;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  height: auto !important;
  background: var(--overlay-bg) !important;
  border: 1px solid var(--overlay-border);
  border-top: 0;
  border-radius: 0 0 var(--overlay-radius) var(--overlay-radius);
}

/* Environment and permission (T3's composer context strip) sit at the top inside the composer card.
   T3 floats the strip outside its card and hides the shell's card surface while it shows. The overlay
   turns that surface back on so one card holds title, strip and editor. */
[data-slot="composer-shell"] {
  display: flex !important;
  flex-direction: column !important;
}

[data-slot="composer-shell"] > :not([data-slot="composer-host"]) {
  order: -1;
  position: relative;
  z-index: 1;
}

/* One card instead of T3's card-on-card: the shell gets the outline, the inner card loses its own. */
[data-slot="composer-shell"][data-context-row]::before {
  display: block !important;
  border: 1px solid var(--chat-composer-outline);
}

[data-slot="composer-shell"][data-context-row] > [data-slot="composer-host"]::before,
[data-slot="composer-shell"][data-context-row] > [data-slot="composer-host"]::after {
  display: none;
}

/* The composer spans the same width as the chat window. */
html[data-overlay-route="thread"] [data-chat-composer-overlay] > div {
  padding-left: 0 !important;
  padding-right: 0 !important;
}

/* "Text outline": a dark outline like WoW's chat, for reading over bright scenery. */
html[data-overlay-outline] [data-workspace-area="conversation"],
html[data-overlay-outline] [data-chat-canvas]::before,
html[data-overlay-outline] [data-slot="composer-shell"]::after {
  text-shadow: 0 0 2px #000, 0 0 3px #000, 1px 1px 1px #000;
}

/* "Title in composer": the title becomes the card's first row, using the shell's unused ::after. */
html[data-overlay-route="thread"][data-overlay-title="composer"] [data-chat-canvas]::before {
  display: none;
}

html[data-overlay-route="thread"][data-overlay-title="composer"] [data-workspace-area="conversation"] {
  border-top: 1px solid var(--overlay-border);
  border-radius: var(--overlay-radius);
}

html[data-overlay-route="thread"][data-overlay-title="composer"] [data-slot="composer-shell"]::after {
  content: var(--overlay-title);
  order: -2;
  position: relative;
  z-index: 1;
  display: block;
  padding: 8px 14px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Without a context strip T3 draws no shell card, so the title row gets one of its own. */
html[data-overlay-route="thread"][data-overlay-title="composer"] [data-slot="composer-shell"]:not([data-context-row]) {
  background: var(--chat-composer-glass-surface);
  border: 1px solid var(--chat-composer-outline);
  border-radius: 16px;
}

html[data-overlay-route="thread"][data-overlay-title="composer"]
  [data-slot="composer-shell"]:not([data-context-row])
  > [data-slot="composer-host"]::after {
  display: none;
}

html[data-overlay-route="thread"] [data-chat-composer-overlay] {
  position: static !important;
  order: 3;
  flex: none;
  margin-top: 6px;
}

/* T3 lifts "Scroll to end" above its floating composer with an inline bottom offset. Here the
   composer sits below the history, so the button goes to the bottom of the history instead. */
html[data-overlay-route="thread"] [data-workspace-area="conversation"] > div:has(> [data-scroll-to-end]) {
  bottom: 12px !important;
}

/* T3 pads the timeline end by the composer's height because its composer floats over the history.
   Here the composer sits below the history, so the pad shrinks. MessagesTimeline.tsx renders it as
   <div aria-hidden style={{ height: composerInset }} /> with no data hook. */
html[data-overlay-route="thread"] .messages-timeline-scroll div[aria-hidden="true"][style*="height"]:empty {
  height: 12px !important;
}
`;
