import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { config } from "./config";
import type { Role } from "./users";

// A minimal signed session cookie for per-user login — HMAC-SHA256 over a
// JSON payload, verified with a constant-time comparison. No external auth
// library: this app's login needs (one credentials form, one cookie, no
// OAuth providers) don't justify the extra surface area of a full auth
// framework, and a hand-rolled token this small is easy to audit completely.
//
// Format: base64url(payload-json) + "." + base64url(hmac-sha256(payload, AUTH_SECRET))

export const SESSION_COOKIE_NAME = "lc_user_session";
// Cookie lifetime (2026-08-17 audit): cut from 30 days to 7. 30 days was only
// ever "matches the legacy password cookie", and for a login that carries
// financial data and team-member access that's an excessively long window for
// a leaked/stolen cookie to keep working. This is a COMPLEMENTARY mitigation —
// it bounds the blast radius — but it is NOT the real fix: the real fix is the
// `epoch` field below, which lets the owner kill any outstanding cookie
// immediately (deactivate/delete/demote/change-password) instead of waiting
// for it to age out. 7 days keeps day-to-day mobile use from re-prompting
// constantly while shrinking the passive-expiry window ~4x.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type SessionPayload = {
  userId: string;
  email: string;
  role: Role;
  organizationId: string;
  // Session-invalidation counter copied from users.session_epoch at login
  // (2026-08-17 audit). The proxy compares this against the live DB value on a
  // short-TTL cached lookup and rejects the token if it's behind — this is
  // what makes "deactivate/delete/demote/change-password" revoke a still-valid
  // 7-day cookie instead of it working until natural expiry. Optional on the
  // type because tokens minted before this field existed simply won't carry it
  // (the proxy coerces a missing value to 0). See lib/users.ts.
  epoch?: number;
  exp: number; // unix seconds
};

function sign(data: string): string {
  return crypto.createHmac("sha256", config.authSecret).update(data).digest("base64url");
}

export function createSessionToken(payload: Omit<SessionPayload, "exp">): string {
  const full: SessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token || !config.authSecret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Convenience for API routes (Phase 2+) that need to know which user/org is
 * making the request — e.g. to scope a query or a credentials write to
 * req.session's organizationId instead of the Phase 0/1 bridge
 * getDefaultOrganizationId(). Only understands the per-user session cookie;
 * routes that must also accept the legacy shared-password login (rare, and
 * that path has no concept of "which org" anyway) keep checking that
 * separately. Returns null for a missing/expired/invalid session — callers
 * should treat that as unauthenticated. */
export function getSessionFromRequest(req: NextRequest): SessionPayload | null {
  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(cookie);
}

/** Same as getSessionFromRequest, for Server Components / Server Actions,
 * which don't have a NextRequest to read cookies from — they use next/headers
 * instead. This was the actual Phase 3 gap found in the smoke test: every
 * interactive API route (api/guests/[id]/route.ts etc.) got session?.organizationId
 * threaded through via getSessionFromRequest, but every dashboard PAGE
 * (guests/page.tsx, bill-pay/page.tsx, etc. — the actual GET render path a
 * logged-in user's browser hits) was still calling data-layer functions with
 * zero arguments, so it always fell back to getDefaultOrganizationId() —
 * meaning a second tenant's dashboard silently rendered Legacy Estate
 * Rentals' real data instead of their own (or an empty state). Confirmed via
 * a real second signup-flow test org during the Phase 3 smoke test. */
export async function getServerSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(cookie);
}
