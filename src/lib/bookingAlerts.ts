// Real-time WhatsApp alert for brand-new OwnerRez bookings — independent of
// the guest-message drafting pipeline in api/cron/check-messages/route.ts.
// Built 2026-08-06 per Seni's ask ("make sure my whatsapp get's pinged for
// any inquiries or bookings") after discovering the existing pipeline only
// ever alerted on a NEW GUEST MESSAGE inside an OwnerRez thread — a booking
// with no message (e.g. an Airbnb instant-book nobody has messaged about
// yet) previously produced zero real-time signal; Seni would only see it
// later in the once-daily executive report or by opening the dashboard.
//
// Deliberately only depends on isWhatsAppConfigured() — NOT
// isMessagingConfigured()/isAiReplyConfigured() (OAuth + Anthropic, both
// needed only for drafting guest replies). Booking data comes from the PAT
// (getBookings()), and the alert text itself is plain formatted data, no AI
// call. Coupling this to the same gates as guest-reply drafting would mean a
// lapsed Anthropic key (has happened to other orgs — see
// getAnthropicCredentials()) silently kills booking alerts too, which is
// exactly the kind of silent single-point-of-failure this feature exists to
// eliminate.
import { redisGet, redisSet } from "@/lib/redis";
import { sendWhatsAppText, sendBookingNotificationTemplate, sendDailySummaryTemplate } from "@/lib/whatsapp";
import { logAiActivity } from "@/lib/aiActivity";
import { resolveGuestName, buildGuestsById } from "@/lib/guestName";
import type { Booking } from "@/lib/types";

const AGENT_KEY = "guest_experience";
const AGENT_NAME = "AI Guest Experience Manager";

// Keep the "seen" record around far longer than any booking lookback this
// app ever queries, so a booking can never fall out of the seen-set and get
// re-alerted on some future run.
const SEEN_TTL_SECONDS = 400 * 24 * 60 * 60;

// Bootstrap safety window: the very first time this feature runs (or after
// a Redis reset), every booking in the account's history is technically
// "unseen." Only alert on ones actually CREATED recently — everything older
// gets silently marked seen instead of triggering a flood of stale alerts.
// Generous on purpose: once bootstrapped, this cron runs every ~2 minutes,
// so a genuinely new booking's createdAt is always minutes old when first
// detected, never anywhere near this window.
const NEW_BOOKING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function seenKey(orgId: string, bookingId: number): string {
  return `booking-alert:${orgId}:seen:${bookingId}`;
}

