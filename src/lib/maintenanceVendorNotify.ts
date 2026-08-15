import { getVendor } from "./billPay";
import { config, isVendorNotifyConfigured } from "./config";
import { markVendorNotified } from "./maintenance";
import { notifyVendorOfWorkOrder, WhatsAppError } from "./whatsapp";
import type { WorkOrder } from "./types";

/**
 * Fires a one-time WhatsApp notify to a vendor the moment they're newly
 * assigned to a work order — the vendor-facing counterpart to
 * lib/serviceRequestNotify.ts's Gabriel notify. Called from the maintenance
 * PATCH route right after lib/maintenance.ts's updateWorkOrderFields
 * succeeds (see src/app/api/maintenance/[id]/route.ts).
 *
 * Best-effort and non-fatal by design, same convention as every other
 * WhatsApp side effect in this app: the vendor *assignment* itself already
 * succeeded in the DB by the time this runs, so a missing template, a
 * vendor with no phone on file, or a Meta API failure should never surface
 * as a failed assignment — it just means the notify step gets skipped, and
 * the returned note string says why (shown next to the vendor picker in
 * MaintenanceExplorer).
 */
export async function notifyVendorIfNewlyAssigned(
  workOrder: WorkOrder,
  previousVendorId: string | null | undefined,
  organizationId?: string
): Promise<string> {
  if (!workOrder.assignedVendorId || workOrder.assignedVendorId === (previousVendorId ?? undefined)) {
    return "";
  }

  const vendor = await getVendor(workOrder.assignedVendorId, organizationId).catch(() => null);
  if (!vendor) return "";
  if (!vendor.contactPhone) {
    return "Vendor has no phone on file — notify skipped.";
  }

  if (!isVendorNotifyConfigured()) {
    return "Vendor auto-notify isn't set up yet — see README's WhatsApp section.";
  }

  try {
    await notifyVendorOfWorkOrder(
      {
        vendorPhone: vendor.contactPhone,
        vendorName: vendor.name,
        propertyName: config.propertyName,
        workOrderTitle: workOrder.title,
        workOrderDescription: workOrder.description ?? "",
        priority: workOrder.priority,
      },
      organizationId
    );
    await markVendorNotified(workOrder.id, organizationId).catch(() => {});
    return "🔔 Vendor notified via WhatsApp.";
  } catch (err) {
    const message = err instanceof WhatsAppError ? err.message : "Unknown error.";
    return `Vendor notify failed: ${message.slice(0, 150)}`;
  }
}
