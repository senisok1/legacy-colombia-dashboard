import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "./lib/session";

// Proxy (formerly "middleware") always runs on the Node.js runtime in
// Next.js 16+, so node:crypto is available here without extra config.

export function proxy(req: NextRequest) {
  // Per-user login (see lib/session.ts) is the only check now. The legacy
  // single shared DASHBOARD_PASSWORD cookie ("lc_dashboard_auth") was
  // retired 2026-08-10 — it let a browser into every page with a valid
  // per-user-looking session but NO organizationId attached, since that
  // path never knew which org it belonged to. That silently broke
  // anything org-scoped (Messaging returned "no conversations found" with
  // no error) while pages with a defensive default-org fallback rendered
  // stale/wrong-looking data instead — exactly what happened on Seni's
  // phone, which had picked up the shared-password cookie (the login
  // page's default mode) instead of his real per-user login. See
  // api/debug/whoami's header for how this was diagnosed.
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const validUserSession = Boolean(verifySessionToken(sessionCookie));

  // No per-user auth configured at all — only relevant for local/demo use
  // that was never set up with AUTH_SECRET; a real deployment always has it.
  if (!validUserSession && !process.env.AUTH_SECRET) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/login") ||
    // Phase 2 self-serve signup — not linked publicly yet (see
    // api/signup/route.ts), but must be reachable pre-login like /login.
    pathname.startsWith("/signup") ||
    pathname.startsWith("/api/signup") ||
    // OwnerRez itself redirects back here after the account owner approves
    // the one-time messaging connection — it isn't reached through a logged
    // in browser session, so it can't carry our password cookie.
    pathname.startsWith("/api/oauth") ||
    // Meta's webhook verification/delivery and the external cron pinger
    // can't carry the dashboard's login cookie either — each of these has
    // its own independent auth instead (WhatsApp verify token + sender
    // allowlist; CRON_SECRET bearer token), checked inside the route itself.
    pathname.startsWith("/api/whatsapp/webhook") ||
    // Elementor's server-side webhook POST (see api/webhooks/website-form)
    // can't carry the dashboard's login cookie either — it has its own
    // independent auth instead (a shared secret query param, checked inside
    // the route itself).
    pathname.startsWith("/api/webhooks/") ||
    // The chat widget embedded on legacycolombia.com calls these from a
    // browser with no dashboard session/cookies at all — each route already
    // enforces its own CORS allowlist (legacycolombia.com only) and rate
    // limiting inside the route itself, so gating them behind login here
    // would just break the widget for every external visitor.
    pathname.startsWith("/api/public/") ||
    // Same reasoning for the static widget scripts themselves: the external
    // site loads these with a plain <script> tag, which can't carry our
    // login cookie either. booking-calendar.js added 2026-08-06 for the
    // Book Direct calendar — found this exact gap while previewing that
    // page (the script 503'd, redirected to /login, since only
    // chat-widget.js was allowlisted here).
    pathname === "/chat-widget.js" ||
    pathname === "/booking-calendar.js" ||
    // Compact inline calendar embedded directly on the homepage's "07 —
    // RESERVE" section, added 2026-08-06 to replace the cross-page
    // handoff to /book-direct/ (see booking-calendar.js's header comment)
    // with an in-place widget-src update — same reasoning as the two
    // script allowlist entries above.
    pathname === "/reserve-mini-calendar.js" ||
    pathname.startsWith("/api/cron/") ||
    // One-time bootstrap endpoints (run the DB migration, create the first
    // login) — each carries its own CRON_SECRET check inside the route, and
    // seed-user permanently refuses once any user already exists, so
    // there's no login to bounce these to yet anyway. See
    // api/admin/migrate and api/admin/seed-user for the full reasoning.
    pathname.startsWith("/api/admin/") ||
    pathname.startsWith("/admin/setup") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    // Phase 5 (PWA, 2026-08-08): the browser fetches the manifest and
    // service worker directly (not through a logged-in page load) — most
    // importantly, Chrome/Safari probe these on the /login page itself
    // before any session cookie exists, to decide whether to show the
    // "install app" prompt at all. Gating them behind login would mean the
    // dashboard could never be installed pre-login, and would break the
    // service worker's install/activate lifecycle post-login too, since it
    // needs to be fetchable from a plain, unauthenticated GET.
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname.startsWith("/icons/")
  ) {
    return NextResponse.next();
  }

  if (validUserSession) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
