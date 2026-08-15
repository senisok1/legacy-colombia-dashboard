/** Defaults to USD (every existing caller before Bill Pay started tracking
 * COP vendor bills assumed USD) — pass a real ISO code (e.g. "COP") for
 * anything actually denominated in another currency so it doesn't render
 * with a misleading "$" prefix at face value. */
export function formatCurrency(amount: number, currency: string = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(
      amount || 0
    );
  } catch {
    // Unknown/invalid ISO code — fall back to a plain labeled number rather than throwing.
    return `${currency} ${Math.round(amount || 0).toLocaleString("en-US")}`;
  }
}

export function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
      new Date(iso)
    );
  } catch {
    return iso;
  }
}

export function formatShortDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** "5m ago", "3h ago", "2d ago" — falls back to a short date past a week. */
export function formatRelativeTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return formatShortDate(iso);
  } catch {
    return iso;
  }
}
