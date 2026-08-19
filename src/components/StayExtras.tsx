"use client";

import { useState } from "react";
import { EXTRA_KINDS, extraKindLabel, type BookingExtra } from "@/lib/bookingExtrasShared";

// Paid extras for one stay (2026-08-17, Seni's ask) — rendered inside each
// stay card on the Team Management tab, Legacy Colombia only.
//
// Gabriel arranges add-on experiences during a stay. The guest pays one
// amount, Gabriel pays the vendor another, and the difference (the margin)
// is split 50/50 between the house and Gabriel (2026-08-19 fix — the split
// used to hand Gabriel the whole margin, which was never actually the deal).
// Both shares are shown but never typed directly: they're derived from the
// two amounts above them, so the figures cannot contradict each other. See
// db/migrations/0034_booking_extras.sql and 0039_commissions.sql.
//
// APPROVAL LOCK (2026-08-19): once the owner approves an extra (see the
// Commissions tab), it's locked — Edit/Delete disappear here. That's
// enforced server-side in api/management/extras' PATCH/DELETE, this is just
// the matching display.

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

type Draft = {
  kind: string;
  customLabel: string;
  serviceDate: string;
  guestPaid: string;
  vendorPaid: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = {
  kind: "daily_cleaning",
  customLabel: "",
  serviceDate: "",
  guestPaid: "",
  vendorPaid: "",
  notes: "",
};

function toDraft(e: BookingExtra): Draft {
  return {
    kind: e.kind,
    customLabel: e.customLabel ?? "",
    serviceDate: e.serviceDate ?? "",
    guestPaid: String(e.guestPaid),
    vendorPaid: String(e.vendorPaid),
    notes: e.notes ?? "",
  };
}

/** Live preview of the derived house/Gabriel split while typing. */
function previewSplit(d: Draft): { houseShare: number; gabrielShare: number } | null {
  const g = Number(d.guestPaid.replace(/[$,\s]/g, ""));
  const v = Number(d.vendorPaid.replace(/[$,\s]/g, "") || 0);
  if (!Number.isFinite(g) || !Number.isFinite(v) || d.guestPaid.trim() === "") return null;
  const margin = Math.round((g - v) * 100) / 100;
  const houseShare = Math.round((margin / 2) * 100) / 100;
  const gabrielShare = Math.round((margin - houseShare) * 100) / 100;
  return { houseShare, gabrielShare };
}

function ExtraForm({
  draft,
  setDraft,
  stayDates,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  stayDates: string[];
  onSubmit: () => void;
  onCancel?: () => void;
  busy: boolean;
  submitLabel: string;
}) {
  const split = previewSplit(draft);
  const field =
    "rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-sm";

  return (
    <form
      className="space-y-2 rounded-md border border-black/10 dark:border-white/10 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <select
          className={field}
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
        >
          {EXTRA_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>

        {draft.kind === "other" && (
          <input
            className={field}
            placeholder="Describe the extra"
            value={draft.customLabel}
            onChange={(e) => setDraft({ ...draft, customLabel: e.target.value })}
          />
        )}

        <select
          className={field}
          value={draft.serviceDate}
          onChange={(e) => setDraft({ ...draft, serviceDate: e.target.value })}
        >
          {/* Blank is still allowed — reporting falls back to the booking's
              arrival date (lib/extrasAnalytics.ts), so an undated extra can
              never drop out of a period total. The picker defaults to the
              first night anyway so the common case is dated. */}
          <option value="">Date (defaults to arrival)</option>
          {stayDates.map((d) => (
            <option key={d} value={d}>
              {new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-black/50 dark:text-white/50">
          Guest paid
          <input
            className={`${field} ml-1 w-24`}
            inputMode="decimal"
            placeholder="0.00"
            value={draft.guestPaid}
            onChange={(e) => setDraft({ ...draft, guestPaid: e.target.value })}
          />
        </label>
        <label className="text-xs text-black/50 dark:text-white/50">
          Paid to vendor
          <input
            className={`${field} ml-1 w-24`}
            inputMode="decimal"
            placeholder="0.00"
            value={draft.vendorPaid}
            onChange={(e) => setDraft({ ...draft, vendorPaid: e.target.value })}
          />
        </label>
        <span className="text-xs text-black/50 dark:text-white/50">
          House{" "}
          <span
            className={`font-semibold ${
              split !== null && split.houseShare < 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {split === null ? "—" : money(split.houseShare)}
          </span>
          {" · "}
          Gabriel{" "}
          <span
            className={`font-semibold ${
              split !== null && split.gabrielShare < 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {split === null ? "—" : money(split.gabrielShare)}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          className={`${field} flex-1 min-w-[12rem]`}
          placeholder="Notes (optional)"
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
        <button
          type="submit"
          disabled={busy || !draft.guestPaid.trim()}
          className="rounded-md bg-black/80 dark:bg-white/80 px-3 py-1 text-sm text-white dark:text-black disabled:opacity-40"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-black/15 dark:border-white/15 px-3 py-1 text-sm"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function StayExtras({
  bookingId,
  extras,
  stayDates,
  onChanged,
  onError,
}: {
  bookingId: number;
  extras: BookingExtra[];
  stayDates: string[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  const totals = extras.reduce(
    (acc, e) => ({
      guestPaid: acc.guestPaid + e.guestPaid,
      houseShare: acc.houseShare + e.houseShare,
      gabrielShare: acc.gabrielShare + e.gabrielShare,
    }),
    { guestPaid: 0, houseShare: 0, gabrielShare: 0 }
  );

  async function send(method: "POST" | "PATCH" | "DELETE", body?: unknown, id?: string) {
    setBusy(true);
    try {
      const url = method === "DELETE" ? `/api/management/extras?id=${encodeURIComponent(id!)}` : "/api/management/extras";
      const res = await fetch(url, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      onChanged();
      return true;
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save extra.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const ok = await send("POST", { bookingId, ...draft });
    if (ok) {
      setDraft(EMPTY_DRAFT);
      setAdding(false);
    }
  }

  async function saveEdit(id: string) {
    const ok = await send("PATCH", { id, ...editDraft });
    if (ok) setEditingId(null);
  }

  return (
    <div className="rounded-md border border-black/10 dark:border-white/10 p-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Extras
        </span>
        {!adding && (
          <button
            type="button"
            onClick={() => {
              // Pre-select the first night so extras get a real date without
              // anyone having to remember to set one.
              setDraft({ ...EMPTY_DRAFT, serviceDate: stayDates[0] ?? "" });
              setAdding(true);
            }}
            className="rounded-md border border-black/15 dark:border-white/15 px-2 py-0.5 text-xs"
          >
            + Add extra
          </button>
        )}
      </div>

      {extras.length > 0 && (
        <ul className="space-y-1">
          {extras.map((e) =>
            editingId === e.id ? (
              <li key={e.id}>
                <ExtraForm
                  draft={editDraft}
                  setDraft={setEditDraft}
                  stayDates={stayDates}
                  onSubmit={() => void saveEdit(e.id)}
                  onCancel={() => setEditingId(null)}
                  busy={busy}
                  submitLabel="Save"
                />
              </li>
            ) : (
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-black/[0.03] dark:bg-white/[0.06] px-2 py-1 text-sm"
              >
                <span className="font-medium">{extraKindLabel(e.kind, e.customLabel)}</span>
                {e.serviceDate && (
                  <span className="text-xs text-black/50 dark:text-white/50">
                    {new Date(`${e.serviceDate}T00:00:00Z`).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </span>
                )}
                <span className="text-xs">
                  Guest {money(e.guestPaid)} · House{" "}
                  <span className="font-semibold">{money(e.houseShare)}</span> · Gabriel{" "}
                  <span className="font-semibold">{money(e.gabrielShare)}</span>
                </span>
                {e.notes && <span className="text-xs text-black/50 dark:text-white/50">{e.notes}</span>}
                {/* Locked once the owner has approved/declined it (see the
                    Commissions tab) or it's been settled — Edit/Delete
                    disappear rather than erroring on click. Server-side
                    enforcement is the real gate; this just avoids a dead
                    button. */}
                {e.settledAt ? (
                  <span className="ml-auto text-xs text-emerald-600 dark:text-emerald-400">✓ Settled</span>
                ) : e.declined ? (
                  <span className="ml-auto text-xs text-black/40 dark:text-white/40">Declined</span>
                ) : e.approved ? (
                  <span className="ml-auto text-xs text-blue-600 dark:text-blue-400">🔒 Approved</span>
                ) : (
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-xs text-amber-600 dark:text-amber-400">Awaiting approval</span>
                    <button
                      type="button"
                      className="text-xs underline"
                      onClick={() => {
                        setEditingId(e.id);
                        setEditDraft(toDraft(e));
                      }}
                    >
                      Edit
                    </button>
                  </span>
                )}
              </li>
            )
          )}
        </ul>
      )}

      {adding && (
        <ExtraForm
          draft={draft}
          setDraft={setDraft}
          stayDates={stayDates}
          onSubmit={() => void add()}
          onCancel={() => {
            setAdding(false);
            setDraft(EMPTY_DRAFT);
          }}
          busy={busy}
          submitLabel="Add"
        />
      )}

      {extras.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-black/10 dark:border-white/10 pt-2 text-sm">
          <span>
            <span className="text-black/50 dark:text-white/50">Total paid by guest</span>{" "}
            <span className="font-semibold">{money(totals.guestPaid)}</span>
          </span>
          <span>
            <span className="text-black/50 dark:text-white/50">Total to the house</span>{" "}
            <span className="font-semibold">{money(totals.houseShare)}</span>
          </span>
          <span>
            <span className="text-black/50 dark:text-white/50">Total Gabriel commission</span>{" "}
            <span className="font-semibold">{money(totals.gabrielShare)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
