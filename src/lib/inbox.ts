import { unstable_cache } from "next/cache";
import { getBookings, getGuests, getThreadMessages } from "./ownerrez";
import { resolveGuestName, buildGuestsById } from "./guestName";
import { redisGet, redisSet } from "./redis";
import { isRedisConfigured } from "./config";
import type { Booking, ThreadMessage } from "./types";

export type ThreadSummary = {
  threadId: number;
  booking: Booking;
  guestName: string; // resolved via guestName.ts — see that file for why this can't just be booking.guestName
  messages: ThreadMessage[]; // full history, chronological
  lastMessage?: ThreadMessage;
  // True when the newest message is guest-authored — i.e. this thread is
  // waiting on a host reply, the same signal used to decide whether to
  // draft an AI suggestion for it.
  awaitingReply: boolean;
};

// The Inbox's first load was fetching every conversation thread the
// account has ever had (156 of them at last count) — one live OwnerRez API
// call per thread, in parallel, but still real network round trips — which
// made opening the tab noticeably slow. Bounding to roughly the last year
// of stays keeps it fast while still covering everything an owner would
// actually work from day to day. It also naturally keeps the AI's style
// calibration (getGlobalHostStyleExamples below) weighted toward how Seni
// writes *now*, not conversations from years ago.
const RECENCY_WINDOW_DAYS = 365;

function isRecentEnough(booking: Booking): boolean {
  if (!booking.departure) return true; // no date info — don't accidentally hide it
  const cutoffMs = Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const departureMs = new Date(booking.departure).getTime();
  return Number.isNaN(departureMs) || departureMs >= cutoffMs;
}

// OwnerRez enforces a per-IP rate limit of 300 requests per 5 minutes
// (confirmed via their API docs 2026-07-31 — roughly 1 req/sec sustained).
// Firing one getThreadMessages call per candidate booking via a single
// Promise.all — well over a hundred at once for this account — blew straight
// through that limit and came back as 429s (confirmed live: "OwnerRez API
// /messages (thread ...) returned 429: Rate limit exceeded"). Every failed
// thread got silently dropped by the catch block below, and once enough of
// them failed the whole Inbox list rendered as "No conversations found." —
// this is the real cause of the Messaging tab intermittently going empty
// (2026-07-31), not a data or auth problem.
//
// Two layers fix this: (1) each thread's messages are cached individually
// (see getCachedThreadMessages below) so a typical scan only makes a live
// OwnerRez call for threads with genuinely new activity, not all of them —
// this is what keeps a warm scan fast AND cheap; (2) whatever does still need
// a live call runs in small paced batches with a 429-specific retry, so even
// a fully cold cache (e.g. right after a deploy) degrades to "slower" rather
// than "OwnerRez throttles us and threads silently vanish."
// Bumped 2026-08-05 (4/1100ms -> 12/800ms) after the Messaging tab started
// failing outright with "Failed to fetch" on a cold cache: adding the
// Nukak - Casa #19 property roughly doubled the account's total booking/
// thread volume (280+ bookings now carry thread_ids, up from ~150 when 4/
// 1100ms was chosen), and 4-per-1.1s could no longer walk that many
// candidates within this route's 60s maxDuration — Vercel kills the
// function mid-scan, which the browser sees as a bare network failure, not
// a clean error response (see api/messages/inbox/route.ts's try/catch,
// which never gets a chance to run). 12/800ms is still a small, paced
// fraction of OwnerRez's documented 300-req/5-min budget (a full 300-
// candidate cold scan is ~300 requests in ~20s, i.e. nowhere near a
// sustained rate that would trip the limit that caused the original 4/
// 1100ms choice — that incident was one single ~150-request Promise.all,
// not a paced batch loop) while comfortably finishing well inside the 60s
// window with room to spare for real network latency.
const THREAD_FETCH_BATCH_SIZE = 12;
const THREAD_FETCH_BATCH_DELAY_MS = 800;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The Inbox LIST view doesn't need millisecond-fresh messages — opening a
// conversation already does its own live fetch (see
// api/messages/thread/[threadId]/route.ts) — it just needs to avoid
// re-requesting every one of this account's 150+ threads from OwnerRez on
// every single scan, including the ?fresh=1 "uncached" path below, which
// used to mean fully uncached and was the main driver of the rate-limit
// hits. A short per-thread cache means only threads with real new activity
// cost a live call on a given scan.
//
// Diagnosed 2026-08-05 (round 2): this cache alone wasn't the problem —
// api/cron/check-messages/route.ts's own message-fetch loop was calling
// getThreadMessages() directly (bypassing this cache entirely), so its
// every-60-second run was a FULL uncached live fetch of every active
// thread, on top of whatever the Inbox tab was doing at the same moment.
// That's what actually blew through OwnerRez's 300-req/5-min budget
// (confirmed via sustained 429s on /bookings, /properties, AND /messages in
// Vercel logs, ~21:04-21:29). Fixed by having the cron import and use this
// exact cache (see getCachedThreadMessages export below) instead of calling
// getThreadMessages directly, so cron runs and Inbox-tab loads now share one
// cache instead of each doing their own full live scan. Bumped from 60s to
// 120s at the same time, deliberately longer than the cron's 60s cadence, so
// a typical back-to-back cron run is a cache hit rather than a coin flip —
// worst-case new-message detection latency goes from "up to 60s" to "up to
// 120s" (still far better than the pre-fix failure mode of messages being
// missed outright during a rate-limit outage).
const THREAD_MESSAGES_CACHE_SECONDS = 120;

