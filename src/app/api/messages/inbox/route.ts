import { NextRequest, NextResponse, after } from "next/server";
import { getAllThreadSummaries, fetchAllThreadSummaries, getSnapshotThreadSummaries } from "@/lib/inbox";
import type { ThreadSummary } from "@/lib/inbox";
import { isMessagingConfigured } from "@/lib/config";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";
// Increased to 120s to handle queue backlog when cron runs simultaneously.
// Even with caching, getBookings/getGuests can queue behind cron's thread fetches.
// 120s provides headroom without hitting Vercel's hard 300s limit.
export const maxDuration = 120;

// Lightweight list view for the Inbox tab's left-hand conversation list —
// intentionally does NOT include translations or AI drafts (those are
// per-thread and fetched only when a conversation is actually opened, via
// GET /api/messages/thread/[threadId]) so this stays fast even with a
// couple hundred threads.
//
// `?fresh=1` bypasses the short cache in lib/inbox.ts entirely and hits
// OwnerRez live for every thread — used by ThreadInbox.tsx right after the
// initial (cached, instant) paint, and on its periodic refresh, so a new
// guest message shows up here within seconds of existing in OwnerRez
// instead of waiting out the cache window. See getAllThreadSummaries's
// comment in lib/inbox.ts for why this exists.
function toThreadListItem(s: ThreadSummary) {
  return {
    threadId: s.threadId,
    bookingId: s.booking.id,
    guestId: s.booking.guestId,
    guestName: s.guestName,
    propertyName: s.booking.propertyName,
    arrival: s.booking.arrival,
    departure: s.booking.departure,
    source: s.booking.source,
    lastMessagePreview: s.lastMessage?.body?.slice(0, 140) ?? "",
    lastMessageAt: s.lastMessage?.sentAt,
    awaitingReply: s.awaitingReply,
  };
}

export async function GET(req: NextRequest) {
  if (!isMessagingConfigured()) {
    return NextResponse.json({ threads: [], messagingConfigured: false });
  }

  const session = getSessionFromRequest(req);
  const groupId = effectivePropertyGroupId(
    req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
  );
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const limit = req.nextUrl.searchParams.get("limit")
    ? parseInt(req.nextUrl.searchParams.get("limit")!)
    : 20; // Default to first 20 conversations to keep initial load fast

  // Wrapped in try/catch (added 2026-07-31) — a transient OwnerRez failure
  // (rate limit, timeout, etc.) used to bubble up as an unhandled 500 with
  // no {threads: [...]} body. ThreadInbox.tsx's client-side fetch didn't
  // check res.ok either, so it would coerce that into an empty array via
  // `threads ?? []` and silently render "No conversations found." — wiping
  // out a perfectly good, already-showing conversation list (including real
  // guest threads like Nyree Tanielian's) on every one of its 45-second
  // background refreshes that happened to hit a flaky upstream call. See
  // ThreadInbox.tsx's fetchThreads for the matching client-side fix.
  try {
    // SNAPSHOT-FIRST REWRITE (2026-08-19, Seni: "the inbox under messaging
    // took 20 seconds to load"). The previous design raced the real
    // computation against a 900ms timer — but on a warm-ish Data Cache the
    // real computation could take anywhere between 1s and 20s+ (a partially
    // cold thread-messages batch pays paced live OwnerRez calls), and
    // because Promise.race only settles on the FIRST result, a computation
    // that took 20s while the timer path was still awaiting the Redis GET
    // inside its setTimeout callback... in practice the race mostly worked,
    // but any hiccup in the timer path (slow Redis read, event-loop
    // starvation while the paced batch loop churned) let the slow
    // computation win the wait. Now the snapshot path IS the primary path:
    // a non-fresh request does ONE O(1) Redis read and returns — never an
    // OwnerRez call, never a paced scan, no timers — and schedules the real
    // recompute via after() so the snapshot stays current. The client
    // follows up with ?fresh=1 (restored below in ThreadInbox.tsx) to
    // replace the instant list with a fully live one.
    //
    // BUG-FIX HISTORY preserved from the old race design (2026-08-07):
    // whatever computation runs must be kept alive via after() — a Vercel
    // invocation can suspend background work once the response is sent, and
    // nothing else in the codebase calls getAllThreadSummaries, so without
    // after() the summaries cache could structurally never warm.
    if (!fresh) {
      const snapshot = await getSnapshotThreadSummaries(session?.organizationId, groupId).catch(() => null);
      after(
        getAllThreadSummaries(session?.organizationId, undefined, groupId)
          .then(() => {})
          .catch(() => {})
      );
      if (snapshot && snapshot.length > 0) {
        const summaries = snapshot.slice(0, limit);
        return NextResponse.json({
          threads: summaries.map(toThreadListItem),
          messagingConfigured: true,
          hasMore: summaries.length >= limit,
          totalAvailable: summaries.length >= limit ? "280+" : summaries.length,
        });
      }
      // No snapshot yet (first-ever load for this org+group, or Redis
      // flushed): fall through to the real computation below — one slow
      // load that seeds the snapshot for every load after it.
    }

    const summariesPromise = fresh
      ? fetchAllThreadSummaries(session?.organizationId, limit, groupId)
      : getAllThreadSummaries(session?.organizationId, undefined, groupId);
    after(summariesPromise.then(() => {}).catch(() => {}));
    const summaries: ThreadSummary[] = await summariesPromise;

    // Pagination: return info for "Load more" button
    const totalAvailable = summaries.length >= limit ? "280+" : summaries.length;
    const hasMore = summaries.length >= limit;

    return NextResponse.json({ threads: summaries.map(toThreadListItem), messagingConfigured: true, hasMore, totalAvailable });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/messages/inbox failed:", message);
    return NextResponse.json({ error: message, messagingConfigured: true }, { status: 502 });
  }
}
