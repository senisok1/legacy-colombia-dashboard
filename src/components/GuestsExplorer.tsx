"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { GuestWithStats } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { useCurrency } from "@/components/CurrencyProvider";

export function GuestsExplorer({ guests }: { guests: GuestWithStats[] }) {
  const { format } = useCurrency();
  const [query, setQuery] = useState("");
  const [repeatOnly, setRepeatOnly] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return guests.filter((g) => {
      if (repeatOnly && !g.isRepeat) return false;
      if (!q) return true;
      return (
        g.fullName.toLowerCase().includes(q) ||
        (g.email ?? "").toLowerCase().includes(q) ||
        (g.phone ?? "").toLowerCase().includes(q) ||
        g.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [guests, query, repeatOnly]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search guests by name, phone, email, or tag…"
          className="flex-1 rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
        />
        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <input type="checkbox" checked={repeatOnly} onChange={(e) => setRepeatOnly(e.target.checked)} />
          Repeat guests only
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-black/50 dark:text-white/50 border-b border-black/10 dark:border-white/10">
              <th className="py-2 pr-4 font-medium">Guest</th>
              <th className="py-2 pr-4 font-medium">Phone</th>
              <th className="py-2 pr-4 font-medium">Email</th>
              <th className="py-2 pr-4 font-medium">Stays</th>
              <th className="py-2 pr-4 font-medium">Lifetime value</th>
              <th className="py-2 pr-4 font-medium">Last stay</th>
              <th className="py-2 pr-4 font-medium">Tags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((g) => (
              <tr key={g.id} className="border-b border-black/5 dark:border-white/5 last:border-0">
                <td className="py-2 pr-4">
                  <Link href={`/guests/${g.id}`} className="font-medium hover:underline">
                    {g.fullName}
                  </Link>
                  {g.isRepeat && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300">
                      repeat
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-black/60 dark:text-white/60">{g.phone || "—"}</td>
                <td className="py-2 pr-4 text-black/60 dark:text-white/60">{g.email || "—"}</td>
                <td className="py-2 pr-4">
                  {g.totalStays} stay{g.totalStays === 1 ? "" : "s"} · {g.totalNights} nights
                </td>
                <td className="py-2 pr-4">{format(g.lifetimeValue)}</td>
                <td className="py-2 pr-4">{formatDate(g.lastStay)}</td>
                <td className="py-2 pr-4">
                  <div className="flex flex-wrap gap-1">
                    {g.tags.map((t) => (
                      <span key={t} className="text-xs px-1.5 py-0.5 rounded-full bg-black/5 dark:bg-white/10">
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-black/50 dark:text-white/50">
                  No guests match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
