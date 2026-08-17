import { NextRequest, NextResponse } from "next/server";
import { upsertBookingOps } from "@/lib/teamActivities";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Sets a stay's event flag + event date (Management tab). Allowlisted for
// READ_ONLY team logins in src/proxy.ts — on-site coordination data.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { bookingId?: number; eventScheduled?: boolean; eventDate?: string | null; eventTime?: string | null }
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

  try {
    await upsertBookingOps({
      organizationId: session.organizationId,
      bookingId: body.bookingId,
      eventScheduled: body.eventScheduled,
      eventDate: body.eventScheduled ? eventDate : null,
      eventTime: body.eventScheduled ? eventTime : null,
      updatedBy: session.email,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/management/booking-ops failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
