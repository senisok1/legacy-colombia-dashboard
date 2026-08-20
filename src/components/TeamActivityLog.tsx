"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/LanguageProvider";

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
  const t = useT();
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [viewerLanguage, setViewerLanguage] = useState<string | undefined>();
  // Gates the Delete action below (2026-08-18, Seni's ask: "add a delete tab
  // under each 'log what you did' line item that can be deleted by admin /
  // owner's only"). This is a UI convenience only — the real gate is the
  // CEO-only check in api/management/activities/route.ts's DELETE handler.
  const [viewerRole, setViewerRole] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default (2026-08-20, Seni's ask: "hide all of the activity
  // in the activity log... make it an Activity Log button so when you click
  // on it, it then expands") — keeps the "log what you did" form front and
  // center without the full history cluttering the tab on every visit.
  const [showLog, setShowLog] = useState(false);
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
      setViewerRole(json.viewerRole);
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

  async function remove(id: string) {
    if (removingId || !window.confirm(t("log.deleteConfirm"))) return;
    setRemovingId(id);
    setError(null);
    try {
      const res = await fetch("/api/management/activities", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("log.failedDelete"));
    } finally {
      setRemovingId(null);
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
          placeholder={t("log.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="rounded-md bg-black/80 dark:bg-white/80 px-3 py-1.5 text-sm text-white dark:text-black disabled:opacity-40"
        >
          {t("log.logIt")}
        </button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <button
        onClick={() => setShowLog((v) => !v)}
        className="text-xs font-medium uppercase tracking-wide text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
      >
        {t("log.toggleButton")}
        {entries ? ` (${entries.length})` : ""} {showLog ? "▾" : "▸"}
      </button>

      {showLog &&
        (!entries ? (
          <p className="text-sm text-black/50 dark:text-white/50">{t("log.loadingActivity")}</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">{t("log.nothingLogged")}</p>
        ) : (
          <ul className="space-y-1">
            {entries.map((a) => (
              <li key={a.id} className="rounded bg-black/5 dark:bg-white/5 px-2 py-1.5 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    {textFor(a, viewerLanguage)}
                    <span className="ml-2 text-xs text-black/40 dark:text-white/40">
                      — {a.author}, {fmtWhen(a.at)}
                    </span>
                  </div>
                  {/* Admin/Owner only (2026-08-18, Seni's ask). */}
                  {viewerRole === "CEO" && (
                    <button
                      onClick={() => void remove(a.id)}
                      disabled={removingId === a.id}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-black/40 hover:text-red-500 dark:text-white/40 disabled:opacity-40"
                    >
                      {removingId === a.id ? t("common.deleting") : t("common.delete")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
