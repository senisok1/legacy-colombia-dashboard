"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// Companion to lib/ssrSnapshot.ts (2026-08-19, the "everything instant"
// pass): when an SSR page was served from a Redis snapshot, the real data is
// being rebuilt in the background — this invisibly re-runs the server render
// a couple of times shortly after paint so the fresh rebuild replaces the
// snapshot on screen without the person touching anything. Two attempts:
// one quick (a warm rebuild finishes in a couple of seconds) and one later
// (covers the cold getGuests fan-out case). Renders nothing.
export function AutoRefresh({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!enabled || ranRef.current) return;
    // Guard against re-running when router.refresh() itself re-renders the
    // tree — the client component instance (and this ref) survives refresh.
    ranRef.current = true;
    const timers = [setTimeout(() => router.refresh(), 5_000), setTimeout(() => router.refresh(), 25_000)];
    return () => timers.forEach(clearTimeout);
  }, [enabled, router]);

  return null;
}
