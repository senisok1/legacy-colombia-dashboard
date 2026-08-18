import { unstable_cache } from "next/cache";
import { config, isRedisConfigured } from "./config";
import { propertyGroupById, DEFAULT_PROPERTY_GROUP_ID } from "./propertyGroups";
import { demoBookings, demoGuests, demoProperty, demoReviews } from "./demoData";
import type { Booking, BookingStatus, Guest, Property, Review, ThreadMessage } from "./types";
import { getDefaultOrganizationId } from "./organizations";
import { getOwnerRezCredentials, type OwnerRezCredentials } from "./credentials";
import type { PmsProvider } from "./pms/types";
import { redisGet, redisSet } from "./redis";
import { markCrmSentReply } from "./adminReplyMarkers";
import { ownerRezQueue } from "./ownerrez-queue";

const API_BASE = "https://api.ownerrez.com/v2";

class OwnerRezApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OwnerRezApiError";
    this.status = status;
  }
}

// ---------- Phase 3: per-tenant credential resolution ----------
// Every exported read/write function below takes an OPTIONAL organizationId
// as its last parameter. Omitting it (every call site in the app today)
// resolves to the pre-existing single customer's org via
// getDefaultOrganizationId() — i.e. byte-for-byte the same behavior as
// before this change, using the same credentials (which, since Phase 1's
// backfill, live in the encrypted organization_credentials table AND still
// fall back to the global config.* env vars if that table has no row).
// Passing a real organizationId (once a route resolves one from the logged-in
// session) makes that call fetch/act on THAT organization's own OwnerRez
// account instead. This keeps the migration purely additive — nothing here
// changes what the existing app calling these functions with zero arguments
// gets back today.
//
// Why this matters for unstable_cache specifically: Next.js's Data Cache
// keys a cached function's result by the ARGUMENTS it was called with, not
// by anything read from ambient state inside the function body. A version of
// this file that read "which org" from some other module-global would cache
// one org's result and silently serve it to every other org for the
// revalidate window — a real cross-tenant data leak, not just a design
// smell. Making organizationId an explicit parameter on every
// unstable_cache-wrapped function below is what makes the cache key vary
// correctly per tenant once real per-tenant calls start happening (Phase 3
// continues call-site by call-site from here).
// Fully defensive on purpose: this now sits in front of every single
// OwnerRez call the app makes (bookings, guests, reviews, messaging, rate
// quotes — everything), almost always still called with no organizationId
// (every pre-Phase-3 call site). Before this file existed, those call sites
// never touched the database at all — just plain env var reads. Since the
// DB is now consulted first (to check for a per-org override), any DB
// hiccup — a transient Neon blip in production, or simply no real
// DATABASE_URL in a local/dev environment — must never take down the
// dashboard's OwnerRez integration the way it never could before. Falls
// all the way back to the raw global config.* values on any failure at any
// step (org lookup or credential lookup), which is exactly what every
// existing call site got before Phase 1/3 existed.
async function resolveOwnerRezCredentials(organizationId?: string): Promise<OwnerRezCredentials> {
  const fallback: OwnerRezCredentials = {
    email: config.ownerRezEmail,
    token: config.ownerRezToken,
    propertyName: config.propertyName,
    propertyId: config.propertyId,
    additionalPropertyIds: config.additionalPropertyIds,
    oauthClientId: config.ownerRezOAuthClientId,
    oauthClientSecret: config.ownerRezOAuthClientSecret,
    oauthToken: config.ownerRezOAuthToken,
  };
  try {
    const orgId = organizationId ?? (await getDefaultOrganizationId());
    return await getOwnerRezCredentials(orgId);
  } catch (err) {
    console.error("[ownerrez] Falling back to global config credentials:", err);
    return fallback;
  }
}

function isLive(creds: OwnerRezCredentials): boolean {
  return Boolean(creds.email && creds.token);
}

function authHeader(creds: OwnerRezCredentials): string {
  const raw = `${creds.email}:${creds.token}`;
  const encoded = Buffer.from(raw, "utf-8").toString("base64");
  return `Basic ${encoded}`;
}

async function orFetch<T>(
  path: string,
  searchParams: Record<string, string | number | undefined> | undefined,
  creds: OwnerRezCredentials
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  // All OwnerRez API calls go through a request queue to enforce 1 req/sec rate limit.
  // Deployed 2026-08-06 as Priority 4 fix for 429 rate-limit collisions.
  const res = await ownerRezQueue.enqueue(() =>
    fetch(url.toString(), {
      headers: {
        Authorization: authHeader(creds),
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": config.userAgent,
      },
      // OwnerRez data changes frequently; always get fresh data.
      cache: "no-store",
    })
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OwnerRezApiError(
      `OwnerRez API ${path} returned ${res.status}: ${body.slice(0, 300)}`,
      res.status
    );
  }

  return (await res.json()) as T;
}

/**
 * Generic paginated fetch. OwnerRez's v2 list endpoints return
 * { items: [...], limit, offset, total_count } (or similarly-shaped paging info).
 * This walks all pages defensively, tolerating a couple of possible shapes.
 */
