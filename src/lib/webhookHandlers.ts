import { sendAdminReplyNotificationTemplate, sendWhatsAppTextTo, sendGuestReplyApprovalTemplate, sendWhatsAppText } from "@/lib/whatsapp";
import { sendBookingNotificationTemplate } from "@/lib/whatsapp";
import { config } from "@/lib/config";
import { draftEscalationAnswerForApproval } from "@/lib/chatWidget";
import { createPendingDraft, getPendingDraftByThreadId } from "@/lib/pendingDrafts";
import { sendMessage } from "@/lib/ownerrez";
import { logAiActivity } from "@/lib/aiActivity";
import type { ThreadMessage, Booking } from "@/lib/types";

interface OwnerRezWebhookEvent {
  eventType: string;
  eventId?: string;
  entityType: string;
  entityId: string;
  timestamp: string;
  data?: Record<string, unknown>;
  message?: ThreadMessage & { guestName?: string; subject?: string; body?: string; threadId?: number; bookingId?: number; guestId?: number; language?: string };
  booking?: Booking & { guestName?: string };
  guest?: Record<string, unknown>;
  inquiry?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Handles incoming message events from OwnerRez.
 * For guest messages: Generates AI draft reply, sends to owner for approval via WhatsApp with YES/NO/EDIT: format
 */
export async function handleOwnerRezMessageEvent(event: OwnerRezWebhookEvent) {
  try {
    console.log("[webhookHandlers] Processing message event", {
      eventType: event.eventType,
      entityId: event.entityId,
      timestamp: event.timestamp,
    });

    const message = event.message as ThreadMessage & { guestName?: string; subject?: string; body?: string; threadId?: number; bookingId?: number; guestId?: number; language?: string } | undefined;
    if (!message) {
      console.warn("[webhookHandlers] Message event has no message data");
      return;
    }

    const ownerPhone = config.ownerPhone || "732-689-5070";
    const isGuestReply = message.senderType === "guest";
    const isAdminReply = message.senderType === "admin" || message.senderType === "owner";

    if (isGuestReply && message.threadId && message.bookingId && message.guestId) {
      console.log(`[webhookHandlers] Guest ${message.guestName} replied to thread ${message.threadId}`);

      const guestName = message.guestName || "Guest";
      const question = message.body || "(No message content)";

      // Check if there's already a pending draft for this thread
      const existing = await getPendingDraftByThreadId(message.threadId).catch(() => null);
      if (existing && existing.status === "pending") {
        console.log(`[webhookHandlers] Already awaiting approval for ${guestName} on thread ${message.threadId}`);
        return; // Don't create a new draft — let them resolve the existing one first
      }

      // Generate AI draft reply
      let aiDraftReply: string | undefined;
      let draftReplyEnglish: string | undefined;
      try {
        aiDraftReply = await draftEscalationAnswerForApproval(question);
        draftReplyEnglish = aiDraftReply;
        console.log(`[webhookHandlers] AI draft generated for ${guestName}`);
      } catch (draftError) {
        console.error(`[webhookHandlers] Failed to generate AI draft: ${draftError}`);
        // Non-fatal — owner can write their own reply with EDIT: ...
      }

      // Create pending draft record (this will automatically supersede any old draft on this thread)
      const pending = await createPendingDraft({
        threadId: message.threadId,
        bookingId: message.bookingId,
        guestId: message.guestId,
        guestName,
        draftReply: aiDraftReply || "",
        replyEnglish: draftReplyEnglish,
        language: message.language || "en",
      });

      console.log(`[webhookHandlers] Created pending draft ${pending.id} for approval`);

      // Send approval request to owner via WhatsApp
      const draftLine = aiDraftReply
        ? `Suggested reply:\n"${aiDraftReply}"\n\nReply YES to send it, NO to skip, or "EDIT: <your text>" to send your own wording.`
        : `No suggested reply could be drafted — reply "EDIT: <your text>" to send an answer, or NO to skip.`;

      const approvalText = `New message from ${guestName} on thread #${message.threadId}:\n\n"${question}"\n\n${draftLine}`;

      let approvalWamid: string | undefined;
      try {
        // Try template first (more reliable for 24-hour window)
        approvalWamid = await sendGuestReplyApprovalTemplate({
          guestName,
          propertyName: config.propertyName || "Your Property",
          guestMessage: question,
          suggestedReply: aiDraftReply ?? "N/A",
        }).catch(() => undefined);
      } catch {
        // Fallback to plain text
        approvalWamid = await sendWhatsAppText(approvalText).catch(() => undefined);
      }
      if (!approvalWamid) {
        approvalWamid = await sendWhatsAppText(approvalText).catch(() => undefined);
      }

      await logAiActivity({
        agentKey: "guest_experience",
        agentDisplayName: "AI Guest Experience Manager",
        task: "Draft reply to guest message (webhook)",
        trigger: `Guest message from ${guestName} on thread #${message.threadId}: "${question.slice(0, 200)}"`,
        decision: aiDraftReply ? "drafted reply, awaiting owner approval" : "no draft — awaiting owner's own wording",
        actionTaken: "Sent approval request to owner via WhatsApp; awaiting YES/NO/EDIT response",
        result: "pending",
      });
    }

    if (isAdminReply) {
      console.log(`[webhookHandlers] Admin replied to thread ${message.threadId}`);
      // Admin replies are handled by the main message send workflow
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
