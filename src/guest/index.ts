// Preload for the T3 webview. Runs in an isolated world inside T3's own web UI.
import { ipcRenderer } from "electron";
import type { GuestClientSettings } from "../shared/types";
import { GUEST_CSS, REQUIRED_HOOKS } from "./style";

const CLIENT_SETTINGS_KEY = "t3code:client-settings:v1";

// SAFETY: the main process answers "guest:client-settings" with a GuestClientSettings.
const reply = ipcRenderer.sendSync("guest:client-settings") as GuestClientSettings;

// A page T3 navigated to gets no settings written into its storage.
if (reply !== null) {
  // Without the desktop app's settings file, the panel keeps the settings it stored on an earlier run.
  const settings = reply.settings ?? localStorage.getItem(CLIENT_SETTINGS_KEY) ?? "{}";

  // The panel always shows T3's composer context strip (environment and permission), which the overlay
  // moves into the composer box. Links and pull requests always open in the system browser, never in T3's
  // in-app browser. Thread notifications (toasts, system notifications, sounds) stay off: the overlay's
  // sidebar shows those states. The desktop app's own settings are left alone.
  localStorage.setItem(
    CLIENT_SETTINGS_KEY,
    JSON.stringify({
      ...JSON.parse(settings),
      persistComposerContextStrip: true,
      browserLinkTarget: "system",
      pullRequestLinksOpenInApp: false,
      inAppNotificationsEnabled: false,
      notificationMode: "off",
    }),
  );
}
// T3's own thread sidebar stays collapsed; the overlay has its own.
localStorage.setItem("chat_thread_sidebar_open", "false");

// T3's thread toasts never show in the panel, whatever T3's notification settings say: the overlay's sidebar
// shows those states. CSS can't match a toast's title, so a toast is marked hidden (style.ts) as it mounts,
// before it paints, then dismissed so it leaves T3's toast stack.
// These are the titles of T3's thread notification toasts. When T3 renames one, update it here.
const THREAD_TOAST_TITLES = new Set([
  "Thread completed",
  "Approval needed",
  "Usage limit reached",
  "Thread failed",
  "Guest request",
  "Input needed",
]);

const TOAST = '[data-slot="toast-popup"]';

function hideThreadToast(toast: Element) {
  const title = toast.querySelector('[data-slot="toast-title"]')?.textContent?.trim() ?? "";

  if (!THREAD_TOAST_TITLES.has(title) || toast.hasAttribute("data-overlay-hidden")) return;
  toast.setAttribute("data-overlay-hidden", "");
  toast.querySelector<HTMLElement>('[data-slot="toast-close"]')?.click();
}

new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;

      if (node.matches(TOAST)) hideThreadToast(node);
      else node.querySelectorAll(TOAST).forEach(hideThreadToast);
    }
  }
}).observe(document, { childList: true, subtree: true });

const style = document.createElement("style");
style.textContent = GUEST_CSS;
// The preload runs before the document is parsed, so the style waits for <head>.
window.addEventListener("DOMContentLoaded", () => document.head.append(style));

// The overlay shows its resize grip while the pointer is over the chat. The webview element gets no
// mouse events of its own in the overlay's page, so the page reports them.
let pointerInside = false;

const reportPointer = (inside: boolean) => {
  if (inside === pointerInside) return;

  pointerInside = inside;
  ipcRenderer.sendToHost("pointer", inside);
};

window.addEventListener("mouseover", () => reportPointer(true));

window.addEventListener("mouseout", (event) => {
  if (event.relatedTarget === null) reportPointer(false);
});

ipcRenderer.on("opacity", (_event, opacity: number) => {
  document.documentElement.style.setProperty("--overlay-opacity", String(opacity));
});
interface Chrome {
  title: string;
  titleInComposer: boolean;
  textOutline: boolean;
  compactComposer: boolean;
  /** The thread waits on an approval or an answer. */
  needsReply: boolean;
  /** The screen edge the overlay docks to. The folded composer's button sits on this side. */
  side: "left" | "right";
}

let chrome: Chrome | null = null;

ipcRenderer.on("chrome", (_event, next: Chrome) => {
  chrome = next;
  const root = document.documentElement;
  // JSON string syntax is valid CSS string syntax for the characters a thread title holds.
  root.style.setProperty("--overlay-title", JSON.stringify(next.title));
  root.dataset.overlayTitle = next.titleInComposer ? "composer" : "chat";
  root.toggleAttribute("data-overlay-outline", next.textOutline);
  root.dataset.overlaySide = next.side;
  foldComposer();
});

