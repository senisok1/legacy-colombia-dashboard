"use client";

import { useMemo, useState } from "react";
import type { Vendor, WorkOrder, WorkOrderPriority, WorkOrderStatus } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";
import { useCurrency } from "@/components/CurrencyProvider";

// Maintenance tab (Phase 3 gap — see docs/VISION.md and lib/maintenance.ts's
// header comment). Tracking-only, except for one deliberate side effect:
// assigning a vendor here fires a one-time WhatsApp notify to that vendor
// (best-effort, see lib/maintenanceVendorNotify.ts) if configured and the
// vendor has a phone on file. Nothing here ever contacts a guest — the only
// other notify anywhere near this tab is Gabriel's, in
// lib/serviceRequestNotify.ts. Guest-reported issues show up here
// automatically once approved in Messaging; everything else is logged
// manually.

const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

const STATUS_STYLES: Record<WorkOrderStatus, string> = {
  open: "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
  blocked: "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  resolved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  cancelled: "bg-black/5 text-black/40 dark:bg-white/5 dark:text-white/40",
};

const PRIORITY_LABELS: Record<WorkOrderPriority, string> = {
  low: "Low",
  normal: "Normal",
  urgent: "Urgent",
  emergency: "Emergency",
};

const PRIORITY_STYLES: Record<WorkOrderPriority, string> = {
  low: "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50",
  normal: "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60",
  urgent: "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  emergency: "bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-300",
};

