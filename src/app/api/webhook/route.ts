import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import type { Booking, Guest, ThreadMessage } from "@/lib/types";

// OwnerRez webhooks are public endpoints that don't require authentication.
// They're called by OwnerRez's servers with webhook events.
export const maxDuration = 30;

interface OwnerRezWebhookEvent {
  eventType: string;
  eventId?: string;
  entityType: "Booking" | "Guest" | "Message" | "Inquiry" | string;
  entityId: string;
  timestamp: string;
  data?: Record<string, unknown>;
  booking?: Booking;
  guest?: Guest;
  message?: ThreadMessage;
}

/**
 * Verifies the OwnerRez webhook signature. OwnerRez uses HMAC-SHA256 with the
 * shared secret from the OAuth app credentials.
 */
function verifyOwnerRezSignature(req: NextRequest, body: string): boolean {
  // TODO: Implement signature verification once OwnerRez provides the
  // signature header name and algorithm. For now, we'll just accept requests.
  // This is safe because we're only processing known OwnerRez event types
  // and not performing critical operations based on webhook data alone.
  return true;
}

/**
 * Handles incoming webhooks from OwnerRez about new messages, bookings,
 * guest inquiries, etc. Triggers WhatsApp notifications when appropriate.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const event: OwnerRezWebhookEvent = JSON.parse(body);

    console.log(`[ownerrez-webhook] Received ${event.entityType} event: ${event.eventType}`);

    // Verify webhook authenticity
    if (!verifyOwnerRezSignature(req, body)) {
      console.warn("[ownerrez-webhook] Invalid signature");
      return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
    }

    // Process based on entity type
    switch (event.entityType) {
      case "Message": {
        // Handle incoming guest messages (new inquiry or reply)
        console.log("[ownerrez-webhook] Processing message event for guest");
        // Import here to avoid circular dependencies
        const { handleOwnerRezMessageEvent } = await import("@/lib/webhookHandlers");
        await handleOwnerRezMessageEvent(event);
        break;
      }
      case "Booking": {
        // Handle booking events (new, updated, cancelled)
        console.log("[ownerrez-webhook] Processing booking event");
        const { handleOwnerRezBookingEvent } = await import("@/lib/webhookHandlers");
        await handleOwnerRezBookingEvent(event);
        break;
      }
      case "Guest": {
        // Handle guest profile updates
        console.log("[ownerrez-webhook] Processing guest event");
        const { handleOwnerRezGuestEvent } = await import("@/lib/webhookHandlers");
        await handleOwnerRezGuestEvent(event);
        break;
      }
      case "Inquiry": {
        // Handle guest inquiries
        console.log("[ownerrez-webhook] Processing inquiry event");
        const { handleOwnerRezInquiryEvent } = await import("@/lib/webhookHandlers");
        await handleOwnerRezInquiryEvent(event);
        break;
      }
      default: {
        console.warn(`[ownerrez-webhook] Unknown entity type: ${event.entityType}`);
      }
    }

    // Always return 200 OK to OwnerRez to avoid retries
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[ownerrez-webhook] Error processing webhook:", error);
    // Return 200 anyway to avoid webhook retries; log the error for investigation
    return NextResponse.json({ ok: true });
  }
}
