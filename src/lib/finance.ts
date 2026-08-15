import { differenceInCalendarDays, format, parseISO, startOfMonth, subMonths } from "date-fns";
import type { Booking } from "./types";

const REVENUE_COUNTING_STATUSES = new Set(["Booked", "Checked In", "Checked Out"]);

export function isRevenueCounting(b: Booking): boolean {
  // Calendar blocks (e.g. Airbnb iCal "not available" placeholders) have no
  // real guest or revenue attached, even though OwnerRez marks them "active".
  return !b.isBlock && REVENUE_COUNTING_STATUSES.has(b.status);
}

// totalAmount is the GROSS amount charged to the guest. hostFee (OwnerRez's
// `total_host_fees`) is what's deducted before Seni actually gets paid —
// computed here rather than stored on the booking so gross and net can
// never drift out of sync with each other.
export function netAmount(b: Booking): number {
  return Math.max(0, (b.totalAmount || 0) - (b.hostFee || 0));
}

export type MonthlyRevenue = {
  month: string;
  label: string;
  revenue: number;
  netRevenue: number;
  nights: number;
  bookings: number;
};

export function revenueByMonth(bookings: Booking[], monthsBack = 12): MonthlyRevenue[] {
  const buckets = new Map<string, MonthlyRevenue>();
  const start = startOfMonth(subMonths(new Date(), monthsBack - 1));

  for (let i = 0; i < monthsBack; i++) {
    const d = startOfMonth(subMonths(new Date(), monthsBack - 1 - i));
    const key = format(d, "yyyy-MM");
    buckets.set(key, { month: key, label: format(d, "MMM yyyy"), revenue: 0, netRevenue: 0, nights: 0, bookings: 0 });
  }

  for (const b of bookings) {
    if (!isRevenueCounting(b) || !b.arrival) continue;
    const arrival = parseISO(b.arrival);
    if (arrival < start) continue;
    const key = format(arrival, "yyyy-MM");
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.revenue += b.totalAmount || 0;
    bucket.netRevenue += netAmount(b);
    bucket.nights += b.nights || 0;
    bucket.bookings += 1;
  }

  return Array.from(buckets.values());
}

export type SourceBreakdown = { source: string; revenue: number; netRevenue: number; bookings: number };

export function revenueBySource(bookings: Booking[]): SourceBreakdown[] {
  const map = new Map<string, SourceBreakdown>();
  for (const b of bookings) {
    if (!isRevenueCounting(b)) continue;
    const key = b.source || "Direct";
    const bucket = map.get(key) ?? { source: key, revenue: 0, netRevenue: 0, bookings: 0 };
    bucket.revenue += b.totalAmount || 0;
    bucket.netRevenue += netAmount(b);
    bucket.bookings += 1;
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
}

// Shared accrual engine for every trailing-window metric (occupancy, ADR,
// RevPAR): clips each booking's stay to the [windowStart, now] window and
// allocates nights/revenue proportionally, rather than crediting a booking's
// FULL length of stay to the window just because its arrival date falls
// inside it. Without this clipping, a 10-night stay that arrived 3 days ago
// would count as 10 "occupied" nights in a 30-day window even though 7 of
// those nights haven't happened yet — which is exactly what was inflating
// RevPAR relative to occupancy before this fix (RevPAR should always equal
// ADR x occupancy; that identity only holds if all three share this same
// clipped-nights basis).
// Same overlap-clipping accrual as accrueInWindow below, generalized to an
// arbitrary [rangeStart, rangeEnd) instead of always ending "now" — needed
// by lib/trendReport.ts to compute a PRIOR period's occupancy/ADR/RevPAR on
// the exact same basis as the current one (e.g. "the 7 days before last
// week"), which accrueInWindow can't express since it's anchored to today.
export function accrueInDateRange(
  bookings: Booking[],
  rangeStart: Date,
  rangeEnd: Date
): { nights: number; grossRevenue: number; netRevenue: number } {
  let nights = 0;
  let grossRevenue = 0;
  let netRevenue = 0;

  for (const b of bookings) {
    if (!isRevenueCounting(b) || !b.arrival || !b.departure) continue;
    const arrival = parseISO(b.arrival);
    const departure = parseISO(b.departure);
    const totalNights = b.nights && b.nights > 0 ? b.nights : nightsBetween(b.arrival, b.departure);
    if (totalNights <= 0) continue;

    const overlapStart = arrival > rangeStart ? arrival : rangeStart;
    const overlapEnd = departure < rangeEnd ? departure : rangeEnd;
    const overlapNights = Math.min(differenceInCalendarDays(overlapEnd, overlapStart), totalNights);
    if (overlapNights <= 0) continue;

    const share = overlapNights / totalNights;
    nights += overlapNights;
    grossRevenue += (b.totalAmount || 0) * share;
    netRevenue += netAmount(b) * share;
  }

  return { nights, grossRevenue, netRevenue };
}

/** Bookings actually MADE (OwnerRez's created_utc) within [rangeStart,
 * rangeEnd) — booking "pickup" for the period, as opposed to
 * accrueInDateRange's stay-date occupancy. Same distinction executiveReport.ts
 * already draws for "Revenue today," generalized to an arbitrary range for
 * lib/trendReport.ts's week-over-week / prior-30d comparisons. */
export function newBookingsInRange(
  bookings: Booking[],
  rangeStart: Date,
  rangeEnd: Date
): { count: number; grossRevenue: number; netRevenue: number } {
  let count = 0;
  let grossRevenue = 0;
  let netRevenue = 0;
  for (const b of bookings) {
    if (!isRevenueCounting(b) || !b.createdAt) continue;
    const createdAt = parseISO(b.createdAt);
    if (createdAt < rangeStart || createdAt >= rangeEnd) continue;
    count += 1;
    grossRevenue += b.totalAmount || 0;
    netRevenue += netAmount(b);
  }
  return { count, grossRevenue, netRevenue };
}

function accrueInWindow(bookings: Booking[], daysBack: number): { nights: number; grossRevenue: number; netRevenue: number } {
  const now = new Date();
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - daysBack);
  return accrueInDateRange(bookings, windowStart, now);
}

