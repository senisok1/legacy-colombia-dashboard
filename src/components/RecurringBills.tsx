"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Monthly recurring bills checklist on the Bill Pay tab (2026-08-17, Seni's
// ask). Add the bills you pay every month once; each month they reappear as
// a tick-list. Anything left unticked when the month flips shows up again
// next month flagged as carried over, so an unpaid bill can never quietly
// disappear. When every line is ticked the banner reads e.g. "All August
// 2026 bills paid".

type BillDue = {
  billId: string;
  name: string;
  amount: number | null;
  currency: string;
  dueDay: number | null;
  period: string;
  periodLabel: string;
  carriedOver: boolean;
  paid: boolean;
  paidAt: string | null;
  paidByName: string | null;
  notes: string | null;
};

type Bill = {
  id: string;
  name: string;
  amount: number | null;
  currency: string;
  dueDay: number | null;
  propertyGroupId: string | null;
  active: boolean;
};

type Board = {
  period: string;
  periodLabel: string;
  dues: BillDue[];
  outstandingCount: number;
  outstandingTotal: number;
  allPaid: boolean;
  summary: string;
  bills: Bill[];
};

function money(amount: number | null, currency: string): string {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(
      amount
    );
  } catch {
    return `${currency} ${amount.toFixed(0)}`;
  }
}

