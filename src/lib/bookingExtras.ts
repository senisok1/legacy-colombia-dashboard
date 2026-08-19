import { query, queryOne } from "./db";
import type { BookingExtra } from "./bookingExtrasShared";

// Paid extras per guest stay (2026-08-17, Seni's ask) — see
// db/migrations/0034_booking_extras.sql for the data-model reasoning, and
// db/migrations/0039_commissions.sql for the 2026-08-19 fixes: the
// guest_paid/vendor_paid margin is now split 50/50 between the house and
// Gabriel (was previously treated as 100% Gabriel commission — a bug), and
// an owner-approval lock was added so Gabriel can no longer edit or delete
// an extra once the owner has signed off on it.
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
  vendor_paid: string;
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string;
  approved: boolean;
  approved_by_name: string | null;
  approved_at: string | Date | null;
  declined: boolean;
  declined_reason: string | null;
  settled_at: string | Date | null;
  settlement_id: string | null;
};

const COLUMNS = `id, booking_id, kind, custom_label, service_date::text as service_date,
  guest_paid, vendor_paid, notes, created_by, updated_by, updated_at,
  approved, approved_by_name, approved_at, declined, declined_reason,
  settled_at, settlement_id`;

/** numeric comes back from pg as a string to preserve precision. */
function money(raw: string | null): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: string | Date | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

function toExtra(r: ExtraRow): BookingExtra {
  const guestPaid = money(r.guest_paid);
  const vendorPaid = money(r.vendor_paid);
  const margin = Math.round((guestPaid - vendorPaid) * 100) / 100;
  // Odd cent goes to the house's side so houseShare + gabrielShare always
  // equals margin exactly — two figures that silently failed to add up to
  // the number above them would be worse than no figure at all.
  const houseShare = Math.round((margin / 2) * 100) / 100;
  const gabrielShare = Math.round((margin - houseShare) * 100) / 100;
  return {
    id: r.id,
    bookingId: Number(r.booking_id),
    kind: r.kind,
    customLabel: r.custom_label,
    serviceDate: r.service_date,
    guestPaid,
    vendorPaid,
    margin,
    houseShare,
    gabrielShare,
    notes: r.notes,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    approved: r.approved,
    approvedByName: r.approved_by_name,
    approvedAt: iso(r.approved_at),
    declined: r.declined,
    declinedReason: r.declined_reason,
    settledAt: iso(r.settled_at),
    settlementId: r.settlement_id,
  };
}