export function occupancyRate(bookings: Booking[], daysBack = 90): number {
  const { nights } = accrueInWindow(bookings, daysBack);
  return daysBack > 0 ? Math.min(100, Math.round((nights / daysBack) * 1000) / 10) : 0;
}

export type BookingPace = {
  daysOut: number;
  nightsBooked: number;
  nightsAvailable: number;
  pct: number;
  revenueOnBooksGross: number;
  revenueOnBooksNet: number;
};

// Forward-looking counterpart to accrueInWindow/occupancyRate — "how full is
// the calendar already, looking ahead" rather than "how full was it,
// looking back." Same overlap-clipping logic (a booking that starts inside
// the window but runs past the end of it only contributes the nights that
// actually fall within [now, now+daysOut]), just pointed at the future
// instead of the past. This is what a booking pace/pickup report needs —
// "nights already on the books for the next N days" — since VISION.md and
// Seni both want this distinct from the backward-looking occupancy figure.
export function bookingPace(bookings: Booking[], daysOut: number): BookingPace {
  const now = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + daysOut);

  let nights = 0;
  let grossRevenue = 0;
  let netRevenue = 0;

  for (const b of bookings) {
    if (!isRevenueCounting(b) || !b.arrival || !b.departure) continue;
    const arrival = parseISO(b.arrival);
    const departure = parseISO(b.departure);
    const totalNights = b.nights && b.nights > 0 ? b.nights : nightsBetween(b.arrival, b.departure);
    if (totalNights <= 0) continue;

    const overlapStart = arrival > now ? arrival : now;
    const overlapEnd = departure < windowEnd ? departure : windowEnd;
    const overlapNights = Math.min(differenceInCalendarDays(overlapEnd, overlapStart), totalNights);
    if (overlapNights <= 0) continue;

    const share = overlapNights / totalNights;
    nights += overlapNights;
    grossRevenue += (b.totalAmount || 0) * share;
    netRevenue += netAmount(b) * share;
  }

  return {
    daysOut,
    nightsBooked: nights,
    nightsAvailable: daysOut,
    pct: daysOut > 0 ? Math.min(100, Math.round((nights / daysOut) * 1000) / 10) : 0,
    revenueOnBooksGross: Math.round(grossRevenue * 100) / 100,
    revenueOnBooksNet: Math.round(netRevenue * 100) / 100,
  };
}

// Average Daily Rate for the trailing window — revenue actually accrued in
// the window divided by nights actually occupied in the window (both from
// accrueInWindow, so this is on the same basis as occupancyRate/revPar).
export function adr(bookings: Booking[], daysBack = 30): { gross: number; net: number } {
  const { nights, grossRevenue, netRevenue } = accrueInWindow(bookings, daysBack);
  return {
    gross: nights > 0 ? Math.round((grossRevenue / nights) * 100) / 100 : 0,
    net: nights > 0 ? Math.round((netRevenue / nights) * 100) / 100 : 0,
  };
}

export type CancellationSummary = { cancelledCount: number; totalCount: number; pct: number };

/** Share of real (non-block) bookings that ended up Cancelled — all-time,
 * not windowed, since cancellations are rare enough that a 30/90-day window
 * would be noisy. Excludes calendar blocks (see isBlock's comment above) —
 * those were never a real reservation to begin with, so counting them in the
 * denominator would understate the true cancellation rate. */
