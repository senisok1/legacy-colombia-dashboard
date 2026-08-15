import { NextRequest, NextResponse } from "next/server";
import { getWhatsAppCredentials } from "@/lib/credentials";
import { getSessionFromRequest } from "@/lib/session";
import { getDefaultOrganizationId } from "@/lib/organizations";

export const dynamic = "force-dynamic";

// ONE-OFF diagnostic (2026-08-07): Seni reported not receiving ANY WhatsApp
// alerts (Lilian Barrios approval ping, Nyree approval ping, and a live
// manual test send via /api/debug/send-test-report all reported
// {sent:true} from Meta's Graph API, but nothing arrived on his phone).
// Since the send code throws on real Graph API errors and doesn't, the
// leading suspect is that the configured recipientNumber itself is stale/
// wrong for this org (Meta will happily accept and return a wamid for a
// valid-format number that isn't actually Seni's phone). Masks everything
// except the last 4 digits — safe to leave deployed briefly, delete once
// resolved.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const orgId = session?.organizationId ?? (await getDefaultOrganizationId());
  const creds = await getWhatsAppCredentials(orgId);

  function mask(v: string) {
    if (!v) return "(empty)";
    return v.length <= 4 ? v : `${"*".repeat(v.length - 4)}${v.slice(-4)}`;
  }

  return NextResponse.json({
    organizationId: orgId,
    recipientNumber: mask(creds.recipientNumber),
    recipientNumberLength: creds.recipientNumber.length,
    phoneNumberIdConfigured: Boolean(creds.phoneNumberId),
    accessTokenConfigured: Boolean(creds.accessToken),
    gabrielNumber: mask(creds.gabrielNumber),
  });
}
