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

    // Keep the last few raw payloads in Redis so real field names can be
    // inspected via /api/admin/webhook-status (found 2026-08-16 that real
    // thread_message payloads were being skipped as "missing threadId/body"
    // — the docs' claimed shape didn't match what actually arrives, and
    // Vercel Hobby has no retrievable runtime-log history to check).
    try {
      const { redisGet, redisSet } = await import("@/lib/redis");
      const prev = await redisGet("webhook:raw-samples").catch(() => null);
      const samples = prev ? (JSON.parse(prev) as unknown[]) : [];
      // Stored as a (possibly truncated) string — never re-parsed server-side.
      samples.unshift({ at: new Date().toISOString(), payload: JSON.stringify(event).slice(0, 4000) });
      await redisSet("webhook:raw-samples", JSON.stringify(samples.slice(0, 8))).catch(() => {});
    } catch {
      /* best-effort only */
    }

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
