import { NextRequest, NextResponse } from "next/server";
import { isRedisConfigured } from "./config";
import { redisGet, redisSet } from "./redis";

// Shared helpers for the public, unauthenticated chat-widget API routes
// (app/api/public/chat-widget/route.ts and .../escalate/route.ts) — every
// other route in this app sits behind the dashboard's password/session
// login, but these two are intentionally reachable from the open internet
// (an embedded <script> on legacycolombia.com calls them directly from a
// visitor's browser, with no login of their own). That means two things
// every other route gets for free have to be handled by hand here:
//   1. CORS — browsers only let JS on legacycolombia.com read the response
//      if we explicitly say so.
//   2. Rate limiting — an unauthenticated POST endpoint that calls the
//      Anthropic API is a standing invitation for abuse-driven API cost, so
//      every request is capped per IP via a simple Redis fixed-window
//      counter.

const ALLOWED_ORIGIN = "https://legacycolombia.com";

/** True if this request's Origin header is the one site allowed to call
 * these public routes. Non-browser callers (curl, server-to-server) don't
 * send an Origin header at all and so won't get CORS headers back — that's
 * fine, CORS is a browser-enforced concept, not a real access control; the
 * rate limiter is what actually bounds abuse cost. */
export function isAllowedOrigin(origin: string | null): boolean {
  return origin === ALLOWED_ORIGIN;
}

/** CORS headers to attach to every response (success or error) from these
 * routes when the request's Origin is the allowed one. Attaching them to
 * error responses too, not just success, so the widget's own JS can read
 * and show a real error message instead of a generic network-error state. */
export function corsHeaders(origin: string | null): HeadersInit {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    // Was "POST, OPTIONS" only, back when the chat-widget routes were the
    // only public callers — widened 2026-08-06 for the new public/availability
    // GET route (see app/api/public/availability/route.ts) without touching
    // any existing POST route's behavior.
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/** Handles an OPTIONS preflight request for a public chat-widget route. */
export function handlePreflight(req: NextRequest): NextResponse {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

/** Best-effort client IP from the header Vercel populates on every request
 * (this app has no other source of the real client IP — it always runs
 * behind Vercel's edge network, never directly exposed). */
export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
}

/**
 * Simple fixed-window rate limiter: at most `max` calls per `windowSeconds`
 * per (keyPrefix, ip) pair, backed by a single Redis counter key. Not
 * perfectly atomic (a GET then a SET, not INCR) — under true concurrent
 * hits from the same IP within the same millisecond it could let a couple
 * extra requests through, which is an acceptable tradeoff for a low-stakes
 * abuse guard rather than a hard billing cap. Fails OPEN (allows the
 * request) if Redis isn't configured at all, matching this app's existing
 * "degrade gracefully without Redis" pattern elsewhere (see
 * isRedisConfigured() callers) — better to let the widget work without
 * Redis set up than to hard-fail every request.
 */
export async function checkRateLimit(
  ip: string,
  keyPrefix: string,
  max: number,
  windowSeconds: number
): Promise<boolean> {
  if (!isRedisConfigured()) return true;

  const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `ratelimit:${keyPrefix}:${ip}:${windowId}`;

  try {
    const raw = await redisGet(key);
    const count = raw ? Number(raw) : 0;
    if (count >= max) return false;
    await redisSet(key, String(count + 1), { exSeconds: windowSeconds });
    return true;
  } catch {
    // Redis hiccup — fail open rather than break the widget over a
    // best-effort abuse guard.
    return true;
  }
}
