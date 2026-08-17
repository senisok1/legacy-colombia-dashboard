// Safe totalling of amounts that may be in different currencies
// (2026-08-17 audit).
//
// THE BUG THIS EXISTS TO PREVENT. Several rollups summed a raw number across
// rows whose `currency` differed, then rendered the result with a hard-coded
// "USD". A single 500,000 COP expense request (~$125) made the Team Expense
// approval banner read "$500,125" — a ~4,000x overstatement on the exact
// screen used to decide what to approve. The per-row rendering was correct;
// only the rollup discarded the currency.
//
// WHY NOT JUST CONVERT. Converting needs a live USD/COP rate, and the
// existing code fell back to summing unconverted when the rate hadn't
// loaded yet or the endpoint failed — which substitutes a silent magnitude
// error for a missing one. A total that is occasionally absent is safe; a
// total that is occasionally 4,000x wrong is not.
//
// So: group by currency and present each separately. No FX dependency, no
// magnitude error possible, and it reads honestly when a property genuinely
// has costs in two currencies.

export type CurrencyTotal = { currency: string; amount: number };

/** Sums amounts per currency, largest first. Rows with no amount are skipped. */
export function sumByCurrency<T>(
  rows: T[],
  amountOf: (row: T) => number | null | undefined,
  currencyOf: (row: T) => string | null | undefined
): CurrencyTotal[] {
  const byCurrency = new Map<string, number>();
  for (const row of rows) {
    const amount = amountOf(row);
    if (amount === null || amount === undefined || !Number.isFinite(amount)) continue;
    const currency = (currencyOf(row) || "USD").toUpperCase();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
  }
  return [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
    .filter((t) => t.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Renders per-currency totals as one string, e.g. "$450.00 + COP 500,000".
 * `format` is the caller's own money formatter so this stays presentation-agnostic.
 */
export function formatCurrencyTotals(
  totals: CurrencyTotal[],
  format: (amount: number, currency: string) => string
): string {
  return totals.map((t) => format(t.amount, t.currency)).join(" + ");
}
