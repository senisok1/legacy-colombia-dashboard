import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { setCredential, listStoredKeys, type CredentialKey } from "@/lib/credentials";

// Lets a logged-in user manage their OWN organization's stored credentials
// (Phase 1's organization_credentials table) — scoped to req session's
// organizationId, never the Phase 0/1 getDefaultOrganizationId() bridge.
// This is the one place in the app so far that actually uses a real
// per-request tenant instead of that bridge.
//
// Note (see api/signup/route.ts's header comment for the full story):
// saving credentials here does NOT yet change what data that organization's
// dashboard shows, because lib/ownerrez.ts / lib/whatsapp.ts / etc. still
// read from the global config env vars, not from these per-org values —
// wiring that up is Phase 3. This route exists so onboarding UI and the
// storage layer can be built and tested ahead of that.
const VALID_KEYS = new Set<CredentialKey>([
  "ownerrez_email",
  "ownerrez_token",
  "ownerrez_property_name",
  "ownerrez_property_id",
  "ownerrez_additional_property_ids",
  "ownerrez_oauth_client_id",
  "ownerrez_oauth_client_secret",
  "ownerrez_oauth_token",
  "whatsapp_access_token",
  "whatsapp_phone_number_id",
  "whatsapp_business_account_id",
  "whatsapp_recipient_number",
  "whatsapp_verify_token",
  "whatsapp_gabriel_number",
  "pricelabs_api_key",
  "pricelabs_listing_id",
  "anthropic_api_key",
  "resend_api_key",
  "report_email_to",
]);

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const storedKeys = await listStoredKeys(session.organizationId);
  return NextResponse.json({ storedKeys });
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { key?: string; value?: string } | null;
  if (!body?.key || !VALID_KEYS.has(body.key as CredentialKey)) {
    return NextResponse.json({ error: "Unknown credential key." }, { status: 400 });
  }
  if (typeof body.value !== "string" || !body.value.trim()) {
    return NextResponse.json({ error: "Value is required." }, { status: 400 });
  }

  await setCredential(session.organizationId, body.key as CredentialKey, body.value.trim());
  return NextResponse.json({ ok: true });
}
