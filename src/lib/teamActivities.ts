import { query } from "./db";

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
  body: string;
  createdAt: string;
};

type Row = {
  id: string;
  booking_id: string | null;
  author_email: string;
  author_name: string | null;
  kind: string;
  body: string;
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
    createdAt: r.created_at,
  };
}

export async function listTeamActivities(organizationId: string, limit = 200): Promise<TeamActivity[]> {
  const rows = await query<Row>(
    `select id, booking_id, author_email, author_name, kind, body, created_at
     from team_activities
     where organization_id = $1
     order by created_at desc
     limit $2`,
    [organizationId, limit]
  );
  return rows.map(fromRow);
}

// ---- Per-stay ops flags (migration 0022): paid event scheduled + date ----

export type BookingOps = {
  bookingId: number;
  eventScheduled: boolean;
  eventDate: string | null; // YYYY-MM-DD
  eventTime: string | null; // "HH:MM" local wall-clock at the property
};

type OpsRow = {
  booking_id: string;
  event_scheduled: boolean;
  event_date: string | null;
  event_time: string | null;
};

export async function listBookingOps(organizationId: string): Promise<Map<number, BookingOps>> {
  const rows = await query<OpsRow>(
    `select booking_id, event_scheduled, event_date::text as event_date, event_time
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
  updatedBy: string;
}): Promise<void> {
  await query(
    `insert into booking_ops (organization_id, booking_id, event_scheduled, event_date, event_time, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (organization_id, booking_id) do update set
       event_scheduled = excluded.event_scheduled,
       event_date = excluded.event_date,
       event_time = excluded.event_time,
       updated_by = excluded.updated_by,
       updated_at = now()`,
    [
      input.organizationId,
      input.bookingId,
      input.eventScheduled,
      input.eventDate,
      input.eventTime,
      input.updatedBy,
    ]
  );
}

export async function createTeamActivity(input: {
  organizationId: string;
  bookingId?: number | null;
  authorEmail: string;
  authorName?: string | null;
  kind: "note" | "activity";
  body: string;
}): Promise<TeamActivity> {
  const rows = await query<Row>(
    `insert into team_activities (organization_id, booking_id, author_email, author_name, kind, body)
     values ($1, $2, $3, $4, $5, $6)
     returning id, booking_id, author_email, author_name, kind, body, created_at`,
    [
      input.organizationId,
      input.bookingId ?? null,
      input.authorEmail,
      input.authorName ?? null,
      input.kind,
      input.body,
    ]
  );
  return fromRow(rows[0]);
}
