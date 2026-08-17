import { NextRequest, NextResponse } from "next/server";
import { upsertBookingOps } from "@/lib/teamActivities";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { getBookings } from "@/lib/ownerrez";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// Sets a stay's event flag + event date (Management tab). Allowlisted for
// READ_ONLY team logins in src/proxy.ts — on-site coordination data.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        bookingId?: number;
        eventScheduled?: boolean;
        eventDate?: string | null;
        eventTime?: string | null;
        eventGuestCount?: number | null;
      }
    | null;

  if (typeof body?.bookingId !== "number" || !Number.isFinite(body.bookingId)) {
    return NextResponse.json({ error: "bookingId is required." }, { status: 400 });
  }
  if (typeof body.eventScheduled !== "boolean") {
    return NextResponse.json({ error: "eventScheduled is required." }, { status: 400 });
  }
  const eventDate =
    typeof body.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.eventDate) ? body.eventDate : null;
  const eventTime =
    typeof body.eventTime === "string" && /^\d{2}:\d{2}$/.test(body.eventTime) ? body.eventTime : null;
  const eventGuestCount =
    typeof body.eventGuestCount === "number" && Number.isInteger(body.eventGuestCount) && body.eventGuestCount > 0
      ? Math.min(body.eventGuestCount, 500)
      : null;

  // bookingId authorisation (2026-08-17 audit).
  //
  // THE BUG: the bookingId above was taken straight from the request body and
  // written with no check that the stay belongs to the caller's property.
  // booking_ops is keyed on (organization_id, booking_id) ONLY, so a team
  // member scoped to one property could set the paid-event flag, date, time
  // and guest count on any other property's stay — OwnerRez booking ids are
  // sequential and trivially enumerable — and it would surface on that
  // property's Management board as a real scheduled event.
  //
  // Group resolution deliberately mirrors src/app/api/management/route.ts:
  // effectivePropertyGroupId() re-checks the cookie against the user's own
  // propertyAccess, so a hand-edited cookie can't widen the permitted set.
  // getBookings() is group-scoped and cached (60s), so this adds no real cost.
  const user = await getUserByEmail(session.email).catch(() => null);
  const groupId = effectivePropertyGroupId(
    req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    user?.propertyAccess
  );
  // Fail CLOSED on a lookup failure: an id we can't verify must not be
  // written, otherwise a transient OwnerRez outage reopens the hole.
  const bookings = await getBookings(session.organizationId, groupId).catch(() => null);
  if (!bookings) {
    return NextResponse.json(
      { error: "Couldn't verify which stay this belongs to just now. Please try again in a moment." },
      { status: 503 }
    );
  }
  if (!bookings.some((b) => b.id === body.bookingId)) {
    return NextResponse.json(
      { error: "That stay isn't part of the property you're viewing." },
      { status: 403 }
    );
  }

  try {
    await upsertBookingOps({
      organizationId: session.organizationId,
      bookingId: body.bookingId,
      eventScheduled: body.eventScheduled,
      eventDate: body.eventScheduled ? eventDate : null,
      eventTime: body.eventScheduled ? eventTime : null,
      eventGuestCount: body.eventScheduled ? eventGuestCount : null,
      updatedBy: session.email,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/management/booking-ops failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
