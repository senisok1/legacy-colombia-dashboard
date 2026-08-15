import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/lib/db";
import { sendWhatsAppText, WhatsAppError } from "@/lib/whatsapp";
import { getSessionFromRequest } from "@/lib/session";
import { getReviews } from "@/lib/ownerrez";
import { getDefaultOrganizationId } from "@/lib/organizations";

type ResponseRow = {
  id: string;
  review_id: number;
  guest_name: string | null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = getSessionFromRequest(req);
  const organizationId = session?.organizationId ?? (await getDefaultOrganizationId());

  try {
    const { text } = (await req.json()) as { text?: string };
    if (!text || !text.trim()) {
      return NextResponse.json({ ok: false, error: "Response text is required" }, { status: 400 });
    }

    // Fetch the reputation response from DB to get review_id
    const response = await queryOne<ResponseRow>(
      "select id, review_id, guest_name from reputation_responses where id = $1 and organization_id = $2",
      [id, organizationId]
    );

    if (!response) {
      return NextResponse.json({ ok: false, error: "Response not found" }, { status: 404 });
    }

    // Fetch all reviews to find the guest's phone/contact info
    const reviews = await getReviews(organizationId);
    const review = reviews.find((r) => r.id === response.review_id);

    if (!review) {
      return NextResponse.json({ ok: false, error: "Review not found" }, { status: 404 });
    }

    // Send via WhatsApp
    // For now, we'll send a simple text message. In the future, this could include
    // guest name and other context in the message.
    const guestName = response.guest_name || review.guestName || "Guest";
    const message = `Hi ${guestName},\n\n${text}`;

    await sendWhatsAppText(message);

    return NextResponse.json({
      ok: true,
      message: `Sent to ${guestName} via WhatsApp`,
    });
  } catch (err) {
    const message =
      err instanceof WhatsAppError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Failed to send response";
    console.error(`POST /api/reputation/${id}/send failed:`, message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
