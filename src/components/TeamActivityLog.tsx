"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Team Activity Log — its own tab as of 2026-08-17 (Seni's ask: "move 'Team
// Activity Log' from the bottom of the Management Tab to its own Tab right
// next to the Management Tab"). Previously the last section of
// ManagementBoard.tsx.
//
// Reads the same GET /api/management payload (its `activityLog` field), so
// it inherits that route's Redis snapshot and paints instantly; writes go to
// POST /api/management/activities with kind:"activity", the same endpoint
// team logins are allowlisted for in src/proxy.ts.

type LogEntry = {
  id: string;
  body: string;
  bodyOriginal?: string | null;
  authorLanguage?: string | null;
  author: string;
  at: string;
};

/** Text to show a given viewer: their own language when we have it.
 * (Mirror of the same helper in ManagementBoard.tsx — bodies are stored in
 * English, bodyOriginal keeps what a Spanish/Portuguese teammate typed.) */
function textFor(entry: LogEntry, viewerLanguage?: string): string {
  const viewer = (viewerLanguage || "English").toLowerCase();
  if (
    viewer !== "english" &&
    entry.authorLanguage &&
    entry.authorLanguage.toLowerCase() === viewer &&
    entry.bodyOriginal
  ) {
    return entry.bodyOriginal;
  }
  return entry.body;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function TeamActivityLog() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [viewerLanguage, setViewerLanguage] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same guard as the Management board: a failed background refresh must
  // never blank out a list that's already on screen.
  const hasDataRef = useRef(false);

  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/management${fresh ? "?fresh=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEntries(json.activityLog ?? []);
      setViewerLanguage(json.viewerLanguage);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : "Failed to load the log.");
    }
  }, []);

  useEffect(() => {
    void load().then(() => load(true));
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/management/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "activity", body: draft.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDraft("");
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !entries) {
    return <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">{error}</div>;
  }

  return (
    <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
      <form className="flex gap-2" onSubmit={submit}>
        <input
          className="flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
          placeholder="Log what you did (pool cleaned, towels restocked, gas refilled…)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="rounded-md bg-black/80 dark:bg-white/80 px-3 py-1.5 text-sm text-white dark:text-black disabled:opacity-40"
        >
          Log it
        </button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {!entries ? (
        <p className="text-sm text-black/50 dark:text-white/50">Loading activity…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-black/50 dark:text-white/50">Nothing logged yet.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((a) => (
            <li key={a.id} className="rounded bg-black/5 dark:bg-white/5 px-2 py-1.5 text-sm">
              {textFor(a, viewerLanguage)}
              <span className="ml-2 text-xs text-black/40 dark:text-white/40">
                — {a.author}, {fmtWhen(a.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
