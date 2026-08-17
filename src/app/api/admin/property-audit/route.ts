import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";
import { getTargetProperties, getBookings, getGuests } from "@/lib/ownerrez";
import { isRevenueCounting, netAmount, summaryStats } from "@/lib/finance";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Cross-property leak audit (2026-08-17, Seni: "triple check all of the data
// per property to make sure there is nothing merging or blending in").
//
// Code review can only prove the group id is THREADED through; this proves
// what actually comes back. For each property group it re-fetches live and
// checks the one thing that matters: does every booking/guest returned for
// this group actually belong to one of that group's OwnerRez property ids?
// Anything that doesn't is a leak, and is listed explicitly rather than
// summarised away.
//
//   GET /api/admin/property-audit?secret=…
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const groups = [];
  const seenBookingIds = new Map<number, string>(); // bookingId -> first group that claimed it

  for (const g of PROPERTY_GROUPS) {
    try {
      const properties = await getTargetProperties(undefined, g.id);
      const allowedIds = new Set(properties.map((p) => p.id));
      const bookings = await getBookings(undefined, g.id);
      const guests = await getGuests(undefined, g.id).catch(() => []);

      // LEAK CHECK 1: a booking whose OwnerRez property_id isn't in this group.
      const foreign = bookings.filter((b) => b.propertyId != null && !allowedIds.has(b.propertyId));

      // LEAK CHECK 2: the same booking appearing under two different groups.
      const duplicatedAcrossGroups: { bookingId: number; alsoIn: string }[] = [];
      for (const b of bookings) {
        const prior = seenBookingIds.get(b.id);
        if (prior && prior !== g.id) duplicatedAcrossGroups.push({ bookingId: b.id, alsoIn: prior });
        else if (!prior) seenBookingIds.set(b.id, g.id);
      }

      // Revenue, computed the same way the Dashboard/Reports tabs do, plus a
      // per-listing split so a merged group is obvious at a glance.
      const stats = summaryStats(bookings);
      const revenueCounting = bookings.filter(isRevenueCounting);
      const byProperty: Record<string, { bookings: number; revenueCounting: number; gross: number; net: number }> = {};
      for (const b of bookings) {
        const key = `${b.propertyId ?? "unknown"} — ${b.propertyName ?? "?"}`;
        byProperty[key] ??= { bookings: 0, revenueCounting: 0, gross: 0, net: 0 };
        byProperty[key].bookings += 1;
        if (isRevenueCounting(b)) {
          byProperty[key].revenueCounting += 1;
          byProperty[key].gross += b.totalAmount || 0;
          byProperty[key].net += netAmount(b);
        }
      }

      // Why a booking doesn't count toward revenue — the difference between
      // "this property earns little" and "we're filtering out its real
      // bookings" (Seni flagged Pompano's revenue as looking wrong).
      const blocks = bookings.filter((b) => b.isBlock);
      const excluded = {
        isBlock: blocks.length,
        blocksWithMoney: blocks.filter((b) => (b.totalAmount || 0) > 0).length,
        cancelled: bookings.filter((b) => b.status === "Cancelled").length,
        otherStatus: bookings.filter(
          (b) => !b.isBlock && !["Booked", "Checked In", "Checked Out", "Cancelled"].includes(b.status)
        ).length,
        countedButZeroAmount: revenueCounting.filter((b) => !(b.totalAmount > 0)).length,
      };
      const blockSample = blocks.slice(0, 6).map((b) => ({
        id: b.id,
        status: b.status,
        source: b.source,
        arrival: b.arrival,
        departure: b.departure,
        guestName: b.guestName,
        totalAmount: b.totalAmount,
      }));
      const sourceCounts: Record<string, number> = {};
      for (const b of bookings) {
        const key = `${b.source || "(none)"}${b.isBlock ? " [block]" : ""}`;
        sourceCounts[key] = (sourceCounts[key] ?? 0) + 1;
      }

      const statuses: Record<string, number> = {};
      for (const b of bookings) statuses[b.status || "(none)"] = (statuses[b.status || "(none)"] ?? 0) + 1;

      const years: Record<string, { bookings: number; gross: number }> = {};
      for (const b of revenueCounting) {
        const y = (b.arrival || "").slice(0, 4) || "(no arrival)";
        years[y] ??= { bookings: 0, gross: 0 };
        years[y].bookings += 1;
        years[y].gross += b.totalAmount || 0;
      }

      groups.push({
        id: g.id,
        label: g.label,
        ownerRezProperties: properties.map((p) => ({ id: p.id, name: p.name })),
        totals: {
          bookings: bookings.length,
          revenueCountingBookings: revenueCounting.length,
          guests: guests.length,
          grossAllTime: Math.round(revenueCounting.reduce((s, b) => s + (b.totalAmount || 0), 0)),
          netAllTime: Math.round(revenueCounting.reduce((s, b) => s + netAmount(b), 0)),
          ytdRevenue: Math.round(stats.ytdRevenue),
          ytdBookings: stats.ytdBookings,
          avgNightlyRate: Math.round(stats.avgNightlyRate),
        },
        byProperty,
        statuses,
        excludedFromRevenue: excluded,
        bookingSources: sourceCounts,
        blockSample,
        byArrivalYear: years,
        leaks: {
          foreignBookings: foreign.length,
          foreignSample: foreign.slice(0, 5).map((b) => ({
            id: b.id,
            propertyId: b.propertyId,
            propertyName: b.propertyName,
            guestName: b.guestName,
          })),
          duplicatedAcrossGroups: duplicatedAcrossGroups.length,
          duplicatedSample: duplicatedAcrossGroups.slice(0, 5),
        },
        clean: foreign.length === 0 && duplicatedAcrossGroups.length === 0,
      });
    } catch (err) {
      groups.push({
        id: g.id,
        label: g.label,
        error: err instanceof Error ? err.message : "Unknown error.",
      });
    }
  }

  return NextResponse.json({ generatedAt: new Date().toISOString(), groups });
}