async function orFetchAllPages<Raw>(
  path: string,
  baseParams: Record<string, string | number | undefined>,
  creds: OwnerRezCredentials
): Promise<Raw[]> {
  const pageSize = 100;
  let offset = 0;
  const all: Raw[] = [];

  for (let page = 0; page < 100; page++) {
    // hard safety cap of 100 pages (10k records) to avoid runaway loops
    const data = await orFetch<Record<string, unknown>>(
      path,
      {
        ...baseParams,
        limit: pageSize,
        offset,
      },
      creds
    );

    const items = (data.items ?? data.results ?? data.data ?? []) as Raw[];
    all.push(...items);

    const totalCount = (data.total_count ?? data.totalCount) as number | undefined;
    if (items.length < pageSize) break;
    if (typeof totalCount === "number" && all.length >= totalCount) break;

    offset += pageSize;
  }

  return all;
}

// ---------- Normalizers ----------
// These read a few plausible field-name variants defensively. If your account's
// API responses use different field names than expected, adjust the `pick()`
// calls below — everything downstream uses the normalized types in lib/types.ts.

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function normalizeProperty(raw: Record<string, unknown>): Property {
  return {
    id: Number(pick(raw, "id", "property_id")),
    name: String(pick(raw, "name", "internal_name", "display_name") ?? "Unnamed property"),
    address: pick(raw, "address", "address1") as string | undefined,
    city: pick(raw, "city") as string | undefined,
    state: pick(raw, "state", "province") as string | undefined,
    country: pick(raw, "country") as string | undefined,
    active: Boolean(pick(raw, "active", "is_active") ?? true),
    raw,
  };
}

function normalizeStatus(value: unknown): BookingStatus {
  const s = String(value ?? "").toLowerCase();
  // OwnerRez API v2's actual BookingStatus enum is just active/canceled/pending.
  if (s === "active") return "Booked";
  if (s === "pending") return "Hold";
  if (s === "canceled" || s.includes("cancel")) return "Cancelled";
  // Older/looser strings some accounts or the legacy v1 API may return.
  if (s.includes("checked in") || s.includes("checkedin")) return "Checked In";
  if (s.includes("checked out") || s.includes("checkedout")) return "Checked Out";
  if (s.includes("hold")) return "Hold";
  if (s.includes("quote")) return "Quote";
  if (s.includes("inquiry")) return "Inquiry";
  if (s.includes("book")) return "Booked";
  return "Unknown";
}

function normalizeBooking(raw: Record<string, unknown>, propertyName?: string): Booking {
  const arrival = String(pick(raw, "arrival", "checkin", "check_in", "start_date") ?? "");
  const departure = String(pick(raw, "departure", "checkout", "check_out", "end_date") ?? "");
  const nights =
    Number(pick(raw, "nights", "num_nights")) ||
    (arrival && departure
      ? Math.max(1, Math.round((+new Date(departure) - +new Date(arrival)) / 86400000))
      : 0);
  const guestFirst = pick(raw, "guest_first_name", "first_name") as string | undefined;
  const guestLast = pick(raw, "guest_last_name", "last_name") as string | undefined;
  const guestDisplay = pick(raw, "guest_name", "display_name") as string | undefined;

  return {
    id: Number(pick(raw, "id", "booking_id")),
    propertyId: Number(pick(raw, "property_id", "property")),
    propertyName,
    guestId: (pick(raw, "guest_id") as number | undefined) ?? null,
    guestName: guestDisplay || [guestFirst, guestLast].filter(Boolean).join(" ") || undefined,
    arrival,
    departure,
    nights,
    status: normalizeStatus(pick(raw, "status", "booking_status")),
    source: String(pick(raw, "source", "site", "listing_site") ?? "Direct"),
    adults: Number(pick(raw, "adults", "num_adults") ?? 0),
    children: Number(pick(raw, "children", "num_children") ?? 0),
    // Gross — what the guest is charged (rent + fees + tax). Confirmed
    // against a live booking's raw payload: OwnerRez v2 names this
    // `total_amount` (matches `total_paid` once fully paid).
    totalAmount: Number(pick(raw, "total_amount", "total", "amount") ?? 0),
    // OwnerRez v2's actual field is `total_host_fees` — channel/OwnerRez fees
    // deducted before the host gets paid. Net payout = totalAmount - hostFee
    // (computed on demand in lib/finance.ts's netAmount(), not stored here,
    // so it can never drift out of sync with totalAmount).
    hostFee: Number(pick(raw, "total_host_fees", "host_fee", "commission") ?? 0),
    createdAt: pick(raw, "created_utc", "created_at") as string | undefined,
    updatedAt: pick(raw, "updated_utc", "updated_at") as string | undefined,
    // OwnerRez v2 "type" is one of booking/block/quote_hold/linked_availability/owner.
    // Blocks are calendar holds (often from channel iCal sync) with no real guest.
    isBlock: Boolean(pick(raw, "is_block")) || String(pick(raw, "type") ?? "") === "block",
    threadIds: Array.isArray(raw["thread_ids"]) ? (raw["thread_ids"] as number[]) : [],
    raw,
  };
}

type EmailAddressEntry = { address?: string; is_default?: boolean };
type PhoneEntry = { number?: string; is_default?: boolean };
type AddressEntry = { city?: string; state?: string; province?: string; country?: string; is_default?: boolean };

function pickDefault<T extends { is_default?: boolean }>(entries: T[] | undefined): T | undefined {
  if (!entries || entries.length === 0) return undefined;
  return entries.find((e) => e.is_default) ?? entries[0];
}

