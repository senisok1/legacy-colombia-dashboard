import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getTargetProperties } from "@/lib/ownerrez";
import { getOwnerRezCredentials } from "@/lib/credentials";
import { getDefaultOrganizationId } from "@/lib/organizations";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// DIAGNOSTIC (2026-08-22, for the premium UI refresh): can this account's
// OwnerRez token actually reach LISTING CONTENT (photos)?
//
// Why this exists: the UI refresh spec requires every property's hero image
// and thumbnails to be pulled dynamically from that property's own OwnerRez
// listing. But OwnerRez gates listing-content endpoints behind a SEPARATE
// partnership agreement (their docs: contact partnerhelp@ownerrez.com,
// subject "Listing Endpoints Access") — the standard PAT that powers every
// other call in this app is not guaranteed to include them. Rather than
// build the whole image pipeline and discover a 401/403 at the end, this
// route asks the API directly and reports exactly what came back.
//
// Tries several documented/plausible shapes because OwnerRez's listing API
// is partner-gated and its exact path isn't in the public v2 reference we
// can see. A 200 with photo URLs on ANY of these means dynamic images are
// viable; 401/403/404 across the board means they aren't, and the refresh
// should use owner-supplied images instead.
//
//   GET /api/admin/listing-photos-probe?secret=…

const API_BASE = "https://api.ownerrez.com/v2";

function authHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, "utf-8").toString("base64")}`;
}

/** Truncated preview of a response body — enough to see the shape without
 *  dumping a whole listing payload into the JSON response. */
function preview(text: string, limit = 600): string {
  return text.length > limit ? `${text.slice(0, limit)}…[${text.length} bytes total]` : text;
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

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
  if (!email || !token) {
    return NextResponse.json({ error: "No OwnerRez credentials resolved." }, { status: 500 });
  }

  // Use a real property id so the per-property paths are actually meaningful.
  let propertyId: number | null = null;
  let propertyName: string | null = null;
  try {
    const props = await getTargetProperties(undefined, "legacy-colombia");
    if (props[0]) {
      propertyId = props[0].id;
      propertyName = props[0].name;
    }
  } catch {
    // Probe the non-property-specific paths anyway.
  }

  const candidates = [
    "/listings",
    propertyId ? `/listings/${propertyId}` : null,
    propertyId ? `/listings/${propertyId}/images` : null,
    propertyId ? `/listings/${propertyId}/photos` : null,
    "/listingimages",
    "/listingphotos",
    propertyId ? `/properties/${propertyId}` : null,
    propertyId ? `/properties/${propertyId}/images` : null,
    propertyId ? `/properties/${propertyId}/photos` : null,
  ].filter((p): p is string => p !== null);

  const results = [];
  for (const path of candidates) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: {
          Authorization: authHeader(email, token),
          Accept: "application/json",
          "User-Agent": config.userAgent,
        },
        cache: "no-store",
      });
      const body = await res.text();
      // Cheap signal for "does this payload actually contain image URLs" —
      // the whole question this route exists to answer.
      const looksLikeImages = /https?:\/\/[^"']+\.(jpe?g|png|webp)/i.test(body);
      results.push({
        path,
        status: res.status,
        ok: res.ok,
        containsImageUrls: looksLikeImages,
        sampleImageUrls: looksLikeImages
          ? [...body.matchAll(/https?:\/\/[^"']+?\.(?:jpe?g|png|webp)/gi)].slice(0, 5).map((m) => m[0])
          : [],
        body: preview(body),
      });
      // Be polite to the 1 req/sec rate limit this account runs under.
      await new Promise((r) => setTimeout(r, 1100));
    } catch (err) {
      results.push({
        path,
        status: 0,
        ok: false,
        containsImageUrls: false,
        sampleImageUrls: [],
        body: err instanceof Error ? err.message : "Unknown error.",
      });
    }
  }

  const working = results.filter((r) => r.ok && r.containsImageUrls);
  return NextResponse.json({
    property: { id: propertyId, name: propertyName },
    verdict:
      working.length > 0
        ? `PHOTOS AVAILABLE via ${working.map((w) => w.path).join(", ")}`
        : "NO PHOTO ACCESS — every candidate endpoint failed or returned no image URLs. Listing content is partner-gated (partnerhelp@ownerrez.com).",
    results,
  });
}
