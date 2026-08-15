"use client";

import { useEffect, useState } from "react";
import { formatDate } from "@/lib/format";

type PromotionCodeSummary = {
  id: string;
  code: string;
  active: boolean;
  percentOff: number | null;
  amountOffCents: number | null;
  duration: string;
  durationInMonths: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  expiresAt: string | null;
  createdAt: string;
};

type DiscountType = "percent" | "amount" | "free";

const emptyForm = {
  code: "",
  discountType: "percent" as DiscountType,
  percentOff: "20",
  amountOffDollars: "10",
  duration: "once" as "once" | "forever" | "repeating",
  durationInMonths: "3",
  maxRedemptions: "",
  expiresAt: "",
};

function discountLabel(c: PromotionCodeSummary): string {
  if (c.percentOff === 100 && c.duration === "forever") return "Free forever";
  if (c.percentOff !== null) return `${c.percentOff}% off`;
  if (c.amountOffCents !== null) return `$${(c.amountOffCents / 100).toFixed(2)} off`;
  return "—";
}

// Platform-operator-only tool (see api/billing/coupons/route.ts's
// requireOperator) for creating Stripe promotion codes — "give discounts or
// free accounts away" (Seni, 2026-08-05). Only rendered by BillingPlans.tsx
// when /api/billing/status reports isOperator: true, i.e. only on Legacy
// Estate Rentals' own account, never a paying tenant's.
export function CouponsManager() {
  const [codes, setCodes] = useState<PromotionCodeSummary[] | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    const res = await fetch("/api/billing/coupons");
    if (res.ok) {
      const data = (await res.json()) as { codes: PromotionCodeSummary[] };
      setCodes(data.codes);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createCode() {
    setCreating(true);
    setError("");
    const body: Record<string, unknown> = {
      code: form.code.trim() || undefined,
      duration: form.duration,
    };
    if (form.discountType === "free") {
      body.freeForever = true;
    } else if (form.discountType === "percent") {
      body.percentOff = Number(form.percentOff);
    } else {
      body.amountOffCents = Math.round(Number(form.amountOffDollars) * 100);
    }
    if (form.duration === "repeating") body.durationInMonths = Number(form.durationInMonths);
    if (form.maxRedemptions.trim()) body.maxRedemptions = Number(form.maxRedemptions);
    if (form.expiresAt) body.expiresAt = new Date(form.expiresAt).toISOString();

    const res = await fetch("/api/billing/coupons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { code?: PromotionCodeSummary; error?: string } | null;
    setCreating(false);
    if (!res.ok || !data?.code) {
      setError(data?.error || "Couldn't create the coupon.");
      return;
    }
    setForm(emptyForm);
    setCodes((prev) => [data.code!, ...(prev ?? [])]);
  }

  async function toggleActive(c: PromotionCodeSummary) {
    const res = await fetch("/api/billing/coupons", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: c.id, active: !c.active }),
    });
    if (res.ok) {
      setCodes((prev) => prev?.map((x) => (x.id === c.id ? { ...x, active: !x.active } : x)) ?? null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-black/10 dark:border-white/15 p-4 space-y-3">
        <h3 className="font-semibold text-sm">Create a coupon</h3>
        <div className="grid grid-cols-2 gap-3">
          <input
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            placeholder="Code (optional — auto-generated if blank)"
            className="rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
          />
          <select
            value={form.discountType}
            onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value as DiscountType }))}
            className="rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
          >
            <option value="percent">Percent off</option>
            <option value="amount">Dollar amount off</option>
            <option value="free">Free account (100% off, forever)</option>
          </select>

          {form.discountType === "percent" && (
            <input
              type="number"
              min={1}
              max={100}
              value={form.percentOff}
              onChange={(e) => setForm((f) => ({ ...f, percentOff: e.target.value }))}
              placeholder="% off"
              className="rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
            />
          )}
          {form.discountType === "amount" && (
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.amountOffDollars}
              onChange={(e) => setForm((f) => ({ ...f, amountOffDollars: e.target.value }))}
              placeholder="$ off"
              className="rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
            />
          )}

          {form.discountType !== "free" && (
            <select
              value={form.duration}
              onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value as typeof f.duration }))}
              className="rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
            >
              <option value="once">Once (first invoice only)</option>
              <option value="repeating">Repeating (N months)</option>
              <option value="forever">Forever</option>
            </select>
          )}
          {form.discountType !== "free" && form.duration === "repeating" && (
            <input
              type="number"
              min={1}
              value={form.durationInMonths}
              onChange={(e) => setForm((f) => ({ ...f, durationInMonths: e.target.value }))}
              placeholder="Number of months"
              className="rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
            />
          )}

          <input
            type="number"
            min={1}
            value={form.maxRedemptions}
            onChange={(e) => setForm((f) => ({ ...f, maxRedemptions: e.target.value }))}
            placeholder="Max redemptions (optional)"
            className="rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
          />
          <input
            type="date"
            value={form.expiresAt}
            onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
            className="rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
          />
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button
          onClick={createCode}
          disabled={creating}
          className="text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
        >
          {creating ? "Creating…" : "Create coupon"}
        </button>
      </div>

      <div className="space-y-2">
        <h3 className="font-semibold text-sm">Existing coupons</h3>
        {codes === null ? (
          <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
        ) : codes.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">No coupons yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-black/50 dark:text-white/50 border-b border-black/10 dark:border-white/15">
                <th className="py-1.5 pr-2">Code</th>
                <th className="py-1.5 pr-2">Discount</th>
                <th className="py-1.5 pr-2">Redeemed</th>
                <th className="py-1.5 pr-2">Expires</th>
                <th className="py-1.5 pr-2">Status</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-b border-black/5 dark:border-white/10">
                  <td className="py-1.5 pr-2 font-mono">{c.code}</td>
                  <td className="py-1.5 pr-2">{discountLabel(c)}</td>
                  <td className="py-1.5 pr-2">
                    {c.timesRedeemed}
                    {c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}
                  </td>
                  <td className="py-1.5 pr-2">{c.expiresAt ? formatDate(c.expiresAt) : "—"}</td>
                  <td className="py-1.5 pr-2">{c.active ? "Active" : "Disabled"}</td>
                  <td className="py-1.5">
                    <button
                      onClick={() => toggleActive(c)}
                      className="text-xs px-2 py-1 rounded-md border border-black/15 dark:border-white/20"
                    >
                      {c.active ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
