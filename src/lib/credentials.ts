import { query, queryOne } from "./db";
import { encrypt, decrypt } from "./crypto";
import { config } from "./config";
import { getDefaultOrganizationId } from "./organizations";

// Per-tenant credential storage — the data layer for
// db/migrations/0016_organization_credentials.sql. Each organization can
// have its own OwnerRez/WhatsApp/PriceLabs credentials, encrypted at rest.
//
// Scope of this file (Phase 1 of the multi-tenant conversion): build the
// storage + a resolver API that FALLS BACK to the existing global env-var
// config whenever an organization has no stored value for a given key.
// That fallback is what keeps this purely additive — every existing call
// site in lib/ownerrez.ts, lib/whatsapp.ts, lib/pricelabs.ts etc. still
// gets the same global values as before until Phase 3 actually rewires
// those call sites to pass the request's organizationId through. Nothing
// here changes application behavior on its own.
//
// Phase 3 smoke-test finding (2026-08-05): that fallback was never scoped
// to just the default org. Once Phase 3 actually started passing real
// per-tenant organizationIds through (see lib/ownerrez.ts,
// lib/whatsapp.ts, lib/pricelabs.ts), a SECOND tenant with no credentials
// of its own configured yet silently inherited Legacy Colombia's real,
// live OwnerRez/WhatsApp/PriceLabs credentials via this exact fallback —
// confirmed live via a real second signup-flow test org. isDefaultOrg()
// below gates the config.* fallback to ONLY the one pre-existing tenant
// (Legacy Colombia, now backfilled into its own DB row via
// api/admin/backfill-credentials so this gating doesn't change its
// behavior at all) — any other org with nothing stored now correctly gets
// an empty/"not connected" credential instead of borrowing someone else's.
// Exported (2026-08-05) so lib/billingGate.ts / api/billing/coupons can
// reuse the exact same "is this the platform operator's own org" check for
// gating coupon management — same reasoning as the credential-fallback
// gate above: only Legacy Estate Rentals (Seni's own org) should be able to
// create Stripe promotion codes for the whole platform, not any tenant
// that later signs up.
export async function isDefaultOrg(organizationId: string): Promise<boolean> {
  try {
    return organizationId === (await getDefaultOrganizationId());
  } catch {
    // Can't tell which org is "default" (e.g. DB hiccup resolving it) —
    // stay conservative and say no, so a transient failure never
    // accidentally hands another tenant Legacy Colombia's real secrets.
    return false;
  }
}

/** Every credential key this app knows how to store per-tenant. Using a
 * union (rather than a free-form string) catches typos at the call site;
 * the underlying table itself is schemaless (see the migration) so adding
 * a new key here never needs a migration. */
export type CredentialKey =
  | "ownerrez_email"
  | "ownerrez_token"
  | "ownerrez_property_name"
  | "ownerrez_property_id"
  | "ownerrez_additional_property_ids"
  | "ownerrez_oauth_client_id"
  | "ownerrez_oauth_client_secret"
  | "ownerrez_oauth_token"
  | "whatsapp_access_token"
  | "whatsapp_phone_number_id"
  | "whatsapp_business_account_id"
  | "whatsapp_recipient_number"
  | "whatsapp_verify_token"
  | "whatsapp_gabriel_number"
  | "pricelabs_api_key"
  | "pricelabs_listing_id"
  | "anthropic_api_key"
  | "resend_api_key"
  | "report_email_to";

type CredentialRow = { key: CredentialKey; value_encrypted: string };

/** Raw get: the stored (decrypted) value for one key, or null if this
 * organization has never had this credential set. */
export async function getCredential(organizationId: string, key: CredentialKey): Promise<string | null> {
  const row = await queryOne<CredentialRow>(
    "select key, value_encrypted from organization_credentials where organization_id = $1 and key = $2",
    [organizationId, key]
  );
  return row ? decrypt(row.value_encrypted) : null;
}

/** Batch get, for resolver functions below that need several keys at once
 * without round-tripping per key. Returns only the keys that exist.
 *
 * Fails soft: if the DB is unreachable or misconfigured (a transient Neon
 * blip, or — as surfaced during Phase 3 build-testing — a local/dev
 * environment with no real DATABASE_URL at all), this logs and returns {}
 * rather than throwing. Every resolver below (getOwnerRezCredentials etc.)
 * treats an empty result as "no per-org override" and falls back to the
 * global config.* env vars, so a DB hiccup degrades to the pre-Phase-1
 * behavior instead of crashing the page/request that needed credentials.
 * Same "degrade gracefully" philosophy as the reviews endpoint and
 * additional-property fetches elsewhere in this codebase. */
