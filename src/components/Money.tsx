"use client";

import { useCurrency } from "./CurrencyProvider";

// Small client leaf for dropping a currency-toggle-aware amount into an
// otherwise server-rendered page (Dashboard, guest detail, BookingsTable,
// RevenueBySourceChart, ExecutiveSummary) without making the whole page a
// client component just to read the USD/COP toggle from context.
export function Money({
  amount,
  currency = "USD",
  className,
}: {
  amount: number;
  currency?: string;
  className?: string;
}) {
  const { format } = useCurrency();
  return <span className={className}>{format(amount, currency)}</span>;
}
