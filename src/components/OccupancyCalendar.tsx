"use client";

import { useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  format,
  getDay,
  isBefore,
  isWithinInterval,
  parseISO,
  startOfDay,
  startOfMonth,
} from "date-fns";
import type { Booking } from "@/lib/types";
import { isRevenueCounting, netAmount } from "@/lib/finance";
import { useCurrency } from "@/components/CurrencyProvider";

const OCCUPIED_STATUSES = new Set(["Booked", "Checked In", "Checked Out", "Hold"]);

// How far Seni can browse in either direction from the current month — far
// enough to review a full year of history or look a year out for planning,
// without letting the nav scroll on forever.
const MONTHS_RANGE = 12;

export function OccupancyCalendar({ bookings }: { bookings: Booking[] }) {
  // Aliased to avoid clashing with date-fns's own `format` import above.
  const { format: formatMoney } = useCurrency();
  const today = startOfDay(new Date());
  const currentMonthStart = startOfMonth(today);
  const [monthOffset, setMonthOffset] = useState(0);

  const month = addMonths(currentMonthStart, monthOffset);
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const days = eachDayOfInterval({ start, end });
  const leadingBlanks = getDay(start); // 0 = Sunday

  // isBlock excludes iCal sync placeholders / manual "not available" holds —
  // these have no real guest attached but often span wide date ranges, and
  // without this filter they were painting almost every day of the month
  // blue "Booked" even in months with only a handful of actual reservations
  // (see lib/finance.ts's isRevenueCounting, which excludes them the same
  // way for revenue).
  const occupiedBookings = bookings.filter(
    (b) => !b.isBlock && OCCUPIED_STATUSES.has(b.status) && b.arrival && b.departure
  );

  function bookingForDay(day: Date): Booking | undefined {
    return occupiedBookings.find((b) => {
      try {
        const arrival = parseISO(b.arrival);
        const departure = parseISO(b.departure);
        return isWithinInterval(day, { start: arrival, end: departure }) && day < departure;
      } catch {
        return false;
      }
    });
  }

  // Three day states: booked (blue), past-and-unbooked (red — a night that's
  // already gone by with nobody in it), and available (neutral — anything
  // today or in the future that isn't booked yet). Today itself counts as
  // "available", not "not booked" — the day isn't over.
  type DayState = "booked" | "notBooked" | "available";
  function stateForDay(day: Date, booking: Booking | undefined): DayState {
    if (booking) return "booked";
    return isBefore(day, today) ? "notBooked" : "available";
  }

  const canGoBack = monthOffset > -MONTHS_RANGE;
  const canGoForward = monthOffset < MONTHS_RANGE;

  // Stats for whatever month is currently in view — "MTD" when that's the
  // real current month (today's calendar box), a completed month's totals
  // when browsing the past, or however much is booked so far when browsing
  // ahead. Revenue/rate/stay-length are bucketed by arrival date, the same
  // convention the Revenue (YTD) stat card and lib/finance.ts already use.
  const monthBookings = bookings.filter(
    (b) => isRevenueCounting(b) && b.arrival && isWithinInterval(parseISO(b.arrival), { start, end })
  );
  const monthRevenue = monthBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
  const monthNetRevenue = monthBookings.reduce((sum, b) => sum + netAmount(b), 0);
  const monthNights = monthBookings.reduce((sum, b) => sum + (b.nights || 0), 0);
  const avgNightlyRate = monthNights > 0 ? monthRevenue / monthNights : 0;
  const avgNetNightlyRate = monthNights > 0 ? monthNetRevenue / monthNights : 0;
  const avgLengthOfStay = monthBookings.length > 0 ? monthNights / monthBookings.length : 0;

  // Occupancy here matches exactly what the grid below is showing (booked
  // days ÷ total days this month) rather than a separate booking-nights
  // count, so the percentage never contradicts the colors on screen.
  const bookedDayCount = days.filter((day) => bookingForDay(day) !== undefined).length;
  const occupancyPct = days.length > 0 ? Math.round((bookedDayCount / days.length) * 1000) / 10 : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setMonthOffset((m) => Math.max(-MONTHS_RANGE, m - 1))}
          disabled={!canGoBack}
          aria-label="Previous month"
          className="w-6 h-6 flex items-center justify-center rounded-md text-sm text-black/50 dark:text-white/50 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ‹
        </button>
        <div className="text-sm font-medium">{format(month, "MMMM yyyy")}</div>
        <button
          onClick={() => setMonthOffset((m) => Math.min(MONTHS_RANGE, m + 1))}
          disabled={!canGoForward}
          aria-label="Next month"
          className="w-6 h-6 flex items-center justify-center rounded-md text-sm text-black/50 dark:text-white/50 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ›
        </button>
      </div>

      {monthOffset !== 0 && (
        <button
          onClick={() => setMonthOffset(0)}
          className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline mb-2 block"
        >
          Back to today
        </button>
      )}

      <div className="grid grid-cols-7 gap-1 text-xs text-center text-black/40 dark:text-white/40 mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: leadingBlanks }).map((_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {days.map((day) => {
          const booking = bookingForDay(day);
          const state = stateForDay(day, booking);
          const label =
            state === "booked"
              ? `${booking!.guestName ?? "Guest"} (${booking!.source})`
              : state === "notBooked"
                ? "Not booked"
                : "Available";
          return (
            <div
              key={day.toISOString()}
              title={label}
              className={`aspect-square rounded-md text-xs flex items-center justify-center border ${
                state === "booked"
                  ? "bg-blue-500/80 text-white border-blue-600"
                  : state === "notBooked"
                    ? "bg-red-500/80 text-white border-red-600"
                    : "bg-black/[0.03] text-black/50 border-transparent dark:bg-white/5 dark:text-white/40"
              }`}
            >
              {format(day, "d")}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 mt-3 text-xs text-black/50 dark:text-white/50 flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-blue-500/80" /> Booked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-red-500/80" /> Not booked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-black/[0.06] dark:bg-white/10" /> Available
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-black/10 dark:border-white/10">
        <MiniStat label="Revenue MTD" value={formatMoney(monthRevenue)} subValue={`Net ${formatMoney(monthNetRevenue)}`} />
        <MiniStat label="Occupancy MTD" value={`${occupancyPct}%`} />
        <MiniStat
          label="Avg nightly rate"
          value={formatMoney(avgNightlyRate)}
          subValue={`Net ${formatMoney(avgNetNightlyRate)}`}
        />
        <MiniStat label="Avg length of stay" value={`${Math.round(avgLengthOfStay * 10) / 10} nights`} />
      </div>
    </div>
  );
}

function MiniStat({ label, value, subValue }: { label: string; value: string; subValue?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-black/40 dark:text-white/40">{label}</div>
      <div className="text-sm font-semibold mt-0.5">{value}</div>
      {/* Gross figure above is what the guest is charged; this is what's
          left after OwnerRez/channel fees — see lib/finance.ts's netAmount(). */}
      {subValue && <div className="text-[11px] text-black/40 dark:text-white/40">{subValue}</div>}
    </div>
  );
}
