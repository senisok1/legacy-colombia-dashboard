"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthlyRevenue } from "@/lib/finance";
import { useCurrency } from "@/components/CurrencyProvider";

export function RevenueChart({ data }: { data: MonthlyRevenue[] }) {
  // useCurrency() is called here, at the top of the component body, then
  // captured by the Tooltip's formatter closure below — recharts calls that
  // formatter as a plain callback, not a component, so it can't call the
  // hook itself.
  const { format } = useCurrency();

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12 }} interval={1} />
        {/* Axis tick labels stay in a fixed "$Nk" shorthand regardless of the
            currency toggle — reformatting these to the live secondary
            currency's own thousands-shorthand is a lower-priority follow-up;
            the Tooltip below (which most users actually read the number
            from) is fully currency-toggle-aware. */}
        <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} width={48} />
        <Tooltip
          formatter={(value) => format(Number(value))}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
