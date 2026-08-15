import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { getWorkOrder, updateWorkOrderStatus, updateWorkOrderFields } from "@/lib/maintenance";
import { notifyVendorIfNewlyAssigned } from "@/lib/maintenanceVendorNotify";
import { getSessionFromRequest } from "@/lib/session";
import type { WorkOrderStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_STATUSES: WorkOrderStatus[] = ["open", "in_progress", "blocked", "resolved", "cancelled"];

// Two independent kinds of edit, mirroring /api/leads/[id]'s pattern:
//   { status: "...", costCents?, rootCause?, resolutionNotes? }  -> updateWorkOrderStatus
//   { fields: { title, description, category, priority, assignedVendorId } } -> updateWorkOrderFields
// Send either or both in one request. Neither ever pages a vendor or
// contacts a guest — see lib/maintenance.ts's header comment.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || (!body.status && !body.fields)) {
    return NextResponse.json({ error: "Provide a status and/or fields to update." }, { status: 400 });
  }

  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
  }

  try {
    if (body.fields) {
      const previous = await getWorkOrder(id, session?.organizationId);
      let fieldsResult = await updateWorkOrderFields(id, body.fields, session?.organizationId);
      if (!fieldsResult) return NextResponse.json({ error: "Work order not found." }, { status: 404 });

      // Best-effort vendor WhatsApp notify — see lib/maintenanceVendorNotify.ts.
      // Never blocks or fails the assignment itself.
      const vendorNotifyNote = await notifyVendorIfNewlyAssigned(
        fieldsResult,
        previous?.assignedVendorId,
        session?.organizationId
      ).catch(() => "");
      if (vendorNotifyNote.startsWith("🔔")) {
        // Re-fetch so the returned work order reflects the just-set vendor_notified_at.
        fieldsResult = (await getWorkOrder(id, session?.organizationId)) ?? fieldsResult;
      }

      if (!body.status) {
        return NextResponse.json({ workOrder: fieldsResult, vendorNotifyNote: vendorNotifyNote || undefined });
      }
    }

    const workOrder = await updateWorkOrderStatus(
      id,
      {
        status: body.status,
        costCents: body.costCents,
        rootCause: body.rootCause,
        resolutionNotes: body.resolutionNotes,
      },
      session?.organizationId
    );
    if (!workOrder) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
    return NextResponse.json({ workOrder });
  } catch (err) {
    return NextResponse.json(
      { error: `Work order update failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
