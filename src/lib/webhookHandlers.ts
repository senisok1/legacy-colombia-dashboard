import { sendAdminReplyNotificationTemplate, sendWhatsAppTextTo } from "@/lib/whatsapp";
import { sendBookingNotificationTemplate } from "@/lib/whatsapp";
import { config } from "@/lib/config";
import type { ThreadMessage, Booking } from "@/lib/types";

interface OwnerRezWebhookEvent {
  eventType: string;
  eventId?: string;
  entityType: string;
  entityId: string;
  timestamp: string;
  data?: Record<string, unknown>;
  message?: ThreadMessage & { guestName?: string; subject?: string; body?: string };
  booking?: Booking & { guestName?: string };
  guest?: Record<string, unknown>;
  inquiry?: Record<string, unknown>;
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
    const message = event.message as ThreadMessage & { guestName?: string; subject?: string; body?: string } | undefined;
    if (!message) {
      console.warn("[webhookHandlers] Message event has no message data");
      return;
    }

    const ownerPhone = config.ownerPhone || "732-689-5070";

    // Determine if this is a guest reply or admin reply
    const isGuestReply = message.senderType === "guest";
    const isAdminReply = message.senderType === "admin" || message.senderType === "owner";

    if (isGuestReply) {
      console.log(`[webhookHandlers] Guest ${message.guestName} replied to thread ${message.threadId}`);
      // Send WhatsApp notification to owner about guest reply
      const guestName = message.guestName || "Guest";
      const subject = message.subject || "New Message";
      const messageBody = message.body || "(No message content)";

      try {
        await sendWhatsAppTextTo(
          ownerPhone,
          `📨 *New Guest Message*\n\nFrom: ${guestName}\nSubject: ${subject}\n\nMessage: ${messageBody}\n\nCheck OwnerRez for full details.`
        );
        console.log(`[webhookHandlers] WhatsApp notification sent for guest message from ${guestName}`);
      } catch (whatsappError) {
        console.error("[webhookHandlers] Failed to send WhatsApp notification:", whatsappError);
      }
    }

    if (isAdminReply) {
      console.log(`[webhookHandlers] Admin replied to thread ${message.threadId}`);
      // Admin replies are handled by the main message send workflow
      // No need to send duplicate notification here
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

    // Extract booking details from event or booking object
    const booking = (event.booking || event.data) as Booking & { guestName?: string } | undefined;
    if (!booking) {
      console.warn("[webhookHandlers] Booking event has no booking data");
      return;
    }

    const ownerPhone = config.ownerPhone || "732-689-5070";

    // Only send notifications for new bookings
    if (event.eventType === "created" || event.eventType === "new") {
      console.log(`[webhookHandlers] New booking created: ${event.entityId}`);

      try {
        const guestName = booking.guestName || (booking as any).fullName || "Guest";
        const checkIn = booking.checkIn ? new Date(booking.checkIn).toLocaleDateString() : "TBD";
        const checkOut = booking.checkOut ? new Date(booking.checkOut).toLocaleDateString() : "TBD";
        const nights = booking.nights || "?";
        const propertyName = (booking as any).propertyName || config.propertyName || "Your Property";

        await sendBookingNotificationTemplate(guestName, propertyName, checkIn, checkOut, nights, ownerPhone);
        console.log(`[webhookHandlers] WhatsApp booking notification sent for ${guestName}`);
      } catch (whatsappError) {
        console.error("[webhookHandlers] Failed to send WhatsApp booking notification:", whatsappError);
      }
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

    const ownerPhone = config.ownerPhone || "732-689-5070";

    // New guest inquiries should notify the owner
    if (event.eventType === "created" || event.eventType === "new") {
      console.log(`[webhookHandlers] New inquiry from guest: ${event.entityId}`);

      try {
        const inquiry = event.inquiry || event.data || {};
        const guestName = (inquiry as any).guestName || (inquiry as any).name || "Guest";
        const question = (inquiry as any).message || (inquiry as any).question || "(No question provided)";

        await sendWhatsAppTextTo(
          ownerPhone,
          `❓ *New Guest Inquiry*\n\nFrom: ${guestName}\n\nQuestion: ${question}\n\nCheck OwnerRez to respond.`
        );
        console.log(`[webhookHandlers] WhatsApp notification sent for inquiry from ${guestName}`);
      } catch (whatsappError) {
        console.error("[webhookHandlers] Failed to send WhatsApp inquiry notification:", whatsappError);
      }
    }
  } catch (error) {
    console.error("[webhookHandlers] Error processing inquiry event:", error);
  }
}
