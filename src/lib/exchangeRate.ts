import { redisGet, redisSet } from "./redis";
import { isRedisConfigured } from "./config";

// Currency-toggle support (Settings > Currency, see lib/organizations.ts's
// secondaryCurrency field). This app tracks money in whatever currency it
// was actually billed/collected in (USD for most things, COP for the
// Gutierrez Group / Nukak #19 monthly statements — see
// api/admin/import-nukak-bills/route.ts). A single "today's rate" can't
// reconstruct exactly what a historical foreign-currency amount was worth in
// USD on the day it was paid, so this is deliberately labeled as an
// approximate, current-rate conversion for browsing convenience — not an
// accounting-grade historical FX record. Stored amounts/currencies never
// change; only the display can be toggled. Generalized beyond COP so any
// tenant can turn on their own secondary currency, not just Seni's org.

const CACHE_TTL_SECONDS = 60 * 60; // refresh hourly

// Best-effort fallbacks if the live lookup fails, for the currencies we
// actually expect a tenant to pick. Any currency not listed here falls back
// to 1 (i.e. no conversion) rather than a fabricated number — better to show
// an obviously-off "toggle unavailable" state than a confidently wrong rate.
const FALLBACK_USD_RATES: Record<string, number> = {
  COP: 4000,
  EUR: 0.92,
  GBP: 0.79,
  MXN: 17,
  CAD: 1.36,
  BRL: 5.5,
};

export type UsdRate = {
  currency: string;
  usdToTarget: number;
  source: "live" | "fallback";
  fetchedAt: string;
};

async function fetchLiveRates(): Promise<Record<string, number> | null> {
  try {
    // Free, no-API-key exchange rate service (used read-only, once/hour at
    // most per currency thanks to the cache below). Returns rates for ~160
    // currencies from a single call, so every org's secondary-currency
    // choice is served from the same lookup.
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
    return data?.rates ?? null;
  } catch {
    return null;
  }
}

export async function getUsdToRate(targetCurrency: string): Promise<UsdRate> {
  const currency = targetCurrency.toUpperCase();
  const cacheKey = `fx:usd-${currency.toLowerCase()}`;

  if (isRedisConfigured()) {
    const cached = await redisGet(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as UsdRate;
      } catch {
        // fall through and recompute
      }
    }
  }

  const rates = await fetchLiveRates();
  const live = rates?.[currency];
  const result: UsdRate =
    typeof live === "number" && Number.isFinite(live) && live > 0
      ? { currency, usdToTarget: live, source: "live", fetchedAt: new Date().toISOString() }
      : {
          currency,
          usdToTarget: FALLBACK_USD_RATES[currency] ?? 1,
          source: "fallback",
          fetchedAt: new Date().toISOString(),
        };

  if (isRedisConfigured()) {
    await redisSet(cacheKey, JSON.stringify(result), { exSeconds: CACHE_TTL_SECONDS });
  }
  return result;
}

// Re-exported so callers only importing conversion math (not the live-rate
// fetch) can go through either module — see currencyMath.ts for why the
// actual implementation lives there (dependency-free, safe for client
// bundles).
export { convertAmountCents } from "./currencyMath";
