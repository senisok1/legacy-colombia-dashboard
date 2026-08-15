import type { Booking, Guest } from "./types";

/**
 * OwnerRez's /v2/bookings response very often doesn't include a usable
 * guest name field at all (it's meant to be joined against /v2/guests by
 * guest_id) — which is why booking.guestName alone showed up blank
 * ("Guest") in the Inbox, even though the same guests display correctly
 * elsewhere in this app (Dashboard, Guests page) wherever the code already
 * does this join. This is the single shared place that join happens now.
 */
export function resolveGuestName(booking: Pick<Booking, "guestName" | "guestId">, guestsById: Map<number, Guest>): string {
  if (booking.guestName?.trim()) return booking.guestName.trim();
  if (booking.guestId != null) {
    const guest = guestsById.get(booking.guestId);
    if (guest?.fullName?.trim()) return guest.fullName.trim();
  }
  return "Guest";
}

export function buildGuestsById(guests: Guest[]): Map<number, Guest> {
  return new Map(guests.map((g) => [g.id, g]));
}

/**
 * Resolves a guest's phone/WhatsApp number the same way resolveGuestName
 * resolves their name — joined from the Guest record via guestId, since
 * Booking itself doesn't carry a phone field. Used to surface the guest's
 * number to Seni when a service-request draft needs it (see
 * lib/aiReply.ts's isServiceRequest) so he can paste it straight into a
 * WhatsApp group. Returns undefined rather than a placeholder string when
 * there's nothing on file, so callers can tell "no phone" apart from "".
 */
export function resolveGuestPhone(booking: Pick<Booking, "guestId">, guestsById: Map<number, Guest>): string | undefined {
  if (booking.guestId == null) return undefined;
  const guest = guestsById.get(booking.guestId);
  const phone = guest?.phone?.trim();
  return phone || undefined;
}
