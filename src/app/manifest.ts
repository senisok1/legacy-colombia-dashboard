import type { MetadataRoute } from "next";

// Phase 5 (PWA, 2026-08-08): makes the dashboard installable to a phone's
// home screen — Next's App Router serves whatever this returns at
// /manifest.webmanifest automatically (see the `manifest` field in
// layout.tsx's metadata export, which just points at that URL).
//
// Deliberately static/single-brand for now rather than per-organization —
// this app is multi-tenant (see lib/themes.ts's per-org color picker), but
// Phase 6 (multi-tenant rollout/isolation testing) hasn't shipped yet and
// Seni is still the only real tenant. A truly per-tenant manifest (different
// name/icons/theme_color per org) would need a dynamic route reading the
// signed-in session, which install prompts can't reliably do before the
// user is authenticated anyway (this manifest has to be servable to a
// logged-out visitor hitting the login screen too). Revisit this once
// Phase 6 actually onboards a second property manager — for now this
// matches Seni's own Red & Black theme (see globals.css/themes.ts).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Legacy Colombia Dashboard",
    short_name: "LC Dashboard",
    description: "Booking dashboard and guest CRM for Legacy Colombia",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
