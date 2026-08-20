"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Construction Budget (2026-08-20, Seni's ask) — CEO/admin only (see
// api/construction-budget/route.ts). Two parts: an "Import" panel where
// pasting a range copied straight out of the Google Sheet (headers + rows,
// tab-separated — Google Sheets' default copy format) replaces the whole
// budget, and a category-grouped table of the result with an editable
// Actual (USD) column for tracking real spend against budget over time.
//
// The source spreadsheet has NO dedicated "category" column — a chapter
// (e.g. "1  PRELIMINARES") is just a row with a code and a description but
// no unit/quantity/price, followed by decimal-coded line items (1.01, 1.02,
// ...) until the next whole-number code. parseImportText below detects that
// pattern directly so a raw copy-paste needs no manual restructuring.

type Item = {
  id: string;
  code: string | null;
  category: string;
  categoryOriginal: string | null;
  description: string;
  descriptionOriginal: string | null;
  unit: string | null;
  quantity: number | null;
  unitPriceCop: number | null;
  totalCop: number | null;
  budgetedUsd: number | null;
  actualUsd: number | null;
  notes: string | null;
  sortOrder: number;
  updatedAt: string;
  updatedBy: string | null;
};

type ImportRow = {
  code: string | null;
  category: string;
  categoryOriginal: string | null;
  description: string;
  descriptionOriginal: string | null;
  unit: string | null;
  quantity: number | null;
  unitPriceCop: number | null;
  totalCop: number | null;
  budgetedUsd: number | null;
};