// Fallback snapshot for the full sorted summaries list — see the "BUG FOUND
// 2026-08-10" comment inside fetchAllThreadSummaries for why this exists.
// TTL bumped 24h -> 7 days (2026-08-16): this snapshot is now ALSO the
// instant-first-paint source for the Inbox (see getSnapshotThreadSummaries
// below) — a week-old list that paints instantly and is refreshed by the
// client within seconds beats an empty "No conversations found" every time.
const THREAD_SUMMARIES_FALLBACK_KEY_PREFIX = "ownerrez:thread-summaries-fallback:";
const THREAD_SUMMARIES_FALLBACK_TTL_SECONDS = 7 * 24 * 60 * 60;

/** INSTANT-LOAD PATH (2026-08-16, Seni: "conversations took too long to
 * initially load"). The inbox route used to race the real computation
 * against a 1s timeout and return EMPTY on a cold cache — so after every
 * deploy (and every 30-min cache expiry) the tab painted "No conversations
 * found" and sat there until a 20-30s paced OwnerRez scan finished. This
 * reads the last known-good sorted snapshot straight from Redis (single
 * O(1) GET, ~tens of ms, survives deploys) so the first paint always has
 * real conversations; ThreadInbox's existing after-paint ?fresh=1 call and
 * 45s polling keep it current, and every healthy recompute rewrites the
 * snapshot. */
export async function getSnapshotThreadSummaries(organizationId?: string): Promise<ThreadSummary[] | null> {
  if (!isRedisConfigured()) return null;
  try {
    const raw = await redisGet(threadSummariesFallbackKey(organizationId));
    if (!raw) return null;
    return JSON.parse(raw) as ThreadSummary[];
  } catch {
    return null; // cache hiccup must never break the inbox
  }
}

function threadSummariesFallbackKey(organizationId?: string): string {
  return `${THREAD_SUMMARIES_FALLBACK_KEY_PREFIX}${organizationId ?? "default"}`;
}

// ROOT CAUSE FIX (2026-08-10, Seni's ask: "conversations are taking a long
// time to load" — the 2026-08-08 fast-path fix didn't actually hold in
// production). Diagnosed by adding temporary timing instrumentation to the
// thread route: getAllThreadSummaries (the 30-min unstable_cache below) was
// taking a genuine ~20-29s EVERY time it was called from
// api/messages/thread/[threadId]/route.ts, even seconds after
// api/messages/inbox/route.ts had just gotten a 210ms hit for the exact same
// org id and the exact same underlying function. Same wrapped function,
// same cache key, wildly different latency depending on which API route
// (i.e. which separate Vercel serverless function) called it — meaning
// Next's unstable_cache Data Cache is NOT reliably shared across these two
// route handlers in this deployment, despite the inline comments elsewhere
// in this file assuming it is. Rather than depend on that (evidently
// unreliable) cross-route sharing for the one thing that matters most for
// perceived speed — opening a conversation — the booking/guestName "warm"
// lookup now goes through Redis instead, which every other piece of shared
// state in this app (pendingDrafts.ts, translate.ts) already uses
// successfully across routes. Written here, every time the list is
// (re)computed; read directly by threadId in the thread route, with no
// dependency on getAllThreadSummaries at all on the read side — a single
// O(1) key lookup instead of hoping a 20-item unstable_cache entry is warm.
// v2: bumped 2026-08-10 to skip past entries written during the rate-limit-
// triggered "Guest" regression described above — see getAllThreadSummaries'
// own v3->v4 bump for the same incident.
function threadSummaryLiteKey(orgId: string, threadId: number): string {
  return `thread-summary-lite-v2:${orgId}:${threadId}`;
}

