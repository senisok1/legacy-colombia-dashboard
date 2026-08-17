"use client";

import { useMemo, useState } from "react";
import type { Bill, BillStatus, Vendor } from "@/lib/types";
import { formatShortDate } from "@/lib/format";
import { useCurrency } from "@/components/CurrencyProvider";
import { convertAmountCents } from "@/lib/currencyMath";

import { sumByCurrency, formatCurrencyTotals } from "@/lib/currencyTotals";

/** Converts a native-currency amount into the given display currency using a
 * USD/COP rate, falling back to the original amount if no rate is available
 * yet or the pair isn't convertible (so a still-loading rate never makes the
 * open total silently drop bills). */
function toDisplayAmount(amount: number, nativeCurrency: string, displayCurrency: string, usdToTarget: number | null): number {
  if (nativeCurrency === displayCurrency || !usdToTarget) return amount;
  const converted = convertAmountCents(Math.round(amount * 100), nativeCurrency, displayCurrency, usdToTarget);
  return converted === null ? amount : converted / 100;
}

// Bill Pay tab (Phase 4, tracking/detection only — see docs/VISION.md and
// lib/billPay.ts's header comment). Nothing on this page sends money.
// "Approve for payment" and "Mark paid" just record a decision/action Seni
// made himself outside this system.

const STATUS_STYLES: Record<BillStatus, string> = {
  pending_review: "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60",
  flagged_duplicate: "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  flagged_anomaly: "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  approved_for_payment: "bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
  paid_manually: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300",
};

const STATUS_LABELS: Record<BillStatus, string> = {
  pending_review: "Needs review",
  flagged_duplicate: "Possible duplicate",
  flagged_anomaly: "Flagged — unusual",
  approved_for_payment: "Approved for payment",
  paid_manually: "Paid",
  rejected: "Rejected",
};

const FILTERS: { key: "open" | "all" | BillStatus; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "flagged_duplicate", label: "Duplicates" },
  { key: "approved_for_payment", label: "Approved" },
  { key: "paid_manually", label: "Paid" },
  { key: "all", label: "All" },
];