function fmtUsd(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtCop(n: number | null): string {
  if (n === null) return "—";
  return "$" + Math.round(n).toLocaleString("es-CO");
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Colombian number format throughout the source sheet: "." = thousands
// separator, "," = decimal separator (e.g. "$ 112.000,00" = 112000.00,
// "1.807" = 1807). Strips currency/percent symbols and spaces first.
function parseCoNumber(raw: string): number | null {
  let s = raw.trim().replace(/[$%\s]/g, "");
  if (!s || s === "-" || s === "—") return null;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function stripAccents(s: string): string {
  // Combining diacritical marks range (U+0300–U+036F) — written as an
  // explicit backslash-u escape rather than literal characters in the regex
  // to avoid any editor/encoding ambiguity.
  return s.normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "");
}

function normHeader(s: string): string {
  return stripAccents(s.trim().toLowerCase());
}

const HEADER_ALIASES: Record<string, string[]> = {
  code: ["codigo", "code"],
  descriptionEs: ["capitulos y actividades", "actividad", "descripcion"],
  descriptionEn: ["chapters and activities", "description", "activity"],
  unit: ["unidad", "unit"],
  quantity: ["cantidad", "quantity", "qty"],
  unitPriceCop: ["valor unitario", "unit price", "unit cost"],
  totalCop: ["valor total", "total"],
  budgetedUsd: ["budgeted total (usd)", "budgeted (usd)", "budgeted usd", "budget usd", "budgeted total"],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Bug fixed 2026-08-20 (Seni: "unit price, total (COP), budgeted (USD)...
// missing" after import): the old version returned the FIRST role (in
// object-declaration order) whose alias was a raw substring of the header
// cell. Two collisions silently stole real columns: "unit" (the Unit
// role's own alias) is a substring of "unitario", so "Valor Unitario"
// matched the Unit role instead of unitPriceCop — and "total" (totalCop's
// generic alias) is a substring of "Budgeted Total (USD)", so that column
// matched totalCop instead of budgetedUsd. Both times the real target role
// ended up with zero matching columns, so every row imported that field as
// null. Fixed two ways: (1) require a WORD boundary around the alias so
// "unit" can't match inside "unitario" (it's followed by "a", not a
// boundary) — this alone fixes the unit/unitario collision; (2) when a cell
// matches more than one role's alias, prefer the LONGEST alias rather than
// the first-declared role — "budgeted total (usd)"/"budgeted total" (14-21
// chars) beats the generic "total" (5 chars) even though "total" is a
// legitimate standalone word inside that header too.
function matchHeaderRole(cell: string): string | null {
  const n = normHeader(cell);
  const candidates: { role: string; alias: string }[] = [];
  for (const [role, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const a of aliases) {
      if (n === a) {
        candidates.push({ role, alias: a });
        continue;
      }
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(a)}(?:[^a-z0-9]|$)`);
      if (re.test(n)) candidates.push({ role, alias: a });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.alias.length - a.alias.length);
  return candidates[0].role;
}

/** Parses a raw paste (tab-separated, as Google Sheets copies by default —
 * comma-separated also accepted as a fallback) into import rows. Scans for
 * the header row (order-independent, alias-matched) rather than assuming a
 * fixed position, so title/currency rows above the real table in a raw
 * sheet copy are harmlessly skipped. Returns an error message instead of
 * rows when no usable header is found. */
function parseImportText(raw: string): { rows: ImportRow[] } | { error: string } {
  const lines = raw.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { error: "Paste is empty." };

  const splitLine = (l: string) => (l.includes("\t") ? l.split("\t") : l.split(","));

  let headerIdx = -1;
  let roleByCol: Record<number, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const roles: Record<number, string> = {};
    cells.forEach((c, idx) => {
      const role = matchHeaderRole(c);
      if (role) roles[idx] = role;
    });
    // A real header needs at least a description column and one of
    // unit/quantity/price — enough to distinguish it from a stray row that
    // happens to contain one matching word.
    const roleSet = new Set(Object.values(roles));
    if ((roleSet.has("descriptionEn") || roleSet.has("descriptionEs")) && (roleSet.has("unit") || roleSet.has("quantity"))) {
      headerIdx = i;
      roleByCol = roles;
      break;
    }
  }
  if (headerIdx === -1) {
    return {
      error:
        "Couldn't find a header row (expecting columns like Code, Chapters and Activities, Unit, Quantity…). Include the header row in your paste.",
    };
  }

  const rows: ImportRow[] = [];
  let currentCategory: string | null = null;
  let currentCategoryOriginal: string | null = null;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const get = (role: string) => {
      for (const [idxStr, r] of Object.entries(roleByCol)) {
        if (r === role) return (cells[Number(idxStr)] ?? "").trim();
      }
      return "";
    };
    const code = get("code") || null;
    const descEs = get("descriptionEs");
    const descEn = get("descriptionEn");
    const unit = get("unit") || null;
    const quantity = parseCoNumber(get("quantity"));
    const unitPriceCop = parseCoNumber(get("unitPriceCop"));
    const totalCop = parseCoNumber(get("totalCop"));
    const budgetedUsd = parseCoNumber(get("budgetedUsd"));
    const description = descEn || descEs;
    if (!description) continue; // blank row

    // Chapter header: no unit/quantity/price at all — the sheet's convention
    // for "this row names a chapter, not a line item".
    if (!unit && quantity === null && unitPriceCop === null) {
      currentCategory = description;
      currentCategoryOriginal = descEn ? descEs || null : null;
      continue;
    }

    rows.push({
      code,
      category: currentCategory || "Uncategorized",
      categoryOriginal: currentCategory ? currentCategoryOriginal : null,
      description,
      descriptionOriginal: descEn && descEs && descEn !== descEs ? descEs : null,
      unit,
      quantity,
      unitPriceCop,
      totalCop,
      budgetedUsd,
    });
  }

  if (rows.length === 0) return { error: "Found a header row but no line items under it." };
  return { rows };
}

function groupByCategory(items: Item[]): { category: string; items: Item[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, Item[]>();
  for (const item of items) {
    if (!buckets.has(item.category)) {
      order.push(item.category);
      buckets.set(item.category, []);
    }
    buckets.get(item.category)!.push(item);
  }
  return order.map((category) => ({ category, items: buckets.get(category)! }));
}

export function ConstructionBudgetBoard() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState<ImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const hasDataRef = useRef(false);

  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/construction-budget${fresh ? "?fresh=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setItems(json.items ?? []);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function handlePreview() {
    setNotice(null);
    const result = parseImportText(pasteText);
    if ("error" in result) {
      setError(result.error);
      setPreview(null);
      return;
    }
    setError(null);
    setPreview(result.rows);
  }

  async function confirmImport() {
    if (!preview || importing) return;
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/construction-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: preview }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice(`Imported ${json.count} line items. This replaced whatever budget was here before.`);
      setPasteText("");
      setPreview(null);
      setShowImport(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  async function saveActual(item: Item, actualUsd: number | null) {
    setSavingId(item.id);
    setError(null);
    try {
      const res = await fetch("/api/construction-budget", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, actualUsd }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? json.item : i)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSavingId(null);
    }
  }

  async function removeItem(item: Item) {
    if (!window.confirm(`Remove "${item.description}" from the budget?`)) return;
    setError(null);
    try {
      const res = await fetch("/api/construction-budget", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove.");
    }
  }

  const totals = useMemo(() => {
    const list = items ?? [];
    const budgeted = list.reduce((s, i) => s + (i.budgetedUsd ?? 0), 0);
    const actual = list.reduce((s, i) => s + (i.actualUsd ?? 0), 0);
    const trackedCount = list.filter((i) => i.actualUsd !== null).length;
    return { budgeted, actual, remaining: budgeted - actual, trackedCount, total: list.length };
  }, [items]);

  const groups = useMemo(() => groupByCategory(items ?? []), [items]);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
          <div className="text-xs text-black/50 dark:text-white/50">Total budgeted</div>
          <div className="text-lg font-semibold">{fmtUsd(totals.budgeted)}</div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
          <div className="text-xs text-black/50 dark:text-white/50">Actual spend recorded</div>
          <div className="text-lg font-semibold">{fmtUsd(totals.actual)}</div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
          <div className="text-xs text-black/50 dark:text-white/50">Remaining</div>
          <div className={`text-lg font-semibold ${totals.remaining < 0 ? "text-red-500" : ""}`}>
            {fmtUsd(totals.remaining)}
          </div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
          <div className="text-xs text-black/50 dark:text-white/50">Lines with actuals recorded</div>
          <div className="text-lg font-semibold">
            {totals.trackedCount} / {totals.total}
          </div>
        </div>
      </div>

      {/* Import panel */}
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Import from spreadsheet</h3>
            <p className="text-xs text-black/50 dark:text-white/50">
              In Google Sheets, select the header row through the last line item, copy (⌘/Ctrl+C), and paste below.
              Chapter rows (e.g. &ldquo;1 PRELIMINARES&rdquo;) are detected automatically and become categories —
              no need to restructure anything first. Importing replaces the entire budget shown below.
            </p>
          </div>
          <button
            onClick={() => setShowImport((s) => !s)}
            className="shrink-0 rounded-md border border-black/15 dark:border-white/15 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5"
          >
            {showImport ? "Cancel" : items && items.length > 0 ? "Re-import" : "Import"}
          </button>
        </div>

        {notice && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {showImport && (
          <div className="space-y-2">
            <textarea
              className="h-40 w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 font-mono text-xs"
              placeholder="Paste the copied range here…"
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                setPreview(null);
              }}
            />
            <div className="flex gap-2">
              <button
                onClick={handlePreview}
                disabled={!pasteText.trim()}
                className="rounded-md border border-black/15 dark:border-white/15 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
              >
                Preview
              </button>
              {preview && (
                <button
                  onClick={() => void confirmImport()}
                  disabled={importing}
                  className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"
                >
                  {importing ? "Importing…" : `Import ${preview.length} line items`}
                </button>
              )}
            </div>
            {preview && (
              <div className="max-h-48 overflow-auto rounded-md border border-black/10 dark:border-white/10 text-xs">
                <table className="w-full">
                  <tbody>
                    {preview.slice(0, 30).map((r, i) => (
                      <tr key={i} className="border-b border-black/5 dark:border-white/5">
                        <td className="px-2 py-1 text-black/40 dark:text-white/40">{r.category}</td>
                        <td className="px-2 py-1">{r.description}</td>
                        <td className="px-2 py-1 text-right">{r.budgetedUsd !== null ? fmtUsd(r.budgetedUsd) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.length > 30 && (
                  <div className="px-2 py-1 text-black/40 dark:text-white/40">…and {preview.length - 30} more</div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Line items, grouped by chapter/category */}
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 overflow-x-auto">
        {!items ? (
          <p className="p-4 text-sm text-black/50 dark:text-white/50">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-black/50 dark:text-white/50">
            Nothing imported yet — use Import above to paste in the budget spreadsheet.
          </p>
        ) : (
          <table className="w-full min-w-[64rem] text-sm">
            <thead>
              <tr className="border-b border-black/10 dark:border-white/10 text-left text-xs text-black/50 dark:text-white/50">
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Unit</th>
                <th className="px-3 py-2 font-medium text-right">Qty</th>
                <th className="px-3 py-2 font-medium text-right">Unit price (COP)</th>
                <th className="px-3 py-2 font-medium text-right">Total (COP)</th>
                <th className="px-3 py-2 font-medium text-right">Budgeted (USD)</th>
                <th className="px-3 py-2 font-medium text-right">Actual (USD)</th>
                <th className="px-3 py-2 font-medium text-right">Variance</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const subBudgeted = g.items.reduce((s, i) => s + (i.budgetedUsd ?? 0), 0);
                const subActual = g.items.reduce((s, i) => s + (i.actualUsd ?? 0), 0);
                return (
                  <Fragment key={g.category}>
                    <tr className="bg-black/5 dark:bg-white/10">
                      <td colSpan={6} className="px-3 py-1.5 text-xs font-semibold">
                        {g.category}
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs font-semibold">{fmtUsd(subBudgeted)}</td>
                      <td className="px-3 py-1.5 text-right text-xs font-semibold">{fmtUsd(subActual)}</td>
                      <td
                        className={`px-3 py-1.5 text-right text-xs font-semibold ${
                          subBudgeted - subActual < 0 ? "text-red-500" : ""
                        }`}
                      >
                        {fmtUsd(subBudgeted - subActual)}
                      </td>
                      <td />
                    </tr>
                    {g.items.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        saving={savingId === item.id}
                        onSaveActual={(v) => void saveActual(item, v)}
                        onRemove={() => void removeItem(item)}
                      />
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-black/15 dark:border-white/15 font-semibold">
                <td colSpan={6} className="px-3 py-2 text-right text-xs">
                  Grand total
                </td>
                <td className="px-3 py-2 text-right text-xs">{fmtUsd(totals.budgeted)}</td>
                <td className="px-3 py-2 text-right text-xs">{fmtUsd(totals.actual)}</td>
                <td className={`px-3 py-2 text-right text-xs ${totals.remaining < 0 ? "text-red-500" : ""}`}>
                  {fmtUsd(totals.remaining)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </div>
  );
}

function ItemRow({
  item,
  saving,
  onSaveActual,
  onRemove,
}: {
  item: Item;
  saving: boolean;
  onSaveActual: (v: number | null) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(item.actualUsd !== null ? String(item.actualUsd) : "");
  const variance = item.actualUsd !== null && item.budgetedUsd !== null ? item.budgetedUsd - item.actualUsd : null;

  return (
    <tr className="border-b border-black/5 dark:border-white/5 align-top">
      <td className="px-3 py-1.5 text-xs text-black/50 dark:text-white/50 whitespace-nowrap">{item.code}</td>
      <td className="px-3 py-1.5">
        {item.description}
        {item.descriptionOriginal && (
          <div className="text-xs text-black/40 dark:text-white/40">{item.descriptionOriginal}</div>
        )}
        {item.notes && <div className="text-xs text-black/40 dark:text-white/40">{item.notes}</div>}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">{item.unit}</td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">{item.quantity ?? ""}</td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtCop(item.unitPriceCop)}</td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtCop(item.totalCop)}</td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtUsd(item.budgetedUsd)}</td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">
        <input
          type="number"
          min={0}
          step="0.01"
          className="w-24 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-1.5 py-1 text-right text-xs"
          placeholder="—"
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = draft.trim() === "" ? null : Number(draft);
            if (v !== item.actualUsd) onSaveActual(Number.isFinite(v as number) ? v : null);
          }}
        />
      </td>
      <td className={`px-3 py-1.5 text-right whitespace-nowrap ${variance !== null && variance < 0 ? "text-red-500" : ""}`}>
        {variance !== null ? fmtUsd(variance) : "—"}
      </td>
      <td className="px-3 py-1.5">
        <button onClick={onRemove} className="text-xs text-black/40 hover:text-red-500 dark:text-white/40">
          ✕
        </button>
      </td>
    </tr>
  );
}
