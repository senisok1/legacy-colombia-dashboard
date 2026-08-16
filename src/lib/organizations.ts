import { query, queryOne, withClient } from "./db";
import { DEFAULT_THEME_ID, type ThemeId } from "./themes";

// Organizations = tenants. See db/migrations/0015_organizations.sql for the
// schema and docs/architecture/ for the full multi-tenancy plan.
//
// This file is intentionally small right now: it's the foundation phase
// (add the table, backfill existing data), not the phase where every route
// actually scopes its queries by organization yet — that's a later,
// larger refactor. getDefaultOrganizationId() below is a deliberate,
// temporary bridge: every place in the codebase that hasn't been taught to
// resolve "which tenant is this request for" yet can keep working exactly
// as before by falling back to the one pre-existing tenant (the current
// customer, Legacy Estate Rentals) until that refactor lands.

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

// "monthly" | "annual" — see db/migrations/0017_billing.sql. Not a union of
// SubscriptionStatus values; this is which billing *cadence* the org picked
// at Stripe Checkout, independent of trialing/active/past_due/canceled.
export type BillingInterval = "monthly" | "annual";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  billingInterval: BillingInterval;
  theme: ThemeId;
  // Settings > Currency. ISO 4217 code (e.g. "COP") or null when this org
  // hasn't turned on the USD/<currency> display toggle — see
  // CurrencyProvider.tsx and db/migrations/0019_secondary_currency.sql.
  secondaryCurrency: string | null;
  createdAt: string;
};

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string | null;
  billing_interval: BillingInterval;
  theme: string | null;
  secondary_currency: string | null;
  created_at: string;
};

function fromRow(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status,
    trialEndsAt: row.trial_ends_at,
    billingInterval: row.billing_interval ?? "monthly",
    theme: (row.theme as ThemeId) ?? DEFAULT_THEME_ID,
    secondaryCurrency: row.secondary_currency ?? null,
    createdAt: row.created_at,
  };
}

const ORG_COLUMNS =
  "id, name, slug, plan, stripe_customer_id, stripe_subscription_id, subscription_status, trial_ends_at, billing_interval, theme, secondary_currency, created_at";

export async function getOrganizationById(id: string): Promise<Organization | null> {
  const row = await queryOne<OrganizationRow>(`select ${ORG_COLUMNS} from organizations where id = $1`, [id]);
  return row ? fromRow(row) : null;
}

export async function getOrganizationBySlug(slug: string): Promise<Organization | null> {
  const row = await queryOne<OrganizationRow>(`select ${ORG_COLUMNS} from organizations where slug = $1`, [slug]);
  return row ? fromRow(row) : null;
}

export async function listOrganizations(): Promise<Organization[]> {
  const rows = await query<OrganizationRow>(`select ${ORG_COLUMNS} from organizations order by created_at asc`);
  return rows.map(fromRow);
}

/** Organizations whose subscription should be treated as "in good standing"
 * for the purposes of running scheduled jobs (cron) or letting the app
 * work at all — trialing or active. Used by Phase 3's per-tenant cron
 * loops so a lapsed/canceled customer's jobs stop running (and stop
 * incurring OwnerRez/Anthropic/WhatsApp API usage) without deleting their
 * data. */
export async function listActiveOrganizations(): Promise<Organization[]> {
  const rows = await query<OrganizationRow>(
    `select ${ORG_COLUMNS} from organizations where subscription_status in ('trialing', 'active') order by created_at asc`
  );
  return rows.map(fromRow);
}

/** Temporary bridge for code that hasn't been refactored to resolve the
 * tenant from the request/session yet. Returns the id of the single
 * pre-existing organization (the current customer). Once every route is
 * tenant-aware (Phase 3), calls to this function should disappear. */