function normalizeGuest(raw: Record<string, unknown>): Guest {
  const first = String(pick(raw, "first_name", "firstname") ?? "");
  const last = String(pick(raw, "last_name", "lastname") ?? "");
  const display = pick(raw, "display_name", "name") as string | undefined;

  // OwnerRez v2's GuestModel nests contact info as arrays
  // (email_addresses[].address, phones[].number, addresses[].city/state/country)
  // rather than flat fields — fall back to flat fields for other API versions.
  const emailEntry = pickDefault(raw["email_addresses"] as EmailAddressEntry[] | undefined);
  const phoneEntry = pickDefault(raw["phones"] as PhoneEntry[] | undefined);
  const addressEntry = pickDefault(raw["addresses"] as AddressEntry[] | undefined);

  return {
    id: Number(pick(raw, "id", "guest_id")),
    firstName: first,
    lastName: last,
    fullName: display || `${first} ${last}`.trim() || "Unknown guest",
    email: emailEntry?.address ?? (pick(raw, "email", "primary_email") as string | undefined),
    phone: phoneEntry?.number ?? (pick(raw, "phone", "primary_phone", "mobile") as string | undefined),
    city: addressEntry?.city ?? (pick(raw, "city") as string | undefined),
    state: addressEntry?.state ?? addressEntry?.province ?? (pick(raw, "state") as string | undefined),
    country: addressEntry?.country ?? (pick(raw, "country") as string | undefined),
    raw,
  };
}

function normalizeReview(raw: Record<string, unknown>): Review {
  // Confirmed against a real response 2026-08-01 (109 real reviews came
  // back): OwnerRez's actual field names are `listing_site` (Airbnb/Vrbo/
  // etc — not `source`/`site`, which don't exist on the real payload) and
  // `stars` (not `rating`/`score`). Every review that came back before this
  // fix silently normalized to source "Unknown" and rating undefined — this
  // function was built early on and never wired into a real feature, so the
  // bug sat unnoticed. Also carries property_id/host `response` text/
  // `visible` through now, since Reputation Manager needs all three (scope
  // reviews to Legacy Colombia specifically — this account manages 8
  // properties, same issue getGuests()/getBookings() already solved for —
  // and tell "host already replied" apart from "needs a response").
  return {
    id: Number(pick(raw, "id", "review_id")),
    bookingId: pick(raw, "booking_id") as number | undefined,
    propertyId: pick(raw, "property_id") as number | undefined,
    guestName: (pick(raw, "display_name", "guest_name", "reviewer_name") as string | undefined) ?? undefined,
    source: String(pick(raw, "listing_site", "source", "site") ?? "Unknown"),
    rating: pick(raw, "stars", "rating", "score") as number | undefined,
    comment: pick(raw, "body", "comment", "text") as string | undefined,
    hostResponse: pick(raw, "response") as string | undefined,
    visible: pick(raw, "visible") as boolean | undefined,
    createdAt: pick(raw, "created_utc", "created_at", "date") as string | undefined,
    raw,
  };
}

// ---------- Public API ----------

async function fetchTargetProperty(organizationId?: string): Promise<Property> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!isLive(creds)) return demoProperty;

  if (creds.propertyId) {
    const raw = await orFetch<Record<string, unknown>>(`/properties/${creds.propertyId}`, undefined, creds);
    return normalizeProperty(raw);
  }

  const items = await orFetchAllPages<Record<string, unknown>>("/properties", {}, creds);
  const properties = items.map(normalizeProperty);
  const match =
    properties.find((p) => p.name.toLowerCase() === creds.propertyName.toLowerCase()) ??
    properties.find((p) => p.name.toLowerCase().includes(creds.propertyName.toLowerCase()));

  if (!match) {
    throw new OwnerRezApiError(
      `No property found matching "${creds.propertyName}". Set OWNERREZ_PROPERTY_ID or OWNERREZ_PROPERTY_NAME (or the equivalent stored credential) to match a property in your OwnerRez account. Properties found: ${properties.map((p) => p.name).join(", ") || "(none)"}`
    );
  }

  return match;
}

// Every page (Dashboard, Guests, Messaging, Reports) independently called
// getBookings()/getGuests()/getTargetProperty() on every navigation with no
// caching (`cache: "no-store"` on every underlying fetch, plus each of these
// paginates 100 records at a time) — so switching tabs meant several
// sequential round trips to OwnerRez's API from scratch every single click.
// Wrapping the three expensive reads in Next's unstable_cache with a short
// revalidate window means consecutive navigations within that window reuse
// the same data instead of re-fetching, while still refreshing often enough
// that new bookings/guests show up quickly. This is Vercel's Data Cache, so
// (unlike a plain in-memory variable) it actually persists across separate
// serverless invocations, not just within one warm container.
export const getTargetProperty = unstable_cache(fetchTargetProperty, ["ownerrez-target-property"], {
  revalidate: 300, // property details essentially never change
});

// Fetches config.additionalPropertyIds directly by ID (no name-matching
// needed since these are already known IDs). A bad/renamed/inaccessible ID
// is logged and skipped rather than breaking the whole dashboard — see
// config.ts's comment on additionalPropertyIds for why these exist (e.g.
// "Nukak - Casa #19", a second Airbnb listing for the same physical villa).
async function fetchAdditionalProperties(creds: OwnerRezCredentials): Promise<Property[]> {
  const results: Property[] = [];
  for (const id of creds.additionalPropertyIds) {
    try {
      const raw = await orFetch<Record<string, unknown>>(`/properties/${id}`, undefined, creds);
      results.push(normalizeProperty(raw));
    } catch (err) {
      console.error(`OwnerRez: failed to load additional property ${id}:`, err);
    }
  }
  return results;
}

