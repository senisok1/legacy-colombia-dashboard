import { after } from "next/server";
import { redisGet, redisSet } from "./redis";
import { isRedisConfigured } from "./config";

// INSTANT SSR (2026-08-19, Seni: "I need them to be instant along with
// checking all other tabs so that everything is instant"): the Dashboard and
// Reports pages are Server Components that used to block their entire HTML
// response on live OwnerRez fetches (getBookings + getGuests — the cold
// getGuests path fans out one request per guest and could take 10-20s).
// This is the same serve-stale-while-revalidate pattern the Team Management
// board and Messaging inbox already use, generalized for SSR: serve the
// last known-good snapshot from Redis in one O(1) GET, schedule the real
// rebuild in the background (after() — runs post-response), and let the
// page's <AutoRefresh /> client component call router.refresh() moments
// later so the fresh rebuild replaces what's on screen without the person
// doing anything.
//
// Only ever bypassed when Redis is unconfigured or genuinely has no entry
// yet (first visit per org+group, or after the TTL) — that one visit pays
// the full build cost and seeds the snapshot for everyone after it.
export async function ssrSnapshotFirst<T>(
  key: string,
  ttlSeconds: number,
  build: () => Promise<T>
): Promise<{ data: T; fromSnapshot: boolean }> {
  const buildAndStore = async (): Promise<T> => {
    const data = await build();
    if (isRedisConfigured()) {
      await redisSet(key, JSON.stringify(data), { exSeconds: ttlSeconds }).catch(() => {});
    }
    return data;
  };

  if (isRedisConfigured()) {
    try {
      const raw = await redisGet(key);
      if (raw) {
        after(buildAndStore().catch(() => {}));
        return { data: JSON.parse(raw) as T, fromSnapshot: true };
      }
    } catch {
      // Redis hiccup — fall through to the live build below.
    }
  }
  return { data: await buildAndStore(), fromSnapshot: false };
}
