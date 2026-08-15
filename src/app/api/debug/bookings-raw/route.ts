import { NextRequest, NextResponse } from "next/server";
import { getBookings, getTargetProperties } from "@/lib/ownerrez";
import { getSessionFromRequest } from "@/lib/session";
import { bookingPace, isRevenueCounting } from "@/lib/finance";

// One-off diagnostic (2026-08-05) for "Messaging tab shows no conversations
// again + a known-good thread (Nyree, 11265042) resolves booking: null" —
// need to see whether getBookings() itself is missing bookings/threadIds
// right now, without needing ADMIN_SECRET (gated on a valid logged-in
// session instead, since this is being debugged live from the dashboard's
// own browser tab). Read-only. Safe to leave deployed like the other
// one-off debug routes.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  }

  const threadIdParam = req.nextUrl.searchParams.get("threadId");
  const targetThreadId = threadIdParam ? Number(threadIdParam) : undefined;

  const properties = await getTargetProperties(session.organizationId);
  const bookings = await getBookings(session.organizationId);

  const withThreadIds = bookings.filter((b) => b.threadIds.length > 0);
  const matching = targetThreadId
    ? bookings.filter((b) => b.threadIds.includes(targetThreadId))
    : [];

  // 2026-08-07 one-off addition: diagnosing whether the AI COO's "zero
  // occupancy across all forward windows" line is real or a bug, by
  // recomputing bookingPace() right here and listing every future
  // non-block booking with its status (isRevenueCounting only counts
  // Booked/Checked In/Checked Out — a future Hold/Inquiry/Quote wouldn't
  // show up in the pace numbers, which would be correct-but-confusing
  // rather than a bug).
  const now = new Date();
  const futureNonBlock = bookings
    .filter((b) => !b.isBlock && b.departure && new Date(b.departure) > now)
    .map((b) => ({
      id: b.id,
      status: b.status,
      arrival: b.arrival,
      departure: b.departure,
      totalAmount: b.totalAmount,
      countsTowardPace: isRevenueCounting(b),
    }));

  return NextResponse.json({
    properties: properties.map((p) => ({ id: p.id, name: p.name })),
    totalBookings: bookings.length,
    bookingsWithThreadIds: withThreadIds.length,
    bookingPace: {
      d30: bookingPace(bookings, 30),
      d90: bookingPace(bookings, 90),
      d365: bookingPace(bookings, 365),
    },
    futureNonBlockBookings: futureNonBlock,
    sample: bookings.slice(0, 5).map((b) => ({
      id: b.id,
      propertyId: b.propertyId,
      guestId: b.guestId,
      arrival: b.arrival,
      departure: b.departure,
      isBlock: b.isBlock,
      threadIds: b.threadIds,
    })),
    targetThreadId: targetThreadId ?? null,
    matchingBookings: matching.map((b) => ({
      id: b.id,
      propertyId: b.propertyId,
      guestId: b.guestId,
      arrival: b.arrival,
      departure: b.departure,
      isBlock: b.isBlock,
      threadIds: b.threadIds,
    })),
  });
}
