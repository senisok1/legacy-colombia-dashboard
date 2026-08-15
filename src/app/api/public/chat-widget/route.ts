import { NextRequest, NextResponse } from "next/server";
import { answerVisitorQuestion, ChatWidgetError, type ChatMessage } from "@/lib/chatWidget";
import { checkRateLimit, corsHeaders, getClientIp, handlePreflight, isAllowedOrigin } from "@/lib/publicApiGuard";

// Public, unauthenticated endpoint for the embeddable chat widget (see
// public/chat-widget.js) running on legacycolombia.com. Every other route in
// this app sits behind the dashboard's login — this one is intentionally
// open to anonymous website visitors, so it's locked down instead by CORS
// (only the legacycolombia.com origin gets a usable response) and a
// per-IP rate limit (see lib/publicApiGuard.ts) rather than auth.
//
// This route ONLY answers the visitor's question — it never sends Seni a
// WhatsApp notification. That only happens once the visitor actually hands
// over contact info, via the separate escalate/route.ts, so a visitor who
// never provides contact info never generates a notification.

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 20;
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
  const allowed = await checkRateLimit(ip, "chat-widget", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many messages — please try again in a bit." },
      { status: 429, headers }
    );
  }

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const rawHistory = Array.isArray(body?.history) ? body.history : [];

  if (!message) {
    return NextResponse.json({ error: "Missing 'message'." }, { status: 400, headers });
  }
  if (message.length > 2000) {
    return NextResponse.json({ error: "Message too long." }, { status: 400, headers });
  }

  const history: ChatMessage[] = rawHistory
    .filter(
      (m: unknown): m is ChatMessage =>
        !!m &&
        typeof m === "object" &&
        (("role" in m && (m as Record<string, unknown>).role === "user") ||
          (m as Record<string, unknown>).role === "assistant") &&
        typeof (m as Record<string, unknown>).content === "string"
    )
    .map((m: ChatMessage) => ({ role: m.role, content: m.content.slice(0, 2000) }));

  try {
    const answer = await answerVisitorQuestion(message, history);
    return NextResponse.json(answer, { headers });
  } catch (err) {
    console.error("[chat-widget] answerVisitorQuestion failed", err);
    const notConfigured = err instanceof ChatWidgetError && /ANTHROPIC_API_KEY/.test(err.message);
    return NextResponse.json(
      {
        error: notConfigured
          ? "Chat isn't set up yet."
          : "Something went wrong answering that — please try again.",
      },
      { status: 500, headers }
    );
  }
}
