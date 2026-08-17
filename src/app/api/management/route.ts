import { NextRequest, NextResponse, after } from "next/server";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { buildGuestsById, resolveGuestName } from "@/lib/guestName";
import { getAllPendingDrafts } from "@/lib/pendingDrafts";
import { listBookingOps, listTeamActivities } from "@/lib/teamActivities";
import { getSessionFromRequest } from "@/lib/session";
import { redisGet, redisSet } from "@/lib/redis";
import { PROPERTY_GROUP_COOKIE, DEFAULT_PROPERTY_GROUP_ID, normalizePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Proxy-contact detection (2026-08-16, Seni's ask). No OwnerRez field flags
// a channel relay/proxy, so only the reliably-detectable cases are labeled:
// relay EMAIL domains the OTAs use, and phone numbers carrying an extension
// (Vrbo/HomeAway's proxy style — real personal numbers don't have "ext").
// Anything unlabeled is, as far as the data can show, the guest's real
// contact info.
const PROXY_EMAIL_DOMAINS = [
  "guest.airbnb.com",
  "guests.airbnb.com",
  "reply.airbnb.com",
  "messages.homeaway.com",
  "messages.vrbo.com",
  "guest.booking.com",
  "mchat.booking.com",
];

function isProxyEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return PROXY_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function isProxyPhone(phone: string): boolean {
  return /ext|,|;|#\d/i.test(phone);
}

// Management-tab board data (2026-08-16): upcoming & in-house stays for the
// on-site team (cleaners, property manager, ...), each stay's ops notes,
// pending paid-extras signals, and the general team activity log. Read side
// of the Management tab — every logged-in role may read this (READ_ONLY
// included); writes go through /api/management/activities.
// Instant-load snapshot (2026-08-16, same pattern as the Messaging inbox):
// the board is served from a Redis snapshot immediately (single O(1) GET)
// while a background recompute refreshes it. ?fresh=1 skips the snapshot -
// the client calls that right after painting the cached copy, and after
// every note/flag write.
const SNAPSHOT_TTL_SECONDS = 6 * 60 * 60;

function snapshotKey(orgId: string, groupId: string): string {
  // Default group keeps the original key (existing warm snapshot stays valid).
  return groupId !== DEFAULT_PROPERTY_GROUP_ID ? `management:board:${orgId}:${groupId}` : `management:board:${orgId}`;
}

async function buildBoard(orgId: string, groupId: string) {
  const [bookings, guests, drafts, activities] = await Promise.all([
    getBookings(orgId, groupId),
    getGuests(orgId, groupId).catch(() => []),
    getAllPendingDrafts(orgId).catch(() => []),
    listTeamActivities(orgId).catch(() => []),
  ]);
  const guestsById = buildGuestsById(guests);
  const opsByBookingId = await listBookingOps(orgId).catch(() => new Map<number, never>());

  const todayMs = Date.now() - 24 * 60 * 60 * 1000;
  // BUG FIX (2026-08-16, Seni spotted a duplicate "Cesia Alvarado" on Legacy
  // Alva): cancelled bookings were never filtered out here (the Dashboard
  // tables always did). A guest who rebooks — e.g. Airbnb -> direct — leaves
  // a CANCELLED original alongside the live one, which reads as a duplicate.
  const upcoming = bookings
    .filter(
      (b) =>
        !b.isBlock &&
        b.status !== "Cancelled" &&
        b.departure &&
        new Date(b.departure).getTime() >= todayMs
    )
    .sort((a, b) => new Date(a.arrival || 0).getTime() - new Date(b.arrival || 0).getTime());

  const extrasByBookingId = new Set(
    drafts.filter((d) => d.isServiceRequest && d.status === "pending").map((d) => d.bookingId)
  );

  const notes = activities.filter((a) => a.kind === "note" && a.bookingId !== null);
  const log = activities.filter((a) => a.kind === "activity");

  // Calendar occupancy needs PAST stays too (2026-08-16, Seni: "so that I
  // can see what days were actually booked") — the stays list above is
  // deliberately upcoming/in-house only. Minimal fields, ~12 months back.
  const calendarWindowMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const calendarStays = bookings
    .filter(
      (b) =>
        !b.isBlock &&
        b.status !== "Cancelled" &&
        b.arrival &&
        b.departure &&
        new Date(b.departure).getTime() >= calendarWindowMs
    )
    .map((b) => ({
      bookingId: b.id,
      guestName: resolveGuestName(b, guestsById) || "Guest",
      arrival: b.arrival,
      departure: b.departure,
    }));

  return {
    calendarStays,
    stays: upcoming.map((b) => ({
      bookingId: b.id,
      guestName: resolveGuestName(b, guestsById) || "Guest",
      ...(() => {
        const g = b.guestId != null ? guestsById.get(b.guestId) : undefined;
        const phone = g?.phone || null;
        const email = g?.email || null;
        return {
          guestPhone: phone && isProxyPhone(phone) ? null : phone,
          guestPhoneProxy: Boolean(phone && isProxyPhone(phone)),
          guestEmail: email && isProxyEmail(email) ? null : email,
          guestEmailProxy: Boolean(email && isProxyEmail(email)),
        };
      })(),
      propertyName: b.propertyName,
      arrival: b.arrival,
      departure: b.departure,
      nights: b.nights,
      adults: b.adults,
      children: b.children,
      source: b.source,
      totalAmount: b.totalAmount,
      extrasRequested: extrasByBookingId.has(b.id),
      eventScheduled: opsByBookingId.get(b.id)?.eventScheduled ?? false,
      eventDate: opsByBookingId.get(b.id)?.eventDate ?? null,
      eventTime: opsByBookingId.get(b.id)?.eventTime ?? null,
      notes: notes
        .filter((n) => n.bookingId === b.id)
        .map((n) => ({ id: n.id, body: n.body, author: n.authorName || n.authorEmail, at: n.createdAt })),
    })),
    activityLog: log
      .slice(0, 100)
      .map((a) => ({ id: a.id, body: a.body, author: a.authorName || a.authorEmail, at: a.createdAt })),
  };
}

async function buildAndStore(orgId: string, groupId: string) {
  const board = await buildBoard(orgId, groupId);
  await redisSet(snapshotKey(orgId, groupId), JSON.stringify(board), { exSeconds: SNAPSHOT_TTL_SECONDS }).catch(() => {});
  return board;
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const orgId = session.organizationId;
  const groupId = normalizePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value);
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";

  try {
    if (!fresh) {
      const cached = await redisGet(snapshotKey(orgId, groupId)).catch(() => null);
      if (cached) {
        // Serve the snapshot instantly; refresh it in the background so the
        // client's follow-up ?fresh=1 (and the next visitor) get current data.
        after(buildAndStore(orgId, groupId).catch(() => {}));
        return NextResponse.json(JSON.parse(cached));
      }
    }
    return NextResponse.json(await buildAndStore(orgId, groupId));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/management failed:", message);
    // Last resort: even a failed FRESH build should serve the snapshot
    // rather than erroring — stale stays beat a "failed to fetch" banner.
    const cached = await redisGet(snapshotKey(orgId, groupId)).catch(() => null);
    if (cached) return NextResponse.json(JSON.parse(cached));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