export function BillPayExplorer({
  initialBills,
  vendors,
}: {
  initialBills: Bill[];
  vendors: Vendor[];
}) {
  const [bills, setBills] = useState<Bill[]>(initialBills);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<"open" | "all" | BillStatus>("open");
  const { format, displayCurrency, rate } = useCurrency();

  function upsert(bill: Bill) {
    setBills((prev) => {
      const exists = prev.some((b) => b.id === bill.id);
      const next = exists ? prev.map((b) => (b.id === bill.id ? bill : b)) : [bill, ...prev];
      return next.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    });
  }

  const filtered = useMemo(() => {
    if (filter === "all") return bills;
    if (filter === "open") {
      return bills.filter((b) => !["paid_manually", "rejected"].includes(b.status));
    }
    return bills.filter((b) => b.status === filter);
  }, [bills, filter]);

  // This app tracks bills in whatever currency they were actually billed in
  // (USD for most vendors, COP for the Gutierrez Group / Nukak #19 monthly
  // statements — see api/admin/import-nukak-bills/route.ts). Summing raw
  // cents across currencies would be meaningless, so every open bill not
  // already in the selected display currency gets converted via the live
  // USD/COP rate (CurrencyProvider.tsx) before being added to this total —
  // the same toggle that controls every other amount on the page.
  const openBills = useMemo(
    () => bills.filter((b) => ["pending_review", "flagged_duplicate", "flagged_anomaly", "approved_for_payment"].includes(b.status)),
    [bills]
  );
  // BUG FIX (2026-08-17 audit): when the FX rate hadn't loaded yet — or the
  // /api/exchange-rate endpoint fails — toDisplayAmount() returns the amount
  // UNCONVERTED, so real COP bills (e.g. Nukak at 3,777,296 COP) were summed
  // raw into a USD-labelled total and the banner read "$3,777,446" instead
  // of "~$1,094". The old comment framed the fallback as protecting against
  // dropped bills, but it substituted a 4,000x magnitude error for a missing
  // one. Now: convert only when every bill can actually be converted;
  // otherwise fall back to honest per-currency totals.
  const canConvertAll = useMemo(
    () => openBills.every((b) => b.currency === displayCurrency) || Boolean(rate?.usdToTarget),
    [openBills, displayCurrency, rate]
  );
  const openTotalAmount = useMemo(() => {
    if (!canConvertAll) return null;
    return openBills.reduce(
      (sum, b) => sum + toDisplayAmount(b.amountCents / 100, b.currency, displayCurrency, rate?.usdToTarget ?? null),
      0
    );
  }, [openBills, displayCurrency, rate, canConvertAll]);
  const openTotalsByCurrency = useMemo(
    () => sumByCurrency(openBills, (b) => b.amountCents / 100, (b) => b.currency),
    [openBills]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-black/40 dark:text-white/40">
          {openBills.length === 0
            ? "Nothing"
            : openTotalAmount !== null
              ? format(openTotalAmount, displayCurrency)
              : formatCurrencyTotals(openTotalsByCurrency, (a, c) => format(a, c))}{" "}
          still open across {openBills.length} bill(s)
        </p>
        <button
          onClick={() => setShowForm((s) => !s)}
          disabled={vendors.length === 0}
          className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
          title={vendors.length === 0 ? "Add a vendor first" : undefined}
        >
          {showForm ? "Cancel" : "+ Add bill"}
        </button>
      </div>

      <div className="text-xs rounded-md bg-black/[0.03] dark:bg-white/[0.05] text-black/50 dark:text-white/50 px-3 py-2">
        Tracking only — nothing here ever sends a payment. &ldquo;Approved for payment&rdquo; and &ldquo;Paid&rdquo; just
        record a decision you made yourself.
      </div>

      {showForm && (
        <BillForm
          vendors={vendors}
          onSaved={(b) => {
            upsert(b);
            setShowForm(false);
          }}
        />
      )}

      <div className="flex gap-1 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`text-xs px-2.5 py-1 rounded-md ${
              filter === f.key
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "bg-black/5 text-black/60 hover:bg-black/10 dark:bg-white/10 dark:text-white/60"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-sm text-black/50 dark:text-white/50">Nothing here.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-black/[0.03] dark:bg-white/[0.05] text-xs text-black/50 dark:text-white/50">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Vendor</th>
                <th className="text-left px-3 py-2 font-medium">Amount</th>
                <th className="text-left px-3 py-2 font-medium">Due</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((bill) => (
                <BillRow key={bill.id} bill={bill} vendors={vendors} onUpdated={upsert} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Shows a bill's amount in the globally-selected display currency, with a
 * title tooltip revealing the original native amount whenever the two
 * differ — so a converted COP bill viewed in USD (or vice versa) never
 * silently hides what it was actually billed in. */
function BillAmountCell({ bill }: { bill: Bill }) {
  const { format, displayCurrency } = useCurrency();
  const converted = bill.currency !== displayCurrency;
  const nativeAmount = (bill.amountCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (
    <span title={converted ? `Originally billed: ${bill.currency} ${nativeAmount}` : undefined}>
      {format(bill.amountCents / 100, bill.currency)}
      {converted && <span className="text-black/30 dark:text-white/30"> *</span>}
    </span>
  );
}

function BillRow({
  bill,
  vendors,
  onUpdated,
}: {
  bill: Bill;
  vendors: Vendor[];
  onUpdated: (b: Bill) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<BillStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(status: BillStatus) {
    setBusy(status);
    setError(null);
    try {
      const res = await fetch(`/api/bills/${bill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = (await res.json()) as { bill?: Bill; error?: string };
      if (!res.ok || !data.bill) throw new Error(data.error || "Failed to update bill.");
      onUpdated(data.bill);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <tr className="border-t border-black/5 dark:border-white/5">
        <td className="px-3 py-2 font-medium">{bill.vendorName ?? bill.vendorId}</td>
        <td className="px-3 py-2">
          <BillAmountCell bill={bill} />
        </td>
        <td className="px-3 py-2 text-black/60 dark:text-white/60">{formatShortDate(bill.dueDate)}</td>
        <td className="px-3 py-2">
          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLES[bill.status]}`}>
            {STATUS_LABELS[bill.status]}
          </span>
        </td>
        <td className="px-3 py-2 text-right">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-xs text-black/50 hover:underline dark:text-white/50"
          >
            {expanded ? "Hide" : "Details"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-black/5 dark:border-white/5 bg-black/[0.015] dark:bg-white/[0.02]">
          <td colSpan={5} className="px-3 py-3 space-y-2">
            {bill.source === "whatsapp" && (
              <div className="text-xs rounded-md bg-black/[0.03] dark:bg-white/[0.05] text-black/50 dark:text-white/50 px-2 py-1">
                🤖 Read automatically from a WhatsApp forward — double-check the details below before approving.
              </div>
            )}
            {editing ? (
              <BillFieldsEditForm
                bill={bill}
                vendors={vendors}
                onSaved={(b) => {
                  onUpdated(b);
                  setEditing(false);
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-black/60 dark:text-white/60">
                  {bill.invoiceNumber && <div>Invoice #: {bill.invoiceNumber}</div>}
                  {bill.invoiceDate && <div>Invoice date: {formatShortDate(bill.invoiceDate)}</div>}
                  {bill.category && <div>Category: {bill.category}</div>}
                  <div>Source: {bill.source}</div>
                  {bill.flagReason && (
                    <div className="col-span-2 text-amber-700 dark:text-amber-300">Flag: {bill.flagReason}</div>
                  )}
                  {bill.reviewNotes && <div className="col-span-2">Notes: {bill.reviewNotes}</div>}
                </div>
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs text-black/50 hover:underline dark:text-white/50"
                >
                  Edit details
                </button>
              </>
            )}
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex gap-2 flex-wrap pt-1">
              {bill.status !== "approved_for_payment" && bill.status !== "paid_manually" && (
                <button
                  onClick={() => setStatus("approved_for_payment")}
                  disabled={busy !== null}
                  className="text-xs px-2.5 py-1 rounded-md bg-blue-600 text-white disabled:opacity-40"
                >
                  {busy === "approved_for_payment" ? "Saving…" : "Approve for payment"}
                </button>
              )}
              {bill.status !== "paid_manually" && (
                <button
                  onClick={() => setStatus("paid_manually")}
                  disabled={busy !== null}
                  className="text-xs px-2.5 py-1 rounded-md bg-emerald-600 text-white disabled:opacity-40"
                >
                  {busy === "paid_manually" ? "Saving…" : "Mark paid (I paid this myself)"}
                </button>
              )}
              {bill.status === "flagged_duplicate" && (
                <button
                  onClick={() => setStatus("pending_review")}
                  disabled={busy !== null}
                  className="text-xs px-2.5 py-1 rounded-md bg-black/5 dark:bg-white/10"
                >
                  Not a duplicate — clear flag
                </button>
              )}
              {bill.status !== "rejected" && (
                <button
                  onClick={() => setStatus("rejected")}
                  disabled={busy !== null}
                  className="text-xs px-2.5 py-1 rounded-md text-red-600 dark:text-red-400 hover:underline"
                >
                  {busy === "rejected" ? "Saving…" : "Reject"}
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** Lets Seni correct a bill's vendor/amount/invoice#/category/dates —
 * separate from the status buttons above so fixing a wrong WhatsApp
 * extraction (see lib/billForward.ts) doesn't read as an approval decision
 * in the AI Activity log. Never touches status. */
function BillFieldsEditForm({
  bill,
  vendors,
  onSaved,
  onCancel,
}: {
  bill: Bill;
  vendors: Vendor[];
  onSaved: (b: Bill) => void;
  onCancel: () => void;
}) {
  const [vendorId, setVendorId] = useState(bill.vendorId);
  const [amount, setAmount] = useState(String(bill.amountCents / 100));
  const [invoiceNumber, setInvoiceNumber] = useState(bill.invoiceNumber ?? "");
  const [category, setCategory] = useState(bill.category ?? "");
  const [invoiceDate, setInvoiceDate] = useState(bill.invoiceDate ?? "");
  const [dueDate, setDueDate] = useState(bill.dueDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const amountNumber = Number(amount);
    if (!amount || Number.isNaN(amountNumber) || amountNumber <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/bills/${bill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            vendorId,
            amountCents: Math.round(amountNumber * 100),
            invoiceNumber: invoiceNumber || undefined,
            category: category || undefined,
            invoiceDate: invoiceDate || undefined,
            dueDate: dueDate || undefined,
          },
        }),
      });
      const data = (await res.json()) as { bill?: Bill; error?: string };
      if (!res.ok || !data.bill) throw new Error(data.error || "Failed to save changes.");
      onSaved(data.bill);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2.5 py-1 text-xs outline-none focus:border-black/30 dark:focus:border-white/30";

  return (
    <div className="space-y-2 rounded-md border border-black/10 dark:border-white/10 p-3 bg-white dark:bg-white/5">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-black/50 dark:text-white/50">Vendor</label>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={inputClass}>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[11px] text-black/50 dark:text-white/50">Amount ({bill.currency})</label>
          <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-[11px] text-black/50 dark:text-white/50">Invoice #</label>
          <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-[11px] text-black/50 dark:text-white/50">Category</label>
          <input value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-[11px] text-black/50 dark:text-white/50">Invoice date</label>
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-[11px] text-black/50 dark:text-white/50">Due date</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-2.5 py-1 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onCancel} className="text-xs px-2.5 py-1 rounded-md bg-black/5 dark:bg-white/10">
          Cancel
        </button>
      </div>
    </div>
  );
}

function BillForm({ vendors, onSaved }: { vendors: Vendor[]; onSaved: (b: Bill) => void }) {
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [category, setCategory] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const amountNumber = Number(amount);
    if (!vendorId) {
      setError("Pick a vendor.");
      return;
    }
    if (!amount || Number.isNaN(amountNumber) || amountNumber <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId,
          amountCents: Math.round(amountNumber * 100),
          invoiceNumber: invoiceNumber || undefined,
          category: category || undefined,
          invoiceDate: invoiceDate || undefined,
          dueDate: dueDate || undefined,
          source: "manual",
        }),
      });
      const data = (await res.json()) as { bill?: Bill; error?: string };
      if (!res.ok || !data.bill) throw new Error(data.error || "Failed to add bill.");
      onSaved(data.bill);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-3 py-1.5 text-sm outline-none focus:border-black/30 dark:focus:border-white/30";

  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 p-4 space-y-3 bg-black/[0.02] dark:bg-white/[0.03]">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Vendor *</label>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={inputClass}>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Amount (USD) *</label>
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Invoice #</label>
          <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Category</label>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. Pool, Utilities"
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Invoice date</label>
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Due date</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button
        onClick={save}
        disabled={saving}
        className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
      >
        {saving ? "Saving…" : "Add bill"}
      </button>
    </div>
  );
}
