"use client";

// Tiny external store for the sidebar's collapsed preference (2026-08-22 UI
// refresh).
//
// Why a store rather than useState + useEffect: reading localStorage during
// render breaks SSR, and setting it from inside an effect is a cascading
// render (and is flagged by react-hooks/set-state-in-effect). An external
// store read through useSyncExternalStore is the pattern React actually
// provides for "browser-only value that can change" — the server snapshot
// is simply `false`, so markup matches on hydration and then corrects.

const KEY = "lc_sidebar_collapsed";
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeSidebar(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    // Private mode / storage disabled — treat as expanded.
    return false;
  }
}

/** Server snapshot: always expanded, so SSR and first client render agree. */
export function getSidebarCollapsedServer(): boolean {
  return false;
}

export function toggleSidebarCollapsed(): void {
  const next = !getSidebarCollapsed();
  try {
    window.localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // Non-fatal: the toggle still applies for this session via emit().
  }
  emit();
}
