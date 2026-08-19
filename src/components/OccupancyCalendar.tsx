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
import { useT, useLanguage } from "@/components/LanguageProvider";

const DOW_BY_LANG: Record<string, string[]> = {
  English: ["S", "M", "T", "W", "T", "F", "S"],
  Spanish: ["D", "L", "M", "M", "J", "V", "S"],
  Portuguese: ["D", "S", "T", "Q", "Q", "S", "S"],
};

const OCCUPIED_STATUSES = new Set(["Booked", "Checked In", "Checked Out", "Hold"]);

// How far Seni can browse in either direction from the current month — far
// enough to review a full year of history or look a year out for planning,
// without letting the nav scroll on forever.
const MONTHS_RANGE = 12;

// showFinancials=false hides Revenue MTD + Avg nightly rate (team dashboards).
export function OccupancyCalendar({ bookings, showFinancials = true }: { bookings: Booking[]; showFinancials?: boolean }) {
  // Aliased to avoid clashing with date-fns's own `format` import above.
  const { format: formatMoney } = useCurrency();
  const t = useT();
  const lang = useLanguage();
  const dow = DOW_BY_LANG[lang] ?? DOW_BY_LANG.English;
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

  // Two day states (simplified 2026-08-16, Seni's ask): booked (blue) and
  // available (neutral). The old red "past night nobody stayed" state was
  // removed — an empty past night reads as available, which makes the
  // months of real booking history far easier to scan at a glance.
  type DayState = "booked" | "available";
  function stateForDay(_day: Date, booking: Booking | undefined): DayState {
    return booking ? "booked" : "available";
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
          aria-label={t("cal.previousMonth")}
          className="w-6 h-6 flex items-center justify-center rounded-md text-sm text-black/50 dark:text-white/50 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ‹
        </button>
        <div className="text-sm font-medium">{format(month, "MMMM yyyy")}</div>
        <button
          onClick={() => setMonthOffset((m) => Math.min(MONTHS_RANGE, m + 1))}
          disabled={!canGoForward}
          aria-label={t("cal.nextMonth")}
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
          {t("common.backToToday")}
        </button>
      )}

      <div className="grid grid-cols-7 gap-1 text-xs text-center text-black/40 dark:text-white/40 mb-1">
        {dow.map((d, i) => (
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
          // Hover tooltip matches the Management calendar's wording
          // (2026-08-16): "Guest: <name>" plus the channel it came from.
          const label =
            state === "booked"
              ? `${t("table.guest")}: ${booking!.guestName ?? t("table.guest")}${booking!.source ? ` (${booking!.source})` : ""}`
              : t("common.available");
          return (
            <div
              key={day.toISOString()}
              title={label}
              className={`aspect-square cursor-default rounded-md text-xs flex items-center justify-center border transition-colors ${
                state === "booked"
                  ? "bg-blue-500/80 text-white border-blue-600"
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
          <span className="inline-block w-3 h-3 rounded-sm bg-blue-500/80" /> {t("common.booked")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-black/[0.06] dark:bg-white/10" /> {t("common.available")}
        </span>
        <span className="w-full text-[11px] text-black/40 dark:text-white/40">
          {t("common.hoverDay")}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-black/10 dark:border-white/10">
        {showFinancials && (
          <MiniStat label={t("cal.revenueMtd")} value={formatMoney(monthRevenue)} subValue={`${t("cal.net")} ${formatMoney(monthNetRevenue)}`} />
        )}
        <MiniStat label={t("cal.occupancyMtd")} value={`${occupancyPct}%`} />
        {showFinancials && (
          <MiniStat
            label={t("cal.avgNightlyRate")}
            value={formatMoney(avgNightlyRate)}
            subValue={`${t("cal.net")} ${formatMoney(avgNetNightlyRate)}`}
          />
        )}
        <MiniStat label={t("dash.avgLengthOfStay")} value={`${Math.round(avgLengthOfStay * 10) / 10} ${t("mgmt.nights")}`} />
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
