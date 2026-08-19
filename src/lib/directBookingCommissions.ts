import { query, queryOne } from "./db";
import type { Booking } from "./types";

// Gabriel's 10% direct-booking commission (2026-08-19, Seni's ask). Gabriel
// earns 10% on any guest stay he books directly, 90% to the house. Detected
// automatically rather than a manual flag: Seni tags these bookings "Gabriel
// Colombia Referral" in OwnerRez itself, and OwnerRez's `source` field
// passes through this app untouched (see lib/ownerrez.ts normalizeBooking),
// so any booking whose source contains "gabriel" (case-insensitive, per
// Seni's explicit ask — labels may vary slightly) is a candidate.
//
// The dollar split is NEVER stored — only which bookings are tracked and
// their approval/settlement state. computeSplit() below always derives the
// amount from the booking's CURRENT totalAmount, same never-store-a-derived-
// number philosophy as booking_extras' commission (see bookingExtras.ts).
// That also means if a booking's total changes before it's approved, the
// commission shown updates automatically rather than going stale.

export const COMMISSION_PCT_DEFAULT = 10;

/** Case-insensitive: matches "Gabriel Colombia Referral" and any similar
 * variant someone might type in OwnerRez later. */
export function isGabrielDirectBooking(source: string | null | undefined): boolean {
  return typeof source === "string" && /gabriel/i.test(source);
}

export type DirectBookingCommission = {
  id: string;
  bookingId: number;
  commissionPct: number;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  declined: boolean;
  declinedReason: string | null;
  settledAt: string | null;
  settlementId: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  booking_id: string;
  commission_pct: string;
  approved: boolean;
  approved_by_name: string | null;
  approved_at: string | Date | null;
  declined: boolean;
  declined_reason: string | null;
  settled_at: string | Date | null;
  settlement_id: string | null;
  created_at: string | Date;
};

const COLUMNS = `id, booking_id, commission_pct, approved, approved_by_name, approved_at,
  declined, declined_reason, settled_at, settlement_id, created_at`;

function iso(v: string | Date | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

function fromRow(r: Row): DirectBookingCommission {
  return {
    id: r.id,
    bookingId: Number(r.booking_id),
    commissionPct: Number(r.commission_pct),
    approved: r.approved,
    approvedByName: r.approved_by_name,
    approvedAt: iso(r.approved_at),
    declined: r.declined,
    declinedReason: r.declined_reason,
    settledAt: iso(r.settled_at),
    settlementId: r.settlement_id,
    createdAt: iso(r.created_at)!,
  };
}

/** Finds bookings that look like a Gabriel direct referral and haven't been
 * tracked yet, and inserts a pending row for each — so the Commissions tab
 * picks up a newly-flagged OwnerRez booking automatically on next load,
 * with no cron needed. Safe to call on every GET (ON CONFLICT DO NOTHING is
 * a no-op for bookings already tracked). */
export async function syncDirectBookingCommissions(input: {
  organizationId: string;
  bookings: Booking[];
}): Promise<void> {
  const candidateIds = input.bookings
    .filter((b) => !b.isBlock && b.status !== "Cancelled" && isGabrielDirectBooking(b.source))
    .map((b) => b.id);
  if (candidateIds.length === 0) return;
  await query(
    `insert into direct_booking_commissions (organization_id, booking_id)
     select $1, unnest($2::bigint[])
     on conflict (organization_id, booking_id) do nothing`,
    [input.organizationId, candidateIds]
  );
}

/** Every tracked direct-booking commission for the org, most recent first. */
export async function listDirectBookingCommissions(organizationId: string): Promise<DirectBookingCommission[]> {
  const rows = await query<Row>(
    `select ${COLUMNS} from direct_booking_commissions where organization_id = $1 order by created_at desc`,
    [organizationId]
  );
  return rows.map(fromRow);
}

/** Owner approval / decline. Route-level guard restricts this to CEO
 * logins — the actual gate is the CEO check in the API route, this is just
 * the org-scoped, settlement-locked write. */
export async function setDirectBookingApproval(input: {
  organizationId: string;
  id: string;
  approved: boolean;
  declined?: boolean;
  declinedReason?: string | null;
  byEmail: string;
  byName?: string | null;
}): Promise<DirectBookingCommission | null> {
  const row = await queryOne<Row>(
    `update direct_booking_commissions set
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
  return row ? fromRow(row) : null;
}

/** The 90/10 split for one commission row, computed live from the
 * booking's CURRENT totalAmount — never stored, see file header. Returns
 * null if the booking itself can no longer be found (e.g. very old/purged
 * from the OwnerRez window this app fetches). */
export function computeSplit(
  commission: DirectBookingCommission,
  booking: Booking | undefined
): { totalAmount: number; houseAmount: number; gabrielAmount: number } | null {
  if (!booking) return null;
  const total = Math.round(booking.totalAmount * 100) / 100;
  const gabrielAmount = Math.round(((total * commission.commissionPct) / 100) * 100) / 100;
  const houseAmount = Math.round((total - gabrielAmount) * 100) / 100;
  return { totalAmount: total, houseAmount, gabrielAmount };
}