// Every OwnerRez property record that should be treated as part of this
// villa's single combined CRM view: the primary property (resolved by
// config.propertyId/propertyName) plus config.additionalPropertyIds. Every
// other data read below (bookings, guests derived from them, reviews) merges
// across this full set, so it doesn't matter which listing a guest actually
// booked or messaged through — the dashboard shows one combined picture.
async function fetchTargetProperties(organizationId?: string, propertyGroupId?: string): Promise<Property[]> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!isLive(creds)) return [demoProperty];

  // Property-group switching (2026-08-16): non-default groups resolve by
  // case-insensitive name match against the account's full property list
  // (e.g. "Legacy Alva" -> "Legacy Alva Waterfront Farm Estate Pool,
  // Theater, Kayaks"). The default group keeps the original config-driven
  // resolution below untouched.
  const group = propertyGroupById(propertyGroupId);
  if (group.id !== DEFAULT_PROPERTY_GROUP_ID && group.nameMatch) {
    const items = await orFetchAllPages<Record<string, unknown>>("/properties", {}, creds);
    const needle = group.nameMatch.toLowerCase();
    const matches = items
      .map(normalizeProperty)
      .filter((prop) => prop.name.toLowerCase().includes(needle));
    if (matches.length === 0) {
      throw new OwnerRezApiError(
        `No OwnerRez property matches "${group.nameMatch}" for the ${group.label} view.`
      );
    }
    return matches;
  }

  const primary = await getTargetProperty(organizationId);
  const additional = await fetchAdditionalProperties(creds);

  const seen = new Set<number>([primary.id]);
  const all = [primary];
  for (const p of additional) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      all.push(p);
    }
  }
  return all;
}

// Diagnosed 2026-08-05: OwnerRez rate-limiting this account (429 on
// /properties, e.g. from unrelated heavy dashboard/badge-polling traffic —
// see NavBar.tsx's APPROVALS_BADGE_POLL_MS comment) used to be a total
// outage for every OwnerRez-backed feature at once, INCLUDING
// api/cron/check-messages, since a thrown error here propagates straight up
// through getBookings()/getGuests() with nothing to fall back to. Property
// data is essentially static (id/name/address), so serving a slightly stale
// copy on a transient OwnerRez failure is always safe and far better than a
// hard failure. This Redis fallback is intentionally separate from (and
// longer-lived than) the unstable_cache above: unstable_cache's 300s
// revalidate window is for keeping data reasonably fresh in the happy path,
// this is purely a last-resort safety net for when OwnerRez itself is
// erroring, with a 7-day TTL since a week-old property list is still
// infinitely more useful than a crash.
const TARGET_PROPERTIES_FALLBACK_KEY = "ownerrez:target-properties-fallback";
const TARGET_PROPERTIES_FALLBACK_TTL_SECONDS = 7 * 24 * 60 * 60;

function targetPropertiesFallbackKeyFor(propertyGroupId?: string): string {
  // Default group keeps the ORIGINAL key so the existing warm fallback
  // stays valid; other groups get their own namespaced copy.
  return propertyGroupId && propertyGroupId !== DEFAULT_PROPERTY_GROUP_ID
    ? `${TARGET_PROPERTIES_FALLBACK_KEY}:${propertyGroupId}`
    : TARGET_PROPERTIES_FALLBACK_KEY;
}

async function fetchTargetPropertiesWithFallback(organizationId?: string, propertyGroupId?: string): Promise<Property[]> {
  const fallbackKey = targetPropertiesFallbackKeyFor(propertyGroupId);
  try {
    const properties = await fetchTargetProperties(organizationId, propertyGroupId);
    if (isRedisConfigured()) {
      await redisSet(fallbackKey, JSON.stringify(properties), {
        exSeconds: TARGET_PROPERTIES_FALLBACK_TTL_SECONDS,
      }).catch(() => {}); // best-effort — never let a Redis hiccup break the happy path
    }
    return properties;
  } catch (err) {
    if (isRedisConfigured()) {
      try {
        const raw = await redisGet(fallbackKey);
        if (raw) {
          console.error(
            "[ownerrez] getTargetProperties failed live, serving Redis fallback copy:",
            err instanceof Error ? err.message : err
          );
          return JSON.parse(raw) as Property[];
        }
      } catch (fallbackErr) {
        console.error("[ownerrez] Redis fallback for getTargetProperties also failed:", fallbackErr);
      }
    }
    throw err;
  }
}

export const getTargetProperties = unstable_cache(
  fetchTargetPropertiesWithFallback,
  ["ownerrez-target-properties"],
  { revalidate: 300 }
);

// INCIDENT 2026-08-07: the daily 5:10am ET executive-report cron came back
// with every metric genuinely zero two mornings in a row (real occupancy,
// revenue, etc. were fine minutes/hours later on the live dashboard) — root
// cause was a transient OwnerRez failure during the cron's window causing
// fetchBookingsForProperty's catch branch below to return [] for a property,
// which silently looks IDENTICAL to "this property really has zero
// bookings" to every caller (buildExecutiveReport, the AI COO briefing,
// etc.). Worse, getCooBriefing.ts caches its narrative for ~20h/day, so one
// bad transient fetch produced a false "business is dead" summary that
// outlived the outage by many hours. Fixed the same way
// fetchTargetPropertiesWithFallback already handles this for /properties:
// cache the last known-good non-empty result per property in Redis and
// serve that instead of a hard empty array when the live fetch throws. A
// slightly-stale bookings snapshot is always safer for reporting purposes
// than a fabricated "zero" that gets treated as verified fact downstream.
const BOOKINGS_FALLBACK_KEY_PREFIX = "ownerrez:bookings-fallback:";
const BOOKINGS_FALLBACK_TTL_SECONDS = 24 * 60 * 60;

