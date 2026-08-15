"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { SourceBreakdown } from "@/lib/finance";
import { useCurrency } from "@/components/CurrencyProvider";

const COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4"];

export function SourceChart({ data }: { data: SourceBreakdown[] }) {
  // useCurrency() is called here, at the top of the component body, then
  // captured by the Tooltip's formatter closure below — recharts calls that
  // formatter as a plain callback, not a component, so it can't call the
  // hook itself.
  const { format } = useCurrency();

  if (data.length === 0) {
    return <p className="text-sm text-black/50 dark:text-white/50 py-8 text-center">No revenue yet to break down.</p>;
  }

  return (
    <div className="flex items-center gap-4">
      <ResponsiveContainer width="60%" height={220}>
        <PieChart>
          <Pie data={data} dataKey="revenue" nameKey="source" innerRadius={45} outerRadius={80} paddingAngle={2}>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => format(Number(value))} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="space-y-1.5 text-sm">
        {data.map((d, i) => (
          <div key={d.source} className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="font-medium">{d.source}</span>
            <span className="text-black/50 dark:text-white/50">{format(d.revenue)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
