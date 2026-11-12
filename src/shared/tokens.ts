/**
 * T3's theme tokens, in the order App.tsx publishes them as `--t3-<name>`. The list is the contract
 * between the theme service (main) and the overlay's own styles: anything the panel colours reads one.
 */
export const THEME_TOKENS = [
  "background",
  "card",
  "popover",
  "sidebar",
  "accent",
  "message-surface",
  "surface-raised",
  "code-background",
  "contrast-foreground",
  "contrast-muted-foreground",
  "contrast-border",
  "contrast-accent-foreground",
  "contrast-card-foreground",
  "contrast-popover-foreground",
  "contrast-message-foreground",
  "contrast-secondary-label",
  "contrast-icon-muted",
  "contrast-sidebar-foreground",
  "contrast-sidebar-muted-foreground",
  "message-action",
  "message-action-foreground",
  "message-action-hover",
  "info-foreground",
  "success-foreground",
  "warning-foreground",
  "warning-surface",
  "error-foreground",
  "error-surface",
  "primary",
  "ring",
  "app-scrollbar-thumb",
  "app-scrollbar-thumb-hover",
  "glass-blur",
  "glass-opacity",
  "glass-saturation",
  "radius",
] as const;

export type ThemeTokens = Record<(typeof THEME_TOKENS)[number], string>;

/**
 * T3 keeps the selected theme per client in localStorage (apps/web/src/hooks/useTheme.ts,
 * themePalette.ts): t3code:theme, t3code:theme-appearance-mode, t3code:theme-follow-system,
 * t3code:theme-halves:v1, t3code:themes:v1 (custom palettes) and
 * t3code:default-theme-applied:v2:<environmentId>. A change to any of them re-themes T3's page,
 * which is the moment to re-read its computed tokens.
 */
export const THEME_STORAGE_KEY = /^t3code:(theme($|-)|themes:|default-theme-applied:)/;

/** Everything the panel needs to look like T3, resolved once in main. */
export interface OverlayTheme {
  tokens: ThemeTokens;
  /** Prompt text size in px, as T3's appearance settings show it. */
  fontSizePrompt: number;
  /** Code text size in px. */
  fontSizeCode: number;
  /** A custom interface font stack, already ended with T3's own fallback stack. */
  fontSans: string | null;
  /** A custom code font stack, already ended with T3's own fallback stack. */
  fontCode: string | null;
  /** The composer glass, in percent. */
  glassOpacity: number;
  glassBlur: string;
  glassSaturation: string;
}
