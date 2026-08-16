import { NextRequest, NextResponse, after } from "next/server";
import { getAllThreadSummaries, fetchAllThreadSummaries, getSnapshotThreadSummaries } from "@/lib/inbox";
import type { ThreadSummary } from "@/lib/inbox";
import { isMessagingConfigured } from "@/lib/config";
import { getSessionFromRequest } from "@/lib/session";

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
export async function GET(req: NextRequest) {
  if (!isMessagingConfigured()) {
    return NextResponse.json({ threads: [], messagingConfigured: false });
  }

  const session = getSessionFromRequest(req);
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
    // FINAL SOLUTION (2026-08-06): Return within 1 second MAX, never wait for API.
    // If cache is cold and fetch is slow, return empty. Client will see instant UI.
    // Cron keeps cache warm every 2 min, so subsequent loads are instant.
    //
    // BUG FIX (2026-08-07): as originally written, the "loser" of this race
    // (summariesPromise, when it takes >1s) was never awaited again after
    // NextResponse.json() below returns — and a Vercel serverless function
    // invocation can suspend/terminate its background work once the
    // response is sent. Since NOTHING else in the codebase ever calls
    // getAllThreadSummaries (confirmed via grep — the cron only warms the
    // separate per-thread getCachedThreadMessages cache), losing this race
    // meant the 30-min summaries cache could structurally never get warmed:
    // every request raced, every race (on a cold cache) lost, and the
    // computation that would have cached the result got cut off before
    // finishing. That's the real reason the Messaging tab could sit on
    // "No conversations found" / totalAvailable:0 indefinitely — not just
    // right after a deploy, but any time this cache expired — regardless of
    // the separate slice-before-sort bug also fixed today. `after()` (Next
    // 15+) keeps this specific promise running to completion in the
    // background after the response flushes, so a losing race still ends
    // with a warm cache for the next request instead of racing and losing
    // forever.
    const summariesPromise = getAllThreadSummaries(session?.organizationId);
    after(summariesPromise.then(() => {}).catch(() => {}));

    // INSTANT-LOAD FIX (2026-08-16): the race used to resolve to [] on a
    // cold cache, painting "No conversations found" until a 20-30s scan
    // finished. Now the timeout path resolves to the last known-good Redis
    // snapshot (started in parallel, ~tens of ms) so the first paint always
    // has real conversations; the client's ?fresh=1 follow-up updates it.
    const snapshotPromise = getSnapshotThreadSummaries(session?.organizationId).catch(() => null);
    const timeoutPromise = new Promise<ThreadSummary[]>((resolve) =>
      setTimeout(async () => resolve(((await snapshotPromise) ?? []).slice(0, limit)), 900)
    );

    let summaries = await Promise.race([summariesPromise, timeoutPromise]);

    const threads = summaries.map((s) => ({
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
    }));

    // Pagination: return info for "Load more" button
    const totalAvailable = summaries.length >= limit ? "280+" : summaries.length;
    const hasMore = summaries.length >= limit;

    return NextResponse.json({ threads, messagingConfigured: true, hasMore, totalAvailable });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/messages/inbox failed:", message);
    return NextResponse.json({ error: message, messagingConfigured: true }, { status: 502 });
  }
}
