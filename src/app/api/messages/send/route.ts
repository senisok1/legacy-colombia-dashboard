import { NextRequest, NextResponse } from "next/server";
import { sendMessage } from "@/lib/ownerrez";
import { appendMessage } from "@/lib/store";
import { isMessagingConfigured } from "@/lib/config";
import { getSessionFromRequest } from "@/lib/session";
import { sendAdminReplyNotificationTemplate } from "@/lib/whatsapp";

type SendBody = {
  threadId: number;
  bookingId: number;
  guestId: number | null;
  guestName?: string;
  subject?: string;
  body: string;
  language?: "en" | "es";
};

// Actually pushes a reply into OwnerRez's messaging thread for a booking —
// it shows up for the guest exactly like a message sent from OwnerRez's own
// inbox. Requires the one-time OAuth connection at /api/oauth/start; see
// README for why (OwnerRez's Personal Access Tokens can't send messages).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!isMessagingConfigured()) {
    return NextResponse.json(
      {
        error:
          "OwnerRez messaging isn't connected yet. Visit /api/oauth/start once to connect it (see README's Messaging section).",
      },
      { status: 400 }
    );
  }

  const payload = (await req.json().catch(() => null)) as SendBody | null;
  if (!payload || !payload.threadId || !payload.body?.trim()) {
    return NextResponse.json({ error: "threadId and body are required." }, { status: 400 });
  }

  try {
    await sendMessage(payload.threadId, payload.body, session?.organizationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send message.";
    // Log the failed attempt too, so it's visible in the Sent log with a clear status.
    const failedEntry = await appendMessage({
      bookingId: payload.bookingId,
      guestId: payload.guestId,
      guestName: payload.guestName,
      subject: payload.subject ?? "Direct reply",
      language: payload.language ?? "en",
      body: payload.body,
      status: "failed",
    }, session?.organizationId);
    return NextResponse.json({ error: message, entry: failedEntry }, { status: 502 });
  }

  const entry = await appendMessage({
    bookingId: payload.bookingId,
    guestId: payload.guestId,
    guestName: payload.guestName,
    subject: payload.subject ?? "Direct reply",
    language: payload.language ?? "en",
    body: payload.body,
    status: "sent",
  }, session?.organizationId);

  // Send WhatsApp notification to admin (Seni) that a reply was sent
  try {
    await sendAdminReplyNotificationTemplate({
      guestName: payload.guestName ?? "Guest",
      guestMessage: payload.subject ?? "Guest inquiry",
      adminReply: payload.body,
    }, session?.organizationId);
  } catch (whatsappErr) {
    // Non-fatal: WhatsApp notification failed, but the message was sent successfully
    console.error("[messages/send] WhatsApp admin-reply notification failed:", whatsappErr);
  }

  return NextResponse.json({ ok: true, entry });
}
