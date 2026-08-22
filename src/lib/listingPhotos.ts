import { unstable_cache } from "next/cache";
import { config } from "@/lib/config";
import { getTargetProperties } from "@/lib/ownerrez";
import { getOwnerRezCredentials } from "@/lib/credentials";
import { getDefaultOrganizationId } from "@/lib/organizations";
import { redisGet, redisSet } from "@/lib/redis";

// Per-property listing photography from OwnerRez (2026-08-22, for the
// premium UI refresh).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a property's imagery may only
// ever come from THAT property's own OwnerRez listing. Seni's spec is
// emphatic and repeated — never mix photos between Legacy Alva, Legacy
// Colombia, Legacy Miami, Legacy Pompano and Legacy Beach House, never use
// stock photography, never borrow another Legacy property's photo as a
// placeholder. That's enforced structurally here: photos are fetched per
// propertyId, keyed per propertyId in the cache, and getPropertyGroupPhotos
// only ever returns photos belonging to the listings that the requested
// property GROUP itself resolves to (via getTargetProperties, the same
// property-scoping every other feature in this app already goes through).
// There is deliberately no "default"/"fallback" photo set — if a property
// has no photos, callers get an empty array and must render a non-photo
// treatment rather than silently showing someone else's house.
//
// DISCOVERY NOTE (2026-08-22, via api/admin/listing-photos-probe): OwnerRez
// exposes this at GET /v2/listings/{propertyId} → `photos[]`, each entry
// { caption, cropped_url, large_url, original_url }. Two gotchas worth
// remembering: (1) listing-content endpoints are partner-gated in general,
// but this account HAS access — verified live against all five property
// groups (83-104 photos each); (2) the URLs are EXTENSIONLESS CDN links
// (https://uc.orez.io/i/{hash}-Large), so any "is this an image?" check
// based on a .jpg/.png file extension will wrongly conclude there are no
// photos. That exact false negative cost a probe round.
//
// Array order is OwnerRez's own listing display order, so photos[0] is the
// listing's top/hero photo — which is what Seni asked for ("use the top
// photos for each property").

const API_BASE = "https://api.ownerrez.com/v2";

export type ListingPhoto = {
  /** OwnerRez's own caption, e.g. "Sunset Living With Panoramic Lake Views". */
  caption: string | null;
  /** Small, pre-cropped — right for thumbnails and property-switcher rows. */
  thumbUrl: string;
  /** Large — right for hero banners and feature cards. */
  largeUrl: string;
  /** Full-size original. Rarely needed in-app; kept for completeness. */
  originalUrl: string;
};

export type PropertyGroupPhotos = {
  groupId: string;
  /** The OwnerRez listings this group resolved to, for traceability. */
  listingIds: number[];
  photos: ListingPhoto[];
};

type RawPhoto = {
  caption?: unknown;
  cropped_url?: unknown;
  large_url?: unknown;
  original_url?: unknown;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function normalizePhoto(raw: RawPhoto): ListingPhoto | null {
  const large = str(raw.large_url);
  const cropped = str(raw.cropped_url);
  const original = str(raw.original_url);
  // Require at least one usable URL; fall back across the three sizes rather
  // than dropping a photo just because one variant is missing.
  const anyUrl = large ?? cropped ?? original;
  if (!anyUrl) return null;
  return {
    caption: str(raw.caption),
    thumbUrl: cropped ?? large ?? anyUrl,
    largeUrl: large ?? original ?? anyUrl,
    originalUrl: original ?? large ?? anyUrl,
  };
}

// Last-known-good copy per listing. Same reasoning as ownerrez.ts's bookings
// fallback: a transient OwnerRez failure should degrade to slightly stale
// photos, never to an empty hero (or, far worse, to some other property's
// photo). 7 days — listing photography changes rarely.
const PHOTOS_FALLBACK_PREFIX = "ownerrez:listing-photos:";
const PHOTOS_FALLBACK_TTL_SECONDS = 7 * 24 * 60 * 60;

async function fetchPhotosForListing(propertyId: number, email: string, token: string): Promise<ListingPhoto[]> {
  const key = `${PHOTOS_FALLBACK_PREFIX}${propertyId}`;
  try {
    const res = await fetch(`${API_BASE}/listings/${propertyId}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`, "utf-8").toString("base64")}`,
        Accept: "application/json",
        "User-Agent": config.userAgent,
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`OwnerRez listings/${propertyId} returned ${res.status}`);
    const json = (await res.json()) as { photos?: RawPhoto[] };
    const photos = Array.isArray(json.photos)
      ? json.photos.map(normalizePhoto).filter((p): p is ListingPhoto => p !== null)
      : [];
    if (photos.length > 0) {
      await redisSet(key, JSON.stringify(photos), { exSeconds: PHOTOS_FALLBACK_TTL_SECONDS }).catch(() => {});
    }
    return photos;
  } catch (err) {
    console.error(`[listingPhotos] live fetch failed for ${propertyId}, trying Redis copy:`, err);
    try {
      const cached = await redisGet(key);
      if (cached) return JSON.parse(cached) as ListingPhoto[];
    } catch (fallbackErr) {
      console.error(`[listingPhotos] Redis fallback also failed for ${propertyId}:`, fallbackErr);
    }
    // Deliberately empty, never another property's photos — see header.
    return [];
  }
}

async function fetchGroupPhotos(groupId: string): Promise<PropertyGroupPhotos> {
  let email = config.ownerRezEmail;
  let token = config.ownerRezToken;
  try {
    const creds = await getOwnerRezCredentials(await getDefaultOrganizationId());
    if (creds.email && creds.token) {
      email = creds.email;
      token = creds.token;
    }
  } catch {
    // Fall back to env config, same posture as lib/ownerrez.ts.
  }
  if (!email || !token) return { groupId, listingIds: [], photos: [] };

  // getTargetProperties is THE property-scoping choke point for this whole
  // app — going through it is what guarantees this group can only ever see
  // its own listings' photos.
  const properties = await getTargetProperties(undefined, groupId).catch(() => []);
  const listingIds = properties.map((p) => p.id);

  const perListing: ListingPhoto[][] = [];
  for (const p of properties) {
    perListing.push(await fetchPhotosForListing(p.id, email, token));
  }

  // Interleave when a group spans several listings (Legacy Colombia is
  // really LC + Nukak Casa #19) so the hero and thumbnails aren't all drawn
  // from whichever listing happens to be first — still strictly within this
  // group's own listings.
  const photos: ListingPhoto[] = [];
  const max = Math.max(0, ...perListing.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const list of perListing) {
      if (list[i]) photos.push(list[i]);
    }
  }

  return { groupId, listingIds, photos };
}

/** Photos for one property group. Cached 6h — listing photography is very
 *  stable, and this sits in the render path of every page with a hero. */
export const getPropertyGroupPhotos = unstable_cache(fetchGroupPhotos, ["ownerrez-listing-photos-v1"], {
  revalidate: 6 * 60 * 60,
});