const THREAD_SUMMARY_LITE_TTL_SECONDS = 1800; // matches getAllThreadSummaries' own window

export type ThreadSummaryLite = Pick<ThreadSummary, "booking" | "guestName">;

export async function getCachedThreadSummaryLite(
  threadId: number,
  organizationId?: string
): Promise<ThreadSummaryLite | null> {
  if (!isRedisConfigured() || !organizationId) return null;
  try {
    const raw = await redisGet(threadSummaryLiteKey(organizationId, threadId));
    if (!raw) return null;
    return JSON.parse(raw) as ThreadSummaryLite;
  } catch {
    return null; // a cache-layer hiccup should never break opening a conversation
  }
}

async function warmThreadSummaryLiteCache(summaries: ThreadSummary[], organizationId?: string): Promise<void> {
  if (!isRedisConfigured() || !organizationId || summaries.length === 0) return;
  try {
    await Promise.all(
      summaries.map((s) =>
        redisSet(
          threadSummaryLiteKey(organizationId, s.threadId),
          JSON.stringify({ booking: s.booking, guestName: s.guestName } satisfies ThreadSummaryLite),
          { exSeconds: THREAD_SUMMARY_LITE_TTL_SECONDS }
        )
      )
    );
  } catch {
    // Best-effort — the thread route's own cold-lookup fallback still works
    // correctly if this never gets written.
  }
}

// PAGINATION: Load conversations in batches to avoid API timeouts.
// 20 per page keeps initial load fast (<5s) even with 280+ total conversations.
// User can click "Load more" to expand the list.
const INBOX_PAGE_SIZE = 20;
// Phase 3: threads an optional organizationId through — same
// arguments-not-globals reasoning as lib/ownerrez.ts's own unstable_cache
// exports (see that file's top-of-file comment): Next's Data Cache keys on
// the call arguments, so adding organizationId as a real parameter here (and
// NOT reading it from any module-global) is what keeps one org's cached
// thread-message result from leaking into another org's poll/enrich call.
// Exported (not just used internally) so api/cron/check-messages/route.ts's
// polling loop can share this exact cache — see the comment above.
export const getCachedThreadMessages = unstable_cache(
  (threadId: number, organizationId?: string) => getThreadMessages(threadId, organizationId),
  ["ownerrez-thread-messages-v1"],
  { revalidate: THREAD_MESSAGES_CACHE_SECONDS }
);

