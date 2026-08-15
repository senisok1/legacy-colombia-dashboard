import { query, queryOne } from "./db";
import { logAiActivity } from "./aiActivity";
import { getDefaultOrganizationId } from "./organizations";
import type { WorkOrder, WorkOrderPriority, WorkOrderStatus } from "./types";

// Phase 3 gap of the Legacy AI Company roadmap (docs/VISION.md) — the
// Maintenance Manager half of "Guest Experience + Maintenance" that never
// got built the first time around (see db/migrations/0007_maintenance.sql's
// header comment). Tracking/prioritization only, same posture as
// lib/leads.ts and lib/billPay.ts: nothing here pages a vendor, sends money,
// or contacts a guest. The only guest-facing/vendor-facing side effects
// anywhere near this file are the existing Gabriel WhatsApp notify in
// lib/serviceRequestNotify.ts and the vendor WhatsApp notify in
// lib/maintenanceVendorNotify.ts (added 2026-08-04) — this module just
// exposes markVendorNotified() as a plain setter for that file to call after
// a real send succeeds, same pattern as markGabrielNotified() below.

const AGENT_KEY = "maintenance";
const AGENT_NAME = "AI Maintenance Manager";

type WorkOrderRow = {
  id: string;
  property_id: string | null;
  guest_id: number | null;
  booking_id: number | null;
  thread_id: number | null;
  title: string;
  description: string | null;
  category: string | null;
  source: string;
  reported_by: string | null;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  assigned_vendor_id: string | null;
  assigned_vendor_name?: string | null;
  cost_cents: number | null;
  root_cause: string | null;
  resolution_notes: string | null;
  gabriel_notified_at: Date | null;
  vendor_notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
};

function fromRow(row: WorkOrderRow): WorkOrder {
  return {
    id: row.id,
    propertyId: row.property_id ?? undefined,
    guestId: row.guest_id ?? undefined,
    bookingId: row.booking_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    source: row.source,
    reportedBy: row.reported_by ?? undefined,
    priority: row.priority,
    status: row.status,
    assignedVendorId: row.assigned_vendor_id ?? undefined,
    assignedVendorName: row.assigned_vendor_name ?? undefined,
    costCents: row.cost_cents ?? undefined,
    rootCause: row.root_cause ?? undefined,
    resolutionNotes: row.resolution_notes ?? undefined,
    gabrielNotifiedAt: row.gabriel_notified_at ? row.gabriel_notified_at.toISOString() : undefined,
    vendorNotifiedAt: row.vendor_notified_at ? row.vendor_notified_at.toISOString() : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : undefined,
  };
}

const SELECT_WITH_VENDOR = `select w.*, v.name as assigned_vendor_name
   from work_orders w
   left join vendors v on v.id = w.assigned_vendor_id`;

/** Every work order, newest first — the Maintenance tab groups these by
 * status client-side, same pattern as CrmCampaignsExplorer/BillPayExplorer. */
export async function listWorkOrders(organizationId?: string): Promise<WorkOrder[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<WorkOrderRow>(
    `${SELECT_WITH_VENDOR} where w.organization_id = $1 order by w.created_at desc`,
    [orgId]
  );
  return rows.map(fromRow);
}

export async function getWorkOrder(id: string, organizationId?: string): Promise<WorkOrder | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<WorkOrderRow>(`${SELECT_WITH_VENDOR} where w.id = $1 and w.organization_id = $2`, [
    id,
    orgId,
  ]);
  return row ? fromRow(row) : null;
}

export async function createWorkOrder(
  input: {
    propertyId?: string;
    guestId?: number;
    bookingId?: number;
    threadId?: number;
    title: string;
    description?: string;
    category?: string;
    source?: string;
    reportedBy?: string;
    priority?: WorkOrderPriority;
  },
  organizationId?: string
): Promise<WorkOrder> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<WorkOrderRow>(
    `insert into work_orders
       (organization_id, property_id, guest_id, booking_id, thread_id, title, description, category,
        source, reported_by, priority)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::work_order_priority)
     returning *, (select name from vendors where id = work_orders.assigned_vendor_id) as assigned_vendor_name`,
    [
      orgId,
      input.propertyId ?? null,
      input.guestId ?? null,
      input.bookingId ?? null,
      input.threadId ?? null,
      input.title,
      input.description ?? null,
      input.category ?? null,
      input.source ?? "manual",
      input.reportedBy ?? null,
      input.priority ?? "normal",
    ]
  );
  if (!row) throw new Error("Failed to create work order.");
  const workOrder = fromRow(row);

  await logAiActivity(
    {
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Log new work order",
      trigger: `${workOrder.source === "guest_message" ? "Guest-reported issue" : "Reported"}: ${workOrder.title}`,
      decision: `queued at priority '${workOrder.priority}'`,
      actionTaken: "Created work order record",
      result: "open",
    },
    orgId
  ).catch(() => {});

  return workOrder;
}

