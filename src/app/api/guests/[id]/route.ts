import { NextRequest, NextResponse } from "next/server";
import { upsertCrmRecord } from "@/lib/store";
import { getSessionFromRequest } from "@/lib/session";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const guestId = Number(id);
  if (!Number.isFinite(guestId)) {
    return NextResponse.json({ error: "Invalid guest id" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const { notes, tags } = body as { notes?: string; tags?: string[] };
  try {
    const record = await upsertCrmRecord(guestId, { notes, tags }, session?.organizationId);
    return NextResponse.json(record);
  } catch (err) {
    // Surface the real Postgres error instead of a bare 500 with no body —
    // this route was silently swallowing failures (client-side
    // GuestNotesEditor never checks res.ok), which made a real save failure
    // invisible in the UI. See Phase 3 smoke-test investigation.
    console.error("[api/guests/:id PATCH] upsertCrmRecord failed", err);
    return NextResponse.json(
      { error: `Save failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
