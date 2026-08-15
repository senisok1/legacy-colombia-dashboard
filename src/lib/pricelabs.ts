import { config } from "./config";
import { getDefaultOrganizationId } from "./organizations";
import { getPriceLabsCredentials, type PriceLabsCredentials } from "./credentials";

// PriceLabs Customer API client (read side confirmed against PriceLabs'
// published Postman collection, 2026-07-30:
// https://documenter.getpostman.com/view/507656/SVSEurQC). Used by
// lib/revenueManager.ts to pull PriceLabs' own recommended rates for
// side-by-side comparison (see docs/VISION.md phase 5), and — as of
// 2026-08-01 — to push an approved rate live via applyDateOverride() below.
//
// applyDateOverride() is the ONLY write function in this file (no
// /push_prices, no bulk endpoints) and it's the ONLY write path this whole
// app uses for rates. It deliberately goes through PriceLabs' Date Specific
// Overrides API rather than OwnerRez's own PATCH /v2/spotrates: PriceLabs
// owns the live pricing sync into OwnerRez via its own separate Integration
// API and treats itself as the source of truth for this listing, so a direct
// OwnerRez write risks being silently overwritten by PriceLabs' next
// scheduled sync. Writing the override here instead means PriceLabs picks it
// up and pushes it into OwnerRez itself, on PriceLabs' own normal cadence —
// not instant. See lib/revenueManager.ts's applyRateOverride(), which is the
// only caller, itself only reachable from an explicit, single-date,
// human-triggered click in the Revenue Management tab.

const API_BASE = "https://api.pricelabs.co/v1";

export class PriceLabsError extends Error {}

export type PriceLabsListing = {
  id: string;
  pms: string;
  name: string;
  min?: number;
  base?: number;
  max?: number;
};

// ---------- Phase 3: per-tenant credential resolution ----------
// Same pattern as lib/ownerrez.ts: every exported function below takes an
// OPTIONAL trailing organizationId, defaulting to the pre-existing single
// customer's org (byte-for-byte the same behavior as before this change).
// Fails soft to the global config.* values on any DB error, same reasoning
// as resolveOwnerRezCredentials in lib/ownerrez.ts.
async function resolvePriceLabsCredentials(organizationId?: string): Promise<PriceLabsCredentials> {
  const fallback: PriceLabsCredentials = {
    apiKey: config.pricelabsApiKey,
    listingId: config.pricelabsListingId,
  };
  try {
    const orgId = organizationId ?? (await getDefaultOrganizationId());
    return await getPriceLabsCredentials(orgId);
  } catch (err) {
    console.error("[pricelabs] Falling back to global config credentials:", err);
    return fallback;
  }
}

function isConfigured(creds: PriceLabsCredentials): boolean {
  return Boolean(creds.apiKey);
}

function authHeaders(creds: PriceLabsCredentials): Record<string, string> {
  return {
    "X-API-Key": creds.apiKey,
    "Content-Type": "application/json",
  };
}

/** Lists every listing connected to this PriceLabs account. Used to look up
 * the (id, pms) pair for the Legacy Colombia listing — see config.ts's
 * pricelabsListingId comment. */
export async function getListings(organizationId?: string): Promise<PriceLabsListing[]> {
  const creds = await resolvePriceLabsCredentials(organizationId);
  if (!isConfigured(creds)) {
    throw new PriceLabsError("PRICELABS_API_KEY isn't set yet.");
  }
  const res = await fetch(`${API_BASE}/listings`, { headers: authHeaders(creds), cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PriceLabsError(`PriceLabs API /listings returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { listings?: PriceLabsListing[] };
  return data.listings ?? [];
}

export type PriceLabsDatePrice = {
  date: string; // YYYY-MM-DD
  /** PriceLabs' own uncustomized recommendation for this date. */
  price: number;
  /** What's actually live/pushed, after any manual overrides Seni set. */
  userPrice: number;
  minStay: number;
};

export type PriceLabsListingPrices = {
  id: string;
  pms: string;
  currency?: string;
  lastRefreshedAt?: string;
  dates: PriceLabsDatePrice[];
  /** Set when PriceLabs couldn't return prices for this listing (not synced
   * recently, listing not found, etc.) — see PriceLabs' documented
   * LISTING_NOT_PRESENT / LISTING_NO_DATA error_status values. */
  error?: string;
};

/** Fetches PriceLabs' full current price calendar for one listing (typically
 * a year or more out — PriceLabs doesn't take a date-range param on this
 * endpoint, it just returns whatever it has). Callers should filter/slice
 * the `dates` array down to the window they actually need. */
export async function getListingPrices(
  id: string,
  pms: string,
  organizationId?: string
): Promise<PriceLabsListingPrices> {
  const creds = await resolvePriceLabsCredentials(organizationId);
  if (!isConfigured(creds)) {
    throw new PriceLabsError("PRICELABS_API_KEY isn't set yet.");
  }
  const res = await fetch(`${API_BASE}/listing_prices`, {
    method: "POST",
    headers: authHeaders(creds),
    body: JSON.stringify({ listings: [{ id, pms }] }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PriceLabsError(`PriceLabs API /listing_prices returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as Array<Record<string, unknown>>;
  const entry = data[0];
  if (!entry) throw new PriceLabsError("PriceLabs API /listing_prices returned an empty response.");

  if (entry.error) {
    return { id, pms, error: String(entry.error), dates: [] };
  }

  const rawDates = (entry.data as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    id,
    pms,
    currency: entry.currency as string | undefined,
    lastRefreshedAt: entry.last_refreshed_at as string | undefined,
    dates: rawDates.map((d) => ({
      date: String(d.date),
      price: Number(d.price),
      userPrice: Number(d.user_price ?? d.price),
      minStay: Number(d.min_stay ?? 0),
    })),
  };
}

export type DateOverrideInput = {
  date: string; // YYYY-MM-DD
  price: number; // in `currency` units, e.g. 650.00
  currency: string;
  reason?: string;
};

export type DateOverrideResult = {
  raw: unknown;
};

/** Pushes a durable per-date price override into PriceLabs — the "Date
 * Specific Overrides" (DSO) API (confirmed against PriceLabs' own docs at
 * developers.pricelabs.co, 2026-08-01: POST /v1/listings/{listing_id}/overrides,
 * body { overrides: [{ date, price, price_type, currency, reason }], pms }).
 * On any validation failure the whole request 400s and nothing is saved —
 * callers should treat a non-ok response as "nothing changed," not partial
 * success. See this file's header comment for why this is the only write
 * path used for rates anywhere in this app. */
export async function applyDateOverride(
  listingId: string,
  pms: string,
  input: DateOverrideInput,
  organizationId?: string
): Promise<DateOverrideResult> {
  const creds = await resolvePriceLabsCredentials(organizationId);
  if (!isConfigured(creds)) {
    throw new PriceLabsError("PRICELABS_API_KEY isn't set yet.");
  }
  const res = await fetch(`${API_BASE}/listings/${encodeURIComponent(listingId)}/overrides`, {
    method: "POST",
    headers: authHeaders(creds),
    body: JSON.stringify({
      pms,
      overrides: [
        {
          date: input.date,
          price: input.price,
          price_type: "fixed",
          currency: input.currency,
          reason: input.reason,
        },
      ],
    }),
    cache: "no-store",
  });
  const bodyText = await res.text().catch(() => "");
  let parsed: unknown = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = bodyText;
    }
  }
  if (!res.ok) {
    throw new PriceLabsError(`PriceLabs API /overrides returned ${res.status}: ${bodyText.slice(0, 500)}`);
  }
  return { raw: parsed };
}
