import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { nativeTheme } from "electron";
import { THEME_TOKENS, type OverlayTheme, type ThemeTokens } from "../shared/tokens";

/**
 * T3's built-in theme, copied from apps/web/src/index.css (`:root` and its dark variant) with the
 * palette variables resolved to literals. Used with no debugging port, or when "custom theme" is off.
 */
const DARK: ThemeTokens = {
  background: "#000",
  card: "#111",
  popover: "#111",
  sidebar: "#111",
  accent: "rgb(255 255 255 / 4%)",
  "message-surface": "#1e1e1e",
  "surface-raised": "#111",
  "code-background": "#0f0f0f",
  "contrast-foreground": "oklch(0.97 0 0)",
  "contrast-muted-foreground": "oklch(0.708 0 0)",
  "contrast-border": "rgb(255 255 255 / 8%)",
  "contrast-accent-foreground": "oklch(0.97 0 0)",
  "contrast-card-foreground": "oklch(0.97 0 0)",
  "contrast-popover-foreground": "oklch(0.97 0 0)",
  "contrast-message-foreground": "oklch(0.97 0 0)",
  "contrast-secondary-label": "oklch(0.708 0 0)",
  "contrast-icon-muted": "oklch(0.708 0 0)",
  "contrast-sidebar-foreground": "oklch(0.97 0 0)",
  "contrast-sidebar-muted-foreground": "oklch(0.708 0 0)",
  "message-action": "oklch(0.571 0.21 264)",
  "message-action-foreground": "#fff",
  "message-action-hover": "color-mix(in srgb, oklch(0.571 0.21 264) 90%, #000)",
  "info-foreground": "oklch(0.707 0.165 254.624)",
  "success-foreground": "oklch(0.765 0.177 163.223)",
  "warning-foreground": "oklch(0.828 0.189 84.429)",
  "warning-surface": "color-mix(in srgb, oklch(0.769 0.188 70.08) 16%, transparent)",
  "error-foreground": "oklch(0.704 0.191 22.216)",
  "error-surface": "color-mix(in srgb, oklch(0.637 0.237 25.331) 16%, transparent)",
  primary: "oklch(0.571 0.21 264)",
  ring: "oklch(0.571 0.21 264)",
  "app-scrollbar-thumb": "rgb(255 255 255 / 8%)",
  "app-scrollbar-thumb-hover": "rgb(255 255 255 / 12%)",
  "glass-blur": "16px",
  "glass-opacity": "80%",
  "glass-saturation": "1.08",
  radius: "0.5rem",
};

const LIGHT: ThemeTokens = {
  background: "oklch(0.992 0 0)",
  card: "#fff",
  popover: "#fff",
  sidebar: "oklch(0.985 0 0)",
  accent: "oklch(0.967 0.001 286.375)",
  "message-surface": "color-mix(in srgb, oklch(0.92 0.004 286.32) 55%, oklch(0.967 0.001 286.375))",
  "surface-raised": "color-mix(in srgb, #fff 20%, transparent)",
  "code-background": "color-mix(in srgb, #fff 90%, oklch(0.992 0 0))",
  "contrast-foreground": "oklch(0.21 0.006 285.885)",
  "contrast-muted-foreground": "oklch(0.552 0.016 285.938)",
  "contrast-border": "oklch(0.92 0.004 286.32)",
  "contrast-accent-foreground": "oklch(0.21 0.006 285.885)",
  "contrast-card-foreground": "oklch(0.21 0.006 285.885)",
  "contrast-popover-foreground": "oklch(0.21 0.006 285.885)",
  "contrast-message-foreground": "oklch(0.21 0.006 285.885)",
  "contrast-secondary-label": "oklch(0.552 0.016 285.938)",
  "contrast-icon-muted": "oklch(0.552 0.016 285.938)",
  "contrast-sidebar-foreground": "oklch(0.21 0.006 285.885)",
  "contrast-sidebar-muted-foreground": "oklch(0.552 0.016 285.938)",
  "message-action": "oklch(0.488 0.217 264)",
  "message-action-foreground": "#fff",
  "message-action-hover": "color-mix(in srgb, oklch(0.488 0.217 264) 90%, oklch(0.992 0 0))",
  "info-foreground": "oklch(0.488 0.243 264.376)",
  "success-foreground": "oklch(0.508 0.118 165.612)",
  "warning-foreground": "oklch(0.555 0.163 48.998)",
  "warning-surface": "color-mix(in srgb, oklch(0.769 0.188 70.08) 8%, transparent)",
  "error-foreground": "oklch(0.505 0.213 27.518)",
  "error-surface": "color-mix(in srgb, oklch(0.637 0.237 25.331) 8%, transparent)",
  primary: "oklch(0.488 0.217 264)",
  ring: "oklch(0.488 0.217 264)",
  "app-scrollbar-thumb": "rgb(217 217 217)",
  "app-scrollbar-thumb-hover": "rgb(191 191 191)",
  "glass-blur": "12px",
  "glass-opacity": "80%",
  "glass-saturation": "1.14",
  radius: "0.5rem",
};

