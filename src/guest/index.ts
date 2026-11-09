// Preload for the T3 webview. Runs in an isolated world inside T3's own web UI.
import { ipcRenderer } from "electron";
import { GUEST_CSS, REQUIRED_HOOKS } from "./style";

const settings = ipcRenderer.sendSync("guest:client-settings") as string | null;
if (settings !== null) {
  // The panel always shows T3's composer context strip (environment and permission), which the overlay
  // moves into the composer box. The desktop app's own setting is left alone.
  localStorage.setItem("t3code:client-settings:v1", JSON.stringify({ ...JSON.parse(settings), persistComposerContextStrip: true }));
}
// T3's own thread sidebar stays collapsed; the overlay has its own.
localStorage.setItem("chat_thread_sidebar_open", "false");

const style = document.createElement("style");
style.textContent = GUEST_CSS;
// The preload runs before the document is parsed, so the style waits for <head>.
window.addEventListener("DOMContentLoaded", () => document.head.append(style));

ipcRenderer.on("opacity", (_event, opacity: number) => {
  document.documentElement.style.setProperty("--overlay-opacity", String(opacity));
});
ipcRenderer.on("chrome", (_event, chrome: { title: string; titleInComposer: boolean; textOutline: boolean }) => {
  const root = document.documentElement;
  // JSON string syntax is valid CSS string syntax for the characters a thread title holds.
  root.style.setProperty("--overlay-title", JSON.stringify(chrome.title));
  root.dataset.overlayTitle = chrome.titleInComposer ? "composer" : "chat";
  root.toggleAttribute("data-overlay-outline", chrome.textOutline);
});

const OPEN_POPOVER = '[role="listbox"], [role="menu"], [role="dialog"]';
const composerText = () =>
  document.querySelector('[data-chat-composer-form="true"] [contenteditable="true"], [data-chat-composer-form="true"] textarea')
    ?.textContent?.trim() ?? "";

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
  return target instanceof Element && target.closest('[data-chat-composer-form="true"]') !== null;
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
  setTimeout(checkHooks, 1500);
});

function checkHooks() {
  if (!isThreadRoute()) return;
  const missing = REQUIRED_HOOKS.filter((selector) => document.querySelector(selector) === null);
  ipcRenderer.sendToHost("hooks", missing);
}

// The overlay's sidebar copies T3's live theme tokens, so it follows whatever theme T3 uses.
const THEME_TOKENS = ["background", "foreground", "muted-foreground", "border", "sidebar", "accent", "popover"];
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
