-- Per-tenant credential storage (Phase 1 of the multi-tenant SaaS
-- conversion — see db/migrations/0015_organizations.sql for the tenant
-- model itself). Each row is one named secret (e.g. "ownerrez_token",
-- "whatsapp_access_token") scoped to one organization, encrypted at rest
-- with AES-256-GCM using the CREDENTIALS_ENCRYPTION_KEY master key (see
-- src/lib/crypto.ts). Key names are free-form application-level strings,
-- not enumerated here, so adding a new kind of credential later never
-- needs a migration.
--
-- This migration is purely additive — it does not change any application
-- behavior yet. Existing global env-var credentials (OWNERREZ_TOKEN,
-- WHATSAPP_ACCESS_TOKEN, etc.) keep working exactly as before;
-- src/lib/credentials.ts's resolver functions fall back to them whenever a
-- given organization has no row here. A later step backfills the current
-- customer's real values into this table for the default org, and later
-- still (Phase 3) every OwnerRez/WhatsApp/PriceLabs call site is rewired to
-- resolve credentials per-tenant instead of from the global config.

create table if not exists organization_credentials (
  organization_id text not null references organizations(id) on delete cascade,
  key text not null,
  -- Encrypted at rest: base64(iv) || ':' || base64(authTag) || ':' || base64(ciphertext).
  -- See src/lib/crypto.ts's encrypt()/decrypt(). Never stores plaintext.
  value_encrypted text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, key)
);

create index if not exists organization_credentials_org_idx on organization_credentials(organization_id);
