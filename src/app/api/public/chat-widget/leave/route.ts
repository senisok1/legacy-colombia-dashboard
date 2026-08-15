import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, corsHeaders, getClientIp, handlePreflight } from "@/lib/publicApiGuard";
import { markVisitorLeft } from "@/lib/chatEscalations";

// Public, unauthenticated endpoint fired via navigator.sendBeacon() when a
// visitor closes the tab/navigates away while an escalation is still
// pending or waiting to be picked up live — see public/chat-widget.js's
// pagehide/beforeunload handler. Lets the fallback sweep in
// api/cron/check-messages fire right away instead of waiting out the full
// 10-minute timeout. Best-effort only: sendBeacon can't guarantee delivery
// (backgrounded mobile tabs especially), which is exactly why the
// time-based fallback in getChatEscalationsNeedingFallback still exists as
// a backstop — this route is purely an optimization to make the common case
// (a visitor deliberately closing the tab) fall back faster.
//
// sendBeacon can't set a custom Content-Type or read the response, so this
// intentionally does the bare minimum and always returns quickly.

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req);
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  // Unlike the other routes, don't hard-reject an unrecognized/missing
  // origin — sendBeacon requests are fire-and-forget from the browser's
  // perspective (no JS ever reads the response), and rejecting outright
  // just means the beacon "fails" silently anyway. Still rate-limited below.

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip, "chat-widget-leave", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
  if (!allowed) {
    return NextResponse.json({ ok: false }, { status: 429, headers });
  }

  const body = await req.json().catch(() => null);
  const escalationId = typeof body?.escalationId === "string" ? body.escalationId.trim() : "";
  if (!escalationId) {
    return NextResponse.json({ ok: false }, { status: 400, headers });
  }

  await markVisitorLeft(escalationId).catch((err) => {
    console.error("[chat-widget/leave] markVisitorLeft failed", err);
  });

  return NextResponse.json({ ok: true }, { headers });
}
