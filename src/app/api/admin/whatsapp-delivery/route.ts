import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { redisGet } from "@/lib/redis";
import { sendGuestReplyApprovalTemplate, sendWhatsAppText, WhatsAppError } from "@/lib/whatsapp";

// ADMIN_SECRET-gated delivery diagnostics for the WhatsApp channel.
// GET  -> the rolling log of Meta delivery-status callbacks recorded by
//         api/whatsapp/webhook (sent/delivered/read/failed + error codes).
// POST -> fires a test send. Body: {"mode":"template"} (default) or
//         {"mode":"text"}. Returns the wamid or the raw send error. Pair a
//         POST with a GET ~20s later to see Meta's verdict on that wamid —
//         "delivered" means it reached the phone; "failed" carries the real
//         reason (e.g. 131049 per-user marketing limits, 131026
//         undeliverable, 130472 experiment holdout).
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  // ?discover=1 — enumerate phone numbers visible to the env access token
  // across candidate WABA ids. Built 2026-08-16: during the Neon DB outage
  // the env-var credential fallback kicked in, and its WHATSAPP_PHONE_NUMBER_ID
  // turned out to be stale (Graph 400 "Object does not exist") — the current
  // id lives only in the org's DB credential row. This reveals the right
  // ids so the env fallback can be corrected. Returns ids/display names
  // only, never tokens.
  if (req.nextUrl.searchParams.get("discover") === "1") {
    const candidates = [config.whatsappBusinessAccountId, "1551368173208827", "2990427064635202"]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    const results: Record<string, unknown> = { envPhoneNumberId: config.whatsappPhoneNumberId };
    for (const waba of candidates) {
      try {
        const res = await fetch(`https://graph.facebook.com/v21.0/${waba}/phone_numbers`, {
          headers: { Authorization: `Bearer ${config.whatsappAccessToken}` },
          cache: "no-store",
        });
        results[waba] = { status: res.status, body: await res.json().catch(() => null) };
      } catch (err) {
        results[waba] = { error: err instanceof Error ? err.message : "unknown" };
      }
    }
    return NextResponse.json({ ok: true, discovery: results });
  }

  const raw = await redisGet("wa:status-log").catch(() => null);
  return NextResponse.json({
    ok: true,
    recipientNumber: config.whatsappRecipientNumber || "(not set)",
    templateName: config.whatsappGuestReplyApprovalTemplate,
    statuses: raw ? JSON.parse(raw) : [],
  });
}

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  const mode = body.mode === "text" ? "text" : "template";

  try {
    const wamid =
      mode === "template"
        ? await sendGuestReplyApprovalTemplate({
            guestName: "Delivery Diagnostic",
            propertyName: config.propertyName || "Legacy Colombia",
            guestMessage: "This is a WhatsApp delivery diagnostic test.",
            suggestedReply: "If you can read this on your phone, template delivery works.",
          })
        : await sendWhatsAppText(
            "WhatsApp delivery diagnostic (plain text). If you can read this, the 24h session window is open."
          );
    return NextResponse.json({ ok: true, mode, wamid, note: "GET this route in ~20s to see Meta's delivery verdict for this wamid." });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      mode,
      error: err instanceof WhatsAppError || err instanceof Error ? err.message : "Unknown error",
    });
  }
}
