import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "./lib/session";
import { getUserSessionEpoch } from "./lib/users";
import { isBillingEnforced } from "./lib/config";
import { getOrganizationById, getDefaultOrganizationId } from "./lib/organizations";
import { isOrgLocked } from "./lib/billing";

// Proxy (formerly "middleware") always runs on the Node.js runtime in
// Next.js 16+, so node:crypto is available here without extra config — and,
// crucially for the session-epoch check below, so is `pg` (the DB layer that
// getUserSessionEpoch reaches). This same file already imports node:crypto
// via lib/session.ts and builds fine, which confirms the Node runtime; a real
// Edge-runtime middleware could not do either.

// --- Session-epoch cache (2026-08-17 audit) ------------------------------
// SESSION INVALIDATION FIX. The signed cookie embeds role+org and lived up to
// 30 days (now 7, see lib/session.ts) with NO server-side revocation, so a
// deleted/deactivated/demoted/password-changed user's token kept working with
// its original privileges. The real fix is a per-user `session_epoch`
// (db/migrations/0036) that's stamped into the token at login and bumped in
// lib/users.ts on any of those events; a token whose epoch is behind the live
// DB value is now rejected here.
//
// WHY THE CHECK LIVES HERE, NOT IN lib/session.ts: the natural place would be
// getSessionFromRequest()/getServerSession(), but getSessionFromRequest() is
// SYNCHRONOUS and is called synchronously from ~40 route handlers outside this
// change's file scope — turning it async to await a DB read would break every
// one of them. The proxy is instead the single choke point every request
// already passes through (it's where the READ_ONLY role gate lives too), so
// enforcing here covers all pages and APIs with zero caller changes.
//
// WHY A CACHE: the proxy runs on EVERY request and must stay fast — a raw DB
// read per request is exactly what to avoid. So epochs are cached per warm
// instance for a short TTL; a revocation therefore propagates within at most
// EPOCH_TTL_MS (plus the fact that the very next login always re-reads). This
// trades a small revocation-latency window for not adding a DB round trip to
// the hot path. A DB error FAILS OPEN (admits the request) — the token is
// still signature- and expiry-checked, and hard-failing here would lock
// everyone out on a transient DB blip.
const EPOCH_TTL_MS = 60_000;
type EpochEntry = { epoch: number | null; at: number };
const epochCache = new Map<string, EpochEntry>();

/** Returns the user's current session epoch (null = no such user, e.g.
 * deleted), or the string "db-error" when the lookup itself failed and the
 * caller should fail open. Cached per warm instance for EPOCH_TTL_MS. */
async function currentSessionEpoch(email: string): Promise<number | null | "db-error"> {
  const key = email.toLowerCase();
  const now = Date.now();
  const cached = epochCache.get(key);
  if (cached && now - cached.at < EPOCH_TTL_MS) return cached.epoch;
  try {
    const epoch = await getUserSessionEpoch(email);
    epochCache.set(key, { epoch, at: now });
    return epoch;
  } catch {
    // Don't cache a failure; fail open for this request only.
    return "db-error";
  }
}

// --- Billing-lock cache (2026-08-17 audit) ------------------------------
// enforceBillingLock() only ran in page.tsx files, so a lapsed/canceled org's
// still-valid session could call every /api/* data route (and burn AI spend)
// indefinitely — the "hard lock" was a UI redirect, not an enforcement
// boundary. This adds the same lock at the proxy choke point so it covers
// APIs too.
//
// THREE SAFETY RAILS, because wrongly locking the real business is far worse
// than a lapsed trial reaching an API:
//   1. Inert unless Stripe is actually configured (isBillingEnforced()), so
//      it does NOTHING on this deployment today — pure future-proofing.
//   2. The DEFAULT org (the real Legacy Estate Rentals tenant) is NEVER
//      locked here regardless of subscription state.
//   3. Any DB/load error fails OPEN (admits the request).
// Cached per warm instance like the epoch check, for the same hot-path reason.
type LockEntry = { locked: boolean; at: number };
const lockCache = new Map<string, LockEntry>();
let defaultOrgIdPromise: Promise<string> | undefined;

