"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrency } from "@/components/CurrencyProvider";
import { useT, useLanguage } from "@/components/LanguageProvider";
import { plural } from "@/lib/i18n";

const DOW_BY_LANG: Record<string, string[]> = {
  English: ["S", "M", "T", "W", "T", "F", "S"],
  Spanish: ["D", "L", "M", "M", "J", "V", "S"],
  Portuguese: ["D", "S", "T", "Q", "Q", "S", "S"],
};

// Client half of the Management tab (see app/management/page.tsx). One
// fetch renders everything; posting a note/activity optimistically
// refetches. Deliberately dependency-free and simple — the audience is the
// on-site team on their phones.

// body is ALWAYS English (translated on write); bodyOriginal holds what a
// Spanish/Portuguese-speaking teammate actually typed. Each viewer sees the
// version in their own language (2026-08-16, Seni's ask).
type StayNote = {
  id: string;
  body: string;
  bodyOriginal?: string | null;
  authorLanguage?: string | null;
  author: string;
  at: string;
};
type Stay = {
  bookingId: number;
  guestName: string;
  guestPhone?: string | null;
  guestPhoneProxy?: boolean;
  guestEmail?: string | null;
  guestEmailProxy?: boolean;
  propertyName?: string;
  arrival?: string;
  departure?: string;
  nights?: number;
  adults?: number;
  children?: number;
  source?: string;
  totalAmount?: number;
  // Team Management "transactions on hover" (2026-08-18, Seni's ask,
  // Admin/Owner only). All three come back undefined for non-CEO viewers —
  // api/management/route.ts strips them server-side, not just hidden here.
  totalPaid?: number;
  balanceOwed?: number;
  charges?: { description: string; amount: number; type: string }[];
  extrasRequested: boolean;
  eventScheduled?: boolean;
  eventDate?: string | null;
  eventTime?: string | null;
  eventGuestCount?: number | null;
  notes: StayNote[];
};

