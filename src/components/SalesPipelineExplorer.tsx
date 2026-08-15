"use client";

import { useMemo, useState } from "react";
import type { Lead, LeadStage } from "@/lib/types";
import { formatRelativeTime, formatShortDate } from "@/lib/format";
import { useCurrency } from "@/components/CurrencyProvider";

// Sales Pipeline tab (Phase 6, tracking/prioritization only — see
// lib/leads.ts's header comment). Nothing on this page sends a guest-facing
// message, promises a date, or applies a discount — moving a card just
// records where Seni (or a future Sales Agent) thinks the conversation is.

const STAGES: LeadStage[] = ["new", "contacted", "qualified", "proposal", "deposit", "booked", "nurture", "lost"];

const STAGE_LABELS: Record<LeadStage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Proposal sent",
  deposit: "Deposit",
  booked: "Booked",
  nurture: "Nurture",
  lost: "Lost",
};

const STAGE_STYLES: Record<LeadStage, string> = {
  new: "border-black/15 dark:border-white/15",
  contacted: "border-sky-300 dark:border-sky-500/40",
  qualified: "border-indigo-300 dark:border-indigo-500/40",
  proposal: "border-amber-300 dark:border-amber-500/40",
  deposit: "border-blue-300 dark:border-blue-500/40",
  booked: "border-emerald-300 dark:border-emerald-500/40",
  nurture: "border-purple-300 dark:border-purple-500/40",
  lost: "border-red-300 dark:border-red-500/40",
};

