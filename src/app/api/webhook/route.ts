import { NextRequest, NextResponse } from "next/server";
import type { OwnerRezWebhookEvent } from "@/lib/webhookHandlers";

// Public endpoint for OwnerRez webhook events (no auth — called by
// OwnerRez's servers). Must be whitelisted in src/proxy.ts alongside the
// other public webhook routes. Always returns 200 quickly so OwnerRez
// doesn't retry-storm on our own processing errors.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const event = (await req.json()) as OwnerRezWebhookEvent;

    // OwnerRez uses snake_case (entity_type); accept camelCase too.
    const entityType = (
      (typeof event.entityType === "string" && event.entityType) ||
      (typeof event.entity_type === "string" && event.entity_type) ||
      ""
    ).toLowerCase();

    console.log(`[ownerrez-webhook] Received ${entityType || "unknown"} event`, {
      action: event.eventType ?? event.action,
      entityId: event.entityId ?? event.entity_id,
    });

    // OwnerRez's "Send a Test Webhook" button posts action:"webhook_test"
    // with entity_type:"api_application" — acknowledge it loudly so it's
    // easy to spot in Vercel logs when verifying the connection.
    const action = String(event.eventType ?? event.action ?? "").toLowerCase();
    if (action === "webhook_test") {
      console.log("[ownerrez-webhook] ✅ webhook_test received — OwnerRez → this endpoint is connected");
      return NextResponse.json({ ok: true, test: true });
    }

    // Dynamic imports keep this route's cold start minimal and avoid any
    // circular-dependency surprises.
    switch (entityType) {
      case "thread_message": // OwnerRez's official entity_type for messages
      case "message": {
        const { handleOwnerRezMessageEvent } = await import("@/lib/webhookHandlers");
        await handleOwnerRezMessageEvent(event);
        break;
      }
      case "booking": {
        const { handleOwnerRezBookingEvent } = await import("@/lib/webhookHandlers");
        await handleOwnerRezBookingEvent(event);
        break;
      }
      case "guest": {
        const { handleOwnerRezGuestEvent } = await import("@/lib/webhookHandlers");
        await handleOwnerRezGuestEvent(event);
        break;
      }
      case "inquiry": {
        const { handleOwnerRezInquiryEvent } = await import("@/lib/webhookHandlers");
        await handleOwnerRezInquiryEvent(event);
        break;
      }
      default: {
        console.warn(`[ownerrez-webhook] Unknown entity type: ${entityType || "(none)"}`);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[ownerrez-webhook] Error processing webhook:", error);
    // 200 anyway — a retry storm from OwnerRez wouldn't help anything.
    return NextResponse.json({ ok: true });
  }
}
