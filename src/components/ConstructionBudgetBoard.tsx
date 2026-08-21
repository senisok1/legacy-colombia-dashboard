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
  /** Real spend, entered in COP (2026-08-21 — COP is the source of truth
   * for everything on this tab now). */
  actualCop: number | null;
  /** Derived server-side: actualCop / fx rate. Display only. */
  actualUsd: number | null;
  notes: string | null;
  sortOrder: number;
  updatedAt: string;
  updatedBy: string | null;
  /** How many notes are in this item's thread (2026-08-20, Seni's ask: "add
   * a notes button for each item in the budget for any user to add
   * notes"). Drives the "Notes (N)" button, same pattern as
   * ConstructionBoard.tsx's Progress Notes. */
  noteCount: number;
};

type BudgetNote = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
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

type LogEntry = {
  id: string;
  itemDescription: string | null;
  action: "imported" | "updated" | "deleted" | "noted" | "deposited";
  detail: string | null;
  actor: string;
  at: string;
};

// Construction Funds (2026-08-20, Seni's ask: "a 'remaining balance' box
// that shows construction funds I've deposited but haven't been used yet...
// a column that shows where the balance is spent so that funds that I
// deposit are always accounted for"). A ledger separate from the budget's
// line items — deposits live in their own table (api/construction-budget/
// funds/route.ts) so a re-import never touches them. "Spent" and the
// category breakdown are both computed live from actual_usd, the existing
// per-line real-spend field.
type Deposit = {
  id: string;
  /** Entered in COP (2026-08-21, Seni: "I will enter the amounts deposited
   * in COP as well"). */
  amountCop: number;
  note: string | null;
  depositedAt: string;
  createdAt: string;
  createdBy: string;
};

type CategorySpend = { category: string; spentCop: number };

/** COP drawn from the deposited funds against a Construction Management
 * open item (2026-08-21, Seni: "allocate deposited construction funds in
 * COP to those open item expenses as well so every dollar is accounted
 * for"). Entered on the Construction Management tab; shown here so the
 * Funds box accounts for it. */
type Allocation = {
  id: string;
  itemId: string;
  itemTitle: string;
  amountCop: number;
  note: string | null;
  createdAt: string;
  createdBy: string;
};