async function fetchAllThreadSummaries(organizationId?: string, limit: number = INBOX_PAGE_SIZE): Promise<ThreadSummary[]> {
  const [bookings, guests] = await Promise.all([getBookings(organizationId), getGuests(organizationId)]);
  const guestsById = buildGuestsById(guests);

  const candidates = bookings.filter((b) => !b.isBlock && b.threadIds.length > 0 && isRecentEnough(b));

  const base = candidates.map((booking) => ({
    threadId: booking.threadIds[0],
    booking,
    guestName: resolveGuestName(booking, guestsById),
  }));

  // BUG FIX (2026-08-07, part 2 — Seni caught this the same day the first
  // fix shipped): the first fix corrected "slice before sort" but still
  // sorted by the booking's OWN stay dates (departure/arrival), not by when
  // a message actually last went back and forth — which is what "in order
  // of the last message sent, like OwnerRez" actually means. Stay dates and
  // message recency are unrelated: a guest whose checkout is months away
  // (or already long past) can send a brand-new message right now and still
  // rank far down the list under date-sorting, silently pushing it off the
  // visible page — this is almost certainly what happened to Lilian
  // Barrios's message here even after the first fix. Also, this list never
  // actually fetched any messages at all ("DON'T fetch thread messages for
  // list view"), so `lastMessagePreview`/`lastMessageAt`/`awaitingReply` in
  // the UI were always blank/false — not just mis-sorted, structurally
  // unable to show real data. Fixed by fetching every candidate's messages
  // (via the same 120s-cached getCachedThreadMessages the cron already
  // keeps warm — see THREAD_MESSAGES_CACHE_SECONDS above) in paced batches,
  // then sorting by the real last-message timestamp.
  //
  // Pacing note: a batch's wall-clock duration is used to decide whether to
  // sleep before the next one, instead of always sleeping
  // THREAD_FETCH_BATCH_DELAY_MS. A fully-cached batch resolves in a few ms
  // (no real OwnerRez calls happened) and doesn't need pacing; only a batch
  // that actually had to hit OwnerRez live (slow) needs the pause that keeps
  // this under OwnerRez's rate limit. Since this whole function only
  // actually re-runs on a cache miss of the 30-min getAllThreadSummaries
  // wrapper below (roughly once per 30 min per org, not on every page view —
  // see that export's comment), the worst case (fully cold cache) pays the
  // full paced cost once, and every request in between is instant.
  // RETRY ADDED 2026-08-10: root cause of the "sort order wrong" bug traced
  // further than the fallback-snapshot guard below — confirmed live that a
  // thread with real messages (e.g. Antoine Carbonell, 11582328) came back
  // with 0 messages from THIS batch loop while the exact same
  // getCachedThreadMessages call succeeded seconds later via the
  // single-thread route. That means the batch's own concurrent load (12
  // threads at once, each a cache miss right after a deploy) is what trips
  // OwnerRez's rate limit here, not a rare one-off — it reproduces on every
  // cold computation, including right after every redeploy, so the
  // fallback-snapshot guard alone could never get a healthy run to seed it.
  // A single short-delay retry on failure is enough to ride out that kind
  // of transient 429/timeout without materially slowing the (already rare,
  // cold-cache-only) full scan.
  const messagesByThreadId = new Map<number, ThreadMessage[]>();
  for (let i = 0; i < base.length; i += THREAD_FETCH_BATCH_SIZE) {
    const batch = base.slice(i, i + THREAD_FETCH_BATCH_SIZE);
    const batchStartedAt = Date.now();
    const results = await Promise.all(
      batch.map(async ({ threadId }) => {
        try {
          return { threadId, messages: await getCachedThreadMessages(threadId, organizationId) };
        } catch (err) {
          console.error(`[inbox] getCachedThreadMessages failed for thread ${threadId}, retrying once:`, err);
          await sleep(1000);
          try {
            return { threadId, messages: await getCachedThreadMessages(threadId, organizationId) };
          } catch (retryErr) {
            console.error(`[inbox] retry also failed for thread ${threadId}:`, retryErr);
            return { threadId, messages: [] as ThreadMessage[] };
          }
        }
      })
    );
    for (const r of results) messagesByThreadId.set(r.threadId, r.messages);
    const batchTookRealCalls = Date.now() - batchStartedAt > 200; // cache hits resolve near-instantly
    if (batchTookRealCalls && i + THREAD_FETCH_BATCH_SIZE < base.length) {
      await sleep(THREAD_FETCH_BATCH_DELAY_MS);
    }
  }

  const withMessages: ThreadSummary[] = base.map(({ threadId, booking, guestName }) => {
    const messages = messagesByThreadId.get(threadId) ?? [];
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
    return {
      threadId,
      booking,
      guestName,
      messages,
      lastMessage,
      // Newest message in the thread is guest-authored -> waiting on Seni.
      awaitingReply: Boolean(lastMessage?.isGuest),
    };
  });

  // BUG FOUND 2026-08-10 (Seni: "all conversations are sorted incorrectly
  // again ... should be sorted by last communication"): same root cause as
  // the getGuests degradation fixed earlier today, hitting the messages
  // batch above instead. getCachedThreadMessages has no fallback-on-failure
  // — a rate-limit/error blip during THIS computation makes the catch above
  // return `[]` for every affected thread, so `lastMessage` comes back
  // undefined for them and the sort silently falls back to booking stay
  // dates (arrival/departure) instead of real last-message time — exactly
  // the wrong-order symptom reported, and since this whole function's
  // result is cached for 30 minutes (see getAllThreadSummaries below), one
  // bad run poisoned the sort order and blanked every preview for the full
  // window. Mirrors the fallback-snapshot guard added to fetchGuests: if a
  // suspicious fraction of candidates come back with zero messages (a real
  // OwnerRez message thread always has at least one), don't trust this run
  // — serve the last known-good full snapshot instead.
  const withAnyMessages = withMessages.filter((w) => w.messages.length > 0).length;
  const summariesLookedDegraded = candidates.length >= 3 && withAnyMessages < candidates.length * 0.5;
  const fallbackKey = threadSummariesFallbackKey(organizationId);

  let sortable = withMessages;
  if (summariesLookedDegraded && isRedisConfigured()) {
    try {
      const raw = await redisGet(fallbackKey);
      if (raw) {
        console.error(
          `[inbox] fetchAllThreadSummaries looked degraded (${withAnyMessages}/${candidates.length} threads had messages) — serving Redis fallback snapshot instead.`
        );
        sortable = JSON.parse(raw) as ThreadSummary[];
      }
    } catch (fallbackErr) {
      console.error("[inbox] Redis fallback for fetchAllThreadSummaries also failed:", fallbackErr);
    }
  }

  const sorted = sortable.sort((a, b) => {
    // Real last-message time when we have it (the correct, OwnerRez-matching
    // order); fall back to booking stay dates only for the rare thread whose
    // message fetch failed outright, so it doesn't just vanish from the list.
    const aTime = a.lastMessage?.sentAt
      ? new Date(a.lastMessage.sentAt).getTime()
      : new Date(a.booking.departure || a.booking.arrival || 0).getTime();
    const bTime = b.lastMessage?.sentAt
      ? new Date(b.lastMessage.sentAt).getTime()
      : new Date(b.booking.departure || b.booking.arrival || 0).getTime();
    return bTime - aTime;
  });

  // Only refresh the fallback snapshot on a genuinely healthy computation —
  // same reasoning as fetchGuests: never let a degraded result overwrite
  // the last known-good one.
  if (!summariesLookedDegraded && isRedisConfigured()) {
    await redisSet(fallbackKey, JSON.stringify(sorted), {
      exSeconds: THREAD_SUMMARIES_FALLBACK_TTL_SECONDS,
    }).catch(() => {});
  }

  const page = sorted.slice(0, limit);
  // Deliberately awaited (not fire-and-forget): these are cheap, parallel
  // Redis SETs (a handful of ms total), and awaiting them here guarantees
  // the lite cache is actually warm by the time this function's own 30-min
  // unstable_cache wrapper (getAllThreadSummaries) returns — so any request
  // racing to open a conversation right after the Inbox list first loads
  // still gets a hit instead of a coin flip.
  await warmThreadSummaryLiteCache(page, organizationId);
  return page;
}

