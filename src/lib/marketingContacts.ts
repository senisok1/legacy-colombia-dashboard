import { query, queryOne } from "./db";
import { getDefaultOrganizationId } from "./organizations";

// Marketing contacts audience list (migration 0010) — a bulk external
// contact list (Mailchimp/Facebook-ads lead-magnet export), separate from
// `guests` (real OwnerRez bookers) and `leads` (real booking-intent
// inquiries). Import/read only for now: there is no "send a campaign to
// this list" capability here, and none should be added without an explicit
// email-sending integration (Resend is currently only wired for the
// executive report, not bulk marketing sends) plus Seni's explicit approval,
// per this project's standing rule that any guest/contact-facing send stays
// behind human approval.

export type MarketingContact = {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  source: string;
  subscribedAt?: string;
  memberRating?: number;
  createdAt: string;
};

type MarketingContactRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  source: string;
  subscribed_at: Date | null;
  member_rating: number | null;
  created_at: Date;
};

function fromRow(row: MarketingContactRow): MarketingContact {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name ?? undefined,
    lastName: row.last_name ?? undefined,
    phone: row.phone ?? undefined,
    source: row.source,
    subscribedAt: row.subscribed_at ? row.subscribed_at.toISOString() : undefined,
    memberRating: row.member_rating ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listMarketingContacts(organizationId?: string): Promise<MarketingContact[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<MarketingContactRow>(
    "select * from marketing_contacts where organization_id = $1 order by created_at desc",
    [orgId]
  );
  return rows.map(fromRow);
}

export type MarketingContactStats = {
  total: number;
  bySource: { source: string; count: number }[];
};

export async function getMarketingContactStats(organizationId?: string): Promise<MarketingContactStats> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<{ source: string; count: string }>(
    "select source, count(*)::text as count from marketing_contacts where organization_id = $1 group by source order by count(*) desc",
    [orgId]
  );
  const bySource = rows.map((r) => ({ source: r.source, count: Number(r.count) }));
  const total = bySource.reduce((sum, r) => sum + r.count, 0);
  return { total, bySource };
}

/** Upserts a contact captured from an on-site form (Elementor webhook — see
 * app/api/webhooks/website-form/route.ts). Unlike the Mailchimp import, this
 * runs continuously and unattended, so it only ever fills in gaps on an
 * existing row (coalesce) rather than overwriting — a repeat visitor
 * resubmitting a form should never clobber data another source already
 * provided. source/subscribed_at are set only on first insert, preserving
 * where a contact was first captured. */
export async function upsertMarketingContactFromWebsite(
  input: {
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
  },
  organizationId?: string
): Promise<MarketingContact> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  // ON CONFLICT target must match migration 0015's composite unique index
  // marketing_contacts_org_email_idx(organization_id, email) — the old
  // single-column marketing_contacts_email_key constraint this used to
  // target was dropped there (two tenants may share a contact's email
  // address), so "on conflict (email)" alone would now error with "no
  // unique or exclusion constraint matching the ON CONFLICT specification"
  // instead of upserting.
  const row = await queryOne<MarketingContactRow>(
    `insert into marketing_contacts (organization_id, email, first_name, last_name, phone, source, subscribed_at)
     values ($1, $2, $3, $4, $5, 'website_form', now())
     on conflict (organization_id, email) do update set
       first_name = coalesce(marketing_contacts.first_name, excluded.first_name),
       last_name = coalesce(marketing_contacts.last_name, excluded.last_name),
       phone = coalesce(marketing_contacts.phone, excluded.phone)
     returning *`,
    [orgId, input.email.trim().toLowerCase(), input.firstName ?? null, input.lastName ?? null, input.phone ?? null]
  );
  if (!row) throw new Error("Failed to upsert marketing contact.");
  return fromRow(row);
}

/** Removes a contact (test submissions, spam, accidental duplicates). Sits
 * behind the same dashboard login as the rest of /api/marketing/contacts —
 * no separate secret needed. */
export async function deleteMarketingContact(id: string, organizationId?: string): Promise<boolean> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<{ id: string }>(
    "delete from marketing_contacts where id = $1 and organization_id = $2 returning id",
    [id, orgId]
  );
  return Boolean(row);
}
