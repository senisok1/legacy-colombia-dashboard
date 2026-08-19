"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sumByCurrency, formatCurrencyTotals } from "@/lib/currencyTotals";
import { useT, useLanguage } from "@/components/LanguageProvider";
import { categoryLabel } from "@/lib/i18n";

// Team Expense Request tab (2026-08-17, Seni's ask). Anyone on the team can
// raise a request; the owner ticks "Owner approved"; whoever buys it ticks
// "Completed" and records what it actually cost. Every step is stamped with
// the person and the timestamp so the whole team sees the same history.

const CATEGORIES = [
  "Maintenance & repairs",
  "Cleaning & supplies",
  "Guest experience",
  "Utilities",
  "Transport & fuel",
  "Staff & labor",
  "Other",
];

type ExpenseRequest = {
  id: string;
  title: string;
  description: string | null;
  descriptionOriginal: string | null;
  authorLanguage: string | null;
  category: string;
  estimatedAmount: number | null;
  currency: string;
  vendor: string | null;
  urgency: "low" | "normal" | "urgent";
  neededBy: string | null;
  referenceUrl: string | null;
  requestedByEmail: string;
  requestedByName: string | null;
  requestedAt: string;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  declined: boolean;
  declinedReason: string | null;
  completed: boolean;
  completedByName: string | null;
  completedAt: string | null;
  actualAmount: number | null;
  editedAt: string | null;
  editedByName: string | null;
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

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const EMPTY_FORM = {
  title: "",
  description: "",
  category: "Maintenance & repairs",
  estimatedAmount: "",
  currency: "USD",
  vendor: "",
  urgency: "normal",
  neededBy: "",
  referenceUrl: "",
};

export function TeamExpenseRequests() {
  const t = useT();
  const lang = useLanguage();
  const [requests, setRequests] = useState<ExpenseRequest[] | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState<"open" | "completed">("open");
  // Edit an existing request (2026-08-17, Seni's ask). Reuses the same form;
  // editingId non-null means the form is editing rather than creating.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewerEmail, setViewerEmail] = useState("");
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/team-expenses");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRequests(json.requests as ExpenseRequest[]);
      setIsOwner(Boolean(json.viewerIsOwner));
      setViewerEmail(json.viewerEmail ?? "");
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : "Failed to load requests.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !form.title.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/team-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId ? { ...form, id: editingId } : form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setForm(EMPTY_FORM);
      setEditingId(null);
      setShowForm(false);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("exp.couldntSend"));
    } finally {
      setBusy(false);
    }
  }

  async function call(method: "PATCH" | "PUT" | "DELETE", payload: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/team-expenses", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("exp.couldntSave"));
      await load();
    } finally {
      setBusy(false);
    }
  }

  function complete(r: ExpenseRequest, completed: boolean) {
    let actualAmount: string | null = null;
    if (completed) {
      const answer = window.prompt(
        `${t("exp.whatDid")} "${r.title}" ${t("exp.costPrompt")}`,
        r.estimatedAmount === null ? "" : String(r.estimatedAmount)
      );
      if (answer === null) return; // cancelled
      actualAmount = answer.trim() === "" ? null : answer.trim();
    }
    void call("PUT", { id: r.id, completed, actualAmount });
  }

  function startEdit(r: ExpenseRequest) {
    setEditingId(r.id);
    setShowForm(true);
    setError(null);
    setForm({
      title: r.title,
      // Their own words when they wrote in another language, otherwise the
      // stored (English) description.
      description: r.descriptionOriginal ?? r.description ?? "",
      category: r.category || "Maintenance & repairs",
      estimatedAmount: r.estimatedAmount === null ? "" : String(r.estimatedAmount),
      currency: r.currency || "USD",
      vendor: r.vendor ?? "",
      urgency: r.urgency,
      neededBy: r.neededBy ?? "",
      referenceUrl: r.referenceUrl ?? "",
    });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function decline(r: ExpenseRequest) {
    const reason = window.prompt(`${t("exp.declineReasonPrompt")} "${r.title}"? (${t("exp.optional")})`, "");
    if (reason === null) return;
    void call("PATCH", { id: r.id, approved: false, declined: true, declinedReason: reason });
  }

  if (error && !requests) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!requests) {
    return <p className="text-sm text-black/50 dark:text-white/50">{t("exp.loadingRequests")}</p>;
  }

  const open = requests.filter((r) => !r.completed);
  const done = requests.filter((r) => r.completed);
  const waiting = open.filter((r) => !r.approved && !r.declined);
  const shown = tab === "open" ? open : done;
  // BUG FIX (2026-08-17 audit): this summed estimatedAmount across rows in
  // DIFFERENT currencies and rendered the result as USD. The submission form
  // offers COP, and individual rows already respected r.currency — only this
  // rollup dropped it, so one 500,000 COP request (~$125) made the banner
  // read "$500,125" on the screen used to approve spending.
  const pendingTotals = sumByCurrency(
    waiting,
    (r) => r.estimatedAmount,
    (r) => r.currency
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-black/10 dark:border-white/10 p-0.5 text-sm">
          <button
            onClick={() => setTab("open")}
            className={`rounded-md px-3 py-1 ${tab === "open" ? "bg-black/10 dark:bg-white/10 font-medium" : ""}`}
          >
            {t("exp.open")} ({open.length})
          </button>
          <button
            onClick={() => setTab("completed")}
            className={`rounded-md px-3 py-1 ${tab === "completed" ? "bg-black/10 dark:bg-white/10 font-medium" : ""}`}
          >
            {t("exp.completed")} ({done.length})
          </button>
        </div>

        {waiting.length > 0 && (
          <span className="rounded-lg bg-amber-500/10 px-3 py-1.5 text-sm text-amber-700 dark:text-amber-400">
            {waiting.length} {t("exp.waitingOnOwner")}
            {pendingTotals.length > 0 && (
              <> · {formatCurrencyTotals(pendingTotals, (a, c) => money(a, c))} {t("exp.estimated")}</>
            )}
          </span>
        )}

        <button
          onClick={() => {
            setShowForm((v) => !v);
            setEditingId(null);
            setForm(EMPTY_FORM);
          }}
          className="ml-auto rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white"
        >
          {showForm ? t("common.cancel") : t("exp.requestExpense")}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {showForm && (
        <form
          onSubmit={submit}
          className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3"
        >
          <p className="text-xs text-black/50 dark:text-white/50">
            {editingId ? t("exp.editingHelp") : t("exp.newHelp")}
          </p>

          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-black/60 dark:text-white/60">
              {t("exp.whatDoYouNeed")} *
              <input
                required
                className="mt-0.5 block w-64 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                placeholder={t("exp.whatPlaceholder")}
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              {t("exp.type")}
              <select
                className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(c, lang)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              {t("exp.howUrgent")}
              <select
                className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.urgency}
                onChange={(e) => setForm((f) => ({ ...f, urgency: e.target.value }))}
              >
                <option value="low">{t("exp.urgencyLow")}</option>
                <option value="normal">{t("exp.urgencyNormal")}</option>
                <option value="urgent">{t("exp.urgencyUrgent")}</option>
              </select>
            </label>
          </div>

          <label className="block text-xs text-black/60 dark:text-white/60">
            {t("exp.whyNeeded")}
            <textarea
              rows={3}
              className="mt-0.5 block w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
              placeholder={t("exp.whyPlaceholder")}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </label>

          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-black/60 dark:text-white/60">
              {t("exp.estimatedCost")}
              <input
                type="number"
                step="0.01"
                min="0"
                className="mt-0.5 block w-32 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.estimatedAmount}
                onChange={(e) => setForm((f) => ({ ...f, estimatedAmount: e.target.value }))}
              />
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              {t("exp.currency")}
              <select
                className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              >
                <option value="USD">USD</option>
                <option value="COP">COP</option>
              </select>
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              {t("exp.vendor")}
              <input
                className="mt-0.5 block w-48 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                placeholder={t("exp.vendorPlaceholder")}
                value={form.vendor}
                onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))}
              />
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              {t("exp.neededBy")}
              <input
                type="date"
                className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.neededBy}
                onChange={(e) => setForm((f) => ({ ...f, neededBy: e.target.value }))}
              />
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              {t("exp.referenceLink")}
              <input
                type="url"
                className="mt-0.5 block w-56 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                placeholder="https://…"
                value={form.referenceUrl}
                onChange={(e) => setForm((f) => ({ ...f, referenceUrl: e.target.value }))}
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            {busy ? t("common.saving") : editingId ? t("exp.saveChanges") : t("exp.sendRequest")}
          </button>
        </form>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-black/50 dark:text-white/50">
          {tab === "open" ? t("exp.noOpen") : t("exp.noCompleted")}
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((r) => (
            <li
              key={r.id}
              className={`rounded-xl border p-3 text-sm ${
                r.declined
                  ? "border-black/10 dark:border-white/10 opacity-60"
                  : r.completed
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : r.approved
                      ? "border-blue-500/30 bg-blue-500/5"
                      : r.urgency === "urgent"
                        ? "border-red-500/40 bg-red-500/5"
                        : "border-black/10 dark:border-white/10 bg-white dark:bg-white/5"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.title}</span>
                <span className="rounded-full bg-black/10 dark:bg-white/10 px-2 py-0.5 text-xs">{categoryLabel(r.category, lang)}</span>
                {r.urgency === "urgent" && !r.completed && (
                  <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                    {t("exp.urgent")}
                  </span>
                )}
                {r.declined && (
                  <span className="rounded-full bg-black/10 dark:bg-white/10 px-2 py-0.5 text-xs">{t("exp.declined")}</span>
                )}
                <span className="ml-auto tabular-nums">
                  {r.completed && r.actualAmount !== null ? (
                    <>
                      <span className="text-black/40 dark:text-white/40 line-through mr-1.5">
                        {money(r.estimatedAmount, r.currency)}
                      </span>
                      {money(r.actualAmount, r.currency)}
                    </>
                  ) : (
                    money(r.estimatedAmount, r.currency)
                  )}
                </span>
              </div>

              {r.description && <p className="mt-1 text-black/70 dark:text-white/70">{r.description}</p>}
              {r.descriptionOriginal && r.descriptionOriginal !== r.description && (
                <p className="mt-0.5 text-xs italic text-black/40 dark:text-white/40">
                  Original ({r.authorLanguage}): {r.descriptionOriginal}
                </p>
              )}

              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-black/50 dark:text-white/50">
                <span>
                  {t("exp.requestedBy")} <strong>{r.requestedByName || r.requestedByEmail}</strong> · {when(r.requestedAt)}
                </span>
                {r.vendor && <span>{t("exp.vendorLabel")}: {r.vendor}</span>}
                {r.neededBy && <span>{t("exp.neededBy")} {r.neededBy}</span>}
                {r.referenceUrl && (
                  <a href={r.referenceUrl} target="_blank" rel="noreferrer" className="underline">
                    {t("exp.quotePhoto")}
                  </a>
                )}
              </div>

              {r.approved && r.approvedAt && (
                <div className="mt-0.5 text-xs text-blue-600 dark:text-blue-400">
                  {t("exp.approvedBy")} {r.approvedByName || t("exp.theOwner")} · {when(r.approvedAt)}
                </div>
              )}
              {r.declined && (
                <div className="mt-0.5 text-xs text-black/50 dark:text-white/50">
                  {t("exp.declinedBy")} {r.approvedByName || t("exp.theOwner")} · {when(r.approvedAt)}
                  {r.declinedReason ? ` — ${r.declinedReason}` : ""}
                </div>
              )}
              {r.editedAt && (
                <div className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                  {t("exp.editedBy")} {r.editedByName || t("exp.aTeammate")} · {when(r.editedAt)}
                </div>
              )}
              {r.completed && (
                <div className="mt-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                  {t("exp.completedBy")} {r.completedByName || t("exp.theTeam")} · {when(r.completedAt)}
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label
                  className={`flex items-center gap-1.5 text-xs ${
                    isOwner ? "" : "text-black/40 dark:text-white/40"
                  }`}
                  title={isOwner ? "" : "Only the owner can approve an expense."}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={r.approved}
                    disabled={!isOwner || busy}
                    onChange={(e) =>
                      void call("PATCH", { id: r.id, approved: e.target.checked, declined: false })
                    }
                  />
                  {t("exp.ownerApproved")}
                </label>

                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={r.completed}
                    disabled={busy || (!r.approved && !r.completed)}
                    onChange={(e) => complete(r, e.target.checked)}
                  />
                  {t("exp.completed")}
                  {!r.approved && !r.completed && (
                    <span className="text-black/40 dark:text-white/40">{t("exp.needsApprovalFirst")}</span>
                  )}
                </label>

                {isOwner && !r.completed && !r.declined && (
                  <button
                    onClick={() => decline(r)}
                    disabled={busy}
                    className="rounded-md border border-black/15 dark:border-white/15 px-2 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                  >
                    {t("exp.decline")}
                  </button>
                )}
                <span className="ml-auto flex gap-1.5">
                  {/* The person who raised it can fix their own request; the
                      owner can fix anyone's. Completed ones are locked. */}
                  {!r.completed && (isOwner || r.requestedByEmail === viewerEmail) && (
                    <button
                      onClick={() => startEdit(r)}
                      disabled={busy}
                      className="rounded-md border border-black/15 dark:border-white/15 px-2 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                    >
                      {t("common.edit")}
                    </button>
                  )}
                  {isOwner && (
                    <button
                      onClick={() => {
                        if (window.confirm(`${t("exp.deleteConfirm")} "${r.title}"?`)) void call("DELETE", { id: r.id });
                      }}
                      disabled={busy}
                      className="rounded-md border border-red-500/40 px-2 py-0.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                    >
                      {t("common.delete")}
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
