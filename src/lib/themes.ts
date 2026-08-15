// Per-organization dashboard color scheme. Added 2026-08-05 (Seni's ask,
// right after the visual refresh) — that refresh introduced a single
// hardcoded indigo --accent/--accent-hover pair (see globals.css); this
// turns it into a per-tenant choice via Settings > Appearance, so the
// product can look different for each property manager who eventually
// subscribes, not just Legacy Estate Rentals.
//
// Every preset besides "red-black" only retints the accent color (nav
// active state, PageHeader tabs/eyebrow, links) and leaves the existing
// light/dark background swap keyed to the system's prefers-color-scheme,
// same as before this feature existed. "red-black" is the one exception —
// Seni's own scheme — which also forces the near-black surface palette
// regardless of system preference, since "red and black" implies a
// specific dramatic look, not just a red accent on an otherwise white
// page. See globals.css for exactly how each id maps to CSS, including the
// red-black-specific overrides for the app's common light-mode surface
// utility classes (bg-white, border-black/10, text-black/50, etc.) so it
// still looks fully black even when the visitor's OS is in light mode.
export type ThemeId = "indigo" | "red-black" | "ocean" | "emerald" | "sunset" | "slate";

export type Theme = {
  id: ThemeId;
  label: string;
  /** Swatch color shown in the Settings > Appearance picker. */
  swatch: string;
  /** True if this theme always renders the dark surface palette,
   * regardless of the visitor's OS light/dark preference. */
  forceDark?: boolean;
};

export const THEMES: Theme[] = [
  { id: "indigo", label: "Indigo (default)", swatch: "#4f46e5" },
  { id: "red-black", label: "Red & Black", swatch: "#dc2626", forceDark: true },
  { id: "ocean", label: "Ocean Blue", swatch: "#0284c7" },
  { id: "emerald", label: "Emerald", swatch: "#059669" },
  { id: "sunset", label: "Sunset Orange", swatch: "#ea580c" },
  { id: "slate", label: "Slate", swatch: "#475569" },
];

export const DEFAULT_THEME_ID: ThemeId = "indigo";

export function isValidThemeId(id: string): id is ThemeId {
  return THEMES.some((t) => t.id === id);
}

export function getTheme(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
