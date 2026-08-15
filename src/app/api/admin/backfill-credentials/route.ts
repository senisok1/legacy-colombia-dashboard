import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { getDefaultOrganizationId } from "@/lib/organizations";
import { setCredential, type CredentialKey } from "@/lib/credentials";
import { isCredentialsEncryptionConfigured } from "@/lib/crypto";

// One-time (safe-to-repeat) step: copies the current global env-var
// credentials (OWNERREZ_TOKEN, WHATSAPP_ACCESS_TOKEN, etc.) into the new
// per-tenant organization_credentials table for the existing customer's
// org, encrypted at rest. Purely additive — this does NOT stop the global
// env vars from working; lib/credentials.ts's resolvers still fall back to
// them for any org (including this one) that has no stored row. Running
// this just means the default org's row now takes precedence over the
// fallback, with no behavior change since the values are identical.
//
// Same HTTP-triggered pattern as api/admin/migrate for the same reason:
// this needs to run inside a live Vercel function to see the real env var
// values, and CREDENTIALS_ENCRYPTION_KEY plus DATABASE_URL are only ever
// readable there. Guarded by ADMIN_SECRET like the other admin routes.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }
  if (!isCredentialsEncryptionConfigured()) {
    return NextResponse.json({ error: "CREDENTIALS_ENCRYPTION_KEY isn't set on this deployment." }, { status: 400 });
  }

  try {
    const organizationId = await getDefaultOrganizationId();

    const values: Partial<Record<CredentialKey, string>> = {
      ownerrez_email: config.ownerRezEmail,
      ownerrez_token: config.ownerRezToken,
      ownerrez_property_name: config.propertyName,
      ownerrez_property_id: config.propertyId ? String(config.propertyId) : "",
      ownerrez_additional_property_ids: config.additionalPropertyIds.join(","),
      ownerrez_oauth_client_id: config.ownerRezOAuthClientId,
      ownerrez_oauth_client_secret: config.ownerRezOAuthClientSecret,
      ownerrez_oauth_token: config.ownerRezOAuthToken,
      whatsapp_access_token: config.whatsappAccessToken,
      whatsapp_phone_number_id: config.whatsappPhoneNumberId,
      whatsapp_business_account_id: config.whatsappBusinessAccountId,
      whatsapp_recipient_number: config.whatsappRecipientNumber,
      whatsapp_verify_token: config.whatsappVerifyToken,
      whatsapp_gabriel_number: config.whatsappGabrielNumber,
      pricelabs_api_key: config.pricelabsApiKey,
      pricelabs_listing_id: config.pricelabsListingId,
      anthropic_api_key: config.anthropicApiKey,
      resend_api_key: config.resendApiKey,
      report_email_to: config.reportEmailTo,
    };

    const stored: string[] = [];
    const skippedEmpty: string[] = [];
    for (const [key, value] of Object.entries(values) as [CredentialKey, string][]) {
      if (!value) {
        skippedEmpty.push(key);
        continue;
      }
      await setCredential(organizationId, key, value);
      stored.push(key);
    }

    return NextResponse.json({
      ok: true,
      organizationId,
      stored,
      skippedEmpty,
      message: `Stored ${stored.length} credential(s) for the default organization; ${skippedEmpty.length} skipped (no global value set).`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Backfill failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