/** All extras for the org, grouped by booking — one query for the whole board. */
export async function listBookingExtras(organizationId: string): Promise<Map<number, BookingExtra[]>> {
  const rows = await query<ExtraRow>(
    `select ${COLUMNS}
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

/** Approved-but-not-yet-settled extras for the Commissions tab — the
 * payable ledger. Excludes anything still awaiting owner review (never
 * treated as payable) and anything already folded into a past settlement. */
export async function listPayableExtras(organizationId: string): Promise<BookingExtra[]> {
  const rows = await query<ExtraRow>(
    `select ${COLUMNS}
       from booking_extras
      where organization_id = $1 and approved = true and settled_at is null
      order by service_date nulls last, created_at`,
    [organizationId]
  );
  return rows.map(toExtra);
}

/** Everything still awaiting the owner's approve/decline decision. */
export async function listPendingExtras(organizationId: string): Promise<BookingExtra[]> {
  const rows = await query<ExtraRow>(
    `select ${COLUMNS}
       from booking_extras
      where organization_id = $1 and approved = false and declined = false and settled_at is null
      order by service_date nulls last, created_at`,
    [organizationId]
  );
  return rows.map(toExtra);
}

export async function createBookingExtra(input: {
  organizationId: string;
  bookingId: number;
  kind: string;
  customLabel: string | null;
  serviceDate: string | null;
  guestPaid: number;
  vendorPaid: number;
  notes: string | null;
  createdBy: string;
}): Promise<BookingExtra> {
  const rows = await query<ExtraRow>(
    `insert into booking_extras
       (organization_id, booking_id, kind, custom_label, service_date, guest_paid, vendor_paid, notes, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     returning ${COLUMNS}`,
    [
      input.organizationId,
      input.bookingId,
      input.kind,
      input.customLabel,
      input.serviceDate,
      input.guestPaid,
      input.vendorPaid,
      input.notes,
      input.createdBy,
    ]
  );
  return toExtra(rows[0]);
}

/** Edit an existing extra. Locked once approved or settled — the WHERE
 * clause below is the real gate (route-level checks are UI convenience, not
 * the enforcement), same pattern as expenseRequests.ts's editExpenseRequest. */
export async function updateBookingExtra(input: {
  organizationId: string;
  id: string;
  kind: string;
  customLabel: string | null;
  serviceDate: string | null;
  guestPaid: number;
  vendorPaid: number;
  notes: string | null;
  updatedBy: string;
  /** True for a CEO/owner session — lets them fix anyone's entry, same as
   * TeamExpenseRequests. A team member may only ever edit their own. */
  requesterIsOwner: boolean;
}): Promise<BookingExtra | null> {
  // organization_id in the WHERE clause, not just the id: a uuid from one
  // org must never be editable from another's session. Lock rules (loosened
  // 2026-08-19, Seni's ask for an owner-only Edit on the Commissions tab's
  // approved list): a NON-owner may only edit their OWN entry and only while
  // it's still unapproved; the OWNER may edit any entry right up until it's
  // settled — he's the approver, so "approved" isn't a lock against him,
  // but a settled row is part of a permanent payout snapshot and stays
  // immutable for everyone. This WHERE clause is the actual protection, not
  // just a hidden button.
  const rows = await query<ExtraRow>(
    `update booking_extras
        set kind = $3, custom_label = $4, service_date = $5,
            guest_paid = $6, vendor_paid = $7, notes = $8,
            updated_by = $9, updated_at = now()
      where organization_id = $1 and id = $2 and settled_at is null
        and ($10 or (approved = false and created_by = $9))
      returning ${COLUMNS}`,
    [
      input.organizationId,
      input.id,
      input.kind,
      input.customLabel,
      input.serviceDate,
      input.guestPaid,
      input.vendorPaid,
      input.notes,
      input.updatedBy,
      input.requesterIsOwner,
    ]
  );
  return rows[0] ? toExtra(rows[0]) : null;
}

/** Owner-only "unlock" of a settled extra (2026-08-19, Seni's ask). Clears
 * settled_at/settlement_id so the row falls back into the unsettled/approved
 * pool and becomes editable there through the normal owner-edit path —
 * requires re-settling afterward. The ORIGINAL settlement record this row
 * was part of is never touched (see commissionSettlements.ts): its recorded
 * total stays a true permanent snapshot of what was actually paid, even
 * after one of its lines gets unlocked and corrected. Only settled rows
 * match the WHERE clause — unlocking something that isn't settled is a
 * no-op 404, not silently ignored. */
export async function unsettleBookingExtra(organizationId: string, id: string): Promise<BookingExtra | null> {
  const row = await queryOne<ExtraRow>(
    `update booking_extras set settled_at = null, settlement_id = null
      where organization_id = $1 and id = $2 and settled_at is not null
      returning ${COLUMNS}`,
    [organizationId, id]
  );
  return row ? toExtra(row) : null;
}

export async function deleteBookingExtra(organizationId: string, id: string): Promise<void> {
  await query(`delete from booking_extras where organization_id = $1 and id = $2`, [organizationId, id]);
}

/** Owner approval / decline for one extra. Route-level guard restricts this
 * to CEO logins; this is org-scoped so one tenant can never touch another's
 * rows. Locked once already settled. */
export async function setExtraApproval(input: {
  organizationId: string;
  id: string;
  approved: boolean;
  declined?: boolean;
  declinedReason?: string | null;
  byEmail: string;
  byName?: string | null;
}): Promise<BookingExtra | null> {
  const row = await queryOne<ExtraRow>(
    `update booking_extras set
       approved = $3,
       declined = $4,
       declined_reason = $5::text,
       approved_by_email = case when $3 or $4 then $6::text else null end,
       approved_by_name  = case when $3 or $4 then $7::text else null end,
       approved_at       = case when $3 or $4 then now() else null end
     where id = $2 and organization_id = $1 and settled_at is null
     returning ${COLUMNS}`,
    [
      input.organizationId,
      input.id,
      input.approved,
      input.declined ?? false,
      input.declinedReason ?? null,
      input.byEmail,
      input.byName ?? null,
    ]
  );
  return row ? toExtra(row) : null;
}

/** Stay-level rollup shown under the extras list. */
export function extrasTotals(extras: BookingExtra[]): {
  guestPaid: number;
  vendorPaid: number;
  houseShare: number;
  gabrielShare: number;
} {
  const guestPaid = extras.reduce((s, e) => s + e.guestPaid, 0);
  const vendorPaid = extras.reduce((s, e) => s + e.vendorPaid, 0);
  const houseShare = extras.reduce((s, e) => s + e.houseShare, 0);
  const gabrielShare = extras.reduce((s, e) => s + e.gabrielShare, 0);
  return {
    guestPaid: Math.round(guestPaid * 100) / 100,
    vendorPaid: Math.round(vendorPaid * 100) / 100,
    houseShare: Math.round(houseShare * 100) / 100,
    gabrielShare: Math.round(gabrielShare * 100) / 100,
  };
}
