"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Tiny client-side sliver for otherwise-server-rendered pages (see
// app/activity/page.tsx) that just need a manual "get me the latest" action
// without the complexity of a client-side polling data layer — audit-log
// entries don't need to be live-updating the way the Approvals queue does.
export function RefreshButton() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  function refresh() {
    setRefreshing(true);
    router.refresh();
    setTimeout(() => setRefreshing(false), 600);
  }

  return (
    <button
      onClick={refresh}
      disabled={refreshing}
      className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
    >
      {refreshing ? "Refreshing…" : "Refresh"}
    </button>
  );
}
