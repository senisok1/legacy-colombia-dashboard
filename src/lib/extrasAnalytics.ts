import type { Booking } from "./types";
import type { BookingExtra } from "./bookingExtrasShared";
import { extraKindLabel } from "./bookingExtrasShared";
import { isRevenueCounting } from "./finance";

// Rolls per-stay paid extras up into revenue figures for the Dashboard and
// the Reports executive summary (2026-08-17, Seni's ask: "see total revenue
// but also see where it's coming from").
//
// THREE RULES THIS FILE ENFORCES.
//
// 1. ONLY THE HOUSE SHARE IS REVENUE. What the guest paid includes Gabriel's
//    commission, which is pass-through — it never belonged to the house.
//    houseRevenue is the number that may be added to booking revenue;
//    guestPaid is reported separately as gross volume, and commission is a
//    cost line. Summing guestPaid into revenue would overstate the business.
//
// 2. EXTRAS NEVER TOUCH ADR, RevPAR OR OCCUPANCY. Those are per-night stay
//    metrics benchmarked against PriceLabs and the market. Folding chef and
//    jet-ski money into them would inflate ADR against comparables and make
//    the rate engine think the property is underpriced when it isn't.
//    Nothing here is exported into those calculations — extras are added at
//    the total line only.
//
// 3. EVERY EXTRA GETS A DATE. service_date is optional on entry, so an extra
//    is attributed to its service date when set and otherwise to its
//    booking's ARRIVAL date. Attributing at read time rather than
//    backfilling a stored value means undated rows can never silently drop
//    out of a period total — the worst failure mode here, because the
//    remaining number still looks plausible.
//
// Property scoping comes for free: extras are keyed by booking_id, and
// callers pass only the bookings for the active property group, so an extra
// whose booking isn't in that list is never counted.

export type ExtrasKindBreakdown = {
  kind: string;
  label: string;
  count: number;
  guestPaid: number;
  houseRevenue: number;
  commission: number;
};

export type ExtrasSummary = {
  /** Extras rows counted in the window. */
  count: number;
  /** Total the guests paid — gross volume, NOT revenue. */
  guestPaid: number;
  /** The house's share. This is the only figure that may be added to revenue. */
  houseRevenue: number;
  /** Gabriel's share — a cost, not revenue. */
  commission: number;
  /** Stays in the window that had at least one extra, over all stays. */
  attachRatePct: number;
  staysWithExtras: number;
  totalStays: number;
  /** House revenue per stay across ALL stays (not just those with extras). */
  houseRevenuePerStay: number;
  byKind: ExtrasKindBreakdown[];
};

export const EMPTY_EXTRAS_SUMMARY: ExtrasSummary = {
  count: 0,
  guestPaid: 0,
  houseRevenue: 0,
  commission: 0,
  attachRatePct: 0,
  staysWithExtras: 0,
  totalStays: 0,
  houseRevenuePerStay: 0,
  byKind: [],
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Rule 3: service date when set, otherwise the booking's arrival date. */
function attributionDate(extra: BookingExtra, booking: Booking | undefined): string | null {
  if (extra.serviceDate) return extra.serviceDate;
  return booking?.arrival ? booking.arrival.slice(0, 10) : null;
}

/**
 * @param bookings   Bookings for the ACTIVE property group only.
 * @param extras     Extras keyed by booking id (lib/bookingExtras#listBookingExtras).
 * @param from/to    Inclusive YYYY-MM-DD window. Omit for all time.
 */
export function summarizeExtras(
  bookings: Booking[],
  extrasByBooking: Map<number, BookingExtra[]>,
  from?: string,
  to?: string
): ExtrasSummary {
  const bookingsById = new Map<number, Booking>();
  for (const b of bookings) bookingsById.set(b.id, b);

  // Denominator for attach rate: real, revenue-counting stays that arrived
  // in the window. A blocked-off or cancelled stay can't be sold an extra,
  // so including them would understate how well extras actually convert.
  const staysInWindow = bookings.filter((b) => {
    if (!isRevenueCounting(b) || !b.arrival) return false;
    const d = b.arrival.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  const byKind = new Map<string, ExtrasKindBreakdown>();
  const bookingIdsWithExtras = new Set<number>();
  let count = 0;
  let guestPaid = 0;
  let houseRevenue = 0;
  let commission = 0;

  for (const [bookingId, list] of extrasByBooking) {
    const booking = bookingsById.get(bookingId);
    if (!booking) continue; // different property group — never counted
    for (const extra of list) {
      const date = attributionDate(extra, booking);
      if (!date) continue;
      if (from && date < from) continue;
      if (to && date > to) continue;

      count += 1;
      guestPaid += extra.guestPaid;
      // 2026-08-19 fix: houseRevenue/commission now come from the corrected
      // 50/50 margin split (guestPaid - vendorPaid, halved) rather than the
      // old "the house gets whatever's typed in, Gabriel gets 100% of the
      // rest" formula — see migration 0039 and bookingExtras.ts's toExtra().
      houseRevenue += extra.houseShare;
      commission += extra.gabrielShare;
      bookingIdsWithExtras.add(bookingId);

      const label = extraKindLabel(extra.kind, extra.customLabel);
      // "Other" rows group under their own typed label, so "Boat charter"
      // and "Photographer" don't collapse into one meaningless bucket.
      const key = extra.kind === "other" ? `other:${label.toLowerCase()}` : extra.kind;
      const row = byKind.get(key) ?? {
        kind: extra.kind,
        label,
        count: 0,
        guestPaid: 0,
        houseRevenue: 0,
        commission: 0,
      };
      row.count += 1;
      row.guestPaid += extra.guestPaid;
      row.houseRevenue += extra.houseShare;
      row.commission += extra.gabrielShare;
      byKind.set(key, row);
    }
  }

  const totalStays = staysInWindow.length;
  // Only count stays that are actually in the denominator, so the rate can
  // never exceed 100% when an extra is attached to an older stay.
  const stayIds = new Set(staysInWindow.map((b) => b.id));
  const staysWithExtras = [...bookingIdsWithExtras].filter((id) => stayIds.has(id)).length;

  return {
    count,
    guestPaid: round2(guestPaid),
    houseRevenue: round2(houseRevenue),
    commission: round2(commission),
    attachRatePct: totalStays > 0 ? Math.round((staysWithExtras / totalStays) * 100) : 0,
    staysWithExtras,
    totalStays,
    houseRevenuePerStay: totalStays > 0 ? round2(houseRevenue / totalStays) : 0,
    byKind: [...byKind.values()]
      .map((r) => ({
        ...r,
        guestPaid: round2(r.guestPaid),
        houseRevenue: round2(r.houseRevenue),
        commission: round2(r.commission),
      }))
      .sort((a, b) => b.houseRevenue - a.houseRevenue),
  };
}

/** YYYY-MM-DD for the first day of the current year / month, local time. */
export function yearStartIso(now = new Date()): string {
  return `${now.getFullYear()}-01-01`;
}

export function monthStartIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}
