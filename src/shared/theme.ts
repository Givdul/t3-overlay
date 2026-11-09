// T3 keeps the selected theme per client in localStorage (apps/web/src/hooks/useTheme.ts, themePalette.ts):
// t3code:theme, t3code:theme-appearance-mode, t3code:theme-follow-system, t3code:theme-halves:v1,
// t3code:themes:v1 (custom palettes) and t3code:default-theme-applied:v2:<environmentId>. Copying the
// "applied" markers stops the panel from re-applying an environment's default theme over the user's pick.
// With no other theme key set, T3 shows its built-in theme and follows the system appearance.
export const THEME_STORAGE_KEY = /^t3code:(theme($|-)|themes:|default-theme-applied:)/;
const APPLIED_MARKER_KEY = /^t3code:default-theme-applied:/;

export type ThemeStorage = Record<string, string>;

/** T3's built-in theme, following the system appearance: only the desktop app's "applied" markers. */
export function defaultThemeStorage(storage: ThemeStorage | null): ThemeStorage {
  return Object.fromEntries(Object.entries(storage ?? {}).filter(([key]) => APPLIED_MARKER_KEY.test(key)));
}

/**
 * Source of a function for T3's page (main world): sets this page's theme keys to `storage` and fires
 * the storage events T3's theme hook listens for, so it re-themes live. The page keeps its own
 * "applied" markers, so an environment's default theme never lands on the panel unasked.
 */
export function themeApplyScript(storage: ThemeStorage): string {
  return `((next) => {
  const isTheme = (key) => ${THEME_STORAGE_KEY.toString()}.test(key) && !${APPLIED_MARKER_KEY.toString()}.test(key);
  const changes = [];
  for (const key of Object.keys(localStorage).filter(isTheme)) {
    if (!(key in next)) changes.push([key, localStorage.getItem(key), null]);
  }
  for (const [key, value] of Object.entries(next)) {
    const old = localStorage.getItem(key);
    if (old !== value) changes.push([key, old, value]);
  }
  for (const [key, oldValue, newValue] of changes) {
    if (newValue === null) localStorage.removeItem(key);
    else localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue, storageArea: localStorage, url: location.href }));
  }
  return changes.length;
})(${JSON.stringify(storage)})`;
}