function formatMoney(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export async function checkNewBookingAlerts(
  bookings: Booking[],
  guestsById: ReturnType<typeof buildGuestsById>,
  orgId: string
): Promise<{
  alerted: { bookingId: number; guestName?: string }[];
  errors: { bookingId: number; error: string }[];
}> {
  const alerted: { bookingId: number; guestName?: string }[] = [];
  const errors: { bookingId: number; error: string }[] = [];

  for (const booking of bookings) {
    if (booking.isBlock || booking.status === "Cancelled") continue;

    const key = seenKey(orgId, booking.id);
    if (await redisGet(key)) continue;

    const createdMs = booking.createdAt ? new Date(booking.createdAt).getTime() : NaN;
    const ageMs = Number.isNaN(createdMs) ? Infinity : Date.now() - createdMs;

    if (ageMs > NEW_BOOKING_MAX_AGE_MS) {
      // Backfill: old booking this feature has simply never seen before.
      // Mark seen, no alert — otherwise going live would spam Seni with the
      // account's entire booking history in one run.
      await redisSet(key, "1", { exSeconds: SEEN_TTL_SECONDS });
      continue;
    }

    try {
      let guestName = resolveGuestName(booking, guestsById);
      // resolveGuestName falls back to "Guest" when the guests directory
      // doesn't have this booking's guest yet (brand-new bookings often sync
      // before their guest record shows up in the property-scoped list —
      // that's how "New booking 18908561 (Guest, Airbnb)" happened). One
      // direct lookup fixes it (2026-08-21, Seni: "I need all names for all
      // whatsapp messages").
      if (guestName === "Guest" && booking.guestId != null) {
        const { getGuestById } = await import("@/lib/ownerrez");
        const guest = await getGuestById(booking.guestId, orgId).catch(() => undefined);
        if (guest?.fullName?.trim()) guestName = guest.fullName.trim();
      }
      const nights = booking.nights ?? null;
      const dates = `${formatDate(booking.arrival)} → ${formatDate(booking.departure)}${nights ? ` (${nights} night${nights === 1 ? "" : "s"})` : ""}`;
      const text =
        `📅 New booking! ${guestName ?? "Guest"} — ${booking.propertyName ?? "your property"}\n` +
        `${dates}` +
        `\nSource: ${booking.source || "Unknown"}` +
        (typeof booking.totalAmount === "number" ? `\nTotal: ${formatMoney(booking.totalAmount)}` : "");

      // Delivery ladder (rewritten 2026-08-17 after Seni reported never
      // receiving new-booking alerts).
      //
      // ROOT CAUSE: `booking_notification` does not exist on the WhatsApp
      // Business Account at all — Meta returns 132001 "template name does not
      // exist" — so this ALWAYS fell through to sendWhatsAppText(), which
      // sends a content-free session-opener template plus a free-text message
      // that 131047 blocks whenever the 24h window is shut. Net result: a
      // meaningless ping, and the booking details never arrived.
      //
      // Rather than leave bookings silent until a new template clears Meta
      // review, step 2 reuses `daily_summary_alert` — already APPROVED and
      // UTILITY category, and its three body params (label / headline /
      // stats) fit a booking alert exactly. Step 1 is kept so that if a
      // purpose-built booking_notification template is created later, it
      // takes over automatically with no code change.
      const headline = `New booking — ${guestName ?? "Guest"}`;
      const statsLine =
        `${dates} · ${booking.source || "Unknown"}` +
        (typeof booking.totalAmount === "number" ? ` · ${formatMoney(booking.totalAmount)}` : "");

      // Parallel email channel (2026-08-21, Seni's ask) — sent BEFORE the
      // WhatsApp ladder so a total WhatsApp failure still lands the alert
      // somewhere. Own once-guard (":email" on the same booking seen-key),
      // so the WhatsApp retry-next-run path never duplicates it.
      const { sendAlertEmailOnce } = await import("@/lib/alertEmail");
      await sendAlertEmailOnce(`${key}:email`, `📅 ${headline}`, text).catch(() => {});

      try {
        await sendBookingNotificationTemplate({
          guestName: guestName ?? "Guest",
          propertyName: booking.propertyName ?? "your property",
          dates,
        }, orgId);
      } catch {
        try {
          await sendDailySummaryTemplate({
            orgLabel: booking.propertyName ?? "your property",
            headline,
            statsLine,
          }, orgId);
        } catch {
          await sendWhatsAppText(text, orgId);
        }
      }
      // Only mark seen AFTER a successful send — if sendWhatsAppText throws
      // (transient WhatsApp/Meta failure), leave it unseen so the next run
      // (~2 min later) retries instead of silently losing the alert forever.
      await redisSet(key, "1", { exSeconds: SEEN_TTL_SECONDS });
      alerted.push({ bookingId: booking.id, guestName });

      await logAiActivity(
        {
          agentKey: AGENT_KEY,
          agentDisplayName: AGENT_NAME,
          task: "New booking alert",
          trigger: `New booking ${booking.id} synced (${guestName ?? "guest"}, ${booking.source || "Unknown"})`,
          dataReviewed: {
            bookingId: booking.id,
            arrival: booking.arrival,
            departure: booking.departure,
            source: booking.source,
            totalAmount: booking.totalAmount,
          },
          communicationSent: { channel: "whatsapp", to: "Seni", text },
          actionTaken: "Sent WhatsApp new-booking alert",
          result: "sent",
        },
        orgId
      );
    } catch (err) {
      errors.push({ bookingId: booking.id, error: err instanceof Error ? err.message : "Unknown error." });
    }
  }

  return { alerted, errors };
}
