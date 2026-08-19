// Balance-due WhatsApp alerts to Geo (2026-08-19, Seni's ask: "create
// whatsapp alerts to be sent to Geo for all properties when there is an
// amount / balance still due 60 days prior to stay and 30 days prior to
// stay").
//
// Runs from api/cron/balance-due once a day, across ALL property groups —
// deliberately NOT AUTOMATION_PROPERTY_GROUPS (the 2026-08-18 pullback
// scoped guest-facing automation to Legacy Colombia; this is an internal
// alert to a team member, and Seni's ask for it was explicitly "for all
// properties").
//
// Balance owed is computed live from getBookings() fields, exactly the same
// one-liner as api/management's stay cards (totalAmount - totalPaid) — never
// stored, so it can't drift; a payment recorded in OwnerRez this morning is
// reflected by tonight's run. Bookings whose totalPaid OwnerRez doesn't
// report are skipped (can't claim a balance is due without knowing what was
// paid).
//
// Two milestones per booking, each firing AT MOST ONCE (Redis seen-keys,
// same pattern as bookingAlerts.ts):
//   60: fires when arrival is 31–60 days out and a balance remains
//   30: fires when arrival is  1–30 days out and a balance remains
// Window semantics (≤60, not ==60) mean a booking created 45 days before
// arrival still gets its 60-day alert on the next run rather than never.
// A booking paid off before a milestone's window simply never fires that
// milestone. Seen-keys are only written AFTER a successful send, so a Meta
// hiccup (or the template still pending approval, with Geo's 24h free-text
// window shut) retries on the next daily run instead of silently losing the
// alert.
import { redisGet, redisSet } from "@/lib/redis";
import { sendBalanceDueTemplate, sendWhatsAppTextTo } from "@/lib/whatsapp";
import { logAiActivity } from "@/lib/aiActivity";
import { resolveGuestName, buildGuestsById } from "@/lib/guestName";
import type { Booking } from "@/lib/types";

const AGENT_KEY = "guest_experience";
const AGENT_NAME = "AI Guest Experience Manager";

// Outlives any horizon this feature looks at (milestone windows only reach
// 60 days ahead), so a booking can never fall out of the seen-set and
// re-alert.
const SEEN_TTL_SECONDS = 400 * 24 * 60 * 60;

type Milestone = 60 | 30;

function seenKey(orgId: string, bookingId: number, milestone: Milestone): string {
  return `balance-due-alert:${orgId}:${bookingId}:${milestone}`;
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Whole days from now until the arrival date (UTC-midnight based, matching
 * how OwnerRez reports arrival as a date, not a timestamp). Negative =
 * already arrived. */
function daysUntil(arrivalIso: string): number {
  const arrival = new Date(arrivalIso);
  if (Number.isNaN(arrival.getTime())) return NaN;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((arrival.getTime() - Date.now()) / msPerDay);
}

function milestoneFor(days: number): Milestone | null {
  if (days >= 1 && days <= 30) return 30;
  if (days >= 31 && days <= 60) return 60;
  return null;
}

export async function checkBalanceDueAlerts(
  bookings: Booking[],
  guestsById: ReturnType<typeof buildGuestsById>,
  orgId: string,
  recipient: { phone: string; name: string },
  propertyLabel: string
): Promise<{
  alerted: { bookingId: number; guestName?: string | null; milestone: Milestone; owed: number }[];
  errors: { bookingId: number; error: string }[];
}> {
  const alerted: { bookingId: number; guestName?: string | null; milestone: Milestone; owed: number }[] = [];
  const errors: { bookingId: number; error: string }[] = [];

  for (const booking of bookings) {
    if (booking.isBlock || booking.status === "Cancelled") continue;
    if (!booking.arrival) continue;
    // Can't assert a balance is due without OwnerRez reporting what was paid.
    if (typeof booking.totalPaid !== "number" || typeof booking.totalAmount !== "number") continue;

    const owed = Math.round((booking.totalAmount - booking.totalPaid) * 100) / 100;
    if (owed <= 0.01) continue;

    const days = daysUntil(booking.arrival);
    const milestone = milestoneFor(days);
    if (milestone === null) continue;

    const key = seenKey(orgId, booking.id, milestone);
    if (await redisGet(key)) continue;

    try {
      const guestName = resolveGuestName(booking, guestsById);
      const propertyName = booking.propertyName || propertyLabel;
      const arrival = formatDate(booking.arrival);
      const amountDue = formatMoney(owed);
      const daysOut = `${days} day${days === 1 ? "" : "s"}`;

      try {
        await sendBalanceDueTemplate(
          {
            to: recipient.phone,
            guestName: guestName ?? "Guest",
            propertyName,
            arrival,
            daysOut,
            amountDue,
          },
          orgId
        );
      } catch {
        // Template not approved yet (or transient template failure) — best
        // effort free text, deliverable only if Geo's 24h session window is
        // open. If THIS also throws, the outer catch leaves the seen-key
        // unwritten and tomorrow's run retries.
        await sendWhatsAppTextTo(
          recipient.phone,
          `💰 Balance due — ${guestName ?? "Guest"} at ${propertyName}\n` +
            `Arrival: ${arrival} (${daysOut} away)\n` +
            `Still owed: ${amountDue}\n\n` +
            `Check OwnerRez to collect before the stay.`,
          orgId
        );
      }

      await redisSet(key, "1", { exSeconds: SEEN_TTL_SECONDS });
      alerted.push({ bookingId: booking.id, guestName, milestone, owed });

      await logAiActivity(
        {
          agentKey: AGENT_KEY,
          agentDisplayName: AGENT_NAME,
          task: `Balance-due alert (${milestone}-day)`,
          trigger: `Booking ${booking.id} arrives in ${days} days with ${amountDue} still owed`,
          dataReviewed: {
            bookingId: booking.id,
            arrival: booking.arrival,
            totalAmount: booking.totalAmount,
            totalPaid: booking.totalPaid,
            owed,
            milestone,
          },
          communicationSent: {
            channel: "whatsapp",
            to: recipient.name,
            text: `${guestName ?? "Guest"} — ${propertyName} — ${arrival} — ${amountDue} due`,
          },
          actionTaken: `Sent ${milestone}-day balance-due WhatsApp alert to ${recipient.name}`,
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
