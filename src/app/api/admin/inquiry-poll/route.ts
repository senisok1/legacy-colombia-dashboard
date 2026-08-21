import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getDefaultOrganizationId } from "@/lib/organizations";
import { getRecentInquiries } from "@/lib/ownerrez";
import { pollInquiryAlerts, wasInquiryAlerted } from "@/lib/inquiryAlerts";

// Manual trigger/diagnostic for the inquiry-alert polling backstop
// (2026-08-21, Juan Botero's missed inquiry — see lib/inquiryAlerts.ts).
//
//   ?secret=ADMIN_SECRET&dry=1   → list what the poll SEES (raw inquiries +
//                                  per-inquiry alerted-already state), sends
//                                  nothing. Use this to verify OwnerRez's
//                                  real response shape.
//   ?secret=ADMIN_SECRET         → run one real poll cycle now (same code
//                                  path the every-minute cron runs).
//   &hours=N                     → override the dry-run lookback (default 48).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!config.adminSecret || req.nextUrl.searchParams.get("secret") !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const orgId = await getDefaultOrganizationId();
    const dry = req.nextUrl.searchParams.get("dry") === "1";

    if (dry) {
      const hours = Number(req.nextUrl.searchParams.get("hours")) || 48;
      const sinceUtc = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const inquiries = await getRecentInquiries(sinceUtc, orgId);
      const withState = await Promise.all(
        inquiries.map(async (i) => ({
          id: i.id,
          guestName: i.guestName,
          message: i.message?.slice(0, 300) ?? null,
          createdUtc: i.createdUtc,
          propertyId: i.propertyId,
          alreadyAlerted: i.id ? await wasInquiryAlerted(orgId, i.id).catch(() => false) : null,
          rawKeys: Object.keys(i.raw),
        }))
      );
      return NextResponse.json({ ok: true, dry: true, sinceUtc, count: inquiries.length, inquiries: withState });
    }

    const result = await pollInquiryAlerts(orgId);
    return NextResponse.json({ ok: true, dry: false, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/admin/inquiry-poll failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
