// Shared surface primitives for the module polish pass (2026-08-22).
//
// WHY THESE EXIST: after the shell refresh, every module inherited the new
// palette but kept its own hand-rolled
// `rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white
// dark:bg-white/5` string — repeated dozens of times across ~20 files. That
// meant "make the cards feel more premium" would have been a find-and-replace
// across the whole app every time, with drift guaranteed. Routing modules
// through these components instead makes each polish pass a wrapper swap,
// and any future spacing/radius/shadow change a one-file edit.
//
// Presentation only. None of these accept or affect data, permissions or
// behavior — they render whatever children they're given.

/** The standard module panel: titled section with optional right-hand
 *  actions and an optional subtitle. Replaces the repeated card div. */
export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Buttons/links shown at the top-right of the card header. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Set false when the child manages its own padding (e.g. a full-bleed table). */
  padded?: boolean;
}) {
  return (
    <section
      className={`rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 ${
        padded ? "p-3 md:p-4" : ""
      } ${className ?? ""}`}
    >
      {(title || actions) && (
        <div className={`flex items-start justify-between gap-3 ${padded ? "mb-3" : "p-3 md:p-4 pb-3"}`}>
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold leading-tight">{title}</h2>}
            {subtitle && (
              <p className="mt-0.5 text-xs text-black/50 dark:text-white/50 leading-snug">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A headline figure tile — the "Owed to Gabriel" / "Gabriel owes the house"
 *  style boxes. `tone` tints the border and label only; the figure itself
 *  always stays high-contrast so the number is never the thing that fades. */
export function KpiTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "neutral" | "accent" | "positive" | "warn";
}) {
  const TONES: Record<string, { border: string; label: string; glow: string }> = {
    neutral: {
      border: "border-black/10 dark:border-white/10",
      label: "text-black/50 dark:text-white/50",
      glow: "transparent",
    },
    accent: {
      border: "border-[var(--accent)]/30",
      label: "text-[var(--accent)]",
      glow: "rgba(20,184,166,0.06)",
    },
    positive: {
      border: "border-emerald-500/30",
      label: "text-emerald-500",
      glow: "rgba(16,185,129,0.05)",
    },
    warn: {
      border: "border-amber-500/30",
      label: "text-amber-500",
      glow: "rgba(245,158,11,0.05)",
    },
  };
  const s = TONES[tone] ?? TONES.neutral;
  return (
    <div
      className={`flex-1 min-w-[13rem] rounded-xl border ${s.border} p-3.5`}
      style={{ background: s.glow }}
    >
      <div className={`text-[11px] uppercase tracking-wide ${s.label}`}>{label}</div>
      {/* Full width on its own line — COP figures run ~4 characters longer
          than USD and previously collided with anything beside them. */}
      <div className="mt-1 text-2xl font-semibold leading-tight break-words">{value}</div>
      {hint && <div className="mt-1.5 text-[11px] leading-snug text-black/45 dark:text-white/45">{hint}</div>}
    </div>
  );
}

/** A single row in a list of records (a commission line, a stay, an item).
 *  Gives every module the same hover, radius and padding rhythm. */
export function RecordRow({
  children,
  highlight,
  className,
  ref,
}: {
  children: React.ReactNode;
  /** Draws attention to a row that just changed state. */
  highlight?: boolean;
  className?: string;
  /** Lets a caller scroll a specific row into view — used by Commissions
   *  to reveal a line that just moved into the approved list. React 19
   *  passes `ref` as an ordinary prop, so no forwardRef needed. */
  ref?: React.Ref<HTMLLIElement>;
}) {
  return (
    <li
      ref={ref}
      className={`rounded-lg px-3 py-2.5 text-sm transition-colors duration-1000 ${
        highlight
          ? "bg-emerald-500/20 ring-2 ring-emerald-500/50"
          : "bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
      } ${className ?? ""}`}
    >
      {children}
    </li>
  );
}

/** Consistent empty state — every module currently phrases these
 *  differently and styles them slightly differently. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-black/40 dark:text-white/40">{children}</p>;
}