function bookingsFallbackKey(propertyId: number, organizationId?: string): string {
  return `${BOOKINGS_FALLBACK_KEY_PREFIX}${organizationId ?? "default"}:${propertyId}`;
}

async function fetchBookingsForProperty(
  propertyId: number,
  propertyName: string,
  creds: OwnerRezCredentials,
  organizationId?: string
): Promise<Booking[]> {
  const fallbackKey = bookingsFallbackKey(propertyId, organizationId);
  try {
    const items = await orFetchAllPages<Record<string, unknown>>(
      "/bookings",
      { property_ids: propertyId },
      creds
    );
    const bookings = items
      .map((raw) => normalizeBooking(raw, propertyName))
      // Defensive: filter client-side too, in case the property_ids param name
      // doesn't match what this account's API expects.
      .filter((b) => !b.propertyId || b.propertyId === propertyId);
    // Only refresh the fallback snapshot on a genuinely successful, non-empty
    // fetch — never overwrite last known-good data with a real "zero" result
    // we can't yet distinguish from a degraded fetch (see catch branch).
    if (isRedisConfigured() && bookings.length > 0) {
      await redisSet(fallbackKey, JSON.stringify(bookings), {
        exSeconds: BOOKINGS_FALLBACK_TTL_SECONDS,
      }).catch(() => {}); // best-effort — never let a Redis hiccup break the happy path
    }
    return bookings;
  } catch (err) {
    // A newly-imported channel listing (e.g. mid "Go Live" review in
    // OwnerRez) can 400/403 on bookings before it's fully activated, and a
    // transient timeout/429 can hit even a fully-live listing — don't let
    // either take down bookings for the rest of the merged set, but don't
    // silently present that as "this property has zero bookings" either.
    console.error(`OwnerRez: failed to load bookings for property ${propertyId}:`, err);
    if (isRedisConfigured()) {
      try {
        const raw = await redisGet(fallbackKey);
        if (raw) {
          console.error(
            `[ownerrez] getBookings failed live for property ${propertyId}, serving Redis fallback copy:`,
            err instanceof Error ? err.message : err
          );
          return JSON.parse(raw) as Booking[];
        }
      } catch (fallbackErr) {
        console.error("[ownerrez] Redis fallback for getBookings also failed:", fallbackErr);
      }
    }
    return [];
  }
}

async function fetchBookings(organizationId?: string, propertyGroupId?: string): Promise<Booking[]> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!isLive(creds)) return demoBookings;

  const properties = await getTargetProperties(organizationId, propertyGroupId);
  const results = await Promise.all(
    properties.map((p) => fetchBookingsForProperty(p.id, p.name, creds, organizationId))
  );
  return results.flat();
}

// See getTargetProperty above for why this is cached — bookings change often
// enough that a 1-minute window still feels live, but avoids re-paginating
// the whole account on every tab click.
export const getBookings = unstable_cache(fetchBookings, ["ownerrez-bookings"], { revalidate: 60 });

// Fetches guests individually, in small parallel batches rather than one
// giant Promise.all — bounds how many concurrent requests hit OwnerRez at
// once (175 guests is fine at a batch of 20; a much larger account
// shouldn't fire hundreds of simultaneous connections).
const GUEST_FETCH_BATCH_SIZE = 20;

async function fetchGuestsByIds(ids: number[], organizationId?: string): Promise<Guest[]> {
  const guests: Guest[] = [];
  for (let i = 0; i < ids.length; i += GUEST_FETCH_BATCH_SIZE) {
    const batch = ids.slice(i, i + GUEST_FETCH_BATCH_SIZE);
    const results = await Promise.all(batch.map((id) => getGuestById(id, organizationId)));
    for (const g of results) if (g) guests.push(g);
  }
  return guests;
}

// This account manages 8 properties total (confirmed 2026-07-30 — Legacy
// Colombia is just one of them: Legacy Alva, Legacy Pompano, Legacy Colombia,
// Legacy Island, Legacy Miami, Legacy Lodge, Legacy Lookout, Legacy Beach
// House). OwnerRez's /v2/guests list endpoint has no property filter — it
// only returns the ENTIRE account's guests (1,900+ at last count), so a
// naive "fetch every guest" call used to (a) return ~1,700 guests who have
// nothing to do with Legacy Colombia at all, badly inflating the CRM's
// guest count and its "missing phone/email" numbers with other-properties'
// guests and abandoned cross-property inquiries, and (b) paginate through
// ~19 sequential 100-per-page requests just to build that oversized list —
// a real chunk of the Messaging tab's slowness, since every route that
// calls getGuests() (Inbox, thread open/enrich, the cron poller) paid that
// cost on every cache miss. Since getBookings() is already scoped to this
// property's property_id, deriving the exact guest IDs from it and fetching
// just those individually (175 guests for 527 Legacy Colombia bookings, vs.
// 1,900+ account-wide) is both correct and far faster. Since getBookings()
// now merges across every property in the combined villa view (primary +
// config.additionalPropertyIds, e.g. the Nukak - Casa #19 listing), this
// automatically picks up guests from both listings with no change needed here.
// BUG FOUND 2026-08-10: a burst of concurrent requests to this account (5
// rapid /api/messages/inbox hits while diagnosing the Messaging speed issue)
// rate-limited a chunk of the individual getGuestById calls below.
// getGuestById's own catch block silently returns `undefined` on any
// failure (a 429 included — it can't tell "this guest doesn't exist" from
// "OwnerRez throttled us" from in here), and fetchGuestsByIds just drops
// those. The result: a single rate-limit blip silently degraded MOST of the
// account's guest list to missing, which cascaded into resolveGuestName
// falling back to the literal string "Guest" for nearly every conversation
// in the live Messaging tab — and because getGuests() is itself cached for
// 60s, and everything downstream of it (getAllThreadSummaries' 30-min cache,
// and the Redis thread-summary-lite cache in lib/inbox.ts) caches ITS
// output too, that one bad fetch stuck around far longer than 60s. Same
// class of problem fetchBookingsForProperty above already guards against
// (a degraded live fetch silently presenting as "genuinely zero/short") —
// mirroring that fallback-snapshot pattern here so a transient rate-limit
// hit degrades to "serve the last known-good full guest list" instead of
// "poison every cache layer above this with wrong data for up to 30
// minutes."
const GUESTS_FALLBACK_KEY_PREFIX = "ownerrez:guests-fallback:";
const GUESTS_FALLBACK_TTL_SECONDS = 24 * 60 * 60;
// A real account can legitimately lose a guest or two between calls
// (cancelled/merged records) — only treat this as "the live fetch degraded,
// don't trust it" when it comes back missing a large chunk, not just a
// couple of stragglers.
const GUESTS_DEGRADED_THRESHOLD = 0.5;