const OPEN_POPOVER = '[role="listbox"], [role="menu"], [role="dialog"]';
const COMPOSER_FORM = '[data-chat-composer-form="true"]';
const composerText = () =>
  document.querySelector(`${COMPOSER_FORM} [contenteditable="true"], ${COMPOSER_FORM} textarea`)?.textContent?.trim() ?? "";

// Compact composer: an empty composer without focus folds into a write button below the history.
// Focus moving in only unfolds. Focus leaving, a route change, or new settings re-check the fold.
const setFolded = (folded: boolean) => document.documentElement.toggleAttribute("data-overlay-composer-folded", folded);
const composerFocused = () =>
  document.hasFocus() && document.querySelector("[data-chat-composer-overlay]")?.contains(document.activeElement) === true;

function foldComposer() {
  const idle = !composerFocused() && composerText() === "" && document.querySelector(OPEN_POPOVER) === null;
  setFolded(chrome !== null && chrome.compactComposer && !chrome.needsReply && idle);
}

/** Unfolds the composer and focuses T3's editor. A resting composer shows a prompt button that mounts the editor. */
function openComposer() {
  setFolded(false);
  const prompt = document.querySelector<HTMLElement>(`${COMPOSER_FORM} [data-chat-composer-transition-prompt="true"]`);
  if (prompt) prompt.click();
  else document.querySelector<HTMLElement>(`${COMPOSER_FORM} [contenteditable="true"]`)?.focus();
}

ipcRenderer.on("focus-composer", openComposer);
window.addEventListener("focusout", () => setTimeout(foldComposer));
window.addEventListener("blur", foldComposer);
window.addEventListener("focusin", () => {
  if (composerFocused()) setFolded(false);
});
// Only the folded button hits the composer region itself: T3 makes it click-through, and the button's
// mousedown has already unfolded it through focusin by the time the click arrives.
window.addEventListener(
  "click",
  (event) => {
    if (event.target instanceof Element && event.target.matches("[data-chat-composer-overlay]")) openComposer();
  },
  true,
);

window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape" && document.querySelector(OPEN_POPOVER) === null) {
      ipcRenderer.sendToHost("escape");
    }
    if (event.key === "Enter" && !event.shiftKey && inComposer(event.target)) watchForSend();
  },
  true,
);
window.addEventListener("submit", (event) => {
  if (inComposer(event.target)) watchForSend();
}, true);

function inComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FORM) !== null;
}

// T3 sends on Enter without a form submit, and Enter also picks slash-menu items.
// A send is the composer going from text to empty right after Enter or the send button.
function watchForSend() {
  if (composerText() === "") return;
  setTimeout(() => {
    if (composerText() === "") ipcRenderer.sendToHost("sent");
  }, 250);
}

// Tells the overlay where T3 went on its own, such as a draft turning into a thread after the first send.
const isThreadRoute = () => /^\/[^/]+\/[^/]+$/.test(location.pathname) && !/^\/(draft|settings)\//.test(location.pathname);

// The overlay's chat-window layout applies only to thread pages; drafts and settings keep T3's own layout.
function markRoute() {
  document.documentElement.dataset.overlayRoute = isThreadRoute() ? "thread" : "other";
}
window.addEventListener("DOMContentLoaded", markRoute);

const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
navigation?.addEventListener("currententrychange", () => {
  markRoute();
  ipcRenderer.sendToHost("route", location.pathname);
  // The next thread's draft text renders a moment after the route changes.
  setTimeout(foldComposer, 300);
  setTimeout(checkHooks, 1500);
});

function checkHooks() {
  if (!isThreadRoute()) return;
  const missing = REQUIRED_HOOKS.filter((selector) => document.querySelector(selector) === null);
  ipcRenderer.sendToHost("hooks", missing);
}

// The overlay's sidebar copies T3's live theme tokens, so it follows whatever theme T3 uses.
const THEME_TOKENS = ["background", "foreground", "muted-foreground", "border", "sidebar", "accent", "popover", "info-foreground"];
let lastTheme = "";
function reportTheme() {
  const computed = getComputedStyle(document.documentElement);
  const theme = Object.fromEntries(THEME_TOKENS.map((name) => [name, computed.getPropertyValue(`--${name}`).trim()]));
  const key = JSON.stringify(theme);
  if (key === lastTheme || theme.background === "") return;
  lastTheme = key;
  ipcRenderer.sendToHost("theme", theme);
}

window.addEventListener("load", () => {
  setTimeout(checkHooks, 3000);
  reportTheme();
  new MutationObserver(reportTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme-id"] });
});
