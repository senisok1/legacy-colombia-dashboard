import { query } from "./db";
import type { BookingExtra } from "./bookingExtrasShared";

// Paid extras per guest stay (2026-08-17, Seni's ask) — see
// db/migrations/0034_booking_extras.sql for the data-model reasoning.
//
// Legacy Colombia only for now: EXTRAS_PROPERTY_GROUP_ID gates both the API
// and the UI. Other properties don't run add-on experiences through an
// on-site manager, and showing an empty commission panel on them would
// imply data was missing rather than not applicable.

export {
  EXTRAS_PROPERTY_GROUP_ID,
  EXTRA_KINDS,
  isValidExtraKind,
  extraKindLabel,
} from "./bookingExtrasShared";
export type { ExtraKind, BookingExtra } from "./bookingExtrasShared";

type ExtraRow = {
  id: string;
  booking_id: string;
  kind: string;
  custom_label: string | null;
  service_date: string | null;
  guest_paid: string;
  house_paid: string;
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string;
};

/** numeric comes back from pg as a string to preserve precision. */
function money(raw: string | null): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toExtra(r: ExtraRow): BookingExtra {
  const guestPaid = money(r.guest_paid);
  const housePaid = money(r.house_paid);
  return {
    id: r.id,
    bookingId: Number(r.booking_id),
    kind: r.kind,
    customLabel: r.custom_label,
    serviceDate: r.service_date,
    guestPaid,
    housePaid,
    commission: Math.round((guestPaid - housePaid) * 100) / 100,
    notes: r.notes,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

/** All extras for the org, grouped by booking — one query for the whole board. */
export async function listBookingExtras(organizationId: string): Promise<Map<number, BookingExtra[]>> {
  const rows = await query<ExtraRow>(
    `select id, booking_id, kind, custom_label, service_date::text as service_date,
            guest_paid, house_paid, notes, created_by, updated_by, updated_at
       from booking_extras
      where organization_id = $1
      order by service_date nulls last, created_at`,
    [organizationId]
  );
  const out = new Map<number, BookingExtra[]>();
  for (const row of rows) {
    const extra = toExtra(row);
    const list = out.get(extra.bookingId);
    if (list) list.push(extra);
    else out.set(extra.bookingId, [extra]);
  }
  return out;
}

export async function createBookingExtra(input: {
  organizationId: string;
  bookingId: number;
  kind: string;
  customLabel: string | null;
  serviceDate: string | null;
  guestPaid: number;
  housePaid: number;
  notes: string | null;
  createdBy: string;
}): Promise<BookingExtra> {
  const rows = await query<ExtraRow>(
    `insert into booking_extras
       (organization_id, booking_id, kind, custom_label, service_date, guest_paid, house_paid, notes, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     returning id, booking_id, kind, custom_label, service_date::text as service_date,
               guest_paid, house_paid, notes, created_by, updated_by, updated_at`,
    [
      input.organizationId,
      input.bookingId,
      input.kind,
      input.customLabel,
      input.serviceDate,
      input.guestPaid,
      input.housePaid,
      input.notes,
      input.createdBy,
    ]
  );
  return toExtra(rows[0]);
}

export async function updateBookingExtra(input: {
  organizationId: string;
  id: string;
  kind: string;
  customLabel: string | null;
  serviceDate: string | null;
  guestPaid: number;
  housePaid: number;
  notes: string | null;
  updatedBy: string;
}): Promise<BookingExtra | null> {
  // organization_id in the WHERE clause, not just the id: a uuid from one
  // org must never be editable from another's session.
  const rows = await query<ExtraRow>(
    `update booking_extras
        set kind = $3, custom_label = $4, service_date = $5,
            guest_paid = $6, house_paid = $7, notes = $8,
            updated_by = $9, updated_at = now()
      where organization_id = $1 and id = $2
      returning id, booking_id, kind, custom_label, service_date::text as service_date,
                guest_paid, house_paid, notes, created_by, updated_by, updated_at`,
    [
      input.organizationId,
      input.id,
      input.kind,
      input.customLabel,
      input.serviceDate,
      input.guestPaid,
      input.housePaid,
      input.notes,
      input.updatedBy,
    ]
  );
  return rows[0] ? toExtra(rows[0]) : null;
}

export async function deleteBookingExtra(organizationId: string, id: string): Promise<void> {
  await query(`delete from booking_extras where organization_id = $1 and id = $2`, [organizationId, id]);
}

/** Stay-level rollup shown under the extras list. */
export function extrasTotals(extras: BookingExtra[]): {
  guestPaid: number;
  housePaid: number;
  commission: number;
} {
  const guestPaid = extras.reduce((s, e) => s + e.guestPaid, 0);
  const housePaid = extras.reduce((s, e) => s + e.housePaid, 0);
  return {
    guestPaid: Math.round(guestPaid * 100) / 100,
    housePaid: Math.round(housePaid * 100) / 100,
    commission: Math.round((guestPaid - housePaid) * 100) / 100,
  };
}