// Recomputing this means one live OwnerRez fetch per conversation thread run
// in parallel — fast once warm, but a real wait on a genuine cold hit. This
// used to be cached for 300s (5 min), which lined up conveniently with the
// check-messages cron's own refreshes — but it also meant a brand-new guest
// message could sit invisible in the Inbox's left-hand list (preview text,
// unread ordering) for up to 5 minutes after it already existed in
// OwnerRez, even though opening the conversation itself was always live
// (see api/messages/thread/[threadId]/route.ts). Confirmed live 2026-07-30
// (a Derick Cruz message showed in OwnerRez's own inbox several minutes
// before it appeared here). Now that getBookings()/getGuests() are both
// scoped to just this property (see getGuests()'s comment in ownerrez.ts —
// this account has 8 properties total), the underlying thread count is much
// smaller than when this 300s window was chosen, so a much shorter cache is
// affordable. This short cache is ALSO paired with a client-side live
// refresh (see ThreadInbox.tsx, which calls the uncached
// fetchAllThreadSummaries directly via the inbox route's ?fresh=1 param
// right after every paint, and polls it periodically) — the cache below is
// just the "instant first paint" layer, not the source of truth for
// freshness anymore. Cache key versioned (v2) since the cached shape changed
// (added guestName).
// Static key array is fine even though fetchAllThreadSummaries now takes an
// optional organizationId — see getCachedThreadMessages above (and
// lib/ownerrez.ts's getBookings/getTargetProperty) for why: Next's Data Cache
// already keys on the call arguments, not the key array, so the org id is
// automatically part of the cache key the moment it's a real parameter.
// Cache key bumped to v3 (2026-08-06): changed to NOT fetch thread messages for instant load.
// Extended cache to 1800s (30 min): getBookings/getGuests queue behind cron (~25s on cache miss).
// 30-min cache means: after first load, ALL loads are instant (typical user session is <30 min).
// New bookings appear in detailed thread view (fetches live), so stale list is OK.
// Bumped to v5 (2026-08-10, same day): the SAME rate-limit incident also
// degraded the messages batch inside fetchAllThreadSummaries (every
// lastMessage came back undefined), which silently broke the "sort by last
// communication" order for 30 minutes — see the "BUG FOUND 2026-08-10"
// comment above for the fix (a matching fallback-snapshot guard). Bumping
// again flushes that poisoned v4 entry immediately.
export const getAllThreadSummaries = unstable_cache(fetchAllThreadSummaries, ["ownerrez-thread-summaries-v5"], {
  revalidate: 1800,
});

