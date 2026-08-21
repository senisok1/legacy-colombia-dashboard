"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/components/LanguageProvider";

// Construction Management tab (2026-08-20, Seni's ask): an open-items
// checklist for the property — anyone with access to this tab (admin/owner
// or a CONSTRUCTION-role login, see src/proxy.ts) can add an item and check
// it off, with a companion activity log so there's always a "who did what"
// trail. Modeled on TeamActivityLog.tsx's fetch/render pattern (double-load
// on mount for instant paint), but its own tables/route — this isn't part
// of the Team Management/READ_ONLY surface at all.
//
// Categories (2026-08-20, Seni's ask: type "Gym" as a category and list
// items under it) are free-text, not a separate managed list — typing the
// same category name a second time groups under the existing heading, and
// the add-item field offers a datalist of categories already in use so a
// typo doesn't quietly create a near-duplicate bucket.
//
// Deletion (2026-08-20, Seni's ask: "only allow me, Seni Sok, to delete the
// activity logs") is gated by `canDelete` from the API response — true only
// for Seni's own login, not every CEO/admin account (see
// lib/construction.ts's isConstructionOwner). This covers both delete
// affordances on this tab: removing a checklist item and removing a single
// activity-log entry.

const UNCATEGORIZED = "__uncategorized__";

type Item = {
  id: string;
  title: string;
  notes: string | null;
  category: string | null;
  completed: boolean;
  completedBy: string | null;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
  noteCount: number;
  /** ISO date (YYYY-MM-DD), or null (2026-08-20, Seni's ask: "add estimated
   * date of completion for each open item for the construction team to
   * input"). */
  estimatedCompletionDate: string | null;
};

type LogEntry = {
  id: string;
  itemTitle: string;
  action: "created" | "completed" | "reopened" | "deleted" | "noted" | "scheduled" | "edited";
  detail: string | null;
  actor: string;
  at: string;
};

type Note = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Groups items by category (insertion order of first appearance),
 * "Uncategorized" always last regardless of when it first appears. */
function groupByCategory(items: Item[]): { key: string; label: string; items: Item[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.category?.trim() || UNCATEGORIZED;
    if (!buckets.has(key)) {
      order.push(key);
      buckets.set(key, []);
    }
    buckets.get(key)!.push(item);
  }
  const named = order.filter((k) => k !== UNCATEGORIZED).sort((a, b) => a.localeCompare(b));
  const groups = named.map((key) => ({ key, label: key, items: buckets.get(key)! }));
  if (buckets.has(UNCATEGORIZED)) {
    groups.push({ key: UNCATEGORIZED, label: "", items: buckets.get(UNCATEGORIZED)! });
  }
  return groups;
}

// ItemRow and GroupedList are deliberately module-level components, NOT
// nested inside ConstructionBoard (2026-08-20 fix, Seni reported "not
// allowing me to type in notes correctly after I click edit"). A component
// defined inside another component's body gets a brand-new function
// identity on every parent re-render — React then treats <ItemRow .../> as
// a completely different element type each time and unmounts/remounts the
// whole subtree, which drops input focus after every single keystroke
// (setEditDraft/setNoteDraft each trigger a ConstructionBoard re-render).
// Hoisting them here keeps their identity stable across renders so typing
// in the edit form (and the progress-notes textbox) behaves normally.
type EditDraft = { title: string; category: string; notes: string };

type ItemRowProps = {
  item: Item;
  completedRow: boolean;
  t: (key: string) => string;
  canDelete: boolean;
  togglingId: string | null;
  removingId: string | null;
  savingDateId: string | null;
  openNotesId: string | null;
  notesByItem: Record<string, Note[]>;
  loadingNotesId: string | null;
  noteDraft: Record<string, string>;
  postingNoteId: string | null;
  editingId: string | null;
  editDraft: EditDraft;
  savingEditId: string | null;
  onToggle: (item: Item) => void;
  onRemove: (item: Item) => void;
  onUpdateEstimatedDate: (item: Item, dateStr: string) => void;
  onToggleNotes: (item: Item) => void;
  onNoteDraftChange: (itemId: string, value: string) => void;
  onPostNote: (item: Item) => void;
  onStartEdit: (item: Item) => void;
  onCancelEdit: () => void;
  onEditFieldChange: (field: keyof EditDraft, value: string) => void;
  onSaveEdit: (item: Item) => void;
};

