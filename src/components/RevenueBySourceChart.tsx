import type { SourceBreakdown } from "@/lib/finance";
import { Money } from "@/components/Money";

// Fixed palette (not generated) so a given channel keeps the same color
// across reloads even as the underlying data changes month to month.
//
// Retuned 2026-08-22 for the premium refresh: a teal-led ramp with warm
// stone/gold accents, instead of the old primary blue/amber/red rainbow.
// Segments stay clearly distinguishable (that's the whole job of a pie
// palette) while reading as one deliberate palette rather than default
// chart colours — the brief calls for teal on charts and warm gold used
// very sparingly. Order matters: the biggest channel takes the first entry,
// so sea-teal leads.
const COLORS = [
  "#14b8a6", // sea teal — primary accent
  "#5eead4", // soft teal
  "#0e7490", // deep teal
  "#d4af37", // warm gold, used sparingly
  "#b8b4aa", // muted stone
  "#2dd4bf", // bright teal
  "#7dd3fc", // pale sky, for long tails
  "#8b7355", // warm brown
];

// Pure-SVG donut chart — no charting library dependency needed for a single
// pie chart. Built as a stacked set of arcs around a circle using basic
// trigonometry (SVG has no native pie/arc primitive, so each slice is a
// <path> built from an arc command between two points on the circle).
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y} Z`;
}

export function RevenueBySourceChart({ breakdown }: { breakdown: SourceBreakdown[] }) {
  const total = breakdown.reduce((sum, s) => sum + s.revenue, 0);
  const slices = breakdown.filter((s) => s.revenue > 0);

  if (total <= 0) {
    return <p className="text-sm text-black/40 dark:text-white/40 py-8 text-center">No revenue booked yet.</p>;
  }

  const cx = 60;
  const cy = 60;
  const r = 55;
  // Built with reduce (rather than a mutable running-angle variable) so the
  // render stays a pure function of props — each slice's start angle is
  // just the sum of every prior slice's share of the circle.
  const paths = slices.reduce<
    { source: string; revenue: number; netRevenue: number; bookings: number; path: string; color: string }[]
  >((acc, s, i) => {
      const angleCursor = acc.reduce((sum, p) => sum + (p.revenue / total) * 360, 0);
      const sliceAngle = (s.revenue / total) * 360;
      const path = arcPath(cx, cy, r, angleCursor, angleCursor + sliceAngle);
      acc.push({ ...s, path, color: COLORS[i % COLORS.length] });
      return acc;
    },
    []
  );

  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 120 120" className="w-32 h-32 shrink-0">
        {paths.map((p) => (
          <path key={p.source} d={p.path} fill={p.color} stroke="var(--background, #fff)" strokeWidth="1" />
        ))}
        {/* Donut hole */}
        <circle cx={cx} cy={cy} r={30} className="fill-white dark:fill-[#0a0a0a]" />
      </svg>
      <div className="flex-1 space-y-2 min-w-0">
        {paths.map((p) => (
          <div key={p.source} className="text-xs">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: p.color }} />
              <span className="truncate flex-1">{p.source}</span>
              <span className="text-black/50 dark:text-white/50 shrink-0">
                <Money amount={p.revenue} /> · {Math.round((p.revenue / total) * 100)}%
              </span>
            </div>
            <div className="pl-[18px] text-[11px] text-black/40 dark:text-white/40">
              Net <Money amount={p.netRevenue} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