function guestsFallbackKey(organizationId?: string): string {
  return `${GUESTS_FALLBACK_KEY_PREFIX}${organizationId ?? "default"}`;
}

async function fetchGuests(organizationId?: string, propertyGroupId?: string): Promise<Guest[]> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!isLive(creds)) return demoGuests;

  const bookings = await getBookings(organizationId, propertyGroupId);
  const guestIds = Array.from(
    new Set(bookings.map((b) => b.guestId).filter((id): id is number => id !== null))
  );
  const guests = await fetchGuestsByIds(guestIds, organizationId);

  const fallbackKey =
    propertyGroupId && propertyGroupId !== DEFAULT_PROPERTY_GROUP_ID
      ? `${guestsFallbackKey(organizationId)}:${propertyGroupId}`
      : guestsFallbackKey(organizationId);
  const lookedDegraded = guestIds.length > 0 && guests.length < guestIds.length * GUESTS_DEGRADED_THRESHOLD;

  if (lookedDegraded && isRedisConfigured()) {
    try {
      const raw = await redisGet(fallbackKey);
      if (raw) {
        const fallback = JSON.parse(raw) as Guest[];
        console.error(
          `[ownerrez] getGuests looked degraded (${guests.length}/${guestIds.length} resolved) — serving Redis fallback copy of ${fallback.length} guests instead.`
        );
        return fallback;
      }
    } catch (fallbackErr) {
      console.error("[ownerrez] Redis fallback for getGuests also failed:", fallbackErr);
    }
  }

  // Only refresh the fallback snapshot on a genuinely healthy fetch — same
  // reasoning as fetchBookingsForProperty: never let a degraded result
  // overwrite the last known-good one.
  if (!lookedDegraded && isRedisConfigured() && guests.length > 0) {
    await redisSet(fallbackKey, JSON.stringify(guests), { exSeconds: GUESTS_FALLBACK_TTL_SECONDS }).catch(() => {});
  }

  return guests;
}

// Bumped to v3 (2026-08-10) to flush a poisoned 60s cache entry created by
// the rate-limit-triggered degraded fetch described above — see fetchGuests.
export const getGuests = unstable_cache(fetchGuests, ["ownerrez-guests-v3"], { revalidate: 60 });

export async function getGuestById(id: number, organizationId?: string): Promise<Guest | undefined> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!isLive(creds)) return demoGuests.find((g) => g.id === id);
  try {
    const raw = await orFetch<Record<string, unknown>>(`/guests/${id}`, undefined, creds);
    return normalizeGuest(raw);
  } catch {
    return undefined;
  }
}

async function fetchReviews(organizationId?: string, propertyGroupId?: string): Promise<Review[]> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!isLive(creds)) return demoReviews;
  try {
    // Property scoping (2026-08-17) — without the group these two calls
    // defaulted to Legacy Colombia, so Reputation showed Colombia's reviews
    // on every property.
    const [properties, bookings] = await Promise.all([
      getTargetProperties(organizationId, propertyGroupId),
      getBookings(organizationId, propertyGroupId),
    ]);
    const propertyIds = new Set(properties.map((p) => p.id));
    // getBookings() is already scoped to just our target properties (it
    // fetches per-property via /properties/{id}/bookings) — so any
    // booking_id found in this set is guaranteed to belong to Legacy
    // Colombia or Nukak #19, with no risk of false-positives from other
    // properties in the wider 8-property account.
    const ourBookingIds = new Set(bookings.map((b) => b.id));

    // BUG FIX (2026-08-07): No documented property filter on /reviews
    // (unlike /bookings), and this account manages 8 properties total. The
    // original filter (`!r.propertyId || propertyIds.has(r.propertyId)`)
    // treated "missing property_id" as "assume it's ours" — safe back when
    // this was a single-property app with a small, mostly-tagged review
    // set (109 reviews, 2026-08-01), but wrong now: live diagnostics showed
    // 1246 of 1407 raw reviews come back with NO property_id at all
    // (confirmed via sample inspection: ancient 2015/2016 Airbnb-import
    // records from a completely different host/apartment, with no
    // property_id, booking_id, or guest_id linking them to anything —
    // orphaned rows OwnerRez's /reviews endpoint returns for the whole
    // 8-property account history). Passing all of those through inflated
    // the Reputation Manager's count to 1347. Fix: for reviews missing
    // property_id, try resolving via booking_id against our already
    // property-scoped booking list before falling back to excluding it —
    // recovers legitimately-ours reviews that just happen to lack a direct
    // property_id, without guessing on reviews we truly can't attribute.
    // Confirmed live (2026-08-07): 0 of the 1246 orphans have a resolvable
    // booking_id either, so this correctly nets out to 101 (50 Legacy
    // Colombia + 51 Nukak) — down from 1347, and provably accurate since
    // every included review is directly tagged with one of our two
    // property ids. Seni separately reported ~158 (84 + 74) from looking
    // at the properties' own Airbnb listing pages; that gap looks like
    // OwnerRez's own review sync from Airbnb lagging/incomplete rather
    // than anything fixable in this filter — see reviews-count-bug memory.
    const items = await orFetchAllPages<Record<string, unknown>>("/reviews", {}, creds);
    return items.map(normalizeReview).filter((r) => {
      if (r.propertyId) return propertyIds.has(r.propertyId);
      if (r.bookingId) return ourBookingIds.has(r.bookingId);
      return false;
    });
  } catch {
    // Reviews endpoint access can vary by account/plan; degrade gracefully.
    return [];
  }
}