let cachedDefaultOrgId: string | null = null;
// Last-resort constant fallback (2026-08-16): during the Neon "data transfer
// quota exceeded" outage, every cold-started lambda's first call here threw,
// which took down BOTH guest-message pipelines (the cron couldn't even list
// orgs; the webhook's createPendingDraft died resolving the org id) — guest
// approvals went silent even though Redis/OwnerRez/WhatsApp were all fine.
// The default org's id is effectively a constant (it's Seni's own org row,
// created once by migration 0015 and confirmed live 2026-08-15), so serving
// it when the DB is unreachable is always correct for this single-operator
// deployment. Overridable via DEFAULT_ORG_ID env var if the row is ever
// recreated.
const DEFAULT_ORG_ID_FALLBACK =
  (process.env.DEFAULT_ORG_ID || "").trim() || "12bddc76-c01d-4f7c-8fed-635aba3f7323";

export async function getDefaultOrganizationId(): Promise<string> {
  if (cachedDefaultOrgId) return cachedDefaultOrgId;
  try {
    const org = await getOrganizationBySlug("legacy-estate-rentals");
    if (!org) {
      throw new Error(
        "No default organization found — run the db migrations (db/migrations/0015_organizations.sql) first."
      );
    }
    cachedDefaultOrgId = org.id;
    return org.id;
  } catch (err) {
    console.error(
      "[organizations] getDefaultOrganizationId DB lookup failed — serving constant fallback:",
      err instanceof Error ? err.message : err
    );
    return DEFAULT_ORG_ID_FALLBACK;
  }
}

export async function createOrganization(input: { name: string; slug: string }): Promise<Organization> {
  const row = await queryOne<OrganizationRow>(
    `insert into organizations (name, slug)
     values ($1, $2)
     returning ${ORG_COLUMNS}`,
    [input.name, input.slug]
  );
  if (!row) throw new Error("Failed to create organization.");
  return fromRow(row);
}

/** Deletes a trial organization and its users — used only by
 * api/admin/delete-test-org to clean up signup-flow smoke tests. Refuses
 * to touch anything that isn't still on 'trial'/'trialing' as a guardrail
 * against ever deleting a real (paying or converted) tenant by mistake.
 * organization_credentials rows cascade automatically (see
 * db/migrations/0016_organization_credentials.sql's "on delete cascade");
 * users does not cascade, so those are deleted explicitly first. */
