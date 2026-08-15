// Pure currency-conversion math, deliberately dependency-free (no Redis, no
// fetch) so it's safe to import from both server code (lib/exchangeRate.ts)
// and client components (CurrencyProvider.tsx) without pulling server-only
// modules into the browser bundle.

/** Converts an amount already in "cents" (amount * 100 — this app's storage
 * convention for every currency, not just USD) between USD and a single
 * secondary currency (whichever one the org picked in Settings > Currency —
 * see lib/organizations.ts's secondaryCurrency field), using a live
 * USD-to-secondary rate. Returns null for any pair that isn't USD<->that
 * secondary currency, so callers can fall back to showing the amount in its
 * original currency instead of a wrong number. */
export function convertAmountCents(
  amountCents: number,
  fromCurrency: string,
  toCurrency: string,
  usdToSecondary: number
): number | null {
  if (fromCurrency === toCurrency) return amountCents;
  const amount = amountCents / 100;
  if (fromCurrency === "USD") return Math.round(amount * usdToSecondary * 100);
  if (toCurrency === "USD") return Math.round((amount / usdToSecondary) * 100);
  return null;
}
