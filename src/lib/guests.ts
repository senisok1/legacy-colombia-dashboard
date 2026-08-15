import { getCrmRecordsByGuestIds } from "./store";
import type { Booking, Guest, GuestWithStats } from "./types";
import { isRevenueCounting } from "./finance";

/**
 * Merges raw OwnerRez guests + bookings with our locally-stored CRM notes/tags
 * into the single enriched view the Guests page and guest detail page use.
 * Guests are de-duplicated by email (falling back to full name) so the same
 * person booking through two different channels shows up as one CRM record.
 */
export async function buildGuestsWithStats(
  guests: Guest[],
  bookings: Booking[],
  organizationId?: string
): Promise<GuestWithStats[]> {
  const byKey = new Map<string, GuestWithStats>();

  const keyFor = (g: Guest) => (g.email ? g.email.toLowerCase() : `name:${g.fullName.toLowerCase()}`);

  // One batched query for every guest's notes/tags instead of one query per
  // guest in the loop below — see the comment on getCrmRecordsByGuestIds.
  // Phase 3 smoke-test finding (2026-08-05): this used to be called with no
  // organizationId, so a second tenant's Guests page would show real OwnerRez
  // guests (once ownerrez.ts's own org id is threaded through) but their
  // notes/tags would always be looked up against the DEFAULT org's
  // guest_notes rows — either silently empty or, worse, showing another
  // tenant's note if the numeric guestId happened to collide.
  const crmByGuestId = await getCrmRecordsByGuestIds(guests.map((g) => g.id), organizationId);

  for (const g of guests) {
    const key = keyFor(g);
    if (byKey.has(key)) continue;
    const crm = crmByGuestId.get(g.id);
    byKey.set(key, {
      ...g,
      bookings: [],
      totalStays: 0,
      totalNights: 0,
      lifetimeValue: 0,
      isRepeat: false,
      notes: crm?.notes ?? "",
      tags: crm?.tags ?? [],
    });
  }

  for (const b of bookings) {
    if (!b.guestId) continue;
    const guest = guests.find((g) => g.id === b.guestId);
    if (!guest) continue;
    const key = keyFor(guest);
    const record = byKey.get(key);
    if (!record) continue;
    record.bookings.push(b);
    if (isRevenueCounting(b)) {
      record.totalStays += 1;
      record.totalNights += b.nights || 0;
      record.lifetimeValue += b.totalAmount || 0;
    }
  }

  for (const record of byKey.values()) {
    record.bookings.sort((a, b) => a.arrival.localeCompare(b.arrival));
    const revenueBookings = record.bookings.filter(isRevenueCounting);
    record.firstStay = revenueBookings[0]?.arrival;
    record.lastStay = revenueBookings[revenueBookings.length - 1]?.arrival;
    record.isRepeat = revenueBookings.length > 1;
  }

  return Array.from(byKey.values()).sort(
    (a, b) => (b.lastStay ?? "").localeCompare(a.lastStay ?? "")
  );
}

export async function findGuestWithStats(
  guests: Guest[],
  bookings: Booking[],
  guestId: number,
  organizationId?: string
): Promise<GuestWithStats | undefined> {
  const all = await buildGuestsWithStats(guests, bookings, organizationId);
  const target = guests.find((g) => g.id === guestId);
  if (!target) return undefined;
  const key = target.email ? target.email.toLowerCase() : `name:${target.fullName.toLowerCase()}`;
  return all.find((g) => (g.email ? g.email.toLowerCase() : `name:${g.fullName.toLowerCase()}`) === key);
}
