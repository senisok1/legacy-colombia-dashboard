import { query, propertyGroupFilter } from "./db";

// Data layer for the Management tab's team activities + per-booking ops
// notes (migration 0021). Org-scoped like every other lib/*.ts — the
// organizationId is always a required, explicit argument here (no default-
// org fallback) since every caller already has a session in hand.

export type TeamActivity = {
  id: string;
  bookingId: number | null;
  authorEmail: string;
  authorName: string | null;
  kind: "note" | "activity";
  /** ALWAYS English — translated on write when the author writes in
   * another language, so an English-reading admin never sees a language
   * they can't read (2026-08-16, Seni's ask). */
  body: string;
  /** What the author actually typed, when that wasn't English. */
  bodyOriginal: string | null;
  authorLanguage: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  booking_id: string | null;
  author_email: string;
  author_name: string | null;
  kind: string;
  body: string;
  body_original: string | null;
  author_language: string | null;
  created_at: string;
};

function fromRow(r: Row): TeamActivity {
  return {
    id: r.id,
    bookingId: r.booking_id === null ? null : Number(r.booking_id),
    authorEmail: r.author_email,
    authorName: r.author_name,
    kind: r.kind === "note" ? "note" : "activity",
    body: r.body,
    bodyOriginal: r.body_original,
    authorLanguage: r.author_language,
    createdAt: r.created_at,
  };
}

/**
 * BUG FIX (2026-08-17 audit): team_activities had NO property_group_id column
 * at all, so the Management tab's general activity log and per-stay notes were
 * organization-wide — every property's board showed every other property's
 * "pool cleaned" / "restocked towels" entries, and a team member scoped to one
 * property could read another's operational notes. Migration
 * db/migrations/0035_team_activities_property_group.sql adds the column; this
 * read applies the standard propertyGroupFilter() convention (NULL counts as
 * the default legacy-colombia group, because every pre-multi-property row was
 * written by and about Legacy Colombia).
 *
 * `propertyGroupId` is OPTIONAL, and omitting it deliberately preserves the
 * old cross-property behaviour. The Management board — the caller this leak
 * was actually about — now passes it (api/management/route.ts's buildBoard),
 * so the log is genuinely scoped there. Cross-property admin/cron paths that
 * genuinely want everything should keep passing undefined.
 */
export async function listTeamActivities(
  organizationId: string,
  limit = 200,
  propertyGroupId?: string
): Promise<TeamActivity[]> {
  const rows = await query<Row>(
    `select id, booking_id, author_email, author_name, kind, body, body_original, author_language, created_at
     from team_activities
     where organization_id = $1${propertyGroupFilter(propertyGroupId, 3)}
     order by created_at desc
     limit $2`,
    propertyGroupId ? [organizationId, limit, propertyGroupId] : [organizationId, limit]
  );
  return rows.map(fromRow);
}

// ---- Per-stay ops flags (migration 0022): paid event scheduled + date ----

export type BookingOps = {
  bookingId: number;
  eventScheduled: boolean;
  eventDate: string | null; // YYYY-MM-DD
  eventTime: string | null; // "HH:MM" local wall-clock at the property
  eventGuestCount: number | null;
};

type OpsRow = {
  booking_id: string;
  event_scheduled: boolean;
  event_date: string | null;
  event_time: string | null;
  event_guest_count: number | null;
};

export async function listBookingOps(organizationId: string): Promise<Map<number, BookingOps>> {
  const rows = await query<OpsRow>(
    `select booking_id, event_scheduled, event_date::text as event_date, event_time, event_guest_count
     from booking_ops where organization_id = $1`,
    [organizationId]
  );
  return new Map(
    rows.map((r) => [
      Number(r.booking_id),
      {
        bookingId: Number(r.booking_id),
        eventScheduled: r.event_scheduled,
        eventDate: r.event_date,
        eventTime: r.event_time,
        eventGuestCount: r.event_guest_count === null ? null : Number(r.event_guest_count),
      },
    ])
  );
}

export async function upsertBookingOps(input: {
  organizationId: string;
  bookingId: number;
  eventScheduled: boolean;
  eventDate: string | null;
  eventTime: string | null;
  eventGuestCount: number | null;
  updatedBy: string;
}): Promise<void> {
  await query(
    `insert into booking_ops (organization_id, booking_id, event_scheduled, event_date, event_time, event_guest_count, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (organization_id, booking_id) do update set
       event_scheduled = excluded.event_scheduled,
       event_date = excluded.event_date,
       event_time = excluded.event_time,
       event_guest_count = excluded.event_guest_count,
       updated_by = excluded.updated_by,
       updated_at = now()`,
    [
      input.organizationId,
      input.bookingId,
      input.eventScheduled,
      input.eventDate,
      input.eventTime,
      input.eventGuestCount,
      input.updatedBy,
    ]
  );
}

/** Admin/Owner only (2026-08-18, Seni's ask: "add a delete tab under each
 * 'log what you did' line item that can be deleted by admin / owner's
 * only") — the CEO-only gate lives at the route layer
 * (api/management/activities/route.ts's DELETE), not here; this is just the
 * org-scoped delete itself. */
export async function deleteTeamActivity(organizationId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from team_activities where id = $1 and organization_id = $2 returning id`,
    [id, organizationId]
  );
  return rows.length > 0;
}

export async function createTeamActivity(input: {
  organizationId: string;
  /** The property this activity belongs to (2026-08-17 audit — see
   * listTeamActivities above). Optional so callers that predate the column
   * still compile; a NULL lands in the default legacy-colombia group, which
   * is what those rows meant historically. The one real write path,
   * src/app/api/management/activities/route.ts, does pass it. */
  propertyGroupId?: string | null;
  bookingId?: number | null;
  authorEmail: string;
  authorName?: string | null;
  kind: "note" | "activity";
  body: string;
  bodyOriginal?: string | null;
  authorLanguage?: string | null;
}): Promise<TeamActivity> {
  const rows = await query<Row>(
    `insert into team_activities (organization_id, property_group_id, booking_id, author_email, author_name, kind, body, body_original, author_language)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, booking_id, author_email, author_name, kind, body, body_original, author_language, created_at`,
    [
      input.organizationId,
      input.propertyGroupId ?? null,
      input.bookingId ?? null,
      input.authorEmail,
      input.authorName ?? null,
      input.kind,
      input.body,
      input.bodyOriginal ?? null,
      input.authorLanguage ?? null,
    ]
  );
  return fromRow(rows[0]);
}
