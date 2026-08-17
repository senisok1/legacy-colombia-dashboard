"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Client half of the Management tab (see app/management/page.tsx). One
// fetch renders everything; posting a note/activity optimistically
// refetches. Deliberately dependency-free and simple — the audience is the
// on-site team on their phones.

type StayNote = { id: string; body: string; author: string; at: string };
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
  extrasRequested: boolean;
  eventScheduled?: boolean;
  eventDate?: string | null;
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
type LogEntry = { id: string; body: string; author: string; at: string };
type CalendarStay = { bookingId: number; guestName: string; arrival?: string; departure?: string };
type BoardData = { stays: Stay[]; calendarStays?: CalendarStay[]; activityLog: LogEntry[]; viewerRole?: string };

function fmtDate(iso?: string): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "TBD"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** Stay & event calendar (2026-08-16, Seni's ask): month grid to the right
 * of the stays list. Occupied nights are filled, event days get a red ring,
 * and hovering any day shows the guest name(s) via the native tooltip. */
function StayCalendar({ stays, calendarStays }: { stays: Stay[]; calendarStays: CalendarStay[] }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const now = new Date();
  const view = new Date(Date.UTC(now.getFullYear(), now.getMonth() + monthOffset, 1));
  const year = view.getUTCFullYear();
  const month = view.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const todayIso = new Date().toISOString().slice(0, 10);

  const byDay = new Map<string, { guests: string[]; events: string[] }>();
  // Occupancy comes from calendarStays (past + future) so past booked
  // nights stay blue; events come from the upcoming/in-house stays list.
  for (const cs of calendarStays) {
    for (const d of stayDates(cs.arrival, cs.departure)) {
      if (!byDay.has(d)) byDay.set(d, { guests: [], events: [] });
      if (!byDay.get(d)!.guests.includes(cs.guestName)) byDay.get(d)!.guests.push(cs.guestName);
    }
  }
  for (const s of stays) {
    for (const d of stayDates(s.arrival, s.departure)) {
      if (!byDay.has(d)) byDay.set(d, { guests: [], events: [] });
      if (!byDay.get(d)!.guests.includes(s.guestName)) byDay.get(d)!.guests.push(s.guestName);
    }
    if (s.eventScheduled && s.eventDate) {
      if (!byDay.has(s.eventDate)) byDay.set(s.eventDate, { guests: [], events: [] });
      byDay.get(s.eventDate)!.events.push(s.guestName);
    }
  }

  const monthLabel = view.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <aside className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 lg:sticky lg:top-20">
      <div className="mb-2 flex items-center justify-between">
        <button
          onClick={() => setMonthOffset((o) => o - 1)}
          className="rounded px-2 py-0.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          aria-label="Previous month"
        >
          ‹
        </button>
        <h3 className="text-sm font-semibold">{monthLabel}</h3>
        <button
          onClick={() => setMonthOffset((o) => o + 1)}
          className="rounded px-2 py-0.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-black/40 dark:text-white/40">
        {DOW.map((d, i) => (
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
                ...info.guests.map((g) => `Guest: ${g}`),
                ...info.events.map((g) => `🎉 EVENT — ${g}`),
              ].join("\n")
            : "Available";
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
          <span className="inline-block h-3 w-3 rounded-sm bg-blue-500/80" /> Booked
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-black/[0.06] dark:bg-white/10" /> Available
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm ring-2 ring-amber-400" /> Event day
        </span>
      </div>
      <p className="mt-1 text-[11px] text-black/40 dark:text-white/40">Hover a day to see who&apos;s at the house.</p>
    </aside>
  );
}

export function ManagementBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});
  const [logDraft, setLogDraft] = useState("");
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
        setError(err instanceof Error ? err.message : "Failed to load.");
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
    const t = setInterval(() => void load(true), 120_000);
    return () => clearInterval(t);
  }, [load]);

  async function setEvent(s: Stay, eventScheduled: boolean, eventDate: string | null) {
    // Optimistic: flip the checkbox/date in place immediately (2026-08-16 —
    // waiting for the server round-trip made the first click feel dead, so
    // people double-clicked). The POST syncs in the background; on failure
    // we resync from the server and show the error.
    setData((prev) =>
      prev
        ? {
            ...prev,
            stays: prev.stays.map((x) =>
              x.bookingId === s.bookingId ? { ...x, eventScheduled, eventDate } : x
            ),
          }
        : prev
    );
    try {
      const res = await fetch("/api/management/booking-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: s.bookingId, eventScheduled, eventDate }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save event flag.");
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
      if (kind === "activity") setLogDraft("");
      else if (bookingId !== undefined) setNoteDrafts((d) => ({ ...d, [bookingId]: "" }));
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">{error}</div>;
  }
  if (!data) {
    return <div className="rounded-xl border border-black/10 dark:border-white/10 p-6 text-sm text-black/50 dark:text-white/50">Loading stays…</div>;
  }

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-500">{error}</div>}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      <section className="lg:col-span-2 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold">Upcoming &amp; in-house stays ({data.stays.length})</h2>
        {data.stays.length === 0 && (
          <p className="text-sm text-black/50 dark:text-white/50">No upcoming stays on the calendar.</p>
        )}
        <div className="space-y-3">
          {data.stays.map((s) => (
            <div key={s.bookingId} className="rounded-lg border border-black/10 dark:border-white/10 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{s.guestName}</span>
                <span className="text-sm text-black/60 dark:text-white/60">
                  {fmtDate(s.arrival)} → {fmtDate(s.departure)}
                  {s.nights ? ` · ${s.nights} night${s.nights === 1 ? "" : "s"}` : ""}
                </span>
                {(s.adults || s.children) && (
                  <span className="text-sm text-black/60 dark:text-white/60">
                    {s.adults ?? 0} adult{(s.adults ?? 0) === 1 ? "" : "s"}
                    {s.children ? ` + ${s.children} kid${s.children === 1 ? "" : "s"}` : ""}
                  </span>
                )}
                {s.extrasRequested && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                    Paid extras requested
                  </span>
                )}
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
                    <span className="text-black/50 dark:text-white/50">📞 Proxy (via platform)</span>
                  )}
                  {s.guestEmail && (
                    <a href={`mailto:${s.guestEmail}`} className="text-[var(--accent)] hover:underline break-all">
                      ✉️ {s.guestEmail}
                    </a>
                  )}
                  {s.guestEmailProxy && (
                    <span className="text-black/50 dark:text-white/50">✉️ Proxy (via platform)</span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={Boolean(s.eventScheduled)}
                    onChange={(e) => void setEvent(s, e.target.checked, e.target.checked ? (s.eventDate ?? null) : null)}
                    className="h-6 w-6 cursor-pointer accent-red-600"
                  />
                  Event deposit paid &amp; scheduled during stay
                </label>
                {s.eventScheduled && (
                  <select
                    value={s.eventDate ?? ""}
                    onChange={(e) => void setEvent(s, true, e.target.value || null)}
                    className="rounded-md border-2 border-red-500 bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="">Pick the event date…</option>
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
                {s.eventScheduled && s.eventDate && (
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
                    EVENT{" "}
                    {new Date(`${s.eventDate}T00:00:00Z`).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
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
                      {n.body}
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
                  placeholder="Add a note (wedding/event, chef booked, early check-in…)"
                  value={noteDrafts[s.bookingId] ?? ""}
                  onChange={(e) => setNoteDrafts((d) => ({ ...d, [s.bookingId]: e.target.value }))}
                />
                <button
                  type="submit"
                  disabled={busy || !(noteDrafts[s.bookingId] ?? "").trim()}
                  className="rounded-md bg-black/80 dark:bg-white/80 px-3 py-1 text-sm text-white dark:text-black disabled:opacity-40"
                >
                  Add
                </button>
              </form>
            </div>
          ))}
        </div>
      </section>

      <StayCalendar stays={data.stays} calendarStays={data.calendarStays ?? []} />
      </div>

      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold">Team activity log</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void post("activity", logDraft);
          }}
        >
          <input
            className="flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-sm"
            placeholder="Log what you did (pool cleaned, towels restocked, gas refilled…)"
            value={logDraft}
            onChange={(e) => setLogDraft(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy || !logDraft.trim()}
            className="rounded-md bg-black/80 dark:bg-white/80 px-3 py-1 text-sm text-white dark:text-black disabled:opacity-40"
          >
            Log it
          </button>
        </form>
        {data.activityLog.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">Nothing logged yet.</p>
        ) : (
          <ul className="space-y-1">
            {data.activityLog.map((a) => (
              <li key={a.id} className="rounded bg-black/5 dark:bg-white/5 px-2 py-1 text-sm">
                {a.body}
                <span className="ml-2 text-xs text-black/40 dark:text-white/40">
                  — {a.author}, {fmtWhen(a.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
