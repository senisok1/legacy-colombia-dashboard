import { NextRequest, NextResponse } from "next/server";
import { createTeamActivity } from "@/lib/teamActivities";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// The ONE write endpoint a READ_ONLY (team) session may call — explicitly
// allowlisted in src/proxy.ts's role gate. Cleaners/property managers use
// it to log their own activities ("pool cleaned", "restocked towels") and
// to add per-stay ops notes (paid-extras requests, wedding/event flags).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { body?: string; bookingId?: number; kind?: string }
    | null;

  const text = body?.body?.trim();
  if (!text) return NextResponse.json({ error: "Write something first." }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: "Keep it under 2000 characters." }, { status: 400 });

  const kind = body?.kind === "note" ? "note" : "activity";
  const bookingId = typeof body?.bookingId === "number" && Number.isFinite(body.bookingId) ? body.bookingId : null;
  if (kind === "note" && bookingId === null) {
    return NextResponse.json({ error: "Notes must be attached to a stay." }, { status: 400 });
  }

  try {
    const activity = await createTeamActivity({
      organizationId: session.organizationId,
      bookingId,
      authorEmail: session.email,
      authorName: null,
      kind,
      body: text,
    });
    return NextResponse.json({ ok: true, activity });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/management/activities failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
