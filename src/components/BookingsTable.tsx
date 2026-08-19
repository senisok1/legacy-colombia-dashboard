"use client";

import type { Booking } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { Money } from "@/components/Money";
import { useT, useLanguage } from "@/components/LanguageProvider";
import { statusLabel } from "@/lib/i18n";

const statusColors: Record<string, string> = {
  Booked: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  "Checked In": "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  "Checked Out": "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  Cancelled: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  Hold: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  Quote: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300",
  Inquiry: "bg-purple-50 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
  Unknown: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
};

// showTotal=false hides the money column (READ_ONLY team dashboards, 2026-08-16).
export function BookingsTable({ bookings, emptyLabel, showTotal = true }: { bookings: Booking[]; emptyLabel?: string; showTotal?: boolean }) {
  const t = useT();
  const lang = useLanguage();
  if (bookings.length === 0) {
    return <p className="text-sm text-black/50 dark:text-white/50 py-6 text-center">{emptyLabel ?? t("table.noBookings")}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-black/50 dark:text-white/50 border-b border-black/10 dark:border-white/10">
            <th className="py-2 pr-4 font-medium">{t("table.guest")}</th>
            <th className="py-2 pr-4 font-medium">{t("table.arrival")}</th>
            <th className="py-2 pr-4 font-medium">{t("table.departure")}</th>
            <th className="py-2 pr-4 font-medium">{t("table.nights")}</th>
            <th className="py-2 pr-4 font-medium">{t("table.source")}</th>
            <th className="py-2 pr-4 font-medium">{t("table.status")}</th>
            {showTotal && <th className="py-2 pr-4 font-medium text-right">{t("table.total")}</th>}
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => (
            <tr key={b.id} className="border-b border-black/5 dark:border-white/5 last:border-0">
              <td className="py-2 pr-4">{b.guestName || "—"}</td>
              <td className="py-2 pr-4">{formatDate(b.arrival)}</td>
              <td className="py-2 pr-4">{formatDate(b.departure)}</td>
              <td className="py-2 pr-4">{b.nights}</td>
              <td className="py-2 pr-4">{b.source}</td>
              <td className="py-2 pr-4">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[b.status] ?? statusColors.Unknown}`}>
                  {statusLabel(b.status, lang)}
                </span>
              </td>
              {showTotal && (
                <td className="py-2 pr-4 text-right">
                  <Money amount={b.totalAmount} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
