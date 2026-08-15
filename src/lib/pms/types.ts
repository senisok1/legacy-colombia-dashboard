// The PMS abstraction layer's contract. Every capability the app currently
// gets from OwnerRez (src/lib/ownerrez.ts) is declared here as a formal
// TypeScript interface, so:
//   1. lib/ownerrez.ts's implementation is checked against this shape
//      (assembled as `ownerRezProvider` at the bottom of that file) — if a
//      future edit there breaks the contract, tsc catches it immediately.
//   2. A future PMS (Hostaway, or eventually pulling directly from each OTA's
//      own API) is a drop-in: write a new module that implements
//      PmsProvider, register it in pms/registry.ts, and every feature that
//      goes through the registry keeps working with zero changes.
//
// Scope note (2026-08-05): this interface + the OwnerRez adapter satisfying
// it now exist and are enforced by the type system, but the ~30 existing
// call sites across the app still import individual named functions
// directly from lib/ownerrez.ts rather than going through
// getPmsProvider() — there's no value in migrating them today since only one
// adapter exists, and every one of those functions already accepts the same
// organizationId parameter this interface uses. When a second adapter
// actually ships, that's the natural time to also switch lib/ownerrez.ts's
// exported functions (and/or the call sites themselves) to resolve through
// the registry instead of calling their own implementation directly.
import type { Booking, Guest, Property, Review, ThreadMessage } from "../types";

export type PmsConnectionStatus = { ok: boolean; message: string };

export type PmsSendMessageResult = { id?: number; dateUtc?: string };

export interface PmsProvider {
  /** Short machine-readable id — "ownerrez" today, "hostaway" etc. later. */
  readonly id: string;

  getTargetProperty(organizationId?: string): Promise<Property>;
  getTargetProperties(organizationId?: string): Promise<Property[]>;

  getBookings(organizationId?: string): Promise<Booking[]>;

  getGuests(organizationId?: string): Promise<Guest[]>;
  getGuestById(id: number, organizationId?: string): Promise<Guest | undefined>;

  getReviews(organizationId?: string): Promise<Review[]>;

  getThreadMessages(threadId: number, organizationId?: string): Promise<ThreadMessage[]>;
  sendMessage(threadId: number, body: string, organizationId?: string): Promise<PmsSendMessageResult>;

  getQuotedNightlyRateCents(date: string, organizationId?: string): Promise<number | null>;

  testConnection(organizationId?: string): Promise<PmsConnectionStatus>;
}