export async function getCredentials(
  organizationId: string,
  keys: CredentialKey[]
): Promise<Partial<Record<CredentialKey, string>>> {
  if (keys.length === 0) return {};
  try {
    const rows = await query<CredentialRow>(
      "select key, value_encrypted from organization_credentials where organization_id = $1 and key = any($2::text[])",
      [organizationId, keys]
    );
    const out: Partial<Record<CredentialKey, string>> = {};
    for (const row of rows) out[row.key] = decrypt(row.value_encrypted);
    return out;
  } catch (err) {
    console.error("[credentials] getCredentials failed, falling back to global config:", err);
    return {};
  }
}

/** Stores (or overwrites) one credential for an organization. Pass an
 * empty string to intentionally clear a value while keeping the row (rare;
 * usually callers should use deleteCredential instead). */
export async function setCredential(organizationId: string, key: CredentialKey, value: string): Promise<void> {
  const encrypted = encrypt(value);
  await query(
    `insert into organization_credentials (organization_id, key, value_encrypted)
     values ($1, $2, $3)
     on conflict (organization_id, key) do update set
       value_encrypted = excluded.value_encrypted,
       updated_at = now()`,
    [organizationId, key, encrypted]
  );
}

export async function deleteCredential(organizationId: string, key: CredentialKey): Promise<void> {
  await query("delete from organization_credentials where organization_id = $1 and key = $2", [organizationId, key]);
}

/** Which of the given keys this organization has explicitly stored (as
 * opposed to falling back to the global config) — used by an admin/settings
 * screen to show "connected" vs "using shared default" per integration. */
export async function listStoredKeys(organizationId: string): Promise<CredentialKey[]> {
  const rows = await query<{ key: CredentialKey }>(
    "select key from organization_credentials where organization_id = $1",
    [organizationId]
  );
  return rows.map((r) => r.key);
}

// --- Resolver bags -----------------------------------------------------
// Shaped to match what lib/ownerrez.ts / lib/whatsapp.ts / lib/pricelabs.ts
// already read off `config.*` today, so wiring these in later (Phase 3) is
// a mechanical swap rather than a redesign. Every field falls back to the
// existing global config value when the organization hasn't stored its own.

export type OwnerRezCredentials = {
  email: string;
  token: string;
  propertyName: string;
  propertyId: number | undefined;
  additionalPropertyIds: number[];
  oauthClientId: string;
  oauthClientSecret: string;
  oauthToken: string;
};

export async function getOwnerRezCredentials(organizationId: string): Promise<OwnerRezCredentials> {
  const c = await getCredentials(organizationId, [
    "ownerrez_email",
    "ownerrez_token",
    "ownerrez_property_name",
    "ownerrez_property_id",
    "ownerrez_additional_property_ids",
    "ownerrez_oauth_client_id",
    "ownerrez_oauth_client_secret",
    "ownerrez_oauth_token",
  ]);
  const allowFallback = await isDefaultOrg(organizationId);
  return {
    email: c.ownerrez_email ?? (allowFallback ? config.ownerRezEmail : ""),
    token: c.ownerrez_token ?? (allowFallback ? config.ownerRezToken : ""),
    propertyName: c.ownerrez_property_name ?? (allowFallback ? config.propertyName : ""),
    propertyId: c.ownerrez_property_id ? Number(c.ownerrez_property_id) : allowFallback ? config.propertyId : undefined,
    additionalPropertyIds: c.ownerrez_additional_property_ids
      ? c.ownerrez_additional_property_ids
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
      : allowFallback
        ? config.additionalPropertyIds
        : [],
    oauthClientId: c.ownerrez_oauth_client_id ?? (allowFallback ? config.ownerRezOAuthClientId : ""),
    oauthClientSecret: c.ownerrez_oauth_client_secret ?? (allowFallback ? config.ownerRezOAuthClientSecret : ""),
    oauthToken: c.ownerrez_oauth_token ?? (allowFallback ? config.ownerRezOAuthToken : ""),
  };
}

