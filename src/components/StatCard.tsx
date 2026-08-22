export function StatCard({
  label,
  value,
  subLabel,
  subValue,
  hint,
  chart,
}: {
  label: string;
  // Widened from `string` to `React.ReactNode` (2026-08-05) so callers in
  // Server Components can pass a <Money amount={...} /> client leaf here to
  // stay currency-toggle-aware (see CurrencyProvider.tsx) without the whole
  // page needing to become a Client Component just for that.
  value: React.ReactNode;
  // Optional second figure shown next to the main one — used for gross vs.
  // net payout, where the two numbers matter equally and neither should be
  // buried in the hint text.
  subLabel?: string;
  subValue?: React.ReactNode;
  // Widened from `string` to `React.ReactNode` (2026-08-22, Seni: a hint
  // that mixes a USD-native figure and a COP-native figure as a plain
  // hardcoded string never reacts to the currency toggle — same reasoning
  // as `value` above. Callers with a currency-toggle-aware hint should pass
  // <Money> leaves inside it instead of interpolating numbers into text.
  hint?: React.ReactNode;
  // Optional mini chart (sparkline / ring / bars) shown to the right of the
  // figure — 2026-08-22, Seni's ask to put charts on the dashboard. Purely
  // decorative-but-truthful: callers derive it from the same numbers the
  // card already displays. Omitted, the card renders exactly as before.
  chart?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 md:p-4 bg-white dark:bg-white/5">
      <div className="text-xs uppercase tracking-wide text-black/50 dark:text-white/50">{label}</div>
      {/* The headline figure gets the card's FULL width on its own row.
          It previously shared a flex row with the chart, which was fine for
          "$79,291" but broke on "COP 290,513,086" — in COP the numbers are
          ~3 orders of magnitude longer, so the value overflowed its track
          and the sparkline drew straight over the digits (reported
          2026-08-22 with a screenshot). Giving the number its own row means
          no currency, and no future longer figure, can ever collide with
          the chart. */}
      <div className="mt-1 text-2xl font-semibold break-words">{value}</div>
      {/* Sub-value and chart share the second row — the chart sits against
          the smaller "Net …" text, matching the mock, and is right-aligned
          whether or not a sub-value exists. */}
      {(subValue || chart) && (
        <div className="mt-0.5 flex items-end justify-between gap-3">
          <div className="min-w-0 text-sm text-black/50 dark:text-white/50">
            {subValue && (
              <>
                {subLabel ? `${subLabel} ` : ""}
                {subValue}
              </>
            )}
          </div>
          {/* Hidden on the narrowest screens: at 2-up on a phone the row is
              too tight for both, and the number is what actually matters. */}
          {chart && <div className="hidden sm:block shrink-0 text-black/70 dark:text-white/70">{chart}</div>}
        </div>
      )}
      {hint && <div className="text-xs text-black/40 dark:text-white/40 mt-1">{hint}</div>}
    </div>
  );
}