function ItemRow({
  item,
  completedRow,
  t,
  canDelete,
  togglingId,
  removingId,
  savingDateId,
  openNotesId,
  notesByItem,
  loadingNotesId,
  noteDraft,
  postingNoteId,
  editingId,
  editDraft,
  savingEditId,
  onToggle,
  onRemove,
  onUpdateEstimatedDate,
  onToggleNotes,
  onNoteDraftChange,
  onPostNote,
  onStartEdit,
  onCancelEdit,
  onEditFieldChange,
  onSaveEdit,
}: ItemRowProps) {
  const notesOpen = openNotesId === item.id;
  const notes = notesByItem[item.id];
  const editing = editingId === item.id;
  // Overdue = has an estimated date, that date is today or in the past, and
  // the item isn't done yet (2026-08-21, Seni's ask: "when the est.
  // completion date is due turn the 'est. completion:' red"). Plain string
  // comparison is safe here since both sides are "YYYY-MM-DD" — ISO date
  // strings sort/compare the same as their calendar order.
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !completedRow && item.estimatedCompletionDate !== null && item.estimatedCompletionDate <= today;
  return (
    <li className="rounded bg-black/5 dark:bg-white/5 px-2 py-1.5 text-sm">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={completedRow}
          disabled={togglingId === item.id}
          onChange={() => onToggle(item)}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className={completedRow ? "line-through text-black/50 dark:text-white/50" : ""}>{item.title}</div>
          {item.notes && <div className="text-xs text-black/50 dark:text-white/50">{item.notes}</div>}
          <div className="text-xs text-black/40 dark:text-white/40">
            {completedRow
              ? `${item.completedBy}, ${item.completedAt ? fmtWhen(item.completedAt) : ""}`
              : `${item.createdBy}, ${fmtWhen(item.createdAt)}`}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-black/50 dark:text-white/50">
            <span className={overdue ? "font-semibold text-red-500" : ""}>{t("construction.estCompletion")}</span>
            <input
              type="date"
              value={item.estimatedCompletionDate ?? ""}
              disabled={savingDateId === item.id}
              onChange={(e) => onUpdateEstimatedDate(item, e.target.value)}
              className={`rounded border bg-transparent px-1 py-0.5 text-xs disabled:opacity-40 ${
                overdue ? "border-red-500 text-red-500" : "border-black/15 dark:border-white/15"
              }`}
            />
          </div>
        </div>
        <button
          onClick={() => onToggleNotes(item)}
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
            item.noteCount > 0
              ? "text-[var(--accent)] hover:underline"
              : "text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
          }`}
        >
          {t("construction.notesButton")}
          {item.noteCount > 0 ? ` (${item.noteCount})` : ""}
        </button>
        <button
          onClick={() => (editing ? onCancelEdit() : onStartEdit(item))}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
        >
          {t("construction.editButton")}
        </button>
        {canDelete && (
          <button
            onClick={() => onRemove(item)}
            disabled={removingId === item.id}
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-black/40 hover:text-red-500 dark:text-white/40 disabled:opacity-40"
          >
            {removingId === item.id ? t("common.deleting") : t("common.delete")}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-2 ml-6 space-y-1.5 border-l-2 border-black/10 dark:border-white/10 pl-3">
          <div>
            <label className="text-xs text-black/50 dark:text-white/50">{t("construction.editTitleLabel")}</label>
            <input
              className="mt-0.5 w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-xs"
              value={editDraft.title}
              onChange={(e) => onEditFieldChange("title", e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-black/50 dark:text-white/50">{t("construction.editCategoryLabel")}</label>
            <input
              list="construction-categories"
              className="mt-0.5 w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-xs"
              value={editDraft.category}
              onChange={(e) => onEditFieldChange("category", e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-black/50 dark:text-white/50">{t("construction.editNotesLabel")}</label>
            <input
              className="mt-0.5 w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-xs"
              value={editDraft.notes}
              onChange={(e) => onEditFieldChange("notes", e.target.value)}
            />
          </div>
          <div className="flex gap-1.5 pt-0.5">
            <button
              onClick={() => onSaveEdit(item)}
              disabled={savingEditId === item.id || !editDraft.title.trim()}
              className="shrink-0 rounded-md bg-black/80 dark:bg-white/80 px-2 py-1 text-xs text-white dark:text-black disabled:opacity-40"
            >
              {savingEditId === item.id ? t("construction.saving") : t("construction.saveEdit")}
            </button>
            <button
              onClick={onCancelEdit}
              disabled={savingEditId === item.id}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80 disabled:opacity-40"
            >
              {t("construction.cancelEdit")}
            </button>
          </div>
        </div>
      )}

      {notesOpen && (
        <div className="mt-2 ml-6 space-y-2 border-l-2 border-black/10 dark:border-white/10 pl-3">
          {loadingNotesId === item.id && !notes ? (
            <p className="text-xs text-black/50 dark:text-white/50">{t("construction.loading")}</p>
          ) : !notes || notes.length === 0 ? (
            <p className="text-xs text-black/50 dark:text-white/50">{t("construction.noNotes")}</p>
          ) : (
            <ul className="space-y-1.5">
              {notes.map((n) => (
                <li key={n.id} className="text-xs">
                  <span className="text-black/80 dark:text-white/80">{n.body}</span>
                  <div className="text-black/40 dark:text-white/40">
                    {n.author}, {fmtWhen(n.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-1.5">
            <input
              className="min-w-0 flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-xs"
              placeholder={t("construction.notePlaceholder")}
              value={noteDraft[item.id] ?? ""}
              onChange={(e) => onNoteDraftChange(item.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onPostNote(item);
              }}
            />
            <button
              onClick={() => onPostNote(item)}
              disabled={postingNoteId === item.id || !(noteDraft[item.id] ?? "").trim()}
              className="shrink-0 rounded-md bg-black/80 dark:bg-white/80 px-2 py-1 text-xs text-white dark:text-black disabled:opacity-40"
            >
              {postingNoteId === item.id ? t("construction.posting") : t("construction.postNote")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

type GroupedListProps = {
  groups: { key: string; label: string; items: Item[] }[];
  completedRow: boolean;
  t: (key: string) => string;
  itemRowProps: Omit<ItemRowProps, "item" | "completedRow">;
};

function GroupedList({ groups, completedRow, t, itemRowProps }: GroupedListProps) {
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.key}>
          {/* Category headings colored red (2026-08-20, Seni's ask: "change
              the color of the category description... to red so that it
              stands out more") — visually separates a category divider
              from ordinary item text at a glance. */}
          {g.label && <div className="mb-1 text-xs font-semibold text-red-600 dark:text-red-400">{g.label}</div>}
          {!g.label && groups.length > 1 && (
            <div className="mb-1 text-xs font-semibold text-black/40 dark:text-white/40">
              {t("construction.uncategorized")}
            </div>
          )}
          <ul className="space-y-1">
            {g.items.map((i) => (
              <ItemRow key={i.id} item={i} completedRow={completedRow} {...itemRowProps} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ConstructionBoard() {
  const t = useT();
  const [items, setItems] = useState<Item[] | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [canDelete, setCanDelete] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [category, setCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removingLogId, setRemovingLogId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-item notes thread (2026-08-20, Seni's ask) — collapsed by default,
  // fetched lazily on first expand and cached per item so reopening doesn't
  // re-fetch. Keyed by item id, same closure-over-state pattern as the rest
  // of this component.
  const [openNotesId, setOpenNotesId] = useState<string | null>(null);
  const [notesByItem, setNotesByItem] = useState<Record<string, Note[]>>({});
  const [loadingNotesId, setLoadingNotesId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [postingNoteId, setPostingNoteId] = useState<string | null>(null);
  // The activity log itself is collapsed by default (2026-08-20, Seni's ask:
  // "hide all of the activity in the activity log... make it an Activity Log
  // button so when you click on it, it then expands").
  const [showLog, setShowLog] = useState(false);
  // Estimated completion date (2026-08-20, Seni's ask) — per-item saving
  // indicator, same pattern as togglingId/removingId above.
  const [savingDateId, setSavingDateId] = useState<string | null>(null);
  // Edit title/category/notes (2026-08-20, Seni's ask: "an edit tab next to
  // progress notes so that I can modify the 'add an item' description") —
  // inline form, one open at a time, same access as the rest of the tab.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; category: string; notes: string }>({
    title: "",
    category: "",
    notes: "",
  });
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
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
      setCanDelete(Boolean(json.canDelete));
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void load().then(() => load(true));
  }, [load]);

  const knownCategories = useMemo(() => {
    const set = new Set<string>();
    for (const i of items ?? []) {
      const c = i.category?.trim();
      if (c) set.add(c);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/construction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          notes: notes.trim() || undefined,
          category: category.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setTitle("");
      setNotes("");
      // Category deliberately NOT cleared — adding several items to the
      // same category (e.g. a handful of Gym repairs) in a row is the
      // common case.
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

  async function removeLogEntry(entry: LogEntry) {
    if (removingLogId || !window.confirm(t("construction.deleteLogConfirm"))) return;
    setRemovingLogId(entry.id);
    setError(null);
    try {
      const res = await fetch("/api/construction/log", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete.");
    } finally {
      setRemovingLogId(null);
    }
  }

  async function updateEstimatedDate(item: Item, dateStr: string) {
    if (savingDateId) return;
    const value = dateStr || null;
    if (value === item.estimatedCompletionDate) return;
    setSavingDateId(item.id);
    setError(null);
    try {
      const res = await fetch("/api/construction", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, estimatedCompletionDate: value }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update the date.");
    } finally {
      setSavingDateId(null);
    }
  }

  async function toggleNotes(item: Item) {
    if (openNotesId === item.id) {
      setOpenNotesId(null);
      return;
    }
    setOpenNotesId(item.id);
    if (notesByItem[item.id]) return; // already cached
    setLoadingNotesId(item.id);
    try {
      const res = await fetch(`/api/construction/notes?itemId=${encodeURIComponent(item.id)}`);
      const json = await res.json();
      if (res.ok) setNotesByItem((m) => ({ ...m, [item.id]: json.notes ?? [] }));
    } catch {
      // Silent — the panel just shows "no notes yet" and a retry happens
      // next time it's reopened.
    } finally {
      setLoadingNotesId(null);
    }
  }

  async function postNote(item: Item) {
    const text = (noteDraft[item.id] ?? "").trim();
    if (!text || postingNoteId) return;
    setPostingNoteId(item.id);
    setError(null);
    try {
      const res = await fetch("/api/construction/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, body: text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotesByItem((m) => ({ ...m, [item.id]: [...(m[item.id] ?? []), json.note] }));
      setNoteDraft((m) => ({ ...m, [item.id]: "" }));
      // Background refresh so the "Notes (N)" badge and the activity log's
      // new "noted" entry show up without the user having to do anything.
      void load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post the note.");
    } finally {
      setPostingNoteId(null);
    }
  }

  function startEdit(item: Item) {
    setEditingId(item.id);
    setEditDraft({ title: item.title, category: item.category ?? "", notes: item.notes ?? "" });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(item: Item) {
    const title = editDraft.title.trim();
    if (!title || savingEditId) return;
    setSavingEditId(item.id);
    setError(null);
    try {
      const res = await fetch("/api/construction", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          title,
          category: editDraft.category.trim() || null,
          notes: editDraft.notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEditingId(null);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the edit.");
    } finally {
      setSavingEditId(null);
    }
  }

  const open = (items ?? []).filter((i) => !i.completed);
  const completed = (items ?? []).filter((i) => i.completed);
  const openGroups = groupByCategory(open);
  const completedGroups = groupByCategory(completed);

  function actionLabel(action: LogEntry["action"]): string {
    return t(`construction.action${action.charAt(0).toUpperCase()}${action.slice(1)}`);
  }

  function onNoteDraftChange(itemId: string, value: string) {
    setNoteDraft((m) => ({ ...m, [itemId]: value }));
  }

  function onEditFieldChange(field: keyof EditDraft, value: string) {
    setEditDraft((d) => ({ ...d, [field]: value }));
  }

  const itemRowProps = {
    t,
    canDelete,
    togglingId,
    removingId,
    savingDateId,
    openNotesId,
    notesByItem,
    loadingNotesId,
    noteDraft,
    postingNoteId,
    editingId,
    editDraft,
    savingEditId,
    onToggle: (item: Item) => void toggle(item),
    onRemove: (item: Item) => void remove(item),
    onUpdateEstimatedDate: (item: Item, dateStr: string) => void updateEstimatedDate(item, dateStr),
    onToggleNotes: (item: Item) => void toggleNotes(item),
    onNoteDraftChange,
    onPostNote: (item: Item) => void postNote(item),
    onStartEdit: startEdit,
    onCancelEdit: cancelEdit,
    onEditFieldChange,
    onSaveEdit: (item: Item) => void saveEdit(item),
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
        <form className="flex flex-wrap gap-2" onSubmit={addItem}>
          <input
            className="min-w-[14rem] flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            placeholder={t("construction.placeholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            list="construction-categories"
            className="w-40 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            placeholder={t("construction.categoryPlaceholder")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <datalist id="construction-categories">
            {knownCategories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <input
            className="min-w-[10rem] flex-1 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
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
                <GroupedList groups={openGroups} completedRow={false} t={t} itemRowProps={itemRowProps} />
              )}
            </div>

            <div>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-black/50 dark:text-white/50">
                {t("construction.completedItems")} ({completed.length})
              </h3>
              {completed.length === 0 ? (
                <p className="text-sm text-black/50 dark:text-white/50">{t("construction.nothingCompleted")}</p>
              ) : (
                <GroupedList groups={completedGroups} completedRow={true} t={t} itemRowProps={itemRowProps} />
              )}
            </div>
          </>
        )}
      </section>

      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-2">
        <button
          onClick={() => setShowLog((v) => !v)}
          className="text-xs font-medium uppercase tracking-wide text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
        >
          {t("construction.activityLog")}
          {log ? ` (${log.length})` : ""} {showLog ? "▾" : "▸"}
        </button>
        {showLog &&
          (!log ? (
            <p className="text-sm text-black/50 dark:text-white/50">{t("construction.loading")}</p>
          ) : log.length === 0 ? (
            <p className="text-sm text-black/50 dark:text-white/50">{t("construction.nothingLogged")}</p>
          ) : (
            <ul className="space-y-1">
              {log.map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-2 text-sm text-black/70 dark:text-white/70">
                  <div>
                    <strong>{entry.actor}</strong> {actionLabel(entry.action)} &ldquo;{entry.itemTitle}&rdquo;
                    {entry.detail && <span className="text-black/50 dark:text-white/50"> — {entry.detail}</span>}
                    <span className="ml-2 text-xs text-black/40 dark:text-white/40">{fmtWhen(entry.at)}</span>
                  </div>
                  {canDelete && (
                    <button
                      onClick={() => void removeLogEntry(entry)}
                      disabled={removingLogId === entry.id}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-black/40 hover:text-red-500 dark:text-white/40 disabled:opacity-40"
                    >
                      {removingLogId === entry.id ? t("common.deleting") : t("common.delete")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
}
