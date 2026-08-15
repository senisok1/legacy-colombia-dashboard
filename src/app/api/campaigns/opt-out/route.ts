import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { setGuestMarketingOptOut } from "@/lib/lifecycleMarketing";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Lets Seni permanently suppress a specific guest from ever being suggested
// as a lifecycle-marketing candidate again (consent/opt-out tracking — see
// db/migrations/0005_lifecycle_campaigns.sql's guest_marketing_preferences
// table). { guestId: number, optedOut: boolean, reason?: string }
//
// This may also be reached as a public, unauthenticated link from an email
// (not gated behind dashboard login) — no per-tenant routing exists for that
// path yet, so getSessionFromRequest simply returns null there and this
// falls back to the single default org, same as today.
export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.guestId !== "number" || typeof body.optedOut !== "boolean") {
    return NextResponse.json({ error: "Provide guestId (number) and optedOut (boolean)." }, { status: 400 });
  }
  await setGuestMarketingOptOut(body.guestId, body.optedOut, body.reason, session?.organizationId);
  return NextResponse.json({ ok: true });
}
