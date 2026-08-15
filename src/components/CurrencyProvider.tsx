"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { formatCurrency } from "@/lib/format";
import { convertAmountCents } from "@/lib/currencyMath";

// Per-org display-currency toggle (Seni's ask, 2026-08-05 — turned on for his
// own Legacy Estate Rentals login with COP, available as an opt-in Settings >
// Currency feature for any other paid tenant with their own currency). Every
// dollar figure across the app (Dashboard, Reports, Revenue Management, Bill
// Pay, etc.) can be viewed in either USD or the org's chosen secondary
// currency, converted at a live exchange rate pulled from /api/exchange-rate
// (lib/exchangeRate.ts, cached ~1h server-side per currency). This is a
// display-only toggle: nothing stored in the database ever changes — a bill
// actually billed in COP still has currency: "COP" in the DB regardless of
// which way this toggle is set, and Stripe subscription charges are always
// billed in real USD (see BillingPlans.tsx, which shows a converted estimate
// alongside the real USD price rather than replacing it).
//
// secondaryCurrency comes from the org record (see lib/organizations.ts),
// resolved server-side in layout.tsx and passed down as a prop — orgs that
// haven't turned this on get secondaryCurrency={null}, which disables the
// toggle entirely (format() just renders the native currency, NavBar hides
// the toggle UI).

type Rate = { currency: string; usdToTarget: number; source: "live" | "fallback"; fetchedAt: string };

type CurrencyContextValue = {
  /** null when this org hasn't turned on a secondary currency. */
  secondaryCurrency: string | null;
  /** "USD" or the org's secondaryCurrency — always "USD" when the feature is off. */
  displayCurrency: string;
  setDisplayCurrency: (c: string) => void;
  rate: Rate | null;
  /** Formats `amount` (already in the given native currency's own units —
   * e.g. dollars for USD, pesos for COP, NOT cents) in whichever currency is
   * currently selected, converting via the live rate when the native and
   * display currencies differ. Falls back to the native currency if no rate
   * is available yet, the feature is off, or the pair isn't convertible. */
  format: (amount: number, nativeCurrency?: string) => string;
};

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

const STORAGE_KEY = "display_currency";
const REFRESH_MS = 30 * 60 * 1000; // keep the on-screen rate reasonably fresh during a long session

export function CurrencyProvider({
  secondaryCurrency,
  children,
}: {
  secondaryCurrency: string | null;
  children: React.ReactNode;
}) {
  const [displayCurrency, setDisplayCurrencyState] = useState<string>("USD");
  const [rate, setRate] = useState<Rate | null>(null);

  useEffect(() => {
    if (!secondaryCurrency) return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      // Only honor a stored choice that matches this org's currently
      // configured secondary currency — otherwise a stale localStorage value
      // from a previously-tried currency (or another org on a shared
      // browser) could silently select a currency the toggle no longer
      // offers.
      if (stored === "USD" || stored === secondaryCurrency) setDisplayCurrencyState(stored);
    } catch {
      // localStorage unavailable (e.g. private browsing) — just defaults to USD.
    }
  }, [secondaryCurrency]);

  useEffect(() => {
    if (!secondaryCurrency) return;
    let cancelled = false;
    async function loadRate() {
      try {
        const res = await fetch(`/api/exchange-rate?currency=${encodeURIComponent(secondaryCurrency!)}`);
        if (!res.ok) return;
        const data = (await res.json()) as Rate;
        if (!cancelled && typeof data.usdToTarget === "number") setRate(data);
      } catch {
        // Keep whatever rate (or null) we already had — format() falls back
        // to native-currency display when rate is null.
      }
    }
    loadRate();
    const interval = setInterval(loadRate, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [secondaryCurrency]);

  const setDisplayCurrency = useCallback((c: string) => {
    setDisplayCurrencyState(c);
    try {
      window.localStorage.setItem(STORAGE_KEY, c);
    } catch {
      // Non-fatal — the choice just won't persist across reloads.
    }
  }, []);

  const format = useCallback(
    (amount: number, nativeCurrency: string = "USD") => {
      if (!secondaryCurrency || nativeCurrency === displayCurrency || !rate) {
        return formatCurrency(amount, nativeCurrency);
      }
      const converted = convertAmountCents(Math.round(amount * 100), nativeCurrency, displayCurrency, rate.usdToTarget);
      if (converted === null) return formatCurrency(amount, nativeCurrency);
      return formatCurrency(converted / 100, displayCurrency);
    },
    [secondaryCurrency, displayCurrency, rate]
  );

  const value = useMemo(
    () => ({ secondaryCurrency, displayCurrency, setDisplayCurrency, rate, format }),
    [secondaryCurrency, displayCurrency, setDisplayCurrency, rate, format]
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    // Defensive fallback rather than throwing — lets any component that
    // forgets it needs the provider still render in native currency instead
    // of crashing the whole page.
    return {
      secondaryCurrency: null,
      displayCurrency: "USD",
      setDisplayCurrency: () => {},
      rate: null,
      format: (a, c = "USD") => formatCurrency(a, c),
    };
  }
  return ctx;
}
