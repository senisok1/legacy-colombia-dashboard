import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { redisGet } from "@/lib/redis";
import {
  sendGuestReplyApprovalTemplate,
  sendWhatsAppText,
  sendBookingNotificationTemplate,
  sendDailySummaryTemplate,
  WhatsAppError,
} from "@/lib/whatsapp";

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

  // Lists the message templates that actually exist on the WhatsApp Business
  // Account, with their status and category (2026-08-17). Added while
  // diagnosing why the new-booking alert never arrived: the code assumed
  // `booking_notification` existed, Meta returned 132001 "template name does
  // not exist", and the caller silently fell back to a free-text send that
  // the 24h window then blocked. Listing them removes the guesswork.
  if (req.nextUrl.searchParams.get("templates") === "1") {
    const wabaId = config.whatsappBusinessAccountId;
    if (!wabaId || !config.whatsappAccessToken) {
      return NextResponse.json(
        { ok: false, error: "WHATSAPP_BUSINESS_ACCOUNT_ID / WHATSAPP_ACCESS_TOKEN not set." },
        { status: 400 }
      );
    }
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`,
      { headers: { Authorization: `Bearer ${config.whatsappAccessToken}` }, cache: "no-store" }
    );
    const json = (await res.json()) as {
      data?: {
        name: string;
        status: string;
        category: string;
        language: string;
        components?: { type: string; text?: string; format?: string }[];
      }[];
      error?: unknown;
    };
    if (!res.ok) return NextResponse.json({ ok: false, error: json.error ?? "Unknown" }, { status: 502 });
    return NextResponse.json({
      ok: true,
      configured: {
        guestReplyApproval: config.whatsappGuestReplyApprovalTemplate,
        bookingNotification: config.whatsappBookingNotificationTemplate,
        dailySummary: config.whatsappDailySummaryTemplate,
        sessionOpener: config.whatsappSessionOpenerTemplate,
        templateLanguage: config.whatsappTemplateLanguage,
      },
      // components included (2026-08-18) — diagnosing why every carrier-sent
      // alert (new booking, admin reply) shows a "Daily Summary for X"
      // heading: need to see whether that's a static HEADER component or
      // static body text baked into daily_summary_alert's approved copy.
      templates: (json.data ?? []).map((t) => ({
        name: t.name,
        status: t.status,
        category: t.category,
        language: t.language,
        components: t.components,
      })),
    });
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

  // guestMessage/suggestedReply overridable (2026-08-17) so a REAL guest
  // message — newlines and all — can be tested, not just a tidy one-liner.
  // Meta rejects template body params containing newlines/tabs, which is the
  // difference between this diagnostic passing and the live alert failing.
  const body = (await req.json().catch(() => ({}))) as {
    mode?: string;
    guestMessage?: string;
    suggestedReply?: string;
  };
  const mode = body.mode === "text" ? "text" : body.mode === "booking" ? "booking" : body.mode === "booking-live" ? "booking-live" : "template";

  try {
    const wamid =
      // Exercises the SAME rung the live booking alert now uses (see
      // lib/bookingAlerts.ts) — daily_summary_alert carrying booking content,
      // because booking_notification doesn't exist on the account.
      mode === "booking-live"
        ? await sendDailySummaryTemplate({
            orgLabel: config.propertyName || "Legacy Colombia",
            headline: "New booking — Delivery Diagnostic",
            statsLine: "Sep 1 → Sep 5 (4 nights) · Airbnb · $2,400",
          })
        : mode === "booking"
        ? await sendBookingNotificationTemplate({
            guestName: "Delivery Diagnostic",
            propertyName: config.propertyName || "Legacy Colombia",
            dates: "Sep 1 → Sep 5 (4 nights)",
          })
        : mode === "template"
        ? await sendGuestReplyApprovalTemplate({
            guestName: "Delivery Diagnostic",
            propertyName: config.propertyName || "Legacy Colombia",
            guestMessage: body.guestMessage ?? "This is a WhatsApp delivery diagnostic test.",
            suggestedReply:
              body.suggestedReply ?? "If you can read this on your phone, template delivery works.",
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
