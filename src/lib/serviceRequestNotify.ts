import { config, isGabrielNotifyConfigured, isDbConfigured } from "./config";
import { notifyGabrielOfServiceRequest, WhatsAppError } from "./whatsapp";
import { createWorkOrder, markGabrielNotified } from "./maintenance";
import type { PendingDraft } from "./types";

/**
 * Fires the Gabriel auto-notify WhatsApp template when a just-approved draft
 * was a service request (chef, massage, jet ski, boat rental, etc.) — see
 * lib/aiReply.ts's isServiceRequest. Shared by both approval paths (the
 * WhatsApp webhook's "YES" handler and the dashboard's approve/edit button)
 * so the behavior — and the confirmation text back to Seni — stays
 * identical no matter which channel he approves from.
 *
 * Also logs a work order (see lib/maintenance.ts) so the request has real,
 * persistent tracking instead of disappearing after the one-shot WhatsApp
 * ping — closing the Phase 3 gap flagged in db/migrations/0007_maintenance.sql.
 * Work-order creation is best-effort: it runs whether or not Gabriel's
 * notify is configured, but never throws — a maintenance-tracking hiccup
 * should never surface as a failure on what is, from the guest's point of
 * view, an already-completed send.
 *
 * Deliberately swallows errors (missing config, Meta API failure, etc.) —
 * failing to notify Gabriel should never block the guest-facing send, which
 * has already succeeded by the time this runs. Returns a short status
 * string to append to Seni's own confirmation message.
 */
export async function notifyGabrielIfServiceRequest(
  draft: Pick<
    PendingDraft,
    "isServiceRequest" | "guestName" | "guestPhone" | "guestMessageEnglish" | "guestMessage" | "guestId" | "bookingId" | "threadId"
  >
): Promise<string> {
  if (!draft.isServiceRequest) return "";

  const summary = draft.guestMessageEnglish ?? draft.guestMessage;

  let workOrderId: string | undefined;
  if (isDbConfigured()) {
    try {
      const workOrder = await createWorkOrder({
        guestId: draft.guestId ?? undefined,
        bookingId: draft.bookingId,
        threadId: draft.threadId,
        title: `Service request from ${draft.guestName ?? "guest"}`,
        description: summary,
        source: "guest_message",
        reportedBy: draft.guestName ?? "guest (via WhatsApp/OwnerRez message)",
      });
      workOrderId = workOrder.id;
    } catch {
      // Tracking is best-effort — see header comment. Gabriel's notify below
      // still runs even if this failed.
    }
  }

  if (!isGabrielNotifyConfigured()) {
    return " (Gabriel auto-notify isn't set up yet — see README's WhatsApp section.)";
  }

  try {
    await notifyGabrielOfServiceRequest({
      propertyName: config.propertyName,
      guestName: draft.guestName ?? "the guest",
      guestPhone: draft.guestPhone ?? "no phone on file",
      requestSummary: summary,
    });
    if (workOrderId) await markGabrielNotified(workOrderId).catch(() => {});
    return " 🔔 Gabriel notified.";
  } catch (err) {
    const message = err instanceof WhatsAppError ? err.message : "Unknown error.";
    return ` (Gabriel notify failed: ${message.slice(0, 150)})`;
  }
}
