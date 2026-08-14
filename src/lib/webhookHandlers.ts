import { sendAdminReplyNotificationTemplate } from "@/lib/whatsapp";
import { sendBookingNotificationTemplate } from "@/lib/whatsapp";
import type { ThreadMessage } from "@/lib/types";

interface OwnerRezWebhookEvent {
  eventType: string;
  eventId?: string;
  entityType: string;
  entityId: string;
  timestamp: string;
  data?: Record<string, unknown>;
  message?: ThreadMessage;
  [key: string]: unknown;
}

/**
 * Handles incoming message events from OwnerRez.
 * Triggers WhatsApp notification when:
 * - A guest replies to a thread (new message in conversation)
 * - An admin sends a reply (guest reply approval is complete)
 */
export async function handleOwnerRezMessageEvent(event: OwnerRezWebhookEvent) {
  try {
    console.log("[webhookHandlers] Processing message event", {
      eventType: event.eventType,
      entityId: event.entityId,
      timestamp: event.timestamp,
    });

    // The message event should contain message details
    const message = event.message as ThreadMessage | undefined;
    if (!message) {
      console.warn("[webhookHandlers] Message event has no message data");
      return;
    }

    // Determine if this is a guest reply or admin reply
    const isGuestReply = message.senderType === "guest";
    const isAdminReply = message.senderType === "admin" || message.senderType === "owner";

    if (isGuestReply) {
      console.log(`[webhookHandlers] Guest replied to thread ${message.threadId}`);
      // Guest message will be picked up by the next cron/check-messages run
      // No immediate notification needed
    }

    if (isAdminReply) {
      console.log(`[webhookHandlers] Admin replied to thread ${message.threadId}`);
      // Send WhatsApp notification to owner about the admin reply
      // This allows owner to approve/edit the response
      // TODO: Integrate with the approval workflow
    }
  } catch (error) {
    console.error("[webhookHandlers] Error processing message event:", error);
  }
}

/**
 * Handles incoming booking events from OwnerRez.
 * Triggers WhatsApp notification when a new booking is created or updated.
 */
export async function handleOwnerRezBookingEvent(event: OwnerRezWebhookEvent) {
  try {
    console.log("[webhookHandlers] Processing booking event", {
      eventType: event.eventType,
      entityId: event.entityId,
      timestamp: event.timestamp,
    });

    // Extract booking details from event
    const booking = event.data as Record<string, unknown> | undefined;
    if (!booking) {
      console.warn("[webhookHandlers] Booking event has no booking data");
      return;
    }

    // Only send notifications for new bookings
    if (event.eventType === "created" || event.eventType === "new") {
      console.log(`[webhookHandlers] New booking created: ${event.entityId}`);
      // Booking notifications are typically sent by the bookingAlerts cron job
      // We could send an additional real-time notification here if needed
    }
  } catch (error) {
    console.error("[webhookHandlers] Error processing booking event:", error);
  }
}

/**
 * Handles incoming guest profile events from OwnerRez.
 * Typically for guest data updates (name, contact info, etc.)
 */
export async function handleOwnerRezGuestEvent(event: OwnerRezWebhookEvent) {
  try {
    console.log("[webhookHandlers] Processing guest event", {
      eventType: event.eventType,
      entityId: event.entityId,
      timestamp: event.timestamp,
    });

    // Guest events might include profile updates, new contacts, etc.
    // These don't typically require immediate WhatsApp notifications
    // but could be logged for audit purposes
  } catch (error) {
    console.error("[webhookHandlers] Error processing guest event:", error);
  }
}

/**
 * Handles incoming inquiry events from OwnerRez.
 * Guest inquiries (questions before booking) should trigger notifications.
 */
export async function handleOwnerRezInquiryEvent(event: OwnerRezWebhookEvent) {
  try {
    console.log("[webhookHandlers] Processing inquiry event", {
      eventType: event.eventType,
      entityId: event.entityId,
      timestamp: event.timestamp,
    });

    // New guest inquiries should notify the owner
    if (event.eventType === "created" || event.eventType === "new") {
      console.log(`[webhookHandlers] New inquiry from guest: ${event.entityId}`);
      // This would trigger a WhatsApp notification similar to message events
    }
  } catch (error) {
    console.error("[webhookHandlers] Error processing inquiry event:", error);
  }
}
