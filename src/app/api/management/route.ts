import { NextRequest, NextResponse } from "next/server";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { buildGuestsById, resolveGuestName } from "@/lib/guestName";
import { getAllPendingDrafts } from "@/lib/pendingDrafts";
import { listTeamActivities } from "@/lib/teamActivities";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Management-tab board data (2026-08-16): upcoming & in-house stays for the
// on-site team (cleaners, property manager, ...), each stay's ops notes,
// pending paid-extras signals, and the general team activity log. Read side
// of the Management tab — every logged-in role may read this (READ_ONLY
// included); writes go through /api/management/activities.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  try {
    const orgId = session.organizationId;
    const [bookings, guests, drafts, activities] = await Promise.all([
      getBookings(orgId),
      // Guest contact info (phone/email when the channel shares it — Airbnb/
      // Vrbo often withhold real email/phone; direct bookings have both).
      getGuests(orgId).catch(() => []),
      getAllPendingDrafts(orgId).catch(() => []),
      listTeamActivities(orgId).catch(() => []),
    ]);
    const guestsById = buildGuestsById(guests);

    // Stays the team actually works from: real bookings (no calendar
    // blocks) that haven't checked out yet (checkout today still shows —
    // that's the turnover the cleaners care about most).
    const todayMs = Date.now() - 24 * 60 * 60 * 1000;
    const upcoming = bookings
      .filter((b) => !b.isBlock && b.departure && new Date(b.departure).getTime() >= todayMs)
      .sort((a, b) => new Date(a.arrival || 0).getTime() - new Date(b.arrival || 0).getTime());

    // Paid-extras signal: a pending AI draft flagged as a service request
    // (chef, massage, jet ski, boat, transport...) on this booking.
    const extrasByBookingId = new Set(
      drafts.filter((d) => d.isServiceRequest && d.status === "pending").map((d) => d.bookingId)
    );

    const notes = activities.filter((a) => a.kind === "note" && a.bookingId !== null);
    const log = activities.filter((a) => a.kind === "activity");

    return NextResponse.json({
      stays: upcoming.map((b) => ({
        bookingId: b.id,
        guestName: resolveGuestName(b, guestsById) || "Guest",
        guestPhone: (b.guestId != null && guestsById.get(b.guestId)?.phone) || null,
        guestEmail: (b.guestId != null && guestsById.get(b.guestId)?.email) || null,
        propertyName: b.propertyName,
        arrival: b.arrival,
        departure: b.departure,
        nights: b.nights,
        adults: b.adults,
        children: b.children,
        source: b.source,
        totalAmount: b.totalAmount,
        extrasRequested: extrasByBookingId.has(b.id),
        notes: notes
          .filter((n) => n.bookingId === b.id)
          .map((n) => ({ id: n.id, body: n.body, author: n.authorName || n.authorEmail, at: n.createdAt })),
      })),
      activityLog: log
        .slice(0, 100)
        .map((a) => ({ id: a.id, body: a.body, author: a.authorName || a.authorEmail, at: a.createdAt })),
      viewerRole: session.role,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/management failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
