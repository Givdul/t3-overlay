// Preload for the T3 webview. Runs in an isolated world inside T3's own web UI.
import { ipcRenderer } from "electron";
import type { GuestClientSettings, TextOutline } from "../shared/types";
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
  textOutline: TextOutline;
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
  root.dataset.overlayOutline = next.textOutline;
  root.dataset.overlaySide = next.side;
  foldComposer();
});

const OPEN_POPOVER = '[role="listbox"], [role="menu"], [role="dialog"]';
const COMPOSER_FORM = '[data-chat-composer-form="true"]';
// T3 sets its editor to contenteditable="false" while dictating, so the editor is found by its test id.
const composerText = () =>
  document.querySelector(`${COMPOSER_FORM} [data-testid="composer-editor"], ${COMPOSER_FORM} textarea`)?.textContent?.trim() ?? "";

// Compact composer: an empty composer without focus folds into a write button below the history.
// Focus moving in only unfolds. Focus leaving, voice input starting or ending, a route change, or new settings re-check the fold.
const setFolded = (folded: boolean) => document.documentElement.toggleAttribute("data-overlay-composer-folded", folded);
const composerFocused = () =>
  document.hasFocus() && document.querySelector("[data-chat-composer-overlay]")?.contains(document.activeElement) === true;

const voiceShown = () => voiceActive() || voiceFailed();

let showedVoice = false;

function foldComposer() {
  showedVoice = voiceShown();
  const idle = !showedVoice && !composerFocused() && composerText() === "" && document.querySelector(OPEN_POPOVER) === null;
  setFolded(chrome !== null && chrome.compactComposer && !chrome.needsReply && idle);
}

// T3 disables its editor while dictating, so focus leaves the still-empty composer. Its voice controls keep the
// composer open until the transcript lands, the recording is cancelled, or an error is dismissed.
new MutationObserver(() => {
  if (voiceShown() !== showedVoice) foldComposer();
}).observe(document, { childList: true, subtree: true });

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
    // T3 cancels voice input on Escape, popover or not, which drops its pending send.
    if (event.key === "Escape") stopWatchingDictatedSend();

    if (event.key === "Escape" && document.querySelector(OPEN_POPOVER) === null) {
      ipcRenderer.sendToHost("escape");
    }

    if (event.key === "Enter" && !event.shiftKey && sendsFromKey(event.target)) watchForSend();
  },
  true,
);

// T3's send button cancels the form submit its click would fire, so the click itself is the send.
window.addEventListener(
  "click",
  (event) => {
    if (event.target instanceof Element && event.target.closest(`${COMPOSER_FORM} button[type="submit"]`)) watchForSend();
  },
  true,
);

function inComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FORM) !== null;
}

// While dictation freezes the editor, focus can land on the page itself, and T3's composer takes those keys too.
function sendsFromKey(target: EventTarget | null): boolean {
  const onPage = target === document.body || target === document.documentElement;

  return inComposer(target) || (onPage && voiceActive());
}

// T3 sends on Enter without a form submit, and Enter also picks slash-menu items.
// A send is the composer going from text to empty right after Enter or the send button.
// Enter on the focused send button also clicks it, so one send can arrive twice.
let sendCheck: ReturnType<typeof setTimeout> | null = null;

function watchForSend() {
  if (voiceActive()) return watchForDictatedSend();
  if (composerText() === "") return;

  if (sendCheck !== null) clearTimeout(sendCheck);
  sendCheck = setTimeout(() => {
    sendCheck = null;

    if (composerText() === "") ipcRenderer.sendToHost("sent");
  }, 250);
}

// While dictating, T3 shows the live transcript in its own box and leaves the composer's text alone. Sending
// then waits for the transcription: T3 adds the transcript to the composer, sends it, and clears it.
// T3 labels its voice controls; nothing else marks the dictation phase. When T3 renames one, update it here.
const CANCEL_VOICE = '[aria-label="Cancel voice input"]';

const voiceActive = () => document.querySelector(`${COMPOSER_FORM} ${CANCEL_VOICE}`) !== null;

const voiceFailed = () => document.querySelector(`${COMPOSER_FORM} [aria-label="Dismiss voice input error"]`) !== null;

/** How long after dictation ends the transcript has to land in the composer and be sent. */
const DICTATED_SEND_GRACE_MS = 2000;

let dictatedSend: MutationObserver | null = null;

let dictatedSendGrace: ReturnType<typeof setTimeout> | null = null;

function stopWatchingDictatedSend() {
  dictatedSend?.disconnect();
  dictatedSend = null;

  if (dictatedSendGrace !== null) clearTimeout(dictatedSendGrace);
  dictatedSendGrace = null;
}

let sawDictatedText = false;

function checkDictatedSend() {
  const hasText = composerText() !== "";

  sawDictatedText ||= hasText;

  if (voiceActive()) return;

  if (voiceFailed()) return stopWatchingDictatedSend();

  if (sawDictatedText && !hasText) {
    stopWatchingDictatedSend();
    ipcRenderer.sendToHost("sent");

    return;
  }

  dictatedSendGrace ??= setTimeout(stopWatchingDictatedSend, DICTATED_SEND_GRACE_MS);
}

// Watches every DOM change, not a timer: the transcript can be in the composer for less than a frame.
function watchForDictatedSend() {
  stopWatchingDictatedSend();
  sawDictatedText = composerText() !== "";
  dictatedSend = new MutationObserver(checkDictatedSend);
  dictatedSend.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// Cancelling voice input drops T3's pending send. An empty composer then looks the same as after a send.
window.addEventListener(
  "click",
  (event) => {
    if (event.target instanceof Element && event.target.closest(CANCEL_VOICE)) stopWatchingDictatedSend();
  },
  true,
);

// Tells the overlay where T3 went on its own, such as a draft turning into a thread after the first send.
const isThreadRoute = () => /^\/[^/]+\/[^/]+$/.test(location.pathname) && !/^\/(draft|settings)\//.test(location.pathname);

// The overlay's chat-window layout applies only to thread pages; drafts and settings keep T3's own layout.
function markRoute() {
  document.documentElement.dataset.overlayRoute = isThreadRoute() ? "thread" : "other";
}
window.addEventListener("DOMContentLoaded", markRoute);

const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
navigation?.addEventListener("currententrychange", () => {
  // Leaving the thread cancels its dictation, and the next thread's empty composer is not a send. A draft's
  // first send clears the composer and then navigates to the new thread, so the cleared composer counts first.
  if (dictatedSend !== null) checkDictatedSend();
  stopWatchingDictatedSend();
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
