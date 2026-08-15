"use client";

import { useEffect } from "react";

// Phase 5 (PWA, 2026-08-08): registers public/sw.js on the client. Split out
// as its own tiny client component (rather than inlining a script into
// layout.tsx) so the root layout — which does real server-side work
// (session lookup, org theme/currency resolution) — stays a Server
// Component. Renders nothing; this is a side-effect-only mount.
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal — the dashboard works fine without an installed PWA, this
      // just means the "Add to Home Screen" prompt won't show up.
    });
  }, []);

  return null;
}