// Escape hatch around the LIST computation's own 20s cache (fresh bookings/
// guests, fresh sort/ordering) — used by the Inbox route's `?fresh=1` path
// so the dashboard catches up to a new guest message or booking within
// seconds instead of waiting out the 20s window above. Note this is no
// longer uncached all the way down: each thread's messages still go through
// getCachedThreadMessages's own 60s cache (see above) — deliberately, since
// that per-thread cache is what keeps this from re-triggering the OwnerRez
// rate limit on every poll. Exported directly (not wrapped in the 20s
// cache) since the point here is just to skip THAT layer.
export { fetchAllThreadSummaries };

/**
 * Flattens every host-authored message across all recent threads,
 * oldest-first, so `.slice(-limit)` grabs the N MOST RECENT examples of
 * Seni's own voice account-wide — not just whatever happens to exist in one
 * guest's own thread, which is often just one or two prior messages and not
 * enough for the AI to reliably match his tone.
 */
async function computeGlobalHostStyleExamples(limit: number, organizationId?: string): Promise<string[]> {
  const summaries = await getAllThreadSummaries(organizationId);
  const hostMessages = summaries
    .flatMap((s) => s.messages)
    .filter((m) => !m.isGuest && m.body.trim())
    .sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""));
  return hostMessages.slice(-limit).map((m) => m.body.trim());
}

// Cached separately from (and much longer than) the Inbox list itself —
// opening a conversation with a new, undrafted guest message calls this to
// calibrate tone, and riding on the Inbox's 60s cache meant that almost
// every thread opened more than a minute after the last one forced a full
// re-fetch of every recent thread's messages just to build a style corpus.
// Seni's writing style doesn't meaningfully change minute to minute, so a
// much longer window here is what actually made "open a conversation" feel
// slow — this was the single biggest lever for that complaint. It still
// naturally reflects new replies within this window, just not instantly.
//
// Phase 3: computeGlobalHostStyleExamples now takes an optional trailing
// organizationId (threaded down into getAllThreadSummaries -> getBookings/
// getThreadMessages). The keyParts array below is deliberately left
// untouched — per lib/ownerrez.ts's getBookings/getTargetProperty (see that
// file's top-of-file comment), Next's unstable_cache keys on the ACTUAL
// ARGUMENTS a wrapped function is called with, not on the static keyParts
// array, so simply adding organizationId as a real parameter is sufficient
// to make each org get its own cache entry — no keyParts change needed.
export const getGlobalHostStyleExamples = unstable_cache(
  computeGlobalHostStyleExamples,
  ["ownerrez-global-style-pool"],
  { revalidate: 600 }
);