export function cancellationRate(bookings: Booking[]): CancellationSummary {
  const real = bookings.filter((b) => !b.isBlock);
  const cancelledCount = real.filter((b) => b.status === "Cancelled").length;
  const totalCount = real.length;
  return {
    cancelledCount,
    totalCount,
    pct: totalCount > 0 ? Math.round((cancelledCount / totalCount) * 1000) / 10 : 0,
  };
}

export type RepeatGuestSummary = { totalGuests: number; repeatGuests: number; pct: number };

/** Of every distinct guest who has ever actually stayed (Booked/Checked
 * In/Checked Out, non-block — see isRevenueCounting), what share have more
 * than one such stay on record. Guests with no guestId (some OTA bookings
 * never expose one) are excluded rather than silently merged into a single
 * bucket, which would inflate the repeat count. */
export function repeatGuestRate(bookings: Booking[]): RepeatGuestSummary {
  const counts = new Map<number, number>();
  for (const b of bookings) {
    if (!isRevenueCounting(b) || b.guestId === null) continue;
    counts.set(b.guestId, (counts.get(b.guestId) ?? 0) + 1);
  }
  const totalGuests = counts.size;
  const repeatGuests = Array.from(counts.values()).filter((c) => c > 1).length;
  return {
    totalGuests,
    repeatGuests,
    pct: totalGuests > 0 ? Math.round((repeatGuests / totalGuests) * 1000) / 10 : 0,
  };
}

export type SummaryStats = {
  ytdRevenue: number;
  ytdNetRevenue: number;
  ytdBookings: number;
  avgNightlyRate: number;
  avgNetNightlyRate: number;
  avgLengthOfStay: number;
  occupancyRate90d: number;
  upcomingArrivals: Booking[];
  upcomingDepartures: Booking[];
  currentGuests: Booking[];
};

export function summaryStats(bookings: Booking[]): SummaryStats {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const ytd = bookings.filter(
    (b) => isRevenueCounting(b) && b.arrival && parseISO(b.arrival) >= yearStart
  );

  const ytdRevenue = ytd.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
  const ytdNetRevenue = ytd.reduce((sum, b) => sum + netAmount(b), 0);
  const ytdNights = ytd.reduce((sum, b) => sum + (b.nights || 0), 0);
  const avgNightlyRate = ytdNights > 0 ? Math.round((ytdRevenue / ytdNights) * 100) / 100 : 0;
  const avgNetNightlyRate = ytdNights > 0 ? Math.round((ytdNetRevenue / ytdNights) * 100) / 100 : 0;
  const avgLengthOfStay = ytd.length > 0 ? Math.round((ytdNights / ytd.length) * 10) / 10 : 0;

  const upcomingArrivals = bookings
    .filter((b) => isRevenueCounting(b) && b.arrival && parseISO(b.arrival) >= now)
    .sort((a, b) => a.arrival.localeCompare(b.arrival))
    .slice(0, 10);

  const upcomingDepartures = bookings
    .filter((b) => isRevenueCounting(b) && b.departure && parseISO(b.departure) >= now)
    .sort((a, b) => a.departure.localeCompare(b.departure))
    .slice(0, 10);

  const currentGuests = bookings.filter(
    (b) =>
      isRevenueCounting(b) &&
      b.arrival &&
      b.departure &&
      parseISO(b.arrival) <= now &&
      parseISO(b.departure) >= now
  );

  return {
    ytdRevenue,
    ytdNetRevenue,
    ytdBookings: ytd.length,
    avgNightlyRate,
    avgNetNightlyRate,
    avgLengthOfStay,
    occupancyRate90d: occupancyRate(bookings, 90),
    upcomingArrivals,
    upcomingDepartures,
    currentGuests,
  };
}

// RevPAR = revenue earned per available night, not just per booked night —
// unlike ADR, this one falls when occupancy is low even if the nights that
// DID book went for a high rate. Single-property dashboard, so "available
// nights" is just calendar days in the window (one unit). Uses the same
// accrueInWindow basis as occupancyRate/adr, so RevPAR = ADR x Occupancy
// holds (up to rounding) instead of the two drifting apart.
export function revPar(bookings: Booking[], daysBack = 30): { gross: number; net: number } {
  const { grossRevenue, netRevenue } = accrueInWindow(bookings, daysBack);
  return {
    gross: daysBack > 0 ? Math.round((grossRevenue / daysBack) * 100) / 100 : 0,
    net: daysBack > 0 ? Math.round((netRevenue / daysBack) * 100) / 100 : 0,
  };
}