export function SalesPipelineExplorer({ initialLeads }: { initialLeads: Lead[] }) {
  const { format } = useCurrency();
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [showForm, setShowForm] = useState(false);

  function upsert(lead: Lead) {
    setLeads((prev) => {
      const exists = prev.some((l) => l.id === lead.id);
      return exists ? prev.map((l) => (l.id === lead.id ? lead : l)) : [lead, ...prev];
    });
  }

  const byStage = useMemo(() => {
    const map = new Map<LeadStage, Lead[]>();
    for (const stage of STAGES) map.set(stage, []);
    for (const lead of leads) map.get(lead.stage)?.push(lead);
    return map;
  }, [leads]);

  const openValueCents = useMemo(
    () =>
      leads
        .filter((l) => l.stage !== "booked" && l.stage !== "lost")
        .reduce((sum, l) => sum + (l.estimatedValueCents ?? 0), 0),
    [leads]
  );
  const openCount = leads.filter((l) => l.stage !== "booked" && l.stage !== "lost").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-black/40 dark:text-white/40">
          {format(openValueCents / 100)} estimated across {openCount} open lead(s)
        </p>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black"
        >
          {showForm ? "Cancel" : "+ Add lead"}
        </button>
      </div>

      <div className="text-xs rounded-md bg-black/[0.03] dark:bg-white/[0.05] text-black/50 dark:text-white/50 px-3 py-2">
        Tracking only — nothing here sends a message to a guest, promises a date, or applies a discount. Moving a
        card just records where the conversation stands.
      </div>

      {showForm && (
        <LeadForm
          onSaved={(l) => {
            upsert(l);
            setShowForm(false);
          }}
        />
      )}

      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map((stage) => (
          <div key={stage} className="flex-none w-64">
            <div className="flex items-center justify-between mb-2 px-0.5">
              <span className="text-xs font-medium text-black/60 dark:text-white/60">{STAGE_LABELS[stage]}</span>
              <span className="text-[10px] text-black/40 dark:text-white/40">{byStage.get(stage)?.length ?? 0}</span>
            </div>
            <div className="space-y-2 min-h-[3rem]">
              {(byStage.get(stage) ?? []).map((lead) => (
                <LeadCard key={lead.id} lead={lead} onUpdated={upsert} />
              ))}
              {(byStage.get(stage) ?? []).length === 0 && (
                <div className="text-[11px] text-black/30 dark:text-white/30 border border-dashed border-black/10 dark:border-white/10 rounded-md py-4 text-center">
                  Empty
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LeadCard({ lead, onUpdated }: { lead: Lead; onUpdated: (l: Lead) => void }) {
  const { format } = useCurrency();
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lostReasonDraft, setLostReasonDraft] = useState("");
  const [showLostPrompt, setShowLostPrompt] = useState(false);

  async function setStage(stage: LeadStage, lostReason?: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage, lostReason }),
      });
      const data = (await res.json()) as { lead?: Lead; error?: string };
      if (!res.ok || !data.lead) throw new Error(data.error || "Failed to update lead.");
      onUpdated(data.lead);
      setShowLostPrompt(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  function handleStageChange(next: LeadStage) {
    if (next === "lost") {
      setShowLostPrompt(true);
      return;
    }
    setStage(next);
  }

  const selectClass =
    "w-full text-[11px] rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-1.5 py-1 outline-none";

  return (
    <div
      className={`rounded-lg border-2 ${STAGE_STYLES[lead.stage]} bg-white dark:bg-white/5 p-2.5 text-xs space-y-1.5`}
    >
      <div className="font-medium">{lead.guestName}</div>
      {(lead.desiredArrival || lead.desiredDeparture) && (
        <div className="text-black/50 dark:text-white/50">
          {formatShortDate(lead.desiredArrival)} → {formatShortDate(lead.desiredDeparture)}
        </div>
      )}
      <div className="flex items-center justify-between text-black/40 dark:text-white/40">
        <span>{lead.source}</span>
        <span>{formatRelativeTime(lead.updatedAt)}</span>
      </div>
      {lead.estimatedValueCents !== undefined && (
        <div className="text-black/60 dark:text-white/60">{format(lead.estimatedValueCents / 100)}</div>
      )}
      {lead.nextAction && (
        <div className="text-amber-700 dark:text-amber-300 truncate" title={lead.nextAction}>
          Next: {lead.nextAction}
        </div>
      )}

      <button
        onClick={() => setExpanded((e) => !e)}
        className="text-[11px] text-black/40 hover:underline dark:text-white/40"
      >
        {expanded ? "Hide" : "Details"}
      </button>

      {expanded && (
        <div className="space-y-1.5 pt-1 border-t border-black/5 dark:border-white/10">
          {lead.contactPhone && <div>📱 {lead.contactPhone}</div>}
          {lead.contactEmail && <div>✉️ {lead.contactEmail}</div>}
          {lead.partySize !== undefined && <div>Party of {lead.partySize}</div>}
          {lead.notes && <div className="text-black/60 dark:text-white/60">{lead.notes}</div>}
          {lead.stage === "lost" && lead.lostReason && (
            <div className="text-red-600 dark:text-red-400">Lost: {lead.lostReason}</div>
          )}

          <select
            value={lead.stage}
            onChange={(e) => handleStageChange(e.target.value as LeadStage)}
            disabled={saving}
            className={selectClass}
          >
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>

          {showLostPrompt && (
            <div className="space-y-1">
              <input
                value={lostReasonDraft}
                onChange={(e) => setLostReasonDraft(e.target.value)}
                placeholder="Why? (price, dates, went cold...)"
                className={selectClass}
              />
              <div className="flex gap-1.5">
                <button
                  onClick={() => setStage("lost", lostReasonDraft || undefined)}
                  disabled={saving}
                  className="text-[11px] px-2 py-1 rounded-md bg-red-600 text-white disabled:opacity-40"
                >
                  {saving ? "Saving…" : "Confirm lost"}
                </button>
                <button
                  onClick={() => setShowLostPrompt(false)}
                  className="text-[11px] px-2 py-1 rounded-md bg-black/5 dark:bg-white/10"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}

function LeadForm({ onSaved }: { onSaved: (l: Lead) => void }) {
  const [guestName, setGuestName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [source, setSource] = useState("");
  const [desiredArrival, setDesiredArrival] = useState("");
  const [desiredDeparture, setDesiredDeparture] = useState("");
  const [partySize, setPartySize] = useState("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [notes, setNotes] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!guestName.trim()) {
      setError("Enter a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: guestName.trim(),
          contactPhone: contactPhone || undefined,
          contactEmail: contactEmail || undefined,
          source: source || "manual",
          desiredArrival: desiredArrival || undefined,
          desiredDeparture: desiredDeparture || undefined,
          partySize: partySize ? Number(partySize) : undefined,
          estimatedValueCents: estimatedValue ? Math.round(Number(estimatedValue) * 100) : undefined,
          notes: notes || undefined,
          nextAction: nextAction || undefined,
        }),
      });
      const data = (await res.json()) as { lead?: Lead; error?: string };
      if (!res.ok || !data.lead) throw new Error(data.error || "Failed to add lead.");
      onSaved(data.lead);
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
          <input value={guestName} onChange={(e) => setGuestName(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Source</label>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="e.g. WhatsApp, Instagram DM, Referral"
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Phone</label>
          <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Email</label>
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Desired arrival</label>
          <input
            type="date"
            value={desiredArrival}
            onChange={(e) => setDesiredArrival(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Desired departure</label>
          <input
            type="date"
            value={desiredDeparture}
            onChange={(e) => setDesiredDeparture(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Party size</label>
          <input
            type="number"
            value={partySize}
            onChange={(e) => setPartySize(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs text-black/50 dark:text-white/50">Estimated value (USD)</label>
          <input
            type="number"
            step="0.01"
            value={estimatedValue}
            onChange={(e) => setEstimatedValue(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-black/50 dark:text-white/50">Next action</label>
          <input
            value={nextAction}
            onChange={(e) => setNextAction(e.target.value)}
            placeholder="e.g. Send proposal, follow up Friday"
            className={inputClass}
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-black/50 dark:text-white/50">Notes</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button
        onClick={save}
        disabled={saving}
        className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
      >
        {saving ? "Saving…" : "Add lead"}
      </button>
    </div>
  );
}
