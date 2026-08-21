import type { Booking, Guest } from "./types";
import { getGuestById } from "./ownerrez";

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
 * Self-heals guestsById for whichever bookings would otherwise still fall
 * back to "Guest" (2026-08-21, Seni: "the new booking that just came in is
 * just showing 'guest' and not name. Please fix once and for all!") — the
 * getGuests() batch join (ownerrez.ts) is cached for 60s and already retries
 * once on a transient failure, but a genuinely BRAND NEW booking's guest
 * record can still be unresolvable within that same cache cycle (OwnerRez
 * hasn't finished propagating it yet), and the fix would otherwise only show
 * up on the NEXT 60s cache cycle. This does one bounded, direct /guests/{id}
 * lookup — via the same getGuestById() bookingAlerts.ts already used for
 * this exact self-heal on the WhatsApp/email alert text — for only the
 * handful of bookings actually missing a name, so a page load can resolve
 * the real name THIS request instead of waiting out the cache. No-op (zero
 * extra requests) for the overwhelmingly common case where every booking
 * already has a name.
 */
export async function selfHealGuestsById(
  bookings: Pick<Booking, "guestName" | "guestId">[],
  guestsById: Map<number, Guest>,
  organizationId?: string
): Promise<Map<number, Guest>> {
  const missingIds = Array.from(
    new Set(
      bookings
        .filter((b) => !b.guestName?.trim() && b.guestId != null && !guestsById.get(b.guestId)?.fullName?.trim())
        .map((b) => b.guestId as number)
    )
  );
  if (missingIds.length === 0) return guestsById;
  const fetched = await Promise.all(missingIds.map((id) => getGuestById(id, organizationId).catch(() => undefined)));
  const merged = new Map(guestsById);
  fetched.forEach((g, i) => {
    if (g) merged.set(missingIds[i], g);
  });
  return merged;
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