// Share of revenue that came in through OwnerRez's own "Direct" source
// (Seni's own site/booking engine) rather than an OTA channel — see
// lib/ownerrez.ts's mapping of OwnerRez's source/site/listing_site field.
// Real data only: a booking with no source recorded on the OwnerRez side
// defaults to "Direct" there, which very slightly overstates this number for
// any such bookings — noted rather than hidden.
export function directBookingShare(bookings: Booking[], daysBack = 30): { pct: number; revenue: number; totalRevenue: number } {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  let directRevenue = 0;
  let totalRevenue = 0;
  for (const b of bookings) {
    if (!isRevenueCounting(b) || !b.arrival) continue;
    if (parseISO(b.arrival) < cutoff) continue;
    totalRevenue += b.totalAmount || 0;
    if ((b.source || "Direct").toLowerCase() === "direct") directRevenue += b.totalAmount || 0;
  }
  return {
    pct: totalRevenue > 0 ? Math.round((directRevenue / totalRevenue) * 1000) / 10 : 0,
    revenue: directRevenue,
    totalRevenue,
  };
}

// Last-minute discount % — there's no stored "list price" anywhere to
// compare a booking's actual rate against (bookings only ever record what a
// guest was actually charged, and PriceLabs' own recommended rate for a
// given stay date already bakes in any last-minute adjustment by the time
// anyone reads it — see lib/pricelabs.ts, which exposes price/userPrice/
// minStay and nothing else). So rather than a discount OFF some baseline
// this app doesn't have, this measures it empirically: the actual gap
// between what guests who booked close to arrival paid per night vs. guests
// who booked well in advance, using only real transacted bookings. This is a
// different (and arguably more honest) definition than "the % PriceLabs'
// last-minute-discount setting is configured to" — flagged as such in
// executiveReport.ts's dataGaps whenever the sample on either side is thin
// enough that the comparison isn't trustworthy yet.
export const LAST_MINUTE_LEAD_DAYS = 7; // booked within a week of arrival
export const ADVANCE_LEAD_DAYS = 21; // booked 3+ weeks out — the "planned" comparison group
const LAST_MINUTE_MIN_SAMPLE = 5; // below this on either side, the average is too noisy to call a real gap

export type LastMinuteDiscount = {
  lastMinuteAvgGross: number | null;
  advanceAvgGross: number | null;
  lastMinuteSampleSize: number;
  advanceSampleSize: number;
  discountPct: number | null; // positive = last-minute bookers paid less per night, on average
  reliable: boolean;
};

export function lastMinuteDiscount(bookings: Booking[], monthsBack = 12): LastMinuteDiscount {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);

  const lastMinuteRates: number[] = [];
  const advanceRates: number[] = [];

  for (const b of bookings) {
    if (!isRevenueCounting(b) || !b.arrival || !b.createdAt) continue;
    const arrival = parseISO(b.arrival);
    if (arrival < cutoff) continue; // keep the comparison to recent-enough bookings to reflect current pricing
    const nights = b.nights && b.nights > 0 ? b.nights : nightsBetween(b.arrival, b.departure);
    if (nights <= 0) continue;
    const createdAt = parseISO(b.createdAt);
    const leadDays = differenceInCalendarDays(arrival, createdAt);
    if (leadDays < 0) continue; // bad data (booked after arrival) — skip rather than guess

    const nightlyRate = (b.totalAmount || 0) / nights;
    if (leadDays <= LAST_MINUTE_LEAD_DAYS) {
      lastMinuteRates.push(nightlyRate);
    } else if (leadDays >= ADVANCE_LEAD_DAYS) {
      advanceRates.push(nightlyRate);
    }
  }

  const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const lastMinuteAvgGross = avg(lastMinuteRates);
  const advanceAvgGross = avg(advanceRates);
  const reliable = lastMinuteRates.length >= LAST_MINUTE_MIN_SAMPLE && advanceRates.length >= LAST_MINUTE_MIN_SAMPLE;

  return {
    lastMinuteAvgGross: lastMinuteAvgGross !== null ? Math.round(lastMinuteAvgGross * 100) / 100 : null,
    advanceAvgGross: advanceAvgGross !== null ? Math.round(advanceAvgGross * 100) / 100 : null,
    lastMinuteSampleSize: lastMinuteRates.length,
    advanceSampleSize: advanceRates.length,
    discountPct:
      lastMinuteAvgGross !== null && advanceAvgGross !== null && advanceAvgGross > 0
        ? Math.round(((advanceAvgGross - lastMinuteAvgGross) / advanceAvgGross) * 1000) / 10
        : null,
    reliable,
  };
}

export function nightsBetween(arrival: string, departure: string): number {
  try {
    return Math.max(0, differenceInCalendarDays(parseISO(departure), parseISO(arrival)));
  } catch {
    return 0;
  }
}