/** T3's own font stacks, from apps/web/src/appearanceFonts.ts. */
export const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif';
export const DEFAULT_CODE = '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

/** The appearance half of T3's ~/.t3/userdata/client-settings.json that the panel uses. */
export interface Appearance {
  fontSizePrompt: number;
  fontSizeCode: number;
  fontSans: string | null;
  fontCode: string | null;
  glassOpacity: number;
}

export const clientSettingsPath = () => join(homedir(), ".t3", "userdata", "client-settings.json");

// T3's own bounds (packages/contracts/src/settings.ts), so a size the desktop app accepts looks the same here.
const PROMPT_SIZE = { min: 12, max: 20, fallback: 14 };
const CODE_SIZE = { min: 10, max: 18, fallback: 13 };

/** The appearance fields of T3's client-settings.json (packages/contracts/src/settings.ts). */
interface ClientSettings {
  fontSizePrompt?: number;
  fontSizeCode?: number;
  fontFamilySans?: string;
  fontFamilyCode?: string;
  glassOpacity?: number;
}

function clamp(value: number | undefined, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;

  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Font/glass preferences from T3's client settings; null when the file is missing or unreadable. */
export async function readAppearance(): Promise<Appearance | null> {
  try {
    // SAFETY: the file is T3's own settings document; these five fields are the numbers and font
    // names the desktop app writes, and each one is clamped or checked below.
    const raw = JSON.parse(await readFile(clientSettingsPath(), "utf8")) as ClientSettings;

    return {
      fontSizePrompt: clamp(raw.fontSizePrompt, PROMPT_SIZE),
      fontSizeCode: clamp(raw.fontSizeCode, CODE_SIZE),
      fontSans: fontStack(raw.fontFamilySans, DEFAULT_SANS),
      fontCode: fontStack(raw.fontFamilyCode, DEFAULT_CODE),
      glassOpacity: clamp(raw.glassOpacity, { min: 0, max: 100, fallback: 80 }),
    };
  } catch {
    return null;
  }
}

/** T3 puts a custom stack in front of its own, so a missing family still lands on a sensible one. */
function fontStack(custom: string | undefined, fallback: string): string | null {
  if (custom === undefined || custom.trim() === "") return null;

  return `${custom.trim()}, ${fallback}`;
}

/**
 * T3's own page tokens merged over the fallback palette for the system appearance. A token the page
 * has no value for, or one still holding an unresolved `var()`, keeps the fallback.
 */
export function resolveTheme(cdpTokens: Partial<ThemeTokens> | null, appearance: Appearance | null): OverlayTheme {
  const tokens: ThemeTokens = { ...(nativeTheme.shouldUseDarkColors ? DARK : LIGHT) };

  for (const name of THEME_TOKENS) {
    const value = cdpTokens?.[name]?.trim();

    if (value !== undefined && value !== "" && !value.includes("var(")) tokens[name] = value;
  }

  const glassOpacity = appearance?.glassOpacity ?? 80;
  tokens["glass-opacity"] = `${glassOpacity}%`;

  return {
    tokens,
    fontSizePrompt: appearance?.fontSizePrompt ?? PROMPT_SIZE.fallback,
    fontSizeCode: appearance?.fontSizeCode ?? CODE_SIZE.fallback,
    fontSans: appearance?.fontSans ?? null,
    fontCode: appearance?.fontCode ?? null,
    glassOpacity,
    glassBlur: tokens["glass-blur"],
    glassSaturation: tokens["glass-saturation"],
  };
}