const FILTERS: { key: "open" | "all" | WorkOrderStatus; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

export function MaintenanceExplorer({
  initialWorkOrders,
  vendors,
}: {
  initialWorkOrders: WorkOrder[];
  vendors: Vendor[];
}) {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>(initialWorkOrders);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<"open" | "all" | WorkOrderStatus>("open");

  function upsert(workOrder: WorkOrder) {
    setWorkOrders((prev) => {
      const exists = prev.some((w) => w.id === workOrder.id);
      const next = exists ? prev.map((w) => (w.id === workOrder.id ? workOrder : w)) : [workOrder, ...prev];
      return next.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    });
  }

  const filtered = useMemo(() => {
    if (filter === "all") return workOrders;
    if (filter === "open") return workOrders.filter((w) => !["resolved", "cancelled"].includes(w.status));
    return workOrders.filter((w) => w.status === filter);
  }, [workOrders, filter]);

  const openCount = workOrders.filter((w) => !["resolved", "cancelled"].includes(w.status)).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-black/40 dark:text-white/40">
          {openCount} open issue{openCount === 1 ? "" : "s"} · guest-reported issues are logged here automatically
          once approved in Messaging.
        </p>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black"
        >
          {showForm ? "Cancel" : "+ Log issue"}
        </button>
      </div>

      <div className="text-xs rounded-md bg-black/[0.03] dark:bg-white/[0.05] text-black/50 dark:text-white/50 px-3 py-2">
        Tracking only — nothing here messages a guest automatically. Assigning a vendor records who&rsquo;s handling
        it, and also sends them a one-time WhatsApp notify if they have a phone on file and the template is
        configured.
      </div>

      {showForm && (
        <NewWorkOrderForm
          onSaved={(w) => {
            upsert(w);
            setShowForm(false);
          }}
        />
      )}

      <div className="flex gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`text-xs px-2.5 py-1 rounded-md ${
              filter === f.key
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "bg-black/5 dark:bg-white/10 text-black/60 dark:text-white/60 hover:bg-black/10"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-sm text-black/50 dark:text-white/50">
          Nothing here — log an issue to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((w) => (
            <WorkOrderCard key={w.id} workOrder={w} vendors={vendors} onUpdated={upsert} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkOrderCard({
  workOrder,
  vendors,
  onUpdated,
}: {
  workOrder: WorkOrder;
  vendors: Vendor[];
  onUpdated: (w: WorkOrder) => void;
}) {
  const { format } = useCurrency();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vendorNote, setVendorNote] = useState<string | null>(null);
  const [showResolveForm, setShowResolveForm] = useState(false);

  async function setStatus(status: WorkOrderStatus) {
    setBusy(status);
    setError(null);
    try {
      const res = await fetch(`/api/maintenance/${workOrder.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = (await res.json()) as { workOrder?: WorkOrder; error?: string };
      if (!res.ok || !data.workOrder) throw new Error(data.error || "Failed to update.");
      onUpdated(data.workOrder);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function assignVendor(vendorId: string) {
    setBusy("assign");
    setError(null);
    setVendorNote(null);
    try {
      const res = await fetch(`/api/maintenance/${workOrder.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { assignedVendorId: vendorId || null } }),
      });
      const data = (await res.json()) as { workOrder?: WorkOrder; error?: string; vendorNotifyNote?: string };
      if (!res.ok || !data.workOrder) throw new Error(data.error || "Failed to assign vendor.");
      onUpdated(data.workOrder);
      if (data.vendorNotifyNote) setVendorNote(data.vendorNotifyNote);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 space-y-2.5 bg-white dark:bg-white/5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{workOrder.title}</div>
          <div className="text-xs text-black/40 dark:text-white/40">
            {workOrder.category ? `${workOrder.category} · ` : ""}
            {workOrder.reportedBy ? `reported by ${workOrder.reportedBy} · ` : ""}
            {formatRelativeTime(workOrder.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${PRIORITY_STYLES[workOrder.priority]}`}>
            {PRIORITY_LABELS[workOrder.priority]}
          </span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLES[workOrder.status]}`}>
            {STATUS_LABELS[workOrder.status]}
          </span>
        </div>
      </div>

      {workOrder.source === "guest_message" && (
        <div className="text-xs rounded-md bg-black/[0.03] dark:bg-white/[0.05] text-black/50 dark:text-white/50 px-2 py-1">
          🗣️ Logged automatically from a guest message.{" "}
          {workOrder.gabrielNotifiedAt ? "Gabriel was notified." : "Gabriel was not notified (check WhatsApp config)."}
        </div>
      )}

      <button onClick={() => setExpanded((v) => !v)} className="text-xs text-black/50 dark:text-white/50 hover:underline">
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded && (
        <div className="space-y-2 text-xs text-black/60 dark:text-white/60">
          {workOrder.description && <p className="whitespace-pre-wrap">{workOrder.description}</p>}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-black/40 dark:text-white/40">Assigned to:</span>
            <select
              value={workOrder.assignedVendorId ?? ""}
              onChange={(e) => assignVendor(e.target.value)}
              disabled={busy !== null}
              className="rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2 py-1 text-xs outline-none"
            >
              <option value="">Unassigned</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            {workOrder.assignedVendorId &&
              (workOrder.vendorNotifiedAt ? (
                <span className="text-[10px] text-emerald-600 dark:text-emerald-400">✓ vendor notified</span>
              ) : (
                <span className="text-[10px] text-black/30 dark:text-white/30">vendor not notified</span>
              ))}
          </div>
          {vendorNote && <p className="text-[11px] text-black/50 dark:text-white/50">{vendorNote}</p>}
          {workOrder.status === "resolved" && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1">
              {workOrder.costCents != null && <div>Cost: {format(workOrder.costCents / 100)}</div>}
              {workOrder.rootCause && <div className="col-span-2">Root cause: {workOrder.rootCause}</div>}
              {workOrder.resolutionNotes && <div className="col-span-2">Resolution: {workOrder.resolutionNotes}</div>}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {showResolveForm ? (
        <ResolveForm
          workOrderId={workOrder.id}
          onSaved={(w) => {
            onUpdated(w);
            setShowResolveForm(false);
            setExpanded(true);
          }}
          onCancel={() => setShowResolveForm(false)}
        />
      ) : (
        <div className="flex gap-2 flex-wrap">
          {workOrder.status === "open" && (
            <button
              onClick={() => setStatus("in_progress")}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white disabled:opacity-40"
            >
              {busy === "in_progress" ? "…" : "Start work"}
            </button>
          )}
          {workOrder.status === "in_progress" && (
            <button
              onClick={() => setStatus("blocked")}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-amber-500 text-white disabled:opacity-40"
            >
              {busy === "blocked" ? "…" : "Mark blocked"}
            </button>
          )}
          {workOrder.status === "blocked" && (
            <button
              onClick={() => setStatus("in_progress")}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white disabled:opacity-40"
            >
              {busy === "in_progress" ? "…" : "Resume work"}
            </button>
          )}
          {workOrder.status !== "resolved" && workOrder.status !== "cancelled" && (
            <button
              onClick={() => setShowResolveForm(true)}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white disabled:opacity-40"
            >
              Mark resolved
            </button>
          )}
          {workOrder.status !== "cancelled" && workOrder.status !== "resolved" && (
            <button
              onClick={() => setStatus("cancelled")}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md text-red-600 dark:text-red-400 hover:underline disabled:opacity-40"
            >
              {busy === "cancelled" ? "…" : "Cancel"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Resolving asks for cost/root cause/notes up front rather than as a
 * separate edit step, so the record is actually useful later (see
 * lib/maintenance.ts's updateWorkOrderStatus) instead of a bare status flip. */
function ResolveForm({
  workOrderId,
  onSaved,
  onCancel,
}: {
  workOrderId: string;
  onSaved: (w: WorkOrder) => void;
  onCancel: () => void;
}) {
  const [cost, setCost] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const costNumber = Number(cost);
      const res = await fetch(`/api/maintenance/${workOrderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "resolved",
          costCents: cost && !Number.isNaN(costNumber) ? Math.round(costNumber * 100) : undefined,
          rootCause: rootCause || undefined,
          resolutionNotes: resolutionNotes || undefined,
        }),
      });
      const data = (await res.json()) as { workOrder?: WorkOrder; error?: string };
      if (!res.ok || !data.workOrder) throw new Error(data.error || "Failed to resolve.");
      onSaved(data.workOrder);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2.5 py-1.5 text-xs outline-none focus:border-black/30 dark:focus:border-white/30";

  return (
    <div className="space-y-2 rounded-md border border-black/10 dark:border-white/10 p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] space-y-1">
          <span className="text-black/50 dark:text-white/50">Cost (USD, optional)</span>
          <input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} className={inputClass} />
        </label>
        <label className="text-[11px] space-y-1">
          <span className="text-black/50 dark:text-white/50">Root cause (optional)</span>
          <input value={rootCause} onChange={(e) => setRootCause(e.target.value)} className={inputClass} />
        </label>
      </div>
      <label className="text-[11px] space-y-1 block">
        <span className="text-black/50 dark:text-white/50">Resolution notes (optional)</span>
        <textarea
          value={resolutionNotes}
          onChange={(e) => setResolutionNotes(e.target.value)}
          rows={2}
          className={inputClass}
        />
      </label>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Confirm resolved"}
        </button>
        <button onClick={onCancel} disabled={saving} className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10">
          Cancel
        </button>
      </div>
    </div>
  );
}

function NewWorkOrderForm({ onSaved }: { onSaved: (w: WorkOrder) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState<WorkOrderPriority>("normal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || undefined,
          category: category || undefined,
          priority,
          source: "manual",
          reportedBy: "Seni",
        }),
      });
      const data = (await res.json()) as { workOrder?: WorkOrder; error?: string };
      if (!res.ok || !data.workOrder) throw new Error(data.error || "Failed to log issue.");
      onSaved(data.workOrder);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-3 py-1.5 text-sm outline-none focus:border-black/30 dark:focus:border-white/30";

  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 space-y-2.5">
      <label className="text-xs space-y-1 block">
        <span className="text-black/50 dark:text-white/50">Issue *</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Pool pump making noise"
          className={inputClass}
        />
      </label>
      <div className="grid grid-cols-2 gap-2.5">
        <label className="text-xs space-y-1">
          <span className="text-black/50 dark:text-white/50">Category (optional)</span>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Plumbing, Pool, HVAC…"
            className={inputClass}
          />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-black/50 dark:text-white/50">Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as WorkOrderPriority)} className={inputClass}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
            <option value="emergency">Emergency</option>
          </select>
        </label>
      </div>
      <label className="text-xs space-y-1 block">
        <span className="text-black/50 dark:text-white/50">Details (optional)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClass} />
      </label>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button
        onClick={save}
        disabled={saving || !title.trim()}
        className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
      >
        {saving ? "Logging…" : "Log issue"}
      </button>
    </div>
  );
}