// Reviews change rarely (a new one lands only when a guest actually leaves
// one) — same caching rationale as getTargetProperty above.
// NOTE: unstable_cache keys on the actual arguments, so adding
// propertyGroupId as a real parameter above is what keeps Alva's and
// Colombia's review sets in separate cache entries.
export const getReviews = unstable_cache(fetchReviews, ["ownerrez-reviews-v2"], { revalidate: 300 });

/**
 * Sends a real message into an OwnerRez conversation thread (e.g. an Airbnb
 * or direct-booking thread), so it shows up for the guest exactly like a
 * message sent from OwnerRez's own inbox.
 *
 * Unlike every other call in this file, this uses OAuth bearer auth, not the
 * Basic-auth Personal Access Token — OwnerRez's PATs are explicitly blocked
 * from the messaging endpoints. See isMessagingConfigured()/README for setup.
 */
export async function sendMessage(
  threadId: number,
  body: string,
  organizationId?: string
): Promise<{ id?: number; dateUtc?: string }> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!creds.oauthToken) {
    throw new OwnerRezApiError(
      "OwnerRez messaging isn't connected yet. Visit /api/oauth/start to connect it (see README)."
    );
  }

  const res = await fetch(`${API_BASE}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.oauthToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": config.userAgent,
    },
    body: JSON.stringify({ thread_id: threadId, body }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new OwnerRezApiError(`OwnerRez API /messages returned ${res.status}: ${errBody.slice(0, 300)}`, res.status);
  }

  const data = (await res.json()) as Record<string, unknown>;

  // Admin-reply visibility (2026-08-18): remember that the CRM itself posted
  // this text, so the cron/webhook "an admin replied in OwnerRez" ping (see
  // lib/adminReplyMarkers.ts) can tell Seni's own approved sends apart from a
  // co-admin replying directly in OwnerRez's UI. Fire-and-forget — a Redis
  // hiccup must never fail a message that already reached the guest.
  markCrmSentReply(body, organizationId).catch(() => {});

  return {
    id: pick(data, "id") as number | undefined,
    dateUtc: pick(data, "date_utc") as string | undefined,
  };
}

function normalizeThreadMessage(raw: Record<string, unknown>, threadId: number): ThreadMessage {
  // Per OwnerRez's documented ThreadParticipantRole enum (confirmed against
  // their OpenAPI spec 2026-07-28): owner, guest, co_host, support, other,
  // cotraveler, third_party_booker. Only "guest" is the guest side of the
  // conversation — everyone else (including "other"/"support") is treated
  // as host-side/non-guest so we don't draft replies to our own notes.
  const fromRole = String(pick(raw, "from_role") ?? "").toLowerCase();
  const isGuest = fromRole === "guest";

  return {
    id: Number(pick(raw, "id")),
    threadId,
    body: String(pick(raw, "body") ?? ""),
    isGuest,
    fromRole,
    sentAt: pick(raw, "date_utc") as string | undefined,
    raw,
  };
}

/**
 * Fetches every message in an OwnerRez conversation thread, oldest first.
 * Uses OAuth bearer auth like sendMessage() (PATs can't touch messaging
 * endpoints at all). Used by the AI reply drafter to (a) find new inbound
 * guest messages and (b) pull Seni's past host-authored replies as style
 * examples.
 */
export async function getThreadMessages(threadId: number, organizationId?: string): Promise<ThreadMessage[]> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!creds.oauthToken) {
    throw new OwnerRezApiError(
      "OwnerRez messaging isn't connected yet. Visit /api/oauth/start to connect it (see README)."
    );
  }

  // OwnerRez's GET /v2/messages takes a camelCase `threadId` query param
  // (confirmed against their published OpenAPI spec 2026-07-28) — every
  // other v2 GET endpoint uses snake_case (property_id, booking_id, etc.),
  // which is why this one was easy to get wrong. Sending `thread_id`
  // instead makes OwnerRez's router fail to match this GET overload at all,
  // which is why it was returning a misleading 405 "UnsupportedApiVersion"
  // rather than a 400 on the parameter itself. There's also no `limit`
  // request parameter on this endpoint — it isn't in the documented schema.
  const url = new URL(`${API_BASE}/messages`);
  url.searchParams.set("threadId", String(threadId));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${creds.oauthToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": config.userAgent,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OwnerRezApiError(
      `OwnerRez API /messages (thread ${threadId}) returned ${res.status}: ${body.slice(0, 300)}`,
      res.status
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  const items = (data.items ?? []) as Record<string, unknown>[];
  return items
    .filter((raw) => !pick(raw, "is_draft") && !pick(raw, "removed_utc"))
    .map((raw) => normalizeThreadMessage(raw, threadId))
    .sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? "") || a.id - b.id);
}

// ---------- Revenue Manager (shadow mode) — reading OwnerRez's actual rate ----------
// OwnerRez's public v2 API has no GET endpoint for reading the rate
// calendar: /v2/spotrates only supports PATCH (confirmed against OwnerRez's
// published OpenAPI spec, 2026-07-30 — api.ownerrez.com/openapi/v2.json has
// no "get" under that path), and /v2/quotes normally creates a real,
// persisted quote record. The QuoteEditModel's `test: true` flag is the
// documented way around that: "the generated quote should be returned only,
// not stored" — the API still computes real charges using the property's
// actual rate calendar/rules, but nothing is written to Seni's account, no
// hold is placed, and no email goes out (generate_email/hold_dates
// explicitly forced false below regardless of the API's own defaults, so a
// future OwnerRez default change can't silently start emailing someone).
//
// Used by lib/revenueManager.ts to get "what OwnerRez would actually charge
// tonight" for comparison against PriceLabs and the AI's own recommendation.
// Returns null (rather than throwing) for a date that fails validation (e.g.
// already booked) so a per-date loop can just skip that date instead of
// aborting the whole run.
//
// Confirmed 2026-07-31 (via a temporary diagnostic route) that Legacy
// Colombia enforces a 2-night minimum stay — a plain 1-night quote fails
// EVERY date with "A minimum of 2 nights is required", which is why this
// used to come back empty for the whole calendar. Fixed by quoting NIGHTS
// nights and averaging the total rent across them; if that still 400s
// (e.g. a longer minimum on some dates), retries once at a longer stay
// before giving up on that date.
async function quoteNightlyRateForNights(
  propertyId: number,
  date: string,
  nights: number,
  creds: OwnerRezCredentials
): Promise<number | null> {
  const departure = new Date(date);
  departure.setUTCDate(departure.getUTCDate() + nights);
  const departureStr = departure.toISOString().slice(0, 10);

  const res = await fetch(`${API_BASE}/quotes`, {
    method: "POST",
    headers: {
      Authorization: authHeader(creds),
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": config.userAgent,
    },
    body: JSON.stringify({
      property_id: propertyId,
      arrival: date,
      departure: departureStr,
      adults: 2,
      test: true, // do NOT persist this quote — see comment above
      generate_charges: true,
      generate_email: false, // never email a guest for a background price check
      hold_dates: false, // never block real availability for a background price check
    }),
    cache: "no-store",
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { charges?: { type?: string; amount?: number }[] };
  const rentCharges = (data.charges ?? []).filter((c) => c.type === "rent");
  if (rentCharges.length === 0) return null;
  const totalRent = rentCharges.reduce((sum, c) => sum + (c.amount ?? 0), 0);
  return Math.round((totalRent / nights) * 100);
}

const QUOTE_NIGHTS_TO_TRY = [2, 3]; // covers the standard 2-night minimum plus a longer holiday-week minimum

export async function getQuotedNightlyRateCents(date: string, organizationId?: string): Promise<number | null> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!isLive(creds)) return null;

  const property = await getTargetProperty(organizationId);

  for (const nights of QUOTE_NIGHTS_TO_TRY) {
    const rate = await quoteNightlyRateForNights(property.id, date, nights, creds);
    if (rate !== null) return rate;
  }
  return null;
}

export async function testConnection(organizationId?: string): Promise<{ ok: boolean; message: string }> {
  const creds = await resolveOwnerRezCredentials(organizationId);
  if (!isLive(creds)) {
    return {
      ok: false,
      message: "Not configured — running in demo mode. Add your OwnerRez email and Personal Access Token in Settings.",
    };
  }
  try {
    const properties = await getTargetProperties(organizationId);
    const [primary, ...additional] = properties;
    const additionalDesc = additional.length
      ? ` + ${additional.map((p) => `"${p.name}" (id ${p.id})`).join(", ")}`
      : "";
    return { ok: true, message: `Connected. Using property "${primary.name}" (id ${primary.id})${additionalDesc}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Unknown connection error." };
  }
}

export { OwnerRezApiError };

// This app's PMS abstraction layer (src/lib/pms/types.ts) formalizes the
// above functions as a swappable "adapter" contract — see that file's header
// comment for the full rationale (Seni's stated intent to potentially move
// off OwnerRez to Hostaway, or eventually pull directly from each OTA). This
// object is the "ownerrez" adapter: TypeScript checks it against
// PmsProvider, so any future edit to the functions above that breaks the
// contract fails to compile here rather than silently drifting.
export const ownerRezProvider: PmsProvider = {
  id: "ownerrez",
  getTargetProperty,
  getTargetProperties,
  getBookings,
  getGuests,
  getGuestById,
  getReviews,
  getThreadMessages,
  sendMessage,
  getQuotedNightlyRateCents,
  testConnection,
};
