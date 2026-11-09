import type { BrowserWindow } from "electron";
import koffi from "koffi";

// Windows only. Elsewhere, Electron's focus() and blur() are enough.
const user32 = process.platform === "win32" ? koffi.load("user32.dll") : null;
const kernel32 = process.platform === "win32" ? koffi.load("kernel32.dll") : null;
const getForegroundWindow = user32?.func("void* __stdcall GetForegroundWindow()");
const setForegroundWindow = user32?.func("bool __stdcall SetForegroundWindow(void* hWnd)");
// Same function, taking the overlay's own HWND as the integer Electron hands out.
const setForegroundHandle = user32?.func("SetForegroundWindow", "bool", ["intptr_t"]);
const getWindowThreadProcessId = user32?.func("uint32 __stdcall GetWindowThreadProcessId(void* hWnd, void* lpdwProcessId)");
const attachThreadInput = user32?.func("bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)");
const getCurrentThreadId = kernel32?.func("uint32 __stdcall GetCurrentThreadId()");

let previous: unknown = null;

function handleAddress(win: BrowserWindow): bigint {
  return win.getNativeWindowHandle().readBigUInt64LE(0);
}

/** Remembers the foreground window, unless it is the overlay itself. */
export function rememberForeground(win: BrowserWindow) {
  const hwnd = getForegroundWindow?.();
  if (hwnd && koffi.address(hwnd) !== handleAddress(win)) previous = hwnd;
}

/**
 * Brings the overlay to the front. Windows refuses SetForegroundWindow from a background app,
 * so the overlay briefly joins the input queue of the current foreground window first.
 */
export function takeFocus(win: BrowserWindow, attempt = 1) {
  forceForeground(win);
  // Windows sometimes refuses the first switch after the overlay starts, so check and retry.
  if (attempt < 3) setTimeout(() => !win.isFocused() && takeFocus(win, attempt + 1), 120);
}

function forceForeground(win: BrowserWindow) {
  const foreground = getForegroundWindow?.();
  if (!foreground || !getWindowThreadProcessId || !attachThreadInput || !getCurrentThreadId || !setForegroundHandle) {
    win.focus();
    return;
  }
  const target = getWindowThreadProcessId(foreground, null);
  const self = getCurrentThreadId();
  const attached = target !== self && attachThreadInput(self, target, true);
  setForegroundHandle(handleAddress(win));
  win.focus();
  // Detaching in the same tick lets Windows hand the foreground straight back to the game.
  if (attached) setTimeout(() => attachThreadInput(self, target, false), 100);
}

/** Gives focus back to the window that was in front before the overlay took it. */
export function returnFocus(win: BrowserWindow) {
  if (setForegroundWindow && previous) setForegroundWindow(previous);
  else win.blur();
}
