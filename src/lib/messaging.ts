import { addDays, isPast, isToday, parseISO } from "date-fns";
import { formatDate } from "./format";
import type { Booking, MessageLogEntry, MessageTemplate } from "./types";

export type SuggestedMessage = {
  key: string; // bookingId + templateId, used for dedupe / React keys
  booking: Booking;
  template: MessageTemplate;
  dueDate: string; // ISO date this message should go out
  isOverdue: boolean;
  alreadyLogged: boolean;
};

const ACTIVE_BOOKING_STATUSES = new Set(["Booked", "Checked In", "Checked Out"]);

function anchorDate(booking: Booking, template: MessageTemplate): Date | null {
  if (!booking.arrival || !booking.departure) return null;
  if (template.trigger === "post_stay_review") return parseISO(booking.departure);
  if (template.trigger === "check_in") return parseISO(booking.arrival);
  if (template.trigger === "pre_arrival") return parseISO(booking.arrival);
  return null; // manual templates have no automatic due date
}

export function computeSuggestedMessages(
  bookings: Booking[],
  templates: MessageTemplate[],
  log: MessageLogEntry[]
): SuggestedMessage[] {
  const loggedKeys = new Set(log.map((m) => `${m.bookingId}:${m.templateId ?? ""}`));
  const suggestions: SuggestedMessage[] = [];

  for (const booking of bookings) {
    if (!ACTIVE_BOOKING_STATUSES.has(booking.status)) continue;

    for (const template of templates) {
      if (!template.active || template.trigger === "manual") continue;
      const anchor = anchorDate(booking, template);
      if (!anchor) continue;

      const due = addDays(anchor, template.daysOffset);
      // Only surface things due within the next 14 days (or already overdue
      // within the last 3 days) so the list stays focused and actionable.
      const daysFromNow = Math.round((+due - Date.now()) / 86400000);
      if (daysFromNow > 14 || daysFromNow < -3) continue;

      const key = `${booking.id}:${template.id}`;
      suggestions.push({
        key,
        booking,
        template,
        dueDate: due.toISOString().slice(0, 10),
        isOverdue: isPast(due) && !isToday(due),
        alreadyLogged: loggedKeys.has(key),
      });
    }
  }

  return suggestions.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function mergeFields(
  body: string,
  booking: Booking,
  guestFirstName?: string
): string {
  return body
    .replaceAll("{{guest_first_name}}", guestFirstName || booking.guestName?.split(" ")[0] || "there")
    .replaceAll("{{guest_name}}", booking.guestName || "Guest")
    .replaceAll("{{arrival_date}}", formatDate(booking.arrival))
    .replaceAll("{{departure_date}}", formatDate(booking.departure))
    .replaceAll("{{property_name}}", booking.propertyName || "Legacy Colombia");
}
