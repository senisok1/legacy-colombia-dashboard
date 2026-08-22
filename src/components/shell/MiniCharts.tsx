// Tiny inline-SVG chart primitives for the dashboard (2026-08-22 UI
// refresh). Deliberately hand-rolled rather than pulling in a charting
// library: these are 30-60px decorative-but-truthful shapes, the bundle
// stays exactly as it was, and every one inherits currentColor / the theme's
// --accent so they need no per-theme handling.
//
// All of them render ONLY from data passed in by the caller — they compute
// nothing and invent nothing. An empty or all-zero series renders as a flat
// baseline rather than a fabricated shape.

/** Sparkline — a revenue/occupancy trend at a glance. */
export function Sparkline({
  values,
  width = 84,
  height = 26,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    // 2px inset top and bottom so the stroke never clips at the extremes.
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return [x, y] as const;
  });
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = points[points.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <path d={area} fill="var(--accent)" opacity={0.13} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2} fill="var(--accent)" />
    </svg>
  );
}

/** Progress ring — occupancy, completion percentage. */
export function DonutRing({
  pct,
  size = 44,
  stroke = 5,
  label,
  className,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  /** Centre text. Omit for a bare ring. */
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = (clamped / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} opacity={0.14} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`}
        // Start at 12 o'clock instead of 3 o'clock.
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {label && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size * 0.26}
          fontWeight={600}
          fill="currentColor"
        >
          {label}
        </text>
      )}
    </svg>
  );
}

/** Mini bar column chart — per-month distribution. */
export function MiniBars({
  values,
  width = 84,
  height = 26,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length === 0) return null;
  const max = Math.max(...values) || 1;
  const gap = 2;
  const barW = Math.max(2, (width - gap * (values.length - 1)) / values.length);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * height);
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            rx={1}
            fill="var(--accent)"
            // Fade older months so the eye lands on the recent end.
            opacity={0.35 + 0.65 * (i / Math.max(1, values.length - 1))}
          />
        );
      })}
    </svg>
  );
}