async function deleteTrialOrganization(org: Organization | null): Promise<{ deleted: boolean; reason?: string }> {
  if (!org) return { deleted: false, reason: "No organization found." };
  if (org.plan !== "trial" || org.subscriptionStatus !== "trialing") {
    return { deleted: false, reason: "Refusing to delete a non-trial organization." };
  }
  await withClient(async (client) => {
    await client.query("begin");
    try {
      // Every table migration 0015/0016 gave an organization_id column,
      // deleted in dependency order (children referencing agents/
      // properties/approvals/vendors before those parent tables, all before
      // organizations itself) — otherwise Postgres's default FK behavior
      // (RESTRICT) blocks the org delete one table at a time. Found via a
      // real cleanup attempt on a Phase 3 smoke-test org (2026-08-05) that
      // had actually exercised AI activity logging, not just page views.
      const orgScopedTablesInDeleteOrder = [
        "tasks",
        "ai_activity_log",
        "bills",
        "work_orders",
        "rate_snapshots",
        "rate_overrides",
        "approvals",
        "vendors",
        "properties",
        "agents",
        "knowledge_base_articles",
        "approval_thresholds",
        "guest_notes",
        "message_templates",
        "message_log",
        "leads",
        "lifecycle_campaign_candidates",
        "guest_marketing_preferences",
        "content_pieces",
        "reputation_responses",
        "marketing_contacts",
        "chat_escalations",
        "organization_credentials",
        "users",
      ];
      for (const table of orgScopedTablesInDeleteOrder) {
        await client.query(`delete from ${table} where organization_id = $1`, [org.id]);
      }
      await client.query("delete from organizations where id = $1", [org.id]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  });
  return { deleted: true };
}

export async function deleteTrialOrganizationBySlug(slug: string): Promise<{ deleted: boolean; reason?: string }> {
  return deleteTrialOrganization(await getOrganizationBySlug(slug));
}

// Same guardrails as deleteTrialOrganizationBySlug — added for Phase 3
// smoke-test cleanup, where a test org's slug wasn't known but its id was
// (surfaced via api/debug/whoami's session inspection).
export async function deleteTrialOrganizationById(id: string): Promise<{ deleted: boolean; reason?: string }> {
  return deleteTrialOrganization(await getOrganizationById(id));
}

const TRIAL_LENGTH_DAYS = 7;

/** Turns a company name into a URL/DB-safe slug ("Sunset Rentals LLC" ->
 * "sunset-rentals-llc"), then appends "-2", "-3", ... if that slug is
 * already taken — organizations.slug is unique (see
 * db/migrations/0015_organizations.sql). Used by signup (Phase 2) so a new
 * customer never has to think about picking a slug themselves. */
async function uniqueSlugFor(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "org";

  let candidate = base;
  let suffix = 2;
  while (await getOrganizationBySlug(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Self-serve signup entry point (Phase 2): creates a brand-new tenant on a
 * 14-day trial. Distinct from createOrganization() above (which just
 * inserts a bare row) because this owns the trial-length business rule and
 * the slug-generation convenience — signup shouldn't have to know either
 * detail. Does NOT create the org's first user; see api/signup/route.ts,
 * which calls this then upsertUser() with the returned id. */
export async function createTrialOrganization(name: string): Promise<Organization> {
  const slug = await uniqueSlugFor(name);
  const trialEndsAt = new Date(Date.now() + TRIAL_LENGTH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const row = await queryOne<OrganizationRow>(
    `insert into organizations (name, slug, plan, subscription_status, trial_ends_at)
     values ($1, $2, 'trial', 'trialing', $3)
     returning ${ORG_COLUMNS}`,
    [name, slug, trialEndsAt]
  );
  if (!row) throw new Error("Failed to create organization.");
  return fromRow(row);
}

export async function updateOrganizationSubscription(
  id: string,
  input: {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    subscriptionStatus?: SubscriptionStatus;
    plan?: string;
    billingInterval?: BillingInterval;
  }
): Promise<void> {
  await query(
    `update organizations set
       stripe_customer_id = coalesce($2, stripe_customer_id),
       stripe_subscription_id = coalesce($3, stripe_subscription_id),
       subscription_status = coalesce($4, subscription_status),
       plan = coalesce($5, plan),
       billing_interval = coalesce($6, billing_interval),
       updated_at = now()
     where id = $1`,
    [
      id,
      input.stripeCustomerId ?? null,
      input.stripeSubscriptionId ?? null,
      input.subscriptionStatus ?? null,
      input.plan ?? null,
      input.billingInterval ?? null,
    ]
  );
}

/** Settings > Appearance — lets a signed-in user pick their own org's
 * dashboard color scheme (see lib/themes.ts). Deliberately not gated to
 * the platform operator (unlike coupon management) — every tenant should
 * be able to theme their own dashboard, that's the whole point of the
 * feature. */
export async function updateOrganizationTheme(id: string, theme: ThemeId): Promise<void> {
  await query(`update organizations set theme = $2, updated_at = now() where id = $1`, [id, theme]);
}

/** Settings > Currency — lets a signed-in user turn on (or off) a live
 * USD/<currency> display toggle for their own org (see CurrencyProvider.tsx
 * and db/migrations/0019_secondary_currency.sql). Off (null) by default for
 * every tenant; each org picks its own secondary currency independently, so
 * one tenant billing in COP doesn't turn this on for anyone else. Pass null
 * to turn the toggle back off. Not gated to the platform operator, same
 * reasoning as updateOrganizationTheme above. */
export async function updateOrganizationSecondaryCurrency(id: string, currency: string | null): Promise<void> {
  await query(`update organizations set secondary_currency = $2, updated_at = now() where id = $1`, [id, currency]);
}
