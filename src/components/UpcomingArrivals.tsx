"use client";

import { useState } from "react";
import type { Booking } from "@/lib/types";
import { BookingsTable } from "@/components/BookingsTable";

// Dashboard's "Upcoming arrivals" with a Load-more pager (2026-08-16,
// Seni's ask — replaces the old exhaustive "All bookings" table at the
// bottom of the page). All rows arrive pre-fetched and name-resolved from
// the server component; this just controls how many are visible.
const PAGE_SIZE = 10;

export function UpcomingArrivals({ bookings, showTotal = true }: { bookings: Booking[]; showTotal?: boolean }) {
  const [visible, setVisible] = useState(PAGE_SIZE);

  return (
    <div>
      <BookingsTable bookings={bookings.slice(0, visible)} emptyLabel="No upcoming arrivals." showTotal={showTotal} />
      {bookings.length > visible && (
        <div className="mt-3 text-center">
          <button
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="rounded-md border border-black/15 dark:border-white/15 px-4 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
          >
            Load more ({bookings.length - visible} more)
          </button>
        </div>
      )}
    </div>
  );
}
