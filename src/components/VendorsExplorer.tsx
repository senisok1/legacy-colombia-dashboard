"use client";

import { useState } from "react";
import type { Vendor } from "@/lib/types";

// Simple CRUD list for the Vendors tab (Phase 4 — see docs/VISION.md). No
// payment-related actions live here; payment_notes is free-text context for
// a human reviewing a bill, never something this UI (or any code path) reads
// to actually move money — see lib/billPay.ts's header comment.

export function VendorsExplorer({ initialVendors }: { initialVendors: Vendor[] }) {
  const [vendors, setVendors] = useState<Vendor[]>(initialVendors);
  const [showForm, setShowForm] = useState(false);

  function upsert(vendor: Vendor) {
    setVendors((prev) => {
      const exists = prev.some((v) => v.id === vendor.id);
      const next = exists ? prev.map((v) => (v.id === vendor.id ? vendor : v)) : [...prev, vendor];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-black/40 dark:text-white/40">
          {vendors.length} vendor{vendors.length === 1 ? "" : "s"} on file
        </p>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black"
        >
          {showForm ? "Cancel" : "+ Add vendor"}
        </button>
      </div>

      {showForm && (
        <VendorForm
          onSaved={(v) => {
            upsert(v);
            setShowForm(false);
          }}
        />
      )}

      {vendors.length === 0 ? (
        <div className="text-center py-16 text-sm text-black/50 dark:text-white/50">
          No vendors yet — add one to start logging bills against it.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-black/[0.03] dark:bg-white/[0.05] text-xs text-black/50 dark:text-white/50">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Category</th>
                <th className="text-left px-3 py-2 font-medium">Contact</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <VendorRow key={v.id} vendor={v} onSaved={upsert} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VendorRow({ vendor, onSaved }: { vendor: Vendor; onSaved: (v: Vendor) => void }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <tr className="border-t border-black/5 dark:border-white/5">
        <td colSpan={5} className="p-3">
          <VendorForm
            vendor={vendor}
            onSaved={(v) => {
              onSaved(v);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-black/5 dark:border-white/5">
      <td className="px-3 py-2 font-medium">{vendor.name}</td>
      <td className="px-3 py-2 text-black/60 dark:text-white/60">{vendor.category || "—"}</td>
      <td className="px-3 py-2 text-black/60 dark:text-white/60">
        {vendor.contactEmail || vendor.contactPhone || "—"}
      </td>
      <td className="px-3 py-2">
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            vendor.active
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
              : "bg-black/5 text-black/40 dark:bg-white/10 dark:text-white/40"
          }`}
        >
          {vendor.active ? "Active" : "Inactive"}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        <button onClick={() => setEditing(true)} className="text-xs text-black/50 hover:underline dark:text-white/50">
          Edit
        </button>
      </td>
    </tr>
  );
}

function VendorForm({
  vendor,
  onSaved,
  onCancel,
}: {
  vendor?: Vendor;
  onSaved: (v: Vendor) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(vendor?.name ?? "");
  const [category, setCategory] = useState(vendor?.category ?? "");
  const [contactName, setContactName] = useState(vendor?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(vendor?.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(vendor?.contactPhone ?? "");
  const [paymentNotes, setPaymentNotes] = useState(vendor?.paymentNotes ?? "");
  const [notes, setNotes] = useState(vendor?.notes ?? "");
  const [active, setActive] = useState(vendor?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { name, category, contactName, contactEmail, contactPhone, paymentNotes, notes, active };
      const res = await fetch(vendor ? `/api/vendors/${vendor.id}` : "/api/vendors", {
        method: vendor ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { vendor?: Vendor; error?: string };
      if (!res.ok || !data.vendor) throw new Error(data.error || "Failed to save vendor.");
      onSaved(data.vendor);
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
          <label className="text-xs text-black/50 dark:text-white/50">Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Category</label>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. Pool, Landscaping, Utilities"
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Contact name</label>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Contact email</label>
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Contact phone</label>
          <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className={inputClass} />
        </div>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-xs text-black/60 dark:text-white/60 pb-1.5">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
        </div>
      </div>
      <div>
        <label className="text-xs text-black/50 dark:text-white/50">
          Payment reference notes (context only — never used to send money)
        </label>
        <input
          value={paymentNotes}
          onChange={(e) => setPaymentNotes(e.target.value)}
          placeholder="e.g. Bancolombia acct ending 4821"
          className={inputClass}
        />
      </div>
      <div>
        <label className="text-xs text-black/50 dark:text-white/50">Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save vendor"}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
