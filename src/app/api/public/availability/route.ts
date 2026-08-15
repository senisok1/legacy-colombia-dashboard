import { NextRequest, NextResponse } from "next/server";
import { getTargetProperty, getBookings } from "@/lib/ownerrez";
import { getLatestRateSnapshots } from "@/lib/revenueManager";
import { checkRateLimit, corsHeaders, getClientIp, handlePreflight, isAllowedOrigin } from "@/lib/publicApiGuard";

// Public, unauthenticated endpoint for the "Book Direct" availability
// calendar on legacycolombia.com (see public/booking-calendar.js). Built
// 2026-08-06 right after fixing the OwnerRez 429 rate-limit crisis (see
// lib/inbox.ts's header comment) — so this deliberately makes ZERO live
// OwnerRez calls per visitor:
//   - Rates come from rate_snapshots (lib/revenueManager.ts's
//     getLatestRateSnapshots()), which Revenue Manager's existing daily cron
//     already populates via test-mode OwnerRez quotes. Reading that table is
//     a plain DB query, no OwnerRez traffic at all.
//   - Availability comes from getBookings(), which is itself unstable_cache'd
//     with a 60s revalidate (lib/ownerrez.ts) — a burst of website visitors
//     all hit the same cached result, not OwnerRez directly.
// Locked down the same way as the chat-widget's public routes: CORS to
// legacycolombia.com only, plus a per-IP rate limit (see
// lib/publicApiGuard.ts) since there's no auth on this route.
//
// Scope: Legacy Colombia's main listing only ("Luxury Waterfront Wellness
// Retreat", OwnerRez property 413494) — getTargetProperty() resolves to
// exactly that property (creds.propertyId), NOT the second listing (Nukak -
// Casa #19, id 492014), per Seni's explicit scoping call. getBookings()
// merges both properties for the org, so bookings are filtered back down to
// just the target property's id below.

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour — generous; this is a cheap read (DB + cached bookings)
const DAYS_AHEAD = 395; // a bit past a year out, so the widget can page forward through every month rate_snapshots' sparse tier still covers

// Same real-occupancy statuses as components/OccupancyCalendar.tsx's
// OCCUPIED_STATUSES — "Quote" and "Inquiry" are pre-booking placeholder
// records (a price quote or inquiry that never became a real reservation)
// and must NOT block a real date, or every date with a stray quote/inquiry
// would show as falsely unavailable. Unlike OccupancyCalendar, isBlock
// records here ARE still treated as unavailable (see below) — this is
// intentionally MORE conservative than the internal dashboard (which
// excludes isBlock to keep revenue/occupancy stats clean): for a public
// booking calendar, a false "unavailable" is a minor inconvenience, but a
// false "available" risks a real double-booking against a channel-synced
// iCal block.
const OCCUPIED_STATUSES = new Set(["Booked", "Checked In", "Checked Out", "Hold"]);
function isUnavailableStatus(status: string): boolean {
  return OCCUPIED_STATUSES.has(status);
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req);
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }
  const headers = corsHeaders(origin);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip, "public-availability", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
  if (!allowed) {
    return NextResponse.json({ error: "Too many requests — please try again shortly." }, { status: 429, headers });
  }

  try {
    const property = await getTargetProperty();
    const [snapshots, allBookings] = await Promise.all([getLatestRateSnapshots(), getBookings()]);

    // 2026-08-06: Seni reported "missing rates on certain dates" on the live
    // calendar — traced to individual dates where runDailyRateSnapshot()'s
    // per-date OwnerRez test-mode quote call failed that day (tolerated
    // per-date there, written as a null ownerrez_rate_cents — see that
    // function's header comment) with no fallback used here, so those dates
    // rendered with no price at all. PriceLabs' recommended rate (and, failing
    // that, the AI's recommendation) is a perfectly reasonable estimate to
    // show a visitor in that gap instead of a blank cell — this is a
    // *display* fallback only, doesn't touch OwnerRez, and doesn't change
    // what Revenue Manager's own internal comparison view shows (that reads
    // getLatestRateSnapshots() directly, unaffected by this).
    const rateByDate = new Map(
      snapshots.map((s) => [s.stayDate, s.ownerRezRateCents ?? s.priceLabsRateCents ?? s.aiRecommendedRateCents])
    );
    const bookings = allBookings.filter((b) => b.propertyId === property.id && b.arrival && b.departure);

    const today = new Date();
    const todayStr = toDateOnly(today);

    const days: { date: string; available: boolean; rateCents: number | null; isToday: boolean }[] = [];
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      d.setUTCDate(d.getUTCDate() + i);
      const dateStr = toDateOnly(d);

      const booked = bookings.some((b) => {
        // isBlock records (often channel-synced iCal holds) don't always carry
        // a real status — treat them as unavailable regardless of status, per
        // the comment above OCCUPIED_STATUSES.
        if (!b.isBlock && !isUnavailableStatus(b.status)) return false;
        const arrival = new Date(b.arrival);
        const departure = new Date(b.departure);
        return d >= arrival && d < departure;
      });

      days.push({
        date: dateStr,
        available: !booked,
        rateCents: rateByDate.get(dateStr) ?? null,
        isToday: dateStr === todayStr,
      });
    }

    return NextResponse.json(
      {
        property: { name: property.name },
        minNights: 2, // Legacy Colombia's enforced minimum stay — see lib/ownerrez.ts's quoteNightlyRateForNights() comment
        currency: "USD",
        generatedAt: new Date().toISOString(),
        days,
      },
      { headers }
    );
  } catch (err) {
    console.error("[public/availability] failed", err);
    return NextResponse.json({ error: "Couldn't load availability right now — please try again shortly." }, { status: 500, headers });
  }
}
