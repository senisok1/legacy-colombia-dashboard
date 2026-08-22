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
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 mt-1 flex-wrap">
            <div className="text-2xl font-semibold">{value}</div>
            {subValue && (
              <div className="text-sm text-black/50 dark:text-white/50">
                {subLabel ? `${subLabel} ` : ""}
                {subValue}
              </div>
            )}
          </div>
        </div>
        {/* Hidden on the narrowest screens: at 2-up on a phone there isn't
            room for both the figure and a chart without squeezing the
            number, which is the thing that actually matters. */}
        {chart && <div className="hidden sm:block shrink-0 mt-1 text-black/70 dark:text-white/70">{chart}</div>}
      </div>
      {hint && <div className="text-xs text-black/40 dark:text-white/40 mt-1">{hint}</div>}
    </div>
  );
}
