import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, corsHeaders, getClientIp, handlePreflight, isAllowedOrigin } from "@/lib/publicApiGuard";
import { getChatEscalation, markDeliveredViaWidget } from "@/lib/chatEscalations";

// Public, unauthenticated endpoint the chat widget polls every few seconds
// after escalating a question, so Seni's WhatsApp-approved answer can appear
// live in the visitor's chat panel if they're still on the page — see
// public/chat-widget.js's poll loop and README's chat widget section.
//
// Deliberately dumb/cheap: no AI calls, one indexed DB lookup, and (only
// when there's actually a fresh answer to hand back) one UPDATE to mark it
// delivered so the fallback sweep in api/cron/check-messages doesn't also
// email/text the same answer a second time.

export const dynamic = "force-dynamic";

// Looser than the chat/escalate endpoints — this fires every few seconds
// for as long as one visitor's panel stays open, not once per message.
const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req);
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }
  const headers = corsHeaders(origin);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip, "chat-widget-poll", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
  if (!allowed) {
    return NextResponse.json({ answered: false }, { status: 429, headers });
  }

  const body = await req.json().catch(() => null);
  const escalationId = typeof body?.escalationId === "string" ? body.escalationId.trim() : "";
  if (!escalationId) {
    return NextResponse.json({ error: "Missing escalationId." }, { status: 400, headers });
  }

  const escalation = await getChatEscalation(escalationId).catch(() => null);
  if (!escalation) {
    // Escalation not found (bad id, or DB hiccup) — tell the widget to stop
    // polling rather than retry forever against something that'll never
    // resolve.
    return NextResponse.json({ answered: false, stopPolling: true }, { headers });
  }

  if (escalation.status === "rejected") {
    // Seni actively said NO — nothing is coming. Let the widget stop
    // politely instead of polling out the full timeout.
    return NextResponse.json({ answered: false, stopPolling: true }, { headers });
  }

  if (escalation.status === "answered" && escalation.finalAnswer) {
    await markDeliveredViaWidget(escalation.id).catch(() => {});
    return NextResponse.json({ answered: true, answer: escalation.finalAnswer }, { headers });
  }

  return NextResponse.json({ answered: false }, { headers });
}