export type WhatsAppCredentials = {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  recipientNumber: string;
  verifyToken: string;
  gabrielNumber: string;
};

export async function getWhatsAppCredentials(organizationId: string): Promise<WhatsAppCredentials> {
  const c = await getCredentials(organizationId, [
    "whatsapp_access_token",
    "whatsapp_phone_number_id",
    "whatsapp_business_account_id",
    "whatsapp_recipient_number",
    "whatsapp_verify_token",
    "whatsapp_gabriel_number",
  ]);
  const allowFallback = await isDefaultOrg(organizationId);
  return {
    accessToken: c.whatsapp_access_token ?? (allowFallback ? config.whatsappAccessToken : ""),
    phoneNumberId: c.whatsapp_phone_number_id ?? (allowFallback ? config.whatsappPhoneNumberId : ""),
    businessAccountId: c.whatsapp_business_account_id ?? (allowFallback ? config.whatsappBusinessAccountId : ""),
    recipientNumber: c.whatsapp_recipient_number ?? (allowFallback ? config.whatsappRecipientNumber : ""),
    verifyToken: c.whatsapp_verify_token ?? (allowFallback ? config.whatsappVerifyToken : ""),
    gabrielNumber: c.whatsapp_gabriel_number ?? (allowFallback ? config.whatsappGabrielNumber : ""),
  };
}

export type PriceLabsCredentials = {
  apiKey: string;
  listingId: string;
};

export async function getPriceLabsCredentials(organizationId: string): Promise<PriceLabsCredentials> {
  const c = await getCredentials(organizationId, ["pricelabs_api_key", "pricelabs_listing_id"]);
  const allowFallback = await isDefaultOrg(organizationId);
  return {
    apiKey: c.pricelabs_api_key ?? (allowFallback ? config.pricelabsApiKey : ""),
    listingId: c.pricelabs_listing_id ?? (allowFallback ? config.pricelabsListingId : ""),
  };
}

// Added 2026-08-05 ("bring your own Claude key" feature): unlike
// OwnerRez/WhatsApp/PriceLabs above, the platform's global ANTHROPIC_API_KEY
// fallback here is NOT gated by isDefaultOrg. Those other fallbacks are
// gated because they're real operational secrets tied to Legacy Colombia's
// specific property listings / phone number / channel-manager account —
// letting another tenant "fall back" to them would leak Seni's actual guest
// data and messaging capability to an unrelated org. An Anthropic key isn't
// tied to any tenant's operational data; every org has always shared the
// one platform key for every AI feature (guest reply drafting, translation,
// bill photo extraction, etc. — see aiReply.ts, translate.ts, billExtract.ts
// et al.), and that's an intentional, existing default that should keep
// working for any tenant who hasn't set their own. This resolver only adds
// an org-level override on top of that unrestricted default, so a paying
// tenant can plug in their own key (and pay their own Anthropic usage)
// without changing behavior for anyone who doesn't.
export async function getAnthropicCredentials(organizationId: string): Promise<{ apiKey: string }> {
  const c = await getCredentials(organizationId, ["anthropic_api_key"]);
  return {
    apiKey: c.anthropic_api_key ?? config.anthropicApiKey,
  };
}

/** Convenience wrapper for the ~9 call sites across aiReply.ts,
 * translate.ts, billExtract.ts, reputationManager.ts, revenueManager.ts,
 * lifecycleMarketing.ts, contentMarketing.ts, cooBriefing.ts, and
 * chatWidget.ts, which previously all read config.anthropicApiKey directly.
 * Mirrors lib/ownerrez.ts's resolveOwnerRezCredentials pattern: resolves an
 * undefined organizationId to the default org (so existing call paths that
 * don't yet thread a real org through — e.g. the public chat widget — keep
 * working exactly as before), and falls back to the raw global key on ANY
 * failure (DB hiccup, org lookup failure, etc.) so a credentials-layer
 * problem degrades to "use the platform key" rather than breaking AI
 * features outright. */
export async function resolveAnthropicApiKey(organizationId?: string): Promise<string> {
  try {
    const orgId = organizationId ?? (await getDefaultOrganizationId());
    const { apiKey } = await getAnthropicCredentials(orgId);
    return apiKey;
  } catch (err) {
    console.error("[credentials] resolveAnthropicApiKey falling back to global config key:", err);
    return config.anthropicApiKey;
  }
}
