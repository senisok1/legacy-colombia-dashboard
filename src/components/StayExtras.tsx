"use client";

import { useState } from "react";
import { EXTRA_KINDS, extraKindLabel, type BookingExtra } from "@/lib/bookingExtrasShared";

// Paid extras for one stay (2026-08-17, Seni's ask) — rendered inside each
// stay card on the Team Management tab, Legacy Colombia only.
//
// Gabriel arranges add-on experiences during a stay. The guest pays one
// amount, part goes to the house, and the difference is his commission.
// Commission is shown but never typed: it's derived from the two amounts
// above it, so the three figures cannot contradict each other. See
// db/migrations/0034_booking_extras.sql.

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

type Draft = {
  kind: string;
  customLabel: string;
  serviceDate: string;
  guestPaid: string;
  housePaid: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = {
  kind: "daily_cleaning",
  customLabel: "",
  serviceDate: "",
  guestPaid: "",
  housePaid: "",
  notes: "",
};

function toDraft(e: BookingExtra): Draft {
  return {
    kind: e.kind,
    customLabel: e.customLabel ?? "",
    serviceDate: e.serviceDate ?? "",
    guestPaid: String(e.guestPaid),
    housePaid: String(e.housePaid),
    notes: e.notes ?? "",
  };
}

/** Live preview of the derived commission while typing. */
function previewCommission(d: Draft): number | null {
  const g = Number(d.guestPaid.replace(/[$,\s]/g, ""));
  const h = Number(d.housePaid.replace(/[$,\s]/g, "") || 0);
  if (!Number.isFinite(g) || !Number.isFinite(h) || d.guestPaid.trim() === "") return null;
  return Math.round((g - h) * 100) / 100;
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
  const commission = previewCommission(draft);
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
          To the house
          <input
            className={`${field} ml-1 w-24`}
            inputMode="decimal"
            placeholder="0.00"
            value={draft.housePaid}
            onChange={(e) => setDraft({ ...draft, housePaid: e.target.value })}
          />
        </label>
        <span className="text-xs text-black/50 dark:text-white/50">
          Gabriel&apos;s commission{" "}
          <span
            className={`font-semibold ${
              commission !== null && commission < 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {commission === null ? "—" : money(commission)}
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
      housePaid: acc.housePaid + e.housePaid,
      commission: acc.commission + e.commission,
    }),
    { guestPaid: 0, housePaid: 0, commission: 0 }
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
                  Guest {money(e.guestPaid)} · House {money(e.housePaid)} ·{" "}
                  <span className="font-semibold">Gabriel {money(e.commission)}</span>
                </span>
                {e.notes && <span className="text-xs text-black/50 dark:text-white/50">{e.notes}</span>}
                <span className="ml-auto flex gap-2">
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
                  <button
                    type="button"
                    className="text-xs underline text-red-600 dark:text-red-400"
                    disabled={busy}
                    onClick={() => void send("DELETE", undefined, e.id)}
                  >
                    Delete
                  </button>
                </span>
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
            <span className="text-black/50 dark:text-white/50">Total paid to the house</span>{" "}
            <span className="font-semibold">{money(totals.housePaid)}</span>
          </span>
          <span>
            <span className="text-black/50 dark:text-white/50">Total Gabriel commission</span>{" "}
            <span className="font-semibold">{money(totals.commission)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
