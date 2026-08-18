import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

// ADMIN_SECRET-gated one-off template submission (2026-08-18, subject-line
// fix). Root cause of "all my WhatsApp messages say Daily Summary for
// Legacy Colombia": booking_notification and admin_reply_notification were
// never approved on the WABA (confirmed via
// /api/admin/whatsapp-delivery?templates=1 — only 7 templates exist, neither
// of these among them), so every send fell through to the daily_summary_alert
// carrier, whose approved body text has "Daily summary for {{1}}:" baked in
// as static (non-parameterized) copy — that heading can't be overridden per
// message, only replaced by submitting a real dedicated template. This route
// submits the three templates the fix depends on:
//   - booking_notification   (params: guestName, propertyName, dates)
//   - admin_reply_notification (params: guestName, guestMessage, adminReply)
//   - new_inquiry_alert      (params: guestName, question)
// Param order/count here MUST match lib/whatsapp.ts's send*Template functions
// exactly, or Meta approves the template but every real send then 400s on a
// parameter-count mismatch.
//
// Kept deployed for future reference (same pattern as
// ownerrez-transactions-probe) — resubmitting is a no-op once APPROVED, and
// harmless (just a duplicate "already exists" error) if run twice.
//
// GET /api/admin/whatsapp-submit-templates?secret=…
const TEMPLATES = [
  {
    name: config.whatsappBookingNotificationTemplate,
    category: "UTILITY",
    language: "en_US",
    components: [
      {
        type: "BODY",
        text: "🏠 *New Booking*\n\n{{1}} booked {{2}}\n{{3}}\n\nFull details in your CRM dashboard at crm.legacyestaterentals.com.",
        example: {
          body_text: [["Maria Gomez", "Legacy Colombia", "Sep 1 → Sep 5 (4 nights)"]],
        },
      },
    ],
  },
  {
    name: config.whatsappAdminReplyNotificationTemplate,
    category: "UTILITY",
    language: "en_US",
    components: [
      {
        type: "BODY",
        text: '✉️ *Admin Reply*\n\nAdmin replied to {{1}} in OwnerRez:\n"{{3}}"\n\nGuest\'s message: "{{2}}"\n\nFYI only — no action needed.',
        example: {
          body_text: [
            [
              "Lilian Barrios",
              "Is early check-in available on Friday",
              "Yes, early check-in is available for a $50 fee.",
            ],
          ],
        },
      },
    ],
  },
  {
    name: config.whatsappNewInquiryTemplate,
    category: "UTILITY",
    language: "en_US",
    components: [
      {
        type: "BODY",
        text: '❓ *New Inquiry*\n\nFrom {{1}}:\n"{{2}}"\n\nCheck OwnerRez to respond.',
        example: {
          body_text: [["Carlos Mendez", "Is the pool heated in December?"]],
        },
      },
    ],
  },
] as const;

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const wabaId = config.whatsappBusinessAccountId;
  if (!wabaId || !config.whatsappAccessToken) {
    return NextResponse.json(
      { ok: false, error: "WHATSAPP_BUSINESS_ACCOUNT_ID / WHATSAPP_ACCESS_TOKEN not set." },
      { status: 400 }
    );
  }

  const results: Record<string, unknown> = {};
  for (const tpl of TEMPLATES) {
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/message_templates`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tpl),
      });
      const json = await res.json().catch(() => null);
      results[tpl.name] = { ok: res.ok, status: res.status, body: json };
    } catch (err) {
      results[tpl.name] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, submitted: results });
}
