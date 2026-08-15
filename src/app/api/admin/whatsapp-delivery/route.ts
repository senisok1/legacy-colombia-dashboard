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
