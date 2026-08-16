"use client";

import { useCallback, useEffect, useState } from "react";

// Client half of the Management tab (see app/management/page.tsx). One
// fetch renders everything; posting a note/activity optimistically
// refetches. Deliberately dependency-free and simple — the audience is the
// on-site team on their phones.

type StayNote = { id: string; body: string; author: string; at: string };
type Stay = {
  bookingId: number;
  guestName: string;
  guestPhone?: string | null;
  guestEmail?: string | null;
  propertyName?: string;
  arrival?: string;
  departure?: string;
  nights?: number;
  adults?: number;
  children?: number;
  source?: string;
  totalAmount?: number;
  extrasRequested: boolean;
  notes: StayNote[];
};
type LogEntry = { id: string; body: string; author: string; at: string };
type BoardData = { stays: Stay[]; activityLog: LogEntry[]; viewerRole?: string };

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

export function ManagementBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});
  const [logDraft, setLogDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/management");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json as BoardData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 120_000);
    return () => clearInterval(t);
  }, [load]);

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
      await load();
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

      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
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
              {(s.guestPhone || s.guestEmail) && (
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
                  {s.guestPhone && (
                    <a href={`tel:${s.guestPhone}`} className="text-[var(--accent)] hover:underline">
                      📞 {s.guestPhone}
                    </a>
                  )}
                  {s.guestEmail && (
                    <a href={`mailto:${s.guestEmail}`} className="text-[var(--accent)] hover:underline break-all">
                      ✉️ {s.guestEmail}
                    </a>
                  )}
                </div>
              )}
              {s.notes.length > 0 && (
                <ul className="space-y-1">
                  {s.notes.map((n) => (
                    <li key={n.id} className="rounded bg-black/5 dark:bg-white/5 px-2 py-1 text-sm">
                      {n.body}
                      <span className="ml-2 text-xs text-black/40 dark:text-white/40">
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