/** Marks a work order's Gabriel-notify as having actually gone out — called
 * from lib/serviceRequestNotify.ts right after a successful WhatsApp send,
 * so the UI can show "Gabriel notified" without guessing from source alone
 * (a failed/unconfigured notify should not claim success). */
export async function markGabrielNotified(id: string, organizationId?: string): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await query("update work_orders set gabriel_notified_at = now() where id = $1 and organization_id = $2", [
    id,
    orgId,
  ]);
}

/** Marks a work order's vendor-notify as having actually gone out — called
 * from lib/maintenanceVendorNotify.ts right after a successful WhatsApp send,
 * same convention as markGabrielNotified above. */
export async function markVendorNotified(id: string, organizationId?: string): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await query("update work_orders set vendor_notified_at = now() where id = $1 and organization_id = $2", [
    id,
    orgId,
  ]);
}

/** Moves a work order to a new status — the entire "maintenance decision"
 * surface here, mirroring lib/leads.ts's updateLeadStage. cost/rootCause/
 * resolutionNotes are only meaningful (and only persisted) when moving to
 * 'resolved'; they're left untouched otherwise so a partial resolve attempt
 * doesn't clobber earlier notes. */
export async function updateWorkOrderStatus(
  id: string,
  update: { status: WorkOrderStatus; costCents?: number; rootCause?: string; resolutionNotes?: string },
  organizationId?: string
): Promise<WorkOrder | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const isResolving = update.status === "resolved";
  const row = await queryOne<WorkOrderRow>(
    `update work_orders set
       status = $2::work_order_status,
       cost_cents = case when $2::work_order_status = 'resolved' then coalesce($3, cost_cents) else cost_cents end,
       root_cause = case when $2::work_order_status = 'resolved' then coalesce($4, root_cause) else root_cause end,
       resolution_notes = case when $2::work_order_status = 'resolved' then coalesce($5, resolution_notes) else resolution_notes end,
       resolved_at = case when $2::work_order_status = 'resolved' then now() else null end,
       updated_at = now()
     where id = $1 and organization_id = $6
     returning *, (select name from vendors where id = work_orders.assigned_vendor_id) as assigned_vendor_name`,
    [id, update.status, update.costCents ?? null, update.rootCause ?? null, update.resolutionNotes ?? null, orgId]
  );
  if (!row) return null;
  const workOrder = fromRow(row);

  await logAiActivity(
    {
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Update work order status",
      trigger: `Seni moved work order ${id} (${workOrder.title}) to ${update.status}`,
      decision: update.status,
      actionTaken: isResolving
        ? `Marked resolved${update.costCents != null ? ` — cost $${(update.costCents / 100).toFixed(2)}` : ""}${update.rootCause ? `, root cause: ${update.rootCause}` : ""}`
        : `Status changed to ${update.status}`,
      result: update.status,
    },
    orgId
  ).catch(() => {});

  return workOrder;
}

/** Corrects/enriches a work order's own fields — vendor assignment, edited
 * description/category/priority — separate from updateWorkOrderStatus so
 * these edits don't read as a status decision in the AI Activity log. */
export async function updateWorkOrderFields(
  id: string,
  updates: Partial<{
    title: string;
    description: string;
    category: string;
    priority: WorkOrderPriority;
    assignedVendorId: string | null;
  }>,
  organizationId?: string
): Promise<WorkOrder | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const existing = await getWorkOrder(id, orgId);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  const nextVendorId = updates.assignedVendorId !== undefined ? updates.assignedVendorId : (merged.assignedVendorId ?? null);
  // A reassignment to a different vendor (or to "Unassigned") should clear
  // any prior vendor_notified_at — otherwise the UI would keep showing "vendor
  // notified" for a vendor who was never told about this specific work order.
  // lib/maintenanceVendorNotify.ts re-sets it once the new vendor is actually
  // notified.
  const vendorChanged = updates.assignedVendorId !== undefined && updates.assignedVendorId !== (existing.assignedVendorId ?? null);
  const row = await queryOne<WorkOrderRow>(
    `update work_orders set
       title = $2, description = $3, category = $4, priority = $5::work_order_priority,
       assigned_vendor_id = $6,
       vendor_notified_at = case when $7 then null else vendor_notified_at end,
       updated_at = now()
     where id = $1 and organization_id = $8
     returning *, (select name from vendors where id = $6) as assigned_vendor_name`,
    [
      id,
      merged.title,
      merged.description ?? null,
      merged.category ?? null,
      merged.priority,
      nextVendorId,
      vendorChanged,
      orgId,
    ]
  );
  return row ? fromRow(row) : null;
}