export function RecurringBills() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [form, setForm] = useState({ name: "", amount: "", dueDay: "", allProperties: false });
  // Inline edit of an existing bill (2026-08-17, Seni's ask) — amounts and
  // due days change, and a bill that's no longer fixed gets deleted instead.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", amount: "", dueDay: "", allProperties: false });
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bill-pay/recurring");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setBoard(json as Board);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : "Failed to load bills.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePaid(due: BillDue, paid: boolean) {
    if (busy) return;
    setBusy(true);
    // Optimistic — the tick should feel instant (same lesson as the
    // Management event checkbox, which needed a double click before this).
    setBoard((b) =>
      b
        ? {
            ...b,
            dues: b.dues.map((d) =>
              d.billId === due.billId && d.period === due.period ? { ...d, paid } : d
            ),
          }
        : b
    );
    try {
      const res = await fetch("/api/bill-pay/recurring", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billId: due.billId, period: due.period, paid, amountPaid: due.amount }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function addBill(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !form.name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/bill-pay/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setForm({ name: "", amount: "", dueDay: "", allProperties: false });
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that bill.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(bill: Bill) {
    setEditingId(bill.id);
    setError(null);
    setEditForm({
      name: bill.name,
      amount: bill.amount === null ? "" : String(bill.amount),
      dueDay: bill.dueDay === null ? "" : String(bill.dueDay),
      allProperties: bill.propertyGroupId === null,
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !editingId || !editForm.name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/bill-pay/recurring", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billId: editingId,
          name: editForm.name,
          amount: editForm.amount === "" ? null : editForm.amount,
          dueDay: editForm.dueDay === "" ? null : editForm.dueDay,
          allProperties: editForm.allProperties,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEditingId(null);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that bill.");
    } finally {
      setBusy(false);
    }
  }

  async function removeBill(bill: Bill) {
    if (busy) return;
    if (!window.confirm(`Delete "${bill.name}" from the monthly list? Past tick-offs are removed too.`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/bill-pay/recurring", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billId: bill.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove that bill.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !board) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!board) {
    return <p className="text-sm text-black/50 dark:text-white/50">Loading monthly bills…</p>;
  }

  const carried = board.dues.filter((d) => d.carriedOver);
  const thisMonth = board.dues.filter((d) => !d.carriedOver);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={`rounded-lg px-3 py-2 text-sm font-medium ${
            board.allPaid
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : board.dues.length === 0
                ? "bg-black/5 dark:bg-white/5 text-black/60 dark:text-white/60"
                : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
          }`}
        >
          {board.summary}
          {!board.allPaid && board.outstandingTotal > 0 && (
            <span className="ml-2 font-normal">· {money(board.outstandingTotal, "USD")} outstanding</span>
          )}
        </div>
        <button
          onClick={() => setShowManage((v) => !v)}
          className="ml-auto rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5"
        >
          {showManage ? "Done" : "Add / edit bills"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {carried.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
            Carried over — still unpaid
          </h3>
          <ul className="divide-y divide-black/5 dark:divide-white/5 rounded-lg border border-red-500/30">
            {carried.map((d) => (
              <Row key={`${d.billId}:${d.period}`} due={d} busy={busy} onToggle={togglePaid} showPeriod />
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          {board.periodLabel}
        </h3>
        {thisMonth.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">
            No recurring bills yet — press “Add / edit bills” to set up the ones you pay every month.
          </p>
        ) : (
          <ul className="divide-y divide-black/5 dark:divide-white/5 rounded-lg border border-black/10 dark:border-white/10">
            {thisMonth.map((d) => (
              <Row key={`${d.billId}:${d.period}`} due={d} busy={busy} onToggle={togglePaid} />
            ))}
          </ul>
        )}
      </div>

      {showManage && (
        <div className="rounded-lg border border-black/10 dark:border-white/10 p-3 space-y-3">
          <form onSubmit={addBill} className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-black/60 dark:text-white/60">
              Bill name
              <input
                required
                className="mt-0.5 block w-44 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                placeholder="Internet, water, gardener…"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              Amount (optional)
              <input
                type="number"
                step="0.01"
                className="mt-0.5 block w-28 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              Due day
              <select
                className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.dueDay}
                onChange={(e) => setForm((f) => ({ ...f, dueDay: e.target.value }))}
              >
                <option value="">—</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-1.5 text-xs text-black/60 dark:text-white/60">
              <input
                type="checkbox"
                checked={form.allProperties}
                onChange={(e) => setForm((f) => ({ ...f, allProperties: e.target.checked }))}
              />
              Applies to all properties
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              Add bill
            </button>
          </form>

          {board.bills.length > 0 && (
            <ul className="divide-y divide-black/5 dark:divide-white/5 text-sm">
              {board.bills.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="font-medium">{b.name}</span>
                  <span className="text-black/50 dark:text-white/50">{money(b.amount, b.currency)}</span>
                  {b.dueDay && (
                    <span className="text-xs text-black/40 dark:text-white/40">due the {b.dueDay}</span>
                  )}
                  {b.propertyGroupId === null && (
                    <span className="rounded-full bg-black/10 dark:bg-white/10 px-2 py-0.5 text-xs">
                      all properties
                    </span>
                  )}
                  <span className="ml-auto flex gap-1.5">
                    <button
                      onClick={() => (editingId === b.id ? setEditingId(null) : startEdit(b))}
                      disabled={busy}
                      className="rounded-md border border-black/15 dark:border-white/15 px-2 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                    >
                      {editingId === b.id ? "Cancel" : "Edit"}
                    </button>
                    <button
                      onClick={() => void removeBill(b)}
                      disabled={busy}
                      className="rounded-md border border-red-500/40 px-2 py-0.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </span>

                  {editingId === b.id && (
                    <form
                      onSubmit={saveEdit}
                      className="mt-2 flex w-full flex-wrap items-end gap-2 border-t border-black/10 dark:border-white/10 pt-2"
                    >
                      <label className="text-xs text-black/60 dark:text-white/60">
                        Bill name
                        <input
                          required
                          className="mt-0.5 block w-44 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                          value={editForm.name}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                        />
                      </label>
                      <label className="text-xs text-black/60 dark:text-white/60">
                        Amount
                        <input
                          type="number"
                          step="0.01"
                          placeholder="leave blank if it varies"
                          className="mt-0.5 block w-32 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                          value={editForm.amount}
                          onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
                        />
                      </label>
                      <label className="text-xs text-black/60 dark:text-white/60">
                        Due day
                        <select
                          className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                          value={editForm.dueDay}
                          onChange={(e) => setEditForm((f) => ({ ...f, dueDay: e.target.value }))}
                        >
                          <option value="">—</option>
                          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5 pb-1.5 text-xs text-black/60 dark:text-white/60">
                        <input
                          type="checkbox"
                          checked={editForm.allProperties}
                          onChange={(e) => setEditForm((f) => ({ ...f, allProperties: e.target.checked }))}
                        />
                        Applies to all properties
                      </label>
                      <button
                        type="submit"
                        disabled={busy}
                        className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
                      >
                        {busy ? "Saving…" : "Save changes"}
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  due,
  busy,
  onToggle,
  showPeriod,
}: {
  due: BillDue;
  busy: boolean;
  onToggle: (due: BillDue, paid: boolean) => void;
  showPeriod?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <input
        type="checkbox"
        checked={due.paid}
        disabled={busy}
        onChange={(e) => onToggle(due, e.target.checked)}
        className="h-4 w-4"
      />
      <span className={due.paid ? "line-through text-black/40 dark:text-white/40" : "font-medium"}>
        {due.name}
      </span>
      {showPeriod && (
        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-600 dark:text-red-400">
          {due.periodLabel}
        </span>
      )}
      {due.dueDay && !due.paid && (
        <span className="text-xs text-black/40 dark:text-white/40">due the {due.dueDay}</span>
      )}
      <span className="ml-auto tabular-nums text-black/60 dark:text-white/60">
        {money(due.amount, due.currency)}
      </span>
      {due.paid && due.paidByName && (
        <span className="w-full text-xs text-black/40 dark:text-white/40">
          Paid by {due.paidByName}
          {due.paidAt ? ` · ${new Date(due.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
        </span>
      )}
    </li>
  );
}