type Funds = {
  deposits: Deposit[];
  totalDepositedCop: number;
  budgetSpentCop: number;
  allocatedCop: number;
  totalSpentCop: number;
  remainingCop: number;
  spendByCategory: CategorySpend[];
  allocations: Allocation[];
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
    const rawCode = get("code");
    const descEs = get("descriptionEs");
    const descEn = get("descriptionEn");
    const unit = get("unit") || null;
    const quantity = parseCoNumber(get("quantity"));
    const unitPriceCop = parseCoNumber(get("unitPriceCop"));
    const totalCop = parseCoNumber(get("totalCop"));
    const budgetedUsd = parseCoNumber(get("budgetedUsd"));

    // Bug fixed 2026-08-20 (Seni: "I also don't see honorary fees and the
    // 19% tax rows at the bottom of the budget"): confirmed live against
    // Seni's actual sheet — "HONORARY FEES (8.5%)", "TAX 19%", and the
    // final "TOTAL" are merged cells spanning the Code+Description columns.
    // When copy-pasted as tab-separated text, a merged cell's text lands in
    // its FIRST column only (here, the Code column) and every other column
    // it spans comes through blank — so descEn/descEs were always empty for
    // these rows, and they got silently dropped by the "blank row" check
    // below. Chapter codes ("1".."26") always parse as a plain whole
    // number; these rows' "code" cell is real text, which is how we tell
    // them apart from an actual chapter header a few lines down.
    const codeIsChapterNumber =
      rawCode !== "" && parseCoNumber(rawCode) !== null && !rawCode.includes(".") && !rawCode.includes(",");
    const codeAsLabel = rawCode && !codeIsChapterNumber && parseCoNumber(rawCode) === null ? rawCode : null;
    const description = descEn || descEs || codeAsLabel;
    if (!description) continue; // blank row
    const code = codeAsLabel ? null : rawCode || null;

    // Chapter header vs. standalone summary row: both have no unit/qty/price
    // of their own (a chapter's cost is the sum of its line items below;
    // Honorary Fees/Tax have no line items at all).
    if (!unit && quantity === null && unitPriceCop === null) {
      // Pure recap rows ("TOTAL", "TOTAL COSTO DIRECTO") just restate a sum
      // of rows already counted above — importing them as their own line
      // item would double-count the grand total.
      if (/^total\b/i.test(description)) continue;

      if (codeIsChapterNumber) {
        // A real chapter (e.g. "1  PRELIMINARES") — the decimal-coded rows
        // under it (1.01, 1.02...) get grouped under this category next.
        currentCategory = description;
        currentCategoryOriginal = descEn ? descEs || null : null;
        continue;
      }

      if (totalCop !== null && totalCop !== 0) {
        // A standalone fee/tax line with real money and no chapter code or
        // line items of its own — file it under its own category instead
        // of discarding it or misfiling it into whatever chapter happened
        // to be last.
        //
        // Bug fixed 2026-08-20 (round 2 — Seni: "I don't see total COP or
        // budgeted USD again!"): the first version of this check also
        // matched on budgetedUsd !== null, which swept up two unrelated
        // rows ("Supply and installation of a sauna", "Household
        // appliances") that have no unit/qty/price/total of their own but
        // do carry a literal formula "$0" in the Budgeted (USD) cell —
        // confirmed live via /api/construction-budget?fresh=1, which showed
        // both misfiled into "Fees & Taxes" with totalCop: null,
        // budgetedUsd: 0, positioned near chapter 20 by first-appearance
        // order — which is exactly why Seni didn't see them near the real
        // Honorary Fees/Tax rows at the bottom. Requiring a genuine nonzero
        // totalCop (present only on the real fee/tax rows) excludes them.
        rows.push({
          code: null,
          category: "Fees & Taxes",
          categoryOriginal: null,
          description,
          descriptionOriginal: null,
          unit: null,
          quantity: null,
          unitPriceCop: null,
          totalCop,
          budgetedUsd,
        });
        continue;
      }

      // No code, no money, no unit/qty/price — a genuinely empty section
      // title. Harmless to treat as a header even if nothing follows it.
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
  // Import/delete are Seni-only (2026-08-20, Seni's ask: "make sure that I,
  // Seni Sok, is the only one that can import budgets or change budgets") —
  // drives whether the Import panel and per-row/per-log delete buttons even
  // render. Entering Actual (USD) stays open to any viewer (CEO or the
  // CONSTRUCTION login), so it's NOT gated by this flag.
  const [canManage, setCanManage] = useState(false);
  // Activity log, collapsed by default (2026-08-20, Seni's ask: "add an
  // activity log button here too... so we can monitor who entered what").
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [removingLogId, setRemovingLogId] = useState<string | null>(null);
  // Editable COP -> USD exchange rate (2026-08-20, Seni's ask: "add a box
  // somewhere where I can modify that rate which will then modify the USD
  // budget"). Seni-only to edit — everyone else (other CEO logins, the
  // CONSTRUCTION login) sees it read-only, same policy as import/delete.
  // Budgeted (USD) below is already recomputed server-side at this rate
  // (see api/construction-budget/route.ts), so editing it and reloading is
  // enough — no client-side recompute needed.
  const [fxRate, setFxRate] = useState<number | null>(null);
  const [fxRateDraft, setFxRateDraft] = useState("");
  const [editingFxRate, setEditingFxRate] = useState(false);
  const [savingFxRate, setSavingFxRate] = useState(false);
  // Per-item notes thread (2026-08-20, Seni's ask: "add a notes button for
  // each item in the budget for any user to add notes") — same lazy-fetch/
  // cache-per-item pattern as ConstructionBoard.tsx's Progress Notes.
  const [openNotesId, setOpenNotesId] = useState<string | null>(null);
  const [notesByItem, setNotesByItem] = useState<Record<string, BudgetNote[]>>({});
  const [loadingNotesId, setLoadingNotesId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [postingNoteId, setPostingNoteId] = useState<string | null>(null);
  // Construction Funds (2026-08-20, Seni's ask) — deposits ledger + the
  // Remaining Balance box. Loaded from a separate endpoint since deposits
  // live in their own table, independent of the budget import cycle.
  const [funds, setFunds] = useState<Funds | null>(null);
  const [showAddDeposit, setShowAddDeposit] = useState(false);
  const [depositAmountDraft, setDepositAmountDraft] = useState("");
  const [depositDateDraft, setDepositDateDraft] = useState("");
  const [depositNoteDraft, setDepositNoteDraft] = useState("");
  const [savingDeposit, setSavingDeposit] = useState(false);
  const [showDepositsList, setShowDepositsList] = useState(false);
  const [removingDepositId, setRemovingDepositId] = useState<string | null>(null);
  // Drill-down under "Where the balance is spent" (2026-08-21, Seni's ask:
  // "what is the best way to see which line items are the funds... being
  // spent on?"). Deliberately NOT a new column next to Actual (USD) — that
  // figure already IS "how much of the deposited balance this line spent"
  // (Spent from deposits above is exactly the sum of every row's Actual
  // (USD)), so a second column would just duplicate it. Instead, clicking a
  // category expands the actual line items with spend, computed client-side
  // from the `items` already loaded for the main table — no new column, no
  // API call, and nothing for a spreadsheet re-import to need to carry,
  // since Actual (USD) was never part of the import in the first place.
  const [expandedSpendCategory, setExpandedSpendCategory] = useState<string | null>(null);
  // COP/USD display toggle (2026-08-21, Seni's ask: "make everything COP on
  // the budget section... If I want to see USD make the COP USD toggle work
  // for this tab too"). COP is the default and the entry currency for
  // everything on this tab; toggling to USD converts DISPLAY figures at the
  // tab's own editable FX rate above (not the live market rate the global
  // nav toggle uses — this keeps every figure here reconciled with the
  // budget's Budgeted math). Persisted per browser.
  const [showUsd, setShowUsd] = useState(false);
  useEffect(() => {
    try {
      setShowUsd(window.localStorage.getItem("construction_budget_view_usd") === "1");
    } catch {
      /* default COP */
    }
  }, []);
  const setShowUsdPersist = (v: boolean) => {
    setShowUsd(v);
    try {
      window.localStorage.setItem("construction_budget_view_usd", v ? "1" : "0");
    } catch {
      /* non-fatal */
    }
  };
  // Every money figure on this tab is COP at heart; this renders it in the
  // currently toggled display currency.
  const money = useCallback(
    (cop: number | null): string => {
      if (cop === null) return "—";
      if (showUsd && fxRate && fxRate > 0) return fmtUsd(cop / fxRate);
      return fmtCop(cop);
    },
    [showUsd, fxRate]
  );
  const hasDataRef = useRef(false);

  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/construction-budget${fresh ? "?fresh=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setItems(json.items ?? []);
      setLog(json.log ?? []);
      setCanManage(Boolean(json.canManage));
      if (typeof json.fxRate === "number") setFxRate(json.fxRate);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  const loadFunds = useCallback(async () => {
    try {
      const res = await fetch("/api/construction-budget/funds");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setFunds({
        deposits: json.deposits ?? [],
        totalDepositedCop: json.totalDepositedCop ?? 0,
        budgetSpentCop: json.budgetSpentCop ?? 0,
        allocatedCop: json.allocatedCop ?? 0,
        totalSpentCop: json.totalSpentCop ?? 0,
        remainingCop: json.remainingCop ?? 0,
        spendByCategory: json.spendByCategory ?? [],
        allocations: json.allocations ?? [],
      });
    } catch {
      // Silent — the Construction Funds box just stays in its loading state
      // and retries on the next reload; the main budget table is the
      // important thing to get on screen.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadFunds();
  }, [load, loadFunds]);

  async function saveFxRate() {
    const rate = parseCoNumber(fxRateDraft);
    if (rate === null || rate <= 0) {
      setError("Enter a valid exchange rate (e.g. 3700).");
      return;
    }
    setSavingFxRate(true);
    setError(null);
    try {
      const res = await fetch("/api/construction-budget/fx-rate", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEditingFxRate(false);
      setNotice(`Exchange rate set to ${rate.toLocaleString("en-US")} COP = $1 USD. Budgeted (USD) updated below.`);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the rate.");
    } finally {
      setSavingFxRate(false);
    }
  }

  async function removeLogEntry(entry: LogEntry) {
    if (removingLogId || !window.confirm("Delete this log entry? This can't be undone.")) return;
    setRemovingLogId(entry.id);
    setError(null);
    try {
      const res = await fetch("/api/construction-budget/log", {
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

  async function toggleNotes(item: Item) {
    if (openNotesId === item.id) {
      setOpenNotesId(null);
      return;
    }
    setOpenNotesId(item.id);
    if (notesByItem[item.id]) return; // already cached
    setLoadingNotesId(item.id);
    try {
      const res = await fetch(`/api/construction-budget/notes?itemId=${encodeURIComponent(item.id)}`);
      const json = await res.json();
      if (res.ok) setNotesByItem((m) => ({ ...m, [item.id]: json.notes ?? [] }));
    } catch {
      // Silent — the panel just shows "no notes yet" and a retry happens
      // next time it's reopened.
    } finally {
      setLoadingNotesId(null);
    }
  }

  function onNoteDraftChange(itemId: string, value: string) {
    setNoteDraft((m) => ({ ...m, [itemId]: value }));
  }

  async function postNote(item: Item) {
    const text = (noteDraft[item.id] ?? "").trim();
    if (!text || postingNoteId) return;
    setPostingNoteId(item.id);
    setError(null);
    try {
      const res = await fetch("/api/construction-budget/notes", {
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
      // A re-import wipes every row's Actual (USD) along with the row
      // itself (see replaceConstructionBudgetItems) — refresh the Funds box
      // so "Spent"/"Remaining balance" reflect that immediately rather than
      // showing stale figures from the budget that just got replaced.
      await loadFunds();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  async function saveActual(item: Item, actualCop: number | null) {
    setSavingId(item.id);
    setError(null);
    try {
      const res = await fetch("/api/construction-budget", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, actualCop }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? json.item : i)) : prev));
      // Background refresh so the activity log picks up the new "updated"
      // entry, and the Funds box's "Spent"/"Remaining balance"/category
      // breakdown pick up the new Actual (USD) figure, without the user
      // having to do anything.
      void load(true);
      void loadFunds();
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

  async function addDeposit() {
    const amount = parseCoNumber(depositAmountDraft);
    if (amount === null || amount <= 0) {
      setError("Enter a valid deposit amount.");
      return;
    }
    setSavingDeposit(true);
    setError(null);
    try {
      const res = await fetch("/api/construction-budget/funds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCop: amount,
          note: depositNoteDraft.trim() || undefined,
          depositedAt: depositDateDraft || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice(`Logged a ${fmtCop(amount)} COP deposit.`);
      setDepositAmountDraft("");
      setDepositNoteDraft("");
      setDepositDateDraft("");
      setShowAddDeposit(false);
      await loadFunds();
      void load(true); // picks up the new "deposited" activity-log entry
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log the deposit.");
    } finally {
      setSavingDeposit(false);
    }
  }

  async function removeDeposit(deposit: Deposit) {
    if (removingDepositId || !window.confirm(`Remove the ${fmtCop(deposit.amountCop)} COP deposit from ${deposit.depositedAt}?`)) return;
    setRemovingDepositId(deposit.id);
    setError(null);
    try {
      const res = await fetch("/api/construction-budget/funds", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deposit.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await loadFunds();
      void load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove the deposit.");
    } finally {
      setRemovingDepositId(null);
    }
  }

  // Line items with real spend, grouped by category and sorted biggest-first
  // within each group — the data behind the "Where the balance is spent"
  // drill-down. Pure client-side derivation from `items`, same source the
  // main table already renders, so it's always in sync with whatever's on
  // screen (no separate fetch to go stale).
  const spendDetailByCategory = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const item of items ?? []) {
      if (!item.actualCop) continue;
      if (!map.has(item.category)) map.set(item.category, []);
      map.get(item.category)!.push(item);
    }
    for (const list of map.values()) list.sort((a, b) => (b.actualCop ?? 0) - (a.actualCop ?? 0));
    return map;
  }, [items]);

  // Fund allocations grouped per open item — the Construction Management
  // half of "where the balance is spent" (2026-08-21).
  const allocationsByItem = useMemo(() => {
    const map = new Map<string, { itemTitle: string; totalCop: number; entries: Allocation[] }>();
    for (const a of funds?.allocations ?? []) {
      const g = map.get(a.itemId) ?? { itemTitle: a.itemTitle, totalCop: 0, entries: [] };
      g.totalCop += a.amountCop;
      g.entries.push(a);
      map.set(a.itemId, g);
    }
    return [...map.values()].sort((a, b) => b.totalCop - a.totalCop);
  }, [funds]);

  // ALL COP (2026-08-21, Seni's ask) — budgeted comes straight from the
  // sheet's Total (COP), actual from the COP entries.
  const totals = useMemo(() => {
    const list = items ?? [];
    const budgeted = list.reduce((s, i) => s + (i.totalCop ?? 0), 0);
    const actual = list.reduce((s, i) => s + (i.actualCop ?? 0), 0);
    const trackedCount = list.filter((i) => i.actualCop !== null).length;
    return { budgeted, actual, remaining: budgeted - actual, trackedCount, total: list.length };
  }, [items]);

  const groups = useMemo(() => groupByCategory(items ?? []), [items]);

  return (
    <div className="space-y-4">
      {/* Exchange rate — Seni-only to edit (2026-08-20, Seni's ask: "add a
          box somewhere where I can modify that rate which will then modify
          the USD budget"). Everyone else sees the current rate read-only. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 px-4 py-2.5 text-sm">
        <span className="text-black/50 dark:text-white/50">Exchange rate:</span>
        {editingFxRate ? (
          <>
            <input
              type="text"
              inputMode="decimal"
              className="w-28 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-right text-sm"
              value={fxRateDraft}
              onChange={(e) => setFxRateDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveFxRate();
              }}
              autoFocus
            />
            <span className="text-black/50 dark:text-white/50">COP = $1 USD</span>
            <button
              onClick={() => void saveFxRate()}
              disabled={savingFxRate}
              className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs text-white disabled:opacity-40"
            >
              {savingFxRate ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditingFxRate(false)}
              disabled={savingFxRate}
              className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="font-semibold">
              {fxRate !== null ? `${fxRate.toLocaleString("en-US")} COP = $1 USD` : "…"}
            </span>
            {canManage && fxRate !== null && (
              <button
                onClick={() => {
                  setFxRateDraft(String(fxRate));
                  setEditingFxRate(true);
                }}
                className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5"
              >
                Edit
              </button>
            )}
          </>
        )}
        <span className="text-xs text-black/40 dark:text-white/40">
          Used for the COP ⇄ USD view toggle and any USD figures.
        </span>
        {/* COP/USD display toggle (2026-08-21, Seni's ask). COP is the
            default and always the entry currency; USD is a converted view
            at the rate on the left. */}
        <div className="ml-auto flex items-center gap-1 text-xs">
          <span className="text-black/40 dark:text-white/40">View:</span>
          <button
            onClick={() => setShowUsdPersist(false)}
            className={`rounded-md px-2 py-1 ${
              !showUsd
                ? "bg-[var(--accent)] text-white"
                : "border border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            COP
          </button>
          <button
            onClick={() => setShowUsdPersist(true)}
            className={`rounded-md px-2 py-1 ${
              showUsd
                ? "bg-[var(--accent)] text-white"
                : "border border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            USD
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
          <div className="text-xs text-black/50 dark:text-white/50">Total budgeted</div>
          <div className="text-lg font-semibold">{money(totals.budgeted)}</div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
          <div className="text-xs text-black/50 dark:text-white/50">Actual spend recorded</div>
          <div className="text-lg font-semibold">{money(totals.actual)}</div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
          <div className="text-xs text-black/50 dark:text-white/50">Remaining</div>
          <div className={`text-lg font-semibold ${totals.remaining < 0 ? "text-red-500" : ""}`}>
            {money(totals.remaining)}
          </div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4">
          <div className="text-xs text-black/50 dark:text-white/50">Lines with actuals recorded</div>
          <div className="text-lg font-semibold">
            {totals.trackedCount} / {totals.total}
          </div>
        </div>
      </div>

      {/* Construction Funds — deposits ledger + Remaining Balance box
          (2026-08-20, Seni's ask). Viewing is open to anyone who can see
          this tab; logging/removing a deposit is Seni-only. Deposits live in
          their own table, so they (and the deposit log) survive a budget
          re-import untouched — only the spend-by-category breakdown below
          moves with whatever Actual (USD) figures are currently entered. */}
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Construction Funds</h3>
          {canManage && (
            <button
              onClick={() => setShowAddDeposit((s) => !s)}
              className="shrink-0 rounded-md border border-black/15 dark:border-white/15 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5"
            >
              {showAddDeposit ? "Cancel" : "Log a deposit"}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-3">
            <div className="text-xs text-black/50 dark:text-white/50">Total deposited</div>
            <div className="text-lg font-semibold">{funds ? money(funds.totalDepositedCop) : "…"}</div>
          </div>
          <div className="rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-3">
            <div className="text-xs text-black/50 dark:text-white/50">Spent from deposits</div>
            <div className="text-lg font-semibold">{funds ? money(funds.totalSpentCop) : "…"}</div>
            {funds && funds.allocatedCop > 0 && (
              <div className="text-xs text-black/40 dark:text-white/40">
                {money(funds.budgetSpentCop)} budget lines + {money(funds.allocatedCop)} open items
              </div>
            )}
          </div>
          <div className="rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-3">
            <div className="text-xs text-black/50 dark:text-white/50">Remaining balance</div>
            <div className={`text-lg font-semibold ${funds && funds.remainingCop < 0 ? "text-red-500" : ""}`}>
              {funds ? money(funds.remainingCop) : "…"}
            </div>
          </div>
        </div>

        {showAddDeposit && canManage && (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-black/10 dark:border-white/10 p-3">
            <label className="flex flex-col gap-1 text-xs text-black/50 dark:text-white/50">
              Amount (COP)
              <input
                type="text"
                inputMode="decimal"
                className="w-40 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-sm"
                value={depositAmountDraft}
                onChange={(e) => setDepositAmountDraft(e.target.value)}
                placeholder="20.000.000"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-black/50 dark:text-white/50">
              Date
              <input
                type="date"
                className="rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-sm"
                value={depositDateDraft}
                onChange={(e) => setDepositDateDraft(e.target.value)}
              />
            </label>
            <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-black/50 dark:text-white/50">
              Note (optional)
              <input
                type="text"
                className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-sm"
                value={depositNoteDraft}
                onChange={(e) => setDepositNoteDraft(e.target.value)}
                placeholder="e.g. wire from personal account"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addDeposit();
                }}
              />
            </label>
            <button
              onClick={() => void addDeposit()}
              disabled={savingDeposit}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"
            >
              {savingDeposit ? "Saving…" : "Add deposit"}
            </button>
          </div>
        )}

        {funds && (funds.spendByCategory.length > 0 || allocationsByItem.length > 0) && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-black/50 dark:text-white/50">
              Where the balance is spent
            </div>
            <p className="mb-1 text-xs text-black/40 dark:text-white/40">Click a category or item to see the detail.</p>
            <ul className="space-y-1 text-sm">
              {funds.spendByCategory.map((c) => {
                const detail = spendDetailByCategory.get(c.category) ?? [];
                const isOpen = expandedSpendCategory === c.category;
                return (
                  <li key={c.category}>
                    <button
                      onClick={() => setExpandedSpendCategory(isOpen ? null : c.category)}
                      className="flex w-full items-center justify-between gap-2 text-left text-black/70 hover:text-black dark:text-white/70 dark:hover:text-white"
                    >
                      <span>
                        {isOpen ? "▾" : "▸"} {c.category}
                      </span>
                      <span className="font-medium">{money(c.spentCop)}</span>
                    </button>
                    {isOpen && (
                      <ul className="ml-4 mt-1 space-y-0.5 border-l border-black/10 pl-3 dark:border-white/10">
                        {detail.map((item) => (
                          <li
                            key={item.id}
                            className="flex items-center justify-between gap-2 text-xs text-black/60 dark:text-white/60"
                          >
                            <span>
                              {item.code ? `${item.code} — ` : ""}
                              {item.description}
                            </span>
                            <span className="shrink-0 font-medium">{money(item.actualCop)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
              {/* Open-item allocations (2026-08-21) — funds allocated on the
                  Construction Management tab, so the two tabs' spend always
                  reconciles against the same deposited balance. */}
              {allocationsByItem.map((g) => {
                const key = `alloc:${g.itemTitle}`;
                const isOpen = expandedSpendCategory === key;
                return (
                  <li key={key}>
                    <button
                      onClick={() => setExpandedSpendCategory(isOpen ? null : key)}
                      className="flex w-full items-center justify-between gap-2 text-left text-black/70 hover:text-black dark:text-white/70 dark:hover:text-white"
                    >
                      <span>
                        {isOpen ? "▾" : "▸"} <span className="text-red-600 dark:text-red-400">Open item:</span> {g.itemTitle}
                      </span>
                      <span className="font-medium">{money(g.totalCop)}</span>
                    </button>
                    {isOpen && (
                      <ul className="ml-4 mt-1 space-y-0.5 border-l border-black/10 pl-3 dark:border-white/10">
                        {g.entries.map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-2 text-xs text-black/60 dark:text-white/60">
                            <span>
                              {fmtWhen(a.createdAt)} — {a.createdBy}
                              {a.note ? ` — ${a.note}` : ""}
                            </span>
                            <span className="shrink-0 font-medium">{money(a.amountCop)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {funds && funds.deposits.length > 0 && (
          <div>
            <button
              onClick={() => setShowDepositsList((v) => !v)}
              className="text-xs font-medium uppercase tracking-wide text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
            >
              Deposits ({funds.deposits.length}) {showDepositsList ? "▾" : "▸"}
            </button>
            {showDepositsList && (
              <ul className="mt-1 space-y-1">
                {funds.deposits.map((d) => (
                  <li key={d.id} className="flex items-start justify-between gap-2 text-sm text-black/70 dark:text-white/70">
                    <div>
                      <span className="font-medium">{money(d.amountCop)}</span>{" "}
                      <span className="text-xs text-black/40 dark:text-white/40">
                        {d.depositedAt} — logged by {d.createdBy}
                      </span>
                      {d.note && <div className="text-xs text-black/50 dark:text-white/50">{d.note}</div>}
                    </div>
                    {canManage && (
                      <button
                        onClick={() => void removeDeposit(d)}
                        disabled={removingDepositId === d.id}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-black/40 hover:text-red-500 dark:text-white/40 disabled:opacity-40"
                      >
                        {removingDepositId === d.id ? "Deleting…" : "Delete"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {notice && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Import panel — Seni only (2026-08-20, Seni's ask). Everyone else
          (other CEO logins, the CONSTRUCTION login) can view the budget and
          enter Actual (USD) below, but can't import or restructure it. */}
      {canManage && (
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
      )}

      {/* Line items, grouped by chapter/category */}
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 overflow-x-auto">
        {!items ? (
          <p className="p-4 text-sm text-black/50 dark:text-white/50">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-black/50 dark:text-white/50">
            {canManage
              ? "Nothing imported yet — use Import above to paste in the budget spreadsheet."
              : "Nothing imported yet."}
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
                <th className="px-3 py-2 font-medium text-right">Budgeted ({showUsd ? "USD" : "COP"})</th>
                <th className="px-3 py-2 font-medium text-right">Actual (COP)</th>
                <th className="px-3 py-2 font-medium text-right">Variance</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const subBudgeted = g.items.reduce((s, i) => s + (i.totalCop ?? 0), 0);
                const subActual = g.items.reduce((s, i) => s + (i.actualCop ?? 0), 0);
                return (
                  <Fragment key={g.category}>
                    <tr className="bg-black/5 dark:bg-white/10">
                      <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold">
                        {g.category}
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs font-semibold">{money(subBudgeted)}</td>
                      <td className="px-3 py-1.5 text-right text-xs font-semibold">{money(subActual)}</td>
                      <td
                        className={`px-3 py-1.5 text-right text-xs font-semibold ${
                          subBudgeted - subActual < 0 ? "text-red-500" : ""
                        }`}
                      >
                        {money(subBudgeted - subActual)}
                      </td>
                      <td />
                    </tr>
                    {g.items.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        saving={savingId === item.id}
                        canManage={canManage}
                        money={money}
                        onSaveActual={(v) => void saveActual(item, v)}
                        onRemove={() => void removeItem(item)}
                        notesOpen={openNotesId === item.id}
                        notes={notesByItem[item.id]}
                        loadingNotes={loadingNotesId === item.id}
                        noteDraft={noteDraft[item.id] ?? ""}
                        postingNote={postingNoteId === item.id}
                        onToggleNotes={() => void toggleNotes(item)}
                        onNoteDraftChange={(v) => onNoteDraftChange(item.id, v)}
                        onPostNote={() => void postNote(item)}
                      />
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-black/15 dark:border-white/15 font-semibold">
                <td colSpan={5} className="px-3 py-2 text-right text-xs">
                  Grand total
                </td>
                <td className="px-3 py-2 text-right text-xs">{money(totals.budgeted)}</td>
                <td className="px-3 py-2 text-right text-xs">{money(totals.actual)}</td>
                <td className={`px-3 py-2 text-right text-xs ${totals.remaining < 0 ? "text-red-500" : ""}`}>
                  {money(totals.remaining)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </section>

      {/* Activity log, collapsed by default (2026-08-20, Seni's ask). */}
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-2">
        <button
          onClick={() => setShowLog((v) => !v)}
          className="text-xs font-medium uppercase tracking-wide text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
        >
          Activity Log
          {log ? ` (${log.length})` : ""} {showLog ? "▾" : "▸"}
        </button>
        {showLog &&
          (!log ? (
            <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
          ) : log.length === 0 ? (
            <p className="text-sm text-black/50 dark:text-white/50">Nothing logged yet.</p>
          ) : (
            <ul className="space-y-1">
              {log.map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-2 text-sm text-black/70 dark:text-white/70">
                  <div>
                    <strong>{entry.actor}</strong>{" "}
                    {entry.action === "imported"
                      ? `imported the budget (${entry.detail ?? ""})`
                      : entry.action === "deleted"
                        ? <>removed &ldquo;{entry.itemDescription}&rdquo;</>
                        : entry.action === "noted"
                          ? <>added a progress note on &ldquo;{entry.itemDescription}&rdquo;</>
                          : entry.itemDescription === null
                            ? entry.detail // e.g. an FX-rate change — no single item to name
                            : <>updated &ldquo;{entry.itemDescription}&rdquo; — {entry.detail}</>}
                    <span className="ml-2 text-xs text-black/40 dark:text-white/40">{fmtWhen(entry.at)}</span>
                  </div>
                  {canManage && (
                    <button
                      onClick={() => void removeLogEntry(entry)}
                      disabled={removingLogId === entry.id}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-black/40 hover:text-red-500 dark:text-white/40 disabled:opacity-40"
                    >
                      {removingLogId === entry.id ? "Deleting…" : "Delete"}
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

function ItemRow({
  item,
  saving,
  canManage,
  money,
  onSaveActual,
  onRemove,
  notesOpen,
  notes,
  loadingNotes,
  noteDraft,
  postingNote,
  onToggleNotes,
  onNoteDraftChange,
  onPostNote,
}: {
  item: Item;
  saving: boolean;
  canManage: boolean;
  /** Renders a COP amount in the tab's current display currency. */
  money: (cop: number | null) => string;
  onSaveActual: (v: number | null) => void;
  onRemove: () => void;
  notesOpen: boolean;
  notes: BudgetNote[] | undefined;
  loadingNotes: boolean;
  noteDraft: string;
  postingNote: boolean;
  onToggleNotes: () => void;
  onNoteDraftChange: (value: string) => void;
  onPostNote: () => void;
}) {
  // Entry is ALWAYS in COP (2026-08-21) — the display toggle only changes
  // the read-only figures around it, never the entry currency.
  const [draft, setDraft] = useState(item.actualCop !== null ? String(item.actualCop) : "");
  const variance = item.actualCop !== null && item.totalCop !== null ? item.totalCop - item.actualCop : null;

  return (
    <>
      <tr className="border-b border-black/5 dark:border-white/5 align-top">
        <td className="px-3 py-1.5 text-xs text-black/50 dark:text-white/50 whitespace-nowrap">{item.code}</td>
        <td className="px-3 py-1.5">
          {item.description}
          {item.descriptionOriginal && (
            <div className="text-xs text-black/40 dark:text-white/40">{item.descriptionOriginal}</div>
          )}
          {item.notes && <div className="text-xs text-black/40 dark:text-white/40">{item.notes}</div>}
          {/* Notes thread (2026-08-20, Seni's ask: "add a notes button for
              each item in the budget for any user to add notes") — open to
              any viewer, same as ConstructionBoard.tsx's Progress Notes. */}
          <button
            onClick={onToggleNotes}
            className={`mt-0.5 rounded px-1 py-0.5 text-xs ${
              item.noteCount > 0
                ? "text-[var(--accent)] hover:underline"
                : "text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
            }`}
          >
            Notes
            {item.noteCount > 0 ? ` (${item.noteCount})` : ""}
          </button>
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap">{item.unit}</td>
        <td className="px-3 py-1.5 text-right whitespace-nowrap">{item.quantity ?? ""}</td>
        <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtCop(item.unitPriceCop)}</td>
        <td className="px-3 py-1.5 text-right whitespace-nowrap">{money(item.totalCop)}</td>
        <td className="px-3 py-1.5 text-right whitespace-nowrap">
          <input
            type="number"
            min={0}
            step="1"
            className="w-32 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-1.5 py-1 text-right text-xs"
            placeholder="COP"
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const v = draft.trim() === "" ? null : Number(draft);
              if (v !== item.actualCop) onSaveActual(Number.isFinite(v as number) ? v : null);
            }}
          />
        </td>
        <td className={`px-3 py-1.5 text-right whitespace-nowrap ${variance !== null && variance < 0 ? "text-red-500" : ""}`}>
          {variance !== null ? money(variance) : "—"}
        </td>
        <td className="px-3 py-1.5">
          {canManage && (
            <button onClick={onRemove} className="text-xs text-black/40 hover:text-red-500 dark:text-white/40">
              ✕
            </button>
          )}
        </td>
      </tr>
      {notesOpen && (
        <tr className="border-b border-black/5 dark:border-white/5">
          <td />
          <td colSpan={8} className="px-3 py-2">
            <div className="ml-1 space-y-2 border-l-2 border-black/10 dark:border-white/10 pl-3">
              {loadingNotes && !notes ? (
                <p className="text-xs text-black/50 dark:text-white/50">Loading…</p>
              ) : !notes || notes.length === 0 ? (
                <p className="text-xs text-black/50 dark:text-white/50">No notes yet.</p>
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
                  placeholder="Add a note…"
                  value={noteDraft}
                  onChange={(e) => onNoteDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onPostNote();
                  }}
                />
                <button
                  onClick={onPostNote}
                  disabled={postingNote || !noteDraft.trim()}
                  className="shrink-0 rounded-md bg-black/80 dark:bg-white/80 px-2 py-1 text-xs text-white dark:text-black disabled:opacity-40"
                >
                  {postingNote ? "Posting…" : "Post note"}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
