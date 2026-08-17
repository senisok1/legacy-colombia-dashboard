import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/lib/db";

import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
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
    const reviews = await getReviews(organizationId, effectivePropertyGroupId(
    req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
  ));
    const review = reviews.find((r) => r.id === response.review_id);

    if (!review) {
      return NextResponse.json({ ok: false, error: "Review not found" }, { status: 404 });
    }

    // WhatsApp send REMOVED 2026-08-17 (Seni: WhatsApp is only for inquiries,
    // guest messages and new bookings). This route used to push the approved
    // response to his own phone purely so he could copy it into OwnerRez —
    // OwnerRez has no write API for review replies. It now returns the
    // composed text instead, which the Reputation tab shows for copying, so
    // the feature still works without spending a WhatsApp message on it.
    const guestName = response.guest_name || review.guestName || "Guest";
    const message = `Hi ${guestName},\n\n${text}`;

    return NextResponse.json({
      ok: true,
      message: "Approved — copy the text below into OwnerRez's Quality Center.",
      guestName,
      responseText: message,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to prepare response";
    console.error(`POST /api/reputation/${id}/send failed:`, message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