async function isOrgBillingLocked(orgId: string): Promise<boolean> {
  if (!isBillingEnforced()) return false; // rail #1 — no Stripe, no lock
  const now = Date.now();
  const cached = lockCache.get(orgId);
  if (cached && now - cached.at < EPOCH_TTL_MS) return cached.locked;
  try {
    if (!defaultOrgIdPromise) defaultOrgIdPromise = getDefaultOrganizationId();
    const defaultOrgId = await defaultOrgIdPromise;
    if (orgId === defaultOrgId) {
      lockCache.set(orgId, { locked: false, at: now }); // rail #2
      return false;
    }
    const org = await getOrganizationById(orgId);
    const locked = org ? isOrgLocked(org) : false;
    lockCache.set(orgId, { locked, at: now });
    return locked;
  } catch {
    return false; // rail #3 — fail open
  }
}

export async function proxy(req: NextRequest) {
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
  const session = verifySessionToken(sessionCookie);
  const validUserSession = Boolean(session);

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
    // OwnerRez webhook events (see api/webhook/route.ts) — OwnerRez's
    // servers POST here with no login cookie. Without this entry those
    // POSTs get 307-redirected to /login and silently dropped, which was
    // the root cause of guest messages never reaching Seni's WhatsApp.
    pathname === "/api/webhook" ||
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
    // SESSION-EPOCH ENFORCEMENT (2026-08-17 audit). Before honoring the
    // token's embedded role/org, confirm it hasn't been revoked. A token whose
    // epoch is behind the live DB value — or whose user no longer exists — is
    // treated exactly as if it were unsigned: the page bounces to /login and
    // the API returns 401. This is what makes deactivate/delete/demote/
    // change-password take effect within the cache TTL instead of after up to
    // 7 days. DB errors fall through (fail open) — see currentSessionEpoch.
    const liveEpoch = await currentSessionEpoch(session!.email);
    const tokenEpoch = session!.epoch ?? 0; // pre-epoch tokens are treated as 0
    const revoked = liveEpoch === null || (liveEpoch !== "db-error" && liveEpoch !== tokenEpoch);
    if (revoked) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Your session is no longer valid. Please sign in again." },
          { status: 401 }
        );
      }
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("next", pathname);
      const res = NextResponse.redirect(loginUrl);
      // Proactively clear the dead cookie so the browser stops re-sending it.
      res.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
      return res;
    }

    // BILLING LOCK ENFORCEMENT (2026-08-17 audit). A lapsed org may no longer
    // reach data/AI routes — matching enforceBillingLock() on pages. Skipped
    // for the paths a locked org needs to RECOVER (view the billing page, run
    // checkout/portal, log out) and for its own password. Inert unless Stripe
    // is configured and never applies to the default org — see
    // isOrgBillingLocked's rails.
    const billingExempt =
      pathname.startsWith("/billing") ||
      pathname.startsWith("/api/billing") ||
      pathname === "/api/logout" ||
      pathname === "/api/settings/password" ||
      pathname === "/settings/account";
    if (!billingExempt && session!.organizationId && (await isOrgBillingLocked(session!.organizationId))) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "This organization's subscription is inactive. Update billing to continue." },
          { status: 402 }
        );
      }
      return NextResponse.redirect(new URL("/billing", req.url));
    }

    // CONSTRUCTION role gate (2026-08-20, Seni's ask: a login for the
    // construction team that "will only have access to the construction
    // management tab" — nothing else, not even Dashboard or their own
    // Settings page. Allowlist rather than the READ_ONLY block's denylist
    // below, since the allowed surface here is a single tab: anything not
    // explicitly listed is refused. Pages bounce to /construction; APIs get
    // 403. Checked BEFORE the READ_ONLY block since a session is exactly one
    // role — this return short-circuits so the (much wider) READ_ONLY
    // allowlist further down never runs for a CONSTRUCTION session.
    if (session!.role === "CONSTRUCTION") {
      const allowed =
        pathname === "/construction" ||
        pathname.startsWith("/construction/") ||
        pathname === "/api/construction" ||
        pathname.startsWith("/api/construction/") ||
        pathname === "/api/logout";
      if (!allowed) {
        if (pathname.startsWith("/api/")) {
          return NextResponse.json(
            { error: "This login only has access to Construction Management." },
            { status: 403 }
          );
        }
        return NextResponse.redirect(new URL("/construction", req.url));
      }
      return NextResponse.next();
    }

    // READ_ONLY role gate (2026-08-16, Seni's ask: a team login for
    // cleaners/property managers that "can view all tabs only but without
    // the ability to reply to guests or modify anything"). Enforced HERE,
    // at the single choke point every API request passes through, instead
    // of sprinkling role checks across ~40 mutating routes. GET/HEAD flow
    // freely (view everything); any write to /api/* is refused except the
    // handful a team member legitimately needs. The session's role can't
    // be forged: it lives inside the HMAC-signed session token verified
    // above (a tampered payload fails signature verification and never
    // reaches this branch).
    // Hard block (2026-08-16, Seni's ask): the admin-only areas aren't just
    // hidden from the team nav — a READ_ONLY session can't open them at all.
    // Pages bounce to /management; their APIs return 403.
    if (session!.role === "READ_ONLY") {
      const TEAM_BLOCKED_PREFIXES = [
        "/guests",
        "/crm-campaigns",
        "/sales-pipeline",
        "/messaging",
        "/approvals",
        "/reputation",
        "/marketing",
        "/activity",
        "/reports",
        "/revenue-management",
        "/api/messages",
        // Added 2026-08-17 with Seni's explicit tab list for team members:
        // Bill Pay and the admin-only Settings pages are owner territory.
        // NOTE: "/settings" itself is deliberately NOT blocked — the team
        // needs /settings and /settings/account (their own password).
        "/bill-pay",
        "/api/bill-pay",
        "/settings/team",
        "/api/settings/users",
        "/billing",
        "/vendors",
        "/maintenance",
      ];
      if (TEAM_BLOCKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
        if (pathname.startsWith("/api/")) {
          return NextResponse.json(
            { error: "This area is admin-only — team accounts can't access it." },
            { status: 403 }
          );
        }
        return NextResponse.redirect(new URL("/management", req.url));
      }

      // STRUCTURAL FIX (2026-08-17 audit). The blocklist above gates admin
      // PAGES but only ever listed three API prefixes by hand, and the role
      // gate further down only blocks non-GET methods. Net effect: a team
      // session couldn't open the Reports tab but could fetch
      // /api/reports/executive directly and read whole-portfolio financials
      // — same for /api/bills, /api/leads, /api/approvals (guest message
      // bodies), /api/marketing/contacts (guest PII) and ~8 others. The nav
      // was in fact polling several of them on every session.
      //
      // Enumerating what to block will always drift behind new routes, so
      // this is DEFAULT-DENY: a team session may reach only the APIs its own
      // five tabs actually need, and anything new is blocked until someone
      // deliberately adds it here.
      const TEAM_API_ALLOWLIST = [
        "/api/logout",
        "/api/translate", // reading Spanish guest threads
        // Team Management board + notes, event flags, extras, and (2026-08-19)
        // the Commissions ledger at /api/management/commissions — this
        // prefix covers all of them. Commissions' GET is fine to reach here
        // (Gabriel views the shared ledger); its PUT (approve/decline) and
        // POST (settle) are deliberately NOT in the write allowlist below,
        // so a READ_ONLY session gets a 403 before the route's own CEO
        // check even runs.
        "/api/management",
        "/api/team-expenses", // Team Expense Requests
        "/api/team-requests", // Team Requests (2026-08-18) — accept/deny tasks tagged to a teammate
        // (The Team Activity Log tab's own free-text feed has no API of its
        // own — it reads /api/management and writes /api/management/activities.)
        "/api/settings/password", // their OWN password (target comes from the cookie)
        "/api/settings/property-group", // property switcher (re-checks propertyAccess)
        "/api/settings/theme",
        "/api/settings/currency",
        "/api/exchange-rate", // display-only FX for the currency toggle
      ];
      if (
        pathname.startsWith("/api/") &&
        !TEAM_API_ALLOWLIST.some((p) => pathname === p || pathname.startsWith(`${p}/`))
      ) {
        return NextResponse.json(
          { error: "This area is admin-only — team accounts can't access it." },
          { status: 403 }
        );
      }
    }

    if (session!.role === "READ_ONLY" && !["GET", "HEAD", "OPTIONS"].includes(req.method) && pathname.startsWith("/api/")) {
      const readOnlyWriteAllowlist =
        pathname === "/api/logout" ||
        // The Management tab's own activity/notes endpoint — the one thing
        // the team is supposed to write (see api/management/activities).
        // POST only (2026-08-18) — DELETE is CEO-only and deliberately NOT
        // allowlisted here, so a team login can log activity but can't
        // remove anyone's entries; the route's own role check is the real
        // gate, this just keeps a READ_ONLY session from reaching it at all.
        (pathname === "/api/management/activities" && req.method === "POST") ||
        // Per-stay event flag + date (see api/management/booking-ops) —
        // same on-site coordination scope as activities/notes.
        pathname === "/api/management/booking-ops" ||
        // Paid extras per stay (2026-08-17, see api/management/extras).
        // Gabriel is the one who actually arranges chefs/massages/jet skis,
        // so he has to be able to record them or they never get logged.
        // POST (create) and PATCH (edit) only — DELETE is CEO-only
        // (2026-08-19 fix) and deliberately excluded here, same posture as
        // team-expenses' DELETE below. The route itself independently locks
        // PATCH once an extra is approved/settled and rejects editing
        // someone else's entry — this allowlist entry only controls whether
        // a READ_ONLY session can reach the route method at all.
        (pathname === "/api/management/extras" && (req.method === "POST" || req.method === "PATCH")) ||
        // Property-view switcher (a cookie-only view preference).
        pathname === "/api/settings/property-group" ||
        // Their OWN password (api/settings/password resolves the target user
        // from the session cookie, never from the body — a team member can
        // only ever change their own).
        pathname === "/api/settings/password" ||
        // Team Expense Requests (2026-08-17): the team raises them (POST)
        // and marks them completed (PUT). Approval is PATCH, which is NOT
        // allowlisted — and the route independently requires a CEO role.
        (pathname === "/api/team-expenses" && (req.method === "POST" || req.method === "PUT")) ||
        // Team Requests (2026-08-18): unlike expense approval, accept/deny
        // (PATCH) here is meant for a TEAM MEMBER — whoever got tagged — so
        // it IS allowlisted, unlike team-expenses' PATCH. The route itself
        // still independently checks that the caller is the tagged person
        // (or a CEO override); this allowlist entry only controls whether a
        // READ_ONLY session can reach the route at all.
        (pathname === "/api/team-requests" &&
          (req.method === "POST" || req.method === "PATCH" || req.method === "PUT")) ||
        // Team Request Notes (2026-08-18): the back-and-forth discussion
        // thread on a request — open to any team member, same posture as
        // the request lifecycle itself.
        (pathname === "/api/team-requests/notes" && req.method === "POST") ||
        // Team Request Edit (2026-08-18): the original requester correcting
        // their own request's details. The route independently re-checks
        // that the caller IS that requester (no CEO override) — this
        // allowlist entry only controls whether a READ_ONLY session can
        // reach the route at all.
        (pathname === "/api/team-requests/edit" && req.method === "PATCH") ||
        // Translation is a POST but modifies nothing — the team needs it to
        // read Spanish guest threads.
        pathname === "/api/translate";
      if (!readOnlyWriteAllowlist) {
        return NextResponse.json(
          { error: "This is a view-only team account — ask the owner to make changes." },
          { status: 403 }
        );
      }
    }
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
