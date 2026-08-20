"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/LanguageProvider";

// Construction Management tab (2026-08-20, Seni's ask): an open-items
// checklist for the property — anyone with access to this tab (admin/owner
// or a CONSTRUCTION-role login, see src/proxy.ts) can add an item and check
// it off, with a companion activity log so there's always a "who did what"
// trail. Modeled on TeamActivityLog.tsx's fetch/render pattern (double-load
// on mount for instant paint, CEO-only delete), but its own tables/route —
// this isn't part of the Team Management/READ_ONLY surface at all.

type Item = {
  id: string;
  title: string;
  notes: string | null;
  completed: boolean;
  completedBy: string | null;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
};

type LogEntry = {
  id: string;
  itemTitle: string;
  action: "created" | "completed" | "reopened" | "deleted";
  actor: string;
  at: string;
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ConstructionBoard() {
  const t = useT();
  const [items, setItems] = useState<Item[] | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [viewerRole, setViewerRole] = useState<string | undefined>();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Same guard as TeamActivityLog: a failed background refresh must never
  // blank out a list that's already on screen.
  const hasDataRef = useRef(false);

  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/construction${fresh ? "?fresh=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setItems(json.items ?? []);
      setLog(json.log ?? []);
      setViewerRole(json.viewerRole);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void load().then(() => load(true));
  }, [load]);

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/construction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), notes: notes.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setTitle("");
      setNotes("");
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the item.");
    } finally {
      setAdding(false);
    }
  }

  async function toggle(item: Item) {
    if (togglingId) return;
    setTogglingId(item.id);
    setError(null);
    try {
      const res = await fetch("/api/construction", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, completed: !item.completed }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update.");
    } finally {
      setTogglingId(null);
    }
  }

  async function remove(item: Item) {
    if (removingId || !window.confirm(t("construction.deleteConfirm"))) return;
    setRemovingId(item.id);
    setError(null);
    try {
      const res = await fetch("/api/construction", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete.");
    } finally {
      setRemovingId(null);
    }
  }

  const open = (items ?? []).filter((i) => !i.completed);
  const completed = (items ?? []).filter((i) => i.completed);

  function actionLabel(action: LogEntry["action"]): string {
    return t(`construction.action${action.charAt(0).toUpperCase()}${action.slice(1)}`);
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
        <form className="flex flex-wrap gap-2" onSubmit={addItem}>
          <input
            className="min-w-[16rem] flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            placeholder={t("construction.placeholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className="min-w-[12rem] flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            placeholder={t("construction.notesPlaceholder")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button
            type="submit"
            disabled={adding || !title.trim()}
            className="rounded-md bg-black/80 dark:bg-white/80 px-3 py-1.5 text-sm text-white dark:text-black disabled:opacity-40"
          >
            {t("construction.add")}
          </button>
        </form>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {!items ? (
          <p className="text-sm text-black/50 dark:text-white/50">{t("construction.loading")}</p>
        ) : (
          <>
            <div>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-black/50 dark:text-white/50">
                {t("construction.openItems")} ({open.length})
              </h3>
              {open.length === 0 ? (
                <p className="text-sm text-black/50 dark:text-white/50">{t("construction.nothingOpen")}</p>
              ) : (
                <ul className="space-y-1">
                  {open.map((i) => (
                    <li key={i.id} className="flex items-start gap-2 rounded bg-black/5 dark:bg-white/5 px-2 py-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={false}
                        disabled={togglingId === i.id}
                        onChange={() => void toggle(i)}
                        className="mt-0.5"
                      />
                      <div className="flex-1">
                        <div>{i.title}</div>
                        {i.notes && <div className="text-xs text-black/50 dark:text-white/50">{i.notes}</div>}
                        <div className="text-xs text-black/40 dark:text-white/40">
                          {i.createdBy}, {fmtWhen(i.createdAt)}
                        </div>
                      </div>
                      {viewerRole === "CEO" && (
                        <button
                          onClick={() => void remove(i)}
                          disabled={removingId === i.id}
                          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-black/40 hover:text-red-500 dark:text-white/40 disabled:opacity-40"
                        >
                          {removingId === i.id ? t("common.deleting") : t("common.delete")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-black/50 dark:text-white/50">
                {t("construction.completedItems")} ({completed.length})
              </h3>
              {completed.length === 0 ? (
                <p className="text-sm text-black/50 dark:text-white/50">{t("construction.nothingCompleted")}</p>
              ) : (
                <ul className="space-y-1">
                  {completed.map((i) => (
                    <li key={i.id} className="flex items-start gap-2 rounded bg-black/5 dark:bg-white/5 px-2 py-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={true}
                        disabled={togglingId === i.id}
                        onChange={() => void toggle(i)}
                        className="mt-0.5"
                      />
                      <div className="flex-1">
                        <div className="line-through text-black/50 dark:text-white/50">{i.title}</div>
                        {i.notes && <div className="text-xs text-black/40 dark:text-white/40">{i.notes}</div>}
                        <div className="text-xs text-black/40 dark:text-white/40">
                          {i.completedBy}, {i.completedAt ? fmtWhen(i.completedAt) : ""}
                        </div>
                      </div>
                      {viewerRole === "CEO" && (
                        <button
                          onClick={() => void remove(i)}
                          disabled={removingId === i.id}
                          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-black/40 hover:text-red-500 dark:text-white/40 disabled:opacity-40"
                        >
                          {removingId === i.id ? t("common.deleting") : t("common.delete")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-black/50 dark:text-white/50">
          {t("construction.activityLog")}
        </h3>
        {!log ? (
          <p className="text-sm text-black/50 dark:text-white/50">{t("construction.loading")}</p>
        ) : log.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">{t("construction.nothingLogged")}</p>
        ) : (
          <ul className="space-y-1">
            {log.map((entry) => (
              <li key={entry.id} className="text-sm text-black/70 dark:text-white/70">
                <strong>{entry.actor}</strong> {actionLabel(entry.action)} &ldquo;{entry.itemTitle}&rdquo;
                <span className="ml-2 text-xs text-black/40 dark:text-white/40">{fmtWhen(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
