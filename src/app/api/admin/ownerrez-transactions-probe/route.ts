import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getBookings, probeBookingFinancials } from "@/lib/ownerrez";

// One-off diagnostic (2026-08-18) for the Team Management "transactions on
// hover / balance owed" feature — confirms the REAL OwnerRez v2 field names
// against a live booking before building anything that touches money. See
// lib/ownerrez.ts's probeBookingFinancials for what this actually calls.
// ADMIN_SECRET-gated, read-only, safe to leave deployed.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const bookingIdParam = req.nextUrl.searchParams.get("bookingId");
  let bookingId = bookingIdParam ? Number(bookingIdParam) : null;

  try {
    if (!bookingId) {
      // Default to the first upcoming, non-block booking so this works with
      // just ?secret= — no need to already know a booking id.
      const bookings = await getBookings();
      const todayMs = Date.now();
      const upcoming = bookings.find(
        (b) => !b.isBlock && b.status !== "Cancelled" && b.departure && new Date(b.departure).getTime() >= todayMs
      );
      if (!upcoming) return NextResponse.json({ error: "No upcoming booking found to probe." }, { status: 404 });
      bookingId = upcoming.id;
    }

    const result = await probeBookingFinancials(bookingId);
    return NextResponse.json({ bookingId, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}