/** Every date of the stay (arrival..departure inclusive) as YYYY-MM-DD. */
function stayDates(arrival?: string, departure?: string): string[] {
  if (!arrival) return [];
  const start = new Date(`${arrival.slice(0, 10)}T00:00:00Z`);
  const end = departure ? new Date(`${departure.slice(0, 10)}T00:00:00Z`) : start;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const out: string[] = [];
  for (let d = new Date(start); d <= end && out.length < 60; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Same as stayDates() but excludes the departure/checkout day — a stay
 * doesn't occupy the property that night (2026-08-19 fix, Seni: "why
 * doesn't the calendar on the team management tab match with the calendar
 * on the dashboard"). The Dashboard's OccupancyCalendar has always used a
 * half-open [arrival, departure) interval; this file's stayDates() was
 * inclusive of departure, so every checkout day painted blue/booked here but
 * gray/available on the Dashboard. Only used for the calendar cells below —
 * stayDates() itself stays inclusive for the event-date picker further down,
 * where the checkout day is still a valid day to schedule something. */
function occupiedDates(arrival?: string, departure?: string): string[] {
  const all = stayDates(arrival, departure);
  return all.length > 1 ? all.slice(0, -1) : all;
}
type LogEntry = StayNote;
type CalendarStay = { bookingId: number; guestName: string; arrival?: string; departure?: string };
type BoardData = {
  stays: Stay[];
  calendarStays?: CalendarStay[];
  activityLog: LogEntry[];
  viewerRole?: string;
  viewerLanguage?: string;
};

/** Text to show a given viewer: their own language when we have it. */
function textFor(entry: { body: string; bodyOriginal?: string | null; authorLanguage?: string | null }, viewerLanguage?: string): string {
  const viewer = (viewerLanguage || "English").toLowerCase();
  if (viewer !== "english" && entry.authorLanguage && entry.authorLanguage.toLowerCase() === viewer && entry.bodyOriginal) {
    return entry.bodyOriginal; // same language as the author — show the original
  }
  return entry.body; // English (translated on write when needed)
}

function fmtDate(iso?: string): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "TBD"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Days-until-arrival countdown (2026-08-18, Seni's ask: "a countdown box
 * of # of days until the stay begins," next to the balance-owed badge).
 * Whole calendar days, UTC-anchored like stayDates() above so it can't
 * drift a day off depending on the visitor's own timezone. Visible to
 * every role — arrival/departure aren't financial data. */
function CountdownBadge({ arrival, departure }: { arrival?: string; departure?: string }) {
  const t = useT();
  const lang = useLanguage();
  if (!arrival) return null;
  const arrivalDay = new Date(`${arrival.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(arrivalDay.getTime())) return null;
  const todayUtc = new Date();
  const todayDay = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate()));
  const daysUntil = Math.round((+arrivalDay - +todayDay) / 86_400_000);

  let label: string;
  let className: string;
  if (daysUntil > 0) {
    label = `${daysUntil} ${plural(daysUntil, "countdown.day", "countdown.days", lang)} ${t("countdown.toArrival")}`;
    className =
      daysUntil <= 3
        ? "bg-red-500/15 text-red-600 dark:text-red-400"
        : daysUntil <= 7
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-black/10 dark:bg-white/10 text-black/60 dark:text-white/60";
  } else if (daysUntil === 0) {
    label = t("countdown.arrivesToday");
    className = "bg-red-500/15 text-red-600 dark:text-red-400";
  } else {
    // Already arrived — still "in house" until departure passes too.
    const departureDay = departure ? new Date(`${departure.slice(0, 10)}T00:00:00Z`) : null;
    const stillInHouse = departureDay && !Number.isNaN(departureDay.getTime()) && +departureDay >= +todayDay;
    label = stillInHouse ? t("countdown.inHouse") : t("countdown.departed");
    className = stillInHouse
      ? "bg-[var(--accent)]/15 text-[var(--accent)]"
      : "bg-black/10 dark:bg-white/10 text-black/40 dark:text-white/40";
  }

  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Half-hour options 6:00 AM → 11:30 PM for the event-time dropdown. */
const EVENT_TIMES: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = [];
  for (let h = 6; h <= 23; h++) {
    for (const m of [0, 30]) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      out.push({ value, label: `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}` });
    }
  }
  return out;
})();

/** Attendance options: every number 1-40, then 45..300 by fives. */
const EVENT_GUEST_COUNTS: number[] = [
  ...Array.from({ length: 40 }, (_, i) => i + 1),
  ...Array.from({ length: 52 }, (_, i) => 45 + i * 5),
];

function fmtTime(hhmm?: string | null): string | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Stay & event calendar (2026-08-16, Seni's ask): month grid to the right
 * of the stays list. Occupied nights are filled, event days get a red ring,
 * and hovering any day shows the guest name(s) via the native tooltip. */
function StayCalendar({ stays, calendarStays }: { stays: Stay[]; calendarStays: CalendarStay[] }) {
  const t = useT();
  const lang = useLanguage();
  const dow = DOW_BY_LANG[lang] ?? DOW_BY_LANG.English;
  const [monthOffset, setMonthOffset] = useState(0);
  const now = new Date();
  const view = new Date(Date.UTC(now.getFullYear(), now.getMonth() + monthOffset, 1));
  const year = view.getUTCFullYear();
  const month = view.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const todayIso = new Date().toISOString().slice(0, 10);

  const byDay = new Map<string, { guests: string[]; events: string[] }>();
  // Occupancy comes ONLY from calendarStays (past + future, already filtered
  // to isOccupying() statuses server-side — see api/management/route.ts) so
  // past booked nights stay blue and a mere Inquiry/Quote doesn't paint a day
  // blue here just because it's also in the upcoming stays list below (fixed
  // 2026-08-19 — this loop used to ALSO add every `stays` entry to `guests`
  // regardless of status, which is what made this calendar disagree with the
  // Dashboard's: `stays`/upcoming only excludes Cancelled, not Inquiry/Quote).
  // Events still come from the upcoming/in-house stays list — that's a
  // separate, unrelated concept from occupancy.
  for (const cs of calendarStays) {
    for (const d of occupiedDates(cs.arrival, cs.departure)) {
      if (!byDay.has(d)) byDay.set(d, { guests: [], events: [] });
      if (!byDay.get(d)!.guests.includes(cs.guestName)) byDay.get(d)!.guests.push(cs.guestName);
    }
  }
  for (const s of stays) {
    if (s.eventScheduled && s.eventDate) {
      if (!byDay.has(s.eventDate)) byDay.set(s.eventDate, { guests: [], events: [] });
      byDay
        .get(s.eventDate)!
        .events.push(
          [s.guestName, fmtTime(s.eventTime) ? `at ${fmtTime(s.eventTime)}` : null, s.eventGuestCount ? `(${s.eventGuestCount} ppl)` : null]
            .filter(Boolean)
            .join(" ")
        );
    }
  }

  const monthLabel = view.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <aside className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
      <div className="mb-2 flex items-center justify-between">
        <button
          onClick={() => setMonthOffset((o) => o - 1)}
          className="rounded px-2 py-0.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={t("cal.previousMonth")}
        >
          ‹
        </button>
        <h3 className="text-sm font-semibold">{monthLabel}</h3>
        <button
          onClick={() => setMonthOffset((o) => o + 1)}
          className="rounded px-2 py-0.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={t("cal.nextMonth")}
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-black/40 dark:text-white/40">
        {dow.map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {Array.from({ length: firstDow }).map((_, i) => (
          <div key={`pad-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const info = byDay.get(iso);
          const occupied = Boolean(info && info.guests.length > 0);
          const hasEvent = Boolean(info && info.events.length > 0);
          const tooltip = info && (info.guests.length > 0 || info.events.length > 0)
            ? [
                ...info.guests.map((g) => `${t("table.guest")}: ${g}`),
                ...info.events.map((g) => `🎉 ${t("mgmt.event")} — ${g}`),
              ].join("\n")
            : t("common.available");
          // Blue = booked (past or future, so real booking history shows);
          // gray = available. Deliberately NO red here (2026-08-16, Seni's
          // ask) — a past unbooked night reads as available, not an alert.
          const cellColor = occupied
            ? "bg-blue-500/80 font-medium text-white"
            : "bg-black/[0.06] dark:bg-white/10 text-black/60 dark:text-white/60";
          return (
            <div
              key={iso}
              title={tooltip}
              className={`flex h-8 cursor-default items-center justify-center rounded-md text-xs transition-colors ${cellColor} ${hasEvent ? "ring-2 ring-amber-400" : ""} ${iso === todayIso ? "outline outline-2 outline-offset-1 outline-black/30 dark:outline-white/40" : ""}`}
            >
              {day}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-black/50 dark:text-white/50">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-blue-500/80" /> {t("common.booked")}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-black/[0.06] dark:bg-white/10" /> {t("common.available")}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm ring-2 ring-amber-400" /> {t("cal.eventDay")}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-black/40 dark:text-white/40">{t("common.hoverDay")}</p>
    </aside>
  );
}

/** Event-only list under the calendar (2026-08-16, Seni's ask): every
 * flagged event with guest, date, time and headcount — soonest first. */
function EventsList({ stays }: { stays: Stay[] }) {
  const t = useT();
  const events = stays
    .filter((s) => s.eventScheduled)
    .sort((a, b) => (a.eventDate ?? "9999").localeCompare(b.eventDate ?? "9999"));

  return (
    <aside className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
      <h3 className="mb-2 text-sm font-semibold">{t("events.title")} ({events.length})</h3>
      {events.length === 0 ? (
        <p className="text-sm text-black/50 dark:text-white/50">{t("events.none")}</p>
      ) : (
        <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {events.map((e) => (
            <li
              key={e.bookingId}
              className="rounded-lg border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-sm"
            >
              <div className="font-medium">{e.guestName}</div>
              <div className="text-black/60 dark:text-white/60">
                {e.eventDate
                  ? new Date(`${e.eventDate}T00:00:00Z`).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      // Year included (2026-08-17, Seni's ask) — events get
                      // booked well ahead, so "Sat, Nov 6" alone is ambiguous.
                      year: "numeric",
                      timeZone: "UTC",
                    })
                  : t("events.dateTbd")}
                {fmtTime(e.eventTime) ? ` · ${fmtTime(e.eventTime)}` : ` · ${t("events.timeTbd")}`}
              </div>
              <div className="text-black/60 dark:text-white/60">
                {e.eventGuestCount ? `${e.eventGuestCount} ${t("events.peopleAttending")}` : t("events.headcountTbd")}
              </div>
              <div className="mt-0.5 text-[11px] text-black/40 dark:text-white/40">
                {t("events.stay")}: {fmtDate(e.arrival)} → {fmtDate(e.departure)}
                {e.propertyName ? ` · ${e.propertyName}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** Hover badge showing balance owed + itemized charges (2026-08-18, Seni's
 * ask: "add a transactions tab in each box where when you hover over you
 * can see financials included the balance owed... pull this data from the
 * ownerrez transactions section"). Admin/Owner only — the API already
 * strips totalPaid/balanceOwed/charges for non-CEO viewers, so this simply
 * doesn't render when they're absent. OwnerRez's v2 API has no separate
 * transactions endpoint (confirmed live 2026-08-18); total_paid and the
 * itemized `charges` line items right on the booking are the real
 * equivalent, so that's what this shows. */
function TransactionsHover({ stay }: { stay: Stay }) {
  const { format: formatMoney } = useCurrency();
  const t = useT();
  if (stay.balanceOwed === undefined || stay.totalPaid === undefined || stay.totalAmount === undefined) return null;
  const owed = stay.balanceOwed;
  return (
    <span className="group relative inline-flex">
      <span
        className={`cursor-default rounded-full px-2 py-0.5 text-xs font-medium ${
          owed > 0.01
            ? "bg-red-500/15 text-red-600 dark:text-red-400"
            : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        }`}
      >
        {owed > 0.01 ? `${t("tx.balanceOwed")}: ${formatMoney(owed)}` : t("tx.paidInFull")}
      </span>
      <span
        className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-64 rounded-lg border border-black/10 bg-white p-3 text-xs shadow-lg group-hover:block dark:border-white/10 dark:bg-neutral-900"
      >
        <div className="mb-1.5 space-y-0.5">
          <div className="flex justify-between">
            <span className="text-black/50 dark:text-white/50">{t("tx.total")}</span>
            <span className="font-medium">{formatMoney(stay.totalAmount)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-black/50 dark:text-white/50">{t("tx.paid")}</span>
            <span className="font-medium">{formatMoney(stay.totalPaid)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-black/50 dark:text-white/50">{t("tx.balanceOwed")}</span>
            <span className={`font-medium ${owed > 0.01 ? "text-red-600 dark:text-red-400" : ""}`}>
              {formatMoney(owed)}
            </span>
          </div>
        </div>
        {stay.charges && stay.charges.length > 0 && (
          <div className="space-y-0.5 border-t border-black/10 pt-1.5 dark:border-white/10">
            {stay.charges.map((c, i) => (
              <div key={i} className="flex justify-between gap-2 text-black/60 dark:text-white/60">
                <span className="truncate">{c.description}</span>
                <span className="shrink-0">{formatMoney(c.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </span>
    </span>
  );
}

export function ManagementBoard() {
  const t = useT();
  const lang = useLanguage();
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const hasDataRef = useRef(false);
  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(fresh ? "/api/management?fresh=1" : "/api/management");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json as BoardData);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      // BUG FIX (2026-08-16, Seni: "failed to fetch upcoming & in-house
      // stays"): a background/fresh refresh failing (e.g. a cold rebuild
      // right after a deploy exceeding the function timeout) used to slam
      // an error banner over a perfectly good, already-rendered board.
      // Errors now only surface when there's nothing on screen yet.
      if (!hasDataRef.current) {
        setError(err instanceof Error ? err.message : t("mgmt.failedLoad"));
      } else {
        console.error("[management] background refresh failed (kept showing last good data):", err);
      }
    }
  }, []);

  useEffect(() => {
    // Instant paint from the server's Redis snapshot, then a fresh copy
    // right behind it, then a 2-minute refresh loop (2026-08-16).
    void load();
    void load(true);
    const interval = setInterval(() => void load(true), 120_000);
    return () => clearInterval(interval);
  }, [load]);

  async function setEvent(
    s: Stay,
    eventScheduled: boolean,
    eventDate: string | null,
    eventTime: string | null,
    eventGuestCount: number | null
  ) {
    // Optimistic: flip the checkbox/date in place immediately (2026-08-16 —
    // waiting for the server round-trip made the first click feel dead, so
    // people double-clicked). The POST syncs in the background; on failure
    // we resync from the server and show the error.
    setData((prev) =>
      prev
        ? {
            ...prev,
            stays: prev.stays.map((x) =>
              x.bookingId === s.bookingId ? { ...x, eventScheduled, eventDate, eventTime, eventGuestCount } : x
            ),
          }
        : prev
    );
    try {
      const res = await fetch("/api/management/booking-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: s.bookingId, eventScheduled, eventDate, eventTime, eventGuestCount }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mgmt.failedEventFlag"));
      void load(true); // resync — the optimistic flip was wrong
    }
  }

  async function post(kind: "note" | "activity", body: string, bookingId?: number) {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/management/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, body: body.trim(), bookingId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (bookingId !== undefined) setNoteDrafts((d) => ({ ...d, [bookingId]: "" }));
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mgmt.failedSave"));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">{error}</div>;
  }
  if (!data) {
    return <div className="rounded-xl border border-black/10 dark:border-white/10 p-6 text-sm text-black/50 dark:text-white/50">{t("mgmt.loadingStays")}</div>;
  }

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-500">{error}</div>}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      <section className="lg:col-span-2 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold">{t("mgmt.upcomingInHouse")} ({data.stays.length})</h2>
        {data.stays.length === 0 && (
          <p className="text-sm text-black/50 dark:text-white/50">{t("mgmt.noUpcomingStays")}</p>
        )}
        <div className="space-y-3">
          {data.stays.map((s) => (
            <div key={s.bookingId} className="rounded-lg border border-black/10 dark:border-white/10 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{s.guestName}</span>
                <span className="text-sm text-black/60 dark:text-white/60">
                  {fmtDate(s.arrival)} → {fmtDate(s.departure)}
                  {s.nights ? ` · ${s.nights} ${plural(s.nights, "mgmt.night", "mgmt.nights", lang)}` : ""}
                </span>
                {(s.adults || s.children) && (
                  <span className="text-sm text-black/60 dark:text-white/60">
                    {s.adults ?? 0} {plural(s.adults ?? 0, "mgmt.adult", "mgmt.adults", lang)}
                    {s.children ? ` + ${s.children} ${plural(s.children, "mgmt.kid", "mgmt.kids", lang)}` : ""}
                  </span>
                )}
                {s.extrasRequested && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                    {t("mgmt.paidExtrasRequested")}
                  </span>
                )}
                <TransactionsHover stay={s} />
                <CountdownBadge arrival={s.arrival} departure={s.departure} />
              </div>
              <div className="text-xs text-black/50 dark:text-white/50">
                {s.propertyName}
                {s.source ? ` · ${s.source}` : ""}
              </div>
              {(s.guestPhone || s.guestEmail || s.guestPhoneProxy || s.guestEmailProxy) && (
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
                  {s.guestPhone && (
                    <a href={`tel:${s.guestPhone}`} className="text-[var(--accent)] hover:underline">
                      📞 {s.guestPhone}
                    </a>
                  )}
                  {s.guestPhoneProxy && (
                    <span className="text-black/50 dark:text-white/50">{t("mgmt.phoneProxy")}</span>
                  )}
                  {s.guestEmail && (
                    <a href={`mailto:${s.guestEmail}`} className="text-[var(--accent)] hover:underline break-all">
                      ✉️ {s.guestEmail}
                    </a>
                  )}
                  {s.guestEmailProxy && (
                    <span className="text-black/50 dark:text-white/50">{t("mgmt.emailProxy")}</span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={Boolean(s.eventScheduled)}
                    onChange={(e) =>
                      void setEvent(
                        s,
                        e.target.checked,
                        e.target.checked ? (s.eventDate ?? null) : null,
                        e.target.checked ? (s.eventTime ?? null) : null,
                        e.target.checked ? (s.eventGuestCount ?? null) : null
                      )
                    }
                    className="h-6 w-6 cursor-pointer accent-red-600"
                  />
                  {t("mgmt.eventCheckbox")}
                </label>
                {s.eventScheduled && (
                  <select
                    value={s.eventDate ?? ""}
                    onChange={(e) => void setEvent(s, true, e.target.value || null, s.eventTime ?? null, s.eventGuestCount ?? null)}
                    className="rounded-md border-2 border-red-500 bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="">{t("mgmt.pickEventDate")}</option>
                    {stayDates(s.arrival, s.departure).map((d) => (
                      <option key={d} value={d}>
                        {new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          timeZone: "UTC",
                        })}
                      </option>
                    ))}
                  </select>
                )}
                {s.eventScheduled && (
                  <select
                    value={s.eventTime ?? ""}
                    onChange={(e) => void setEvent(s, true, s.eventDate ?? null, e.target.value || null, s.eventGuestCount ?? null)}
                    className="rounded-md border-2 border-red-500 bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="">{t("mgmt.pickTime")}</option>
                    {EVENT_TIMES.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                )}
                {s.eventScheduled && (
                  <select
                    value={s.eventGuestCount ?? ""}
                    onChange={(e) =>
                      void setEvent(
                        s,
                        true,
                        s.eventDate ?? null,
                        s.eventTime ?? null,
                        e.target.value ? Number(e.target.value) : null
                      )
                    }
                    className="rounded-md border-2 border-red-500 bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="">{t("mgmt.peopleAttending")}</option>
                    {EVENT_GUEST_COUNTS.map((n) => (
                      <option key={n} value={n}>
                        {n} {n === 1 ? t("mgmt.person") : t("mgmt.people")}
                      </option>
                    ))}
                  </select>
                )}
                {s.eventScheduled && s.eventDate && (
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
                    {t("mgmt.event")}{" "}
                    {new Date(`${s.eventDate}T00:00:00Z`).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                    {fmtTime(s.eventTime) ? ` · ${fmtTime(s.eventTime)}` : ""}
                    {s.eventGuestCount ? ` · ${s.eventGuestCount} ${t("mgmt.people")}` : ""}
                  </span>
                )}
              </div>
              {s.notes.length > 0 && (
                <ul className="space-y-1">
                  {s.notes.map((n) => (
                    <li
                      key={n.id}
                      className="rounded bg-red-500/10 px-2 py-1 text-sm font-medium text-red-600 dark:text-red-400"
                    >
                      {textFor(n, data.viewerLanguage)}
                      <span className="ml-2 text-xs font-normal text-red-500/70">
                        — {n.author}, {fmtWhen(n.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void post("note", noteDrafts[s.bookingId] ?? "", s.bookingId);
                }}
              >
                <input
                  className="flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-sm"
                  placeholder={t("mgmt.notePlaceholder")}
                  value={noteDrafts[s.bookingId] ?? ""}
                  onChange={(e) => setNoteDrafts((d) => ({ ...d, [s.bookingId]: e.target.value }))}
                />
                <button
                  type="submit"
                  disabled={busy || !(noteDrafts[s.bookingId] ?? "").trim()}
                  className="rounded-md bg-black/80 dark:bg-white/80 px-3 py-1 text-sm text-white dark:text-black disabled:opacity-40"
                >
                  {t("common.add")}
                </button>
              </form>
            </div>
          ))}
        </div>
      </section>

      {/* Sticky lives on this wrapper, not on StayCalendar alone (bug fixed
          2026-08-18, Seni: "events list overlaps the calendar"). Position:
          sticky elements paint above static siblings regardless of DOM
          order, so a sticky calendar sitting directly above a static
          EventsList meant the pinned calendar visually overlapped the
          events list as it scrolled underneath — worse in dark mode since
          both panels use a near-transparent bg-white/5. Making the whole
          calendar+events block stick together as one unit keeps the
          "always visible while scrolling stays" behavior with nothing left
          to overlap. */}
      <div className="space-y-6 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
        <StayCalendar stays={data.stays} calendarStays={data.calendarStays ?? []} />
        <EventsList stays={data.stays} />
      </div>
      </div>

    </div>
  );
}
