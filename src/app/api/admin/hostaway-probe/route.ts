import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { hostawayGet, isHostawayConfigured, getHostawayToken } from "@/lib/hostaway";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Hostaway discovery probe (2026-08-17). Deliberately built and deployed
// BEFORE any mapping code: the last time data-shape assumptions went in
// ahead of a real response, the result was a set of invented fields that
// type-checked and still didn't work. So this returns Hostaway's ACTUAL
// payloads, and the Booking/Guest/ThreadMessage mappers get written against
// what comes back — not against what the docs imply.
//
//   GET /api/admin/hostaway-probe?secret=…                 → connection + listings
//   GET /api/admin/hostaway-probe?secret=…&path=/reservations&limit=2
//   GET /api/admin/hostaway-probe?secret=…&path=/conversations&limit=2
//
// `path` is restricted to an allowlist of read-only endpoints so this can't
// be turned into an open proxy into the Hostaway account.
const ALLOWED_PATHS = new Set([
  "/listings",
  "/reservations",
  "/conversations",
  "/guests",
  "/customFieldDefinitions",
]);

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!isHostawayConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        error:
          "Hostaway isn't configured yet — HOSTAWAY_ACCOUNT_ID and HOSTAWAY_API_KEY need values in Vercel.",
      },
      { status: 400 }
    );
  }

  const path = req.nextUrl.searchParams.get("path");
  const limit = Number(req.nextUrl.searchParams.get("limit") || 3);

  try {
    // No path = connection check + the listing inventory, which is what's
    // needed to map Hostaway listing ids onto our property groups.
    if (!path) {
      const token = await getHostawayToken();
      const listings = await hostawayGet<{ result?: Record<string, unknown>[] }>("/listings", {
        limit: 100,
      });
      return NextResponse.json({
        configured: true,
        tokenOk: Boolean(token),
        listingCount: listings.result?.length ?? 0,
        listings: (listings.result ?? []).map((l) => ({
          id: l.id,
          name: l.name,
          internalListingName: l.internalListingName,
          address: l.address,
          city: l.city,
        })),
      });
    }

    if (!ALLOWED_PATHS.has(path)) {
      return NextResponse.json(
        { error: `path must be one of: ${[...ALLOWED_PATHS].join(", ")}` },
        { status: 400 }
      );
    }

    const listingId = req.nextUrl.searchParams.get("listingId") || undefined;
    const raw = await hostawayGet<{ result?: unknown[] }>(path, {
      limit,
      ...(listingId ? { listingId } : {}),
    });
    const result = Array.isArray(raw.result) ? raw.result : [];

    // Return the FULL first object (so every field name is visible) plus the
    // key set of the rest, which is what the mappers actually need.
    return NextResponse.json({
      path,
      count: result.length,
      firstRecordVerbatim: result[0] ?? null,
      fieldNames: result[0] && typeof result[0] === "object" ? Object.keys(result[0] as object) : [],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 502 }
    );
  }
}
