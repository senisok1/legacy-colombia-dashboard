import { NextRequest, NextResponse } from "next/server";
import { config, isAiReplyConfigured, isDbConfigured, isMessagingConfigured, isWhatsAppConfigured } from "@/lib/config";
import { getBookings, getGuests, getThreadMessages } from "@/lib/ownerrez";
import { getGlobalHostStyleExamples, getCachedThreadMessages } from "@/lib/inbox";
import { resolveGuestName, resolveGuestPhone, buildGuestsById } from "@/lib/guestName";
import { draftGuestReply } from "@/lib/aiReply";
import { translateText, detectLanguageAndTranslateToEnglish } from "@/lib/translate";
import { sendWhatsAppText, sendGuestReplyApprovalTemplate, sendAdminReplyNotificationTemplate } from "@/lib/whatsapp";
import { wasCrmSentReply, alreadyNotifiedAdminReply, clearAdminReplyNotified } from "@/lib/adminReplyMarkers";
import {
  createPendingDraft,
  getLastSeenMessageId,
  setLastSeenMessageId,
  linkWhatsAppMessageId,
  getPendingDraftByThreadId,
  getLastCheckedAtMany,
  alreadyAlertedRecently,
  setLastCheckedAt,
  updateDraftEnglishFields,
} from "@/lib/pendingDrafts";
import { logAiActivity } from "@/lib/aiActivity";
import { trailingGuestMessages, combineGuestMessageBodies } from "@/lib/guestMessageGroup";
import { sweepChatEscalationFallbacks } from "@/lib/chatEscalationFallback";
import { checkNewBookingAlerts } from "@/lib/bookingAlerts";
import { listActiveOrganizations } from "@/lib/organizations";
import { AUTOMATION_PROPERTY_GROUPS } from "@/lib/propertyGroups";
import type { Booking, ThreadMessage } from "@/lib/types";

const AGENT_KEY = "guest_experience";
const AGENT_NAME = "AI Guest Experience Manager";

export const maxDuration = 60; // seconds — plenty for a handful of threads

const MAX_STYLE_EXAMPLES = 20;

// How many thread-message fetches to have in flight at once during the
// fetch phase below. Bounded (rather than one giant Promise.all across
// every thread) so a large thread count doesn't fire hundreds of
// simultaneous connections at OwnerRez in one burst.
// Tuned 2026-08-06: reduced from 20 to 12 to further lower request/sec
// burst rate (sustained ~1.5 req/sec instead of ~4.7).
const MESSAGE_FETCH_BATCH_SIZE = 12;
// Small pause between batches — see lib/inbox.ts's matching
// THREAD_FETCH_BATCH_DELAY_MS comment. Most runs are cache hits now (see
// getCachedThreadMessages below) so this rarely matters, but on a fully cold
// cache (e.g. right after a deploy, when every active thread is a miss at
// once) it keeps this cron from firing a burst with zero pacing,
// which is exactly the kind of spike that tripped OwnerRez's 429 on
// 2026-08-05 even though the 5-minute rolling total was theoretically fine.
// Tuned 2026-08-06: increased from 500ms to 800ms delay to spread requests
// more evenly when batch size is 12 (lower combined req/sec during cold cache).
const MESSAGE_FETCH_BATCH_DELAY_MS = 800;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// OwnerRez enforces a per-IP rate limit of 300 requests / 5 minutes (~1
// req/sec sustained, confirmed via their API docs 2026-07-31). This route
// used to scan EVERY non-cancelled booking with a thread — no recency
// filter at all — every single minute. With this account's real thread
// count (150+), that alone needs ~2.5 req/sec just for this cron, which is
// mathematically impossible to fit in OwnerRez's budget no matter how the
// requests are batched or paced — and it was crowding out the dashboard's
// own Inbox scans, which is what actually caused the Messaging tab to
// intermittently show "No conversations found." (confirmed via a live 429
// from OwnerRez, 2026-07-31; see lib/inbox.ts for the matching Inbox-side
// fix). A guest who checked out months ago essentially never sends a new
// message that needs a fast AI-drafted reply — this cron's whole purpose is
// near-real-time response for CURRENT and RECENTLY-DEPARTED guests, so
// bounding it to a real "active" window (any booking not yet departed, plus
// a tail after departure for late questions/lost items/reviews) cuts the
// per-run thread count dramatically and brings this comfortably back under
// budget. The dashboard's Inbox tab still shows the full history — it's not
// bound by this window, only by its own (much more relaxed) recency filter.
const ACTIVE_THREAD_WINDOW_DAYS = 45;

// If a thread's very first-ever poll finds an unanswered guest message
// newer than this, treat it as genuinely new (draft + alert) rather than
// old backlog to silently skip — see the isFirstPoll comment below for why
// this exists: a brand-new booking can sync into OwnerRez with its ENTIRE
// pre-booking conversation as this thread's first-ever poll, with the
// guest's last message never having been answered by a human. Bounded to a
// few hours (rather than "always draft on first poll") so that if Redis's
// cursor state is ever lost/reset, we don't mass-spam Seni re-litigating
// every thread's ancient history as if it were brand new.
const FIRST_POLL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

function isActiveEnoughForPolling(departure: string | null | undefined): boolean {
  if (!departure) return true; // no date info — don't accidentally skip it
  const cutoffMs = Date.now() - ACTIVE_THREAD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const departureMs = new Date(departure).getTime();
  return Number.isNaN(departureMs) || departureMs >= cutoffMs;
}

// Polls every OwnerRez conversation thread for new inbound guest messages,
// drafts an AI reply for each one (grounded in Seni's own past messages +
// the property facts file), and texts Seni on WhatsApp for approval. Meant
// to run on an external scheduler (cron-job.org) every 1 minute — OwnerRez
// has no "new message" webhook, so polling is the only option (confirmed
// during setup; see README). Vercel's own vercel.json cron is just a
// once-daily backstop in case the external pinger ever stops.
//
// The message-fetch phase (one live OwnerRez call per thread) used to run
// strictly sequentially, one thread at a time — fine at a 5-minute cadence,
// but with 150+ threads that could take tens of seconds, which is too slow
// and too close to timing out to run safely every 1 minute. Fetching in
// parallel batches (see MESSAGE_FETCH_BATCH_SIZE) instead brings a typical
// run down to a couple of seconds. Only the drafting/WhatsApp-notify step
// below stays sequential — that only ever runs for threads with a genuinely
// new guest message, which is rare per run, so there's no meaningful
// slowdown from keeping it simple and rate-limit-friendly.
//
// Phase 3: this whole body of work (chat-fallback sweep + OwnerRez
// thread-polling/AI-drafting/WhatsApp-approval loop) now runs once per
// organization in good standing (see listActiveOrganizations()) rather than
// once for the implicit default org — see runCheckMessagesForOrg below. Each
// org's run is isolated by the try/catch in the loop in GET() so one
// tenant's failure can never stop another tenant's guest messages from
// getting polled/drafted/approved-texted. The isMessagingConfigured()/
// isAiReplyConfigured()/isWhatsAppConfigured() checks below still read
// GLOBAL env-var config today (not yet per-org) — that's an intentional gap
// left for a later phase; for now they just mean "skip this org's run" not
// "error", which keeps the response shape honest without breaking anything.
async function runCheckMessagesForOrg(orgId: string): Promise<Record<string, unknown>> {
  // Chat-widget escalation fallback sweep runs independently of the
  // OwnerRez guest-message polling below — it needs Postgres + WhatsApp, not
  // OwnerRez OAuth or a live Anthropic key (the escalation's answer was
  // already drafted back at escalate-time). Wrapped in its own try/catch so
  // a failure here (or the guest-message poll being unconfigured) never
  // blocks the other. See lib/chatEscalationFallback.ts. (DB connectivity is
  // already guaranteed by the isDbConfigured() gate in GET() below, since
  // listActiveOrganizations() itself requires it.)
  let chatFallbackResult: Awaited<ReturnType<typeof sweepChatEscalationFallbacks>> | { skipped: string } = {
    skipped: "WhatsApp not configured yet.",
  };
  if (isWhatsAppConfigured()) {
    try {
      chatFallbackResult = await sweepChatEscalationFallbacks(orgId);
    } catch (err) {
      chatFallbackResult = { skipped: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  // New-booking alert (2026-08-06): deliberately gated on isWhatsAppConfigured()
  // ONLY, independent of the isMessagingConfigured()/isAiReplyConfigured()
  // gates below — see lib/bookingAlerts.ts header comment for why. Wrapped in
  // its own try/catch (same pattern as the chat-fallback sweep above) so a
  // failure here (bad OwnerRez PAT, Redis hiccup, etc.) never blocks guest-
  // message drafting, and vice versa.
  //
  // PER-PROPERTY (2026-08-17 audit): this used to call getBookings(orgId) /
  // getGuests(orgId) with NO property group, so it defaulted to Legacy
  // Colombia — meaning new bookings on Alva, Pompano, Miami and Beach House
  // NEVER fired a WhatsApp new-booking alert. Now it iterates every property
  // group; each group's fetch+alert is isolated in its own try/catch so one
  // property's OwnerRez failure can't suppress the others' alerts.
  let newBookingResults: Record<string, unknown> = { skipped: "WhatsApp not configured yet." };
  if (isWhatsAppConfigured()) {
    const perGroup: Record<string, unknown> = {};
    // Scoped to Legacy Colombia only for now (2026-08-18, Seni's ask) — see
    // lib/propertyGroups.ts's AUTOMATION_PROPERTY_GROUPS comment.
    for (const group of AUTOMATION_PROPERTY_GROUPS) {
      try {
        const [bookingsForAlert, guestsForAlert] = await Promise.all([
          getBookings(orgId, group.id),
          getGuests(orgId, group.id),
        ]);
        perGroup[group.id] = await checkNewBookingAlerts(
          bookingsForAlert,
          buildGuestsById(guestsForAlert),
          orgId
        );
      } catch (err) {
        perGroup[group.id] = { skipped: err instanceof Error ? err.message : "Unknown error." };
      }
    }
    newBookingResults = perGroup;
  }

  // Inquiry-alert POLLING backstop (2026-08-21, Juan Botero's missed
  // inquiry — see lib/inquiryAlerts.ts for the full story). Runs every
  // minute regardless of webhook health: inquiries have no booking/thread so
  // the thread-polling loop below never sees them, and the `inquiry` webhook
  // has silently died three times. One OwnerRez request per run — trivially
  // inside the rate budget. Own try/catch so an OwnerRez hiccup here never
  // blocks guest-message drafting, and vice versa.
  let inquiryPollResult: Record<string, unknown> = { skipped: "WhatsApp not configured yet." };
  if (isWhatsAppConfigured()) {
    try {
      const { pollInquiryAlerts } = await import("@/lib/inquiryAlerts");
      inquiryPollResult = await pollInquiryAlerts(orgId);
    } catch (err) {
      inquiryPollResult = { error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  if (!isMessagingConfigured()) {
    return {
      skipped: "OwnerRez messaging not connected yet.",
      chatFallback: chatFallbackResult,
      newBookings: newBookingResults,
      inquiryPoll: inquiryPollResult,
    };
  }
  if (!isAiReplyConfigured()) {
    return {
      skipped: "ANTHROPIC_API_KEY not set (or has no credits).",
      chatFallback: chatFallbackResult,
      newBookings: newBookingResults,
      inquiryPoll: inquiryPollResult,
    };
  }
  if (!isWhatsAppConfigured()) {
    return {
      skipped: "WhatsApp not configured yet.",
      chatFallback: chatFallbackResult,
      newBookings: newBookingResults,
      inquiryPoll: inquiryPollResult,
    };
  }

  // MULTI-PROPERTY COVERAGE (2026-08-17 audit). This whole poll used to call
  // getBookings(orgId) / getGuests(orgId) / getGlobalHostStyleExamples(…,orgId)
  // with NO property group — i.e. Legacy Colombia only — so guest messages on
  // the other four properties (Alva, Pompano, Miami, Beach House) were NEVER
  // drafted or alerted. We now gather candidate threads from EVERY property
  // group into ONE combined list.
  //
  // BUDGET/FAIRNESS DECISION (ties into CRON_TIME_BUDGET_MS below): rather than
  // run five separate 45s fetch loops — which would need roughly 5x the 60s
  // maxDuration and blow the budget — we merge all properties' candidate
  // threads into a single list and run the SAME single 45s-budgeted loop with
  // the SAME global least-recently-checked sort. Two wins: (1) the existing
  // per-run time budget is preserved unchanged, and (2) the round-robin
  // fairness cursor (setLastCheckedAt / getLastCheckedAtMany) now spans all
  // five properties for free — a thread not serviced this run, whichever
  // property it belongs to, sorts to the front next run, so no property can be
  // permanently starved. The tradeoff: per-run capacity (~40-50 live thread
  // fetches inside the budget) is now SHARED across all properties instead of
  // dedicated to Colombia, so the worst-case time for any single thread to get
  // its turn grows roughly with the combined active-thread count. With crons
  // every 1-2 minutes and most fetches being cache hits, that's still on the
  // order of minutes, not "forever."
  const drafted: { threadId: number; guestName?: string; draftId: string }[] = [];
  const errors: { threadId: number; error: string }[] = [];

  // Per-property drafting context: the guest directory (property-scoped) and
  // the host-style tone corpus (also property-scoped as of 2026-08-17) each
  // thread should be resolved / drafted against. Keyed by property group id.
  type GroupContext = {
    guestsById: ReturnType<typeof buildGuestsById>;
    stylePool: string[];
  };
  const groupContext = new Map<string, GroupContext>();

  // Dedup (booking, threadId) pairs up front — a guest can theoretically
  // appear on more than one booking's threadIds list, and a thread belongs to
  // exactly one property, so we only want to check each real thread once per
  // run across all properties.
  const seenThreadIds = new Set<number>();
  const candidates: { booking: Booking; threadId: number; groupId: string }[] = [];

  // Start the per-run time budget clock HERE — before the per-property
  // candidate build — so the single 45s budget (CRON_TIME_BUDGET_MS below)
  // covers both the five-property data fetch and the thread-message fetch
  // loop, keeping total runtime under the 60s maxDuration. See that constant's
  // comment for the full reasoning.
  const runStartedAt = Date.now();

  // Scoped to Legacy Colombia only for now (2026-08-18, Seni's ask) — see
  // lib/propertyGroups.ts's AUTOMATION_PROPERTY_GROUPS comment.
  for (const group of AUTOMATION_PROPERTY_GROUPS) {
    try {
      const [allBookings, guests] = await Promise.all([
        getBookings(orgId, group.id),
        getGuests(orgId, group.id),
      ]);
      const bookings = allBookings.filter(
        (b) => !b.isBlock && b.status !== "Cancelled" && b.threadIds.length > 0 && isActiveEnoughForPolling(b.departure)
      );
      const guestsById = buildGuestsById(guests);

      // Grounded in Seni's own replies across THIS property's recent
      // conversations (see inbox.ts), not just whatever's in each individual
      // thread — most threads only have a couple of prior host messages,
      // nowhere near enough for the AI to reliably match his tone. Computed
      // once per property per run (cached 600s in inbox.ts, so cheap).
      const stylePool = await getGlobalHostStyleExamples(MAX_STYLE_EXAMPLES, orgId, group.id);
      groupContext.set(group.id, { guestsById, stylePool });

      for (const booking of bookings) {
        for (const threadId of booking.threadIds) {
          if (seenThreadIds.has(threadId)) continue;
          seenThreadIds.add(threadId);
          candidates.push({ booking, threadId, groupId: group.id });
        }
      }
    } catch (groupErr) {
      // One property's data fetch failing must NOT stop the others being
      // polled — its candidates simply aren't added this run. threadId -1 is
      // a sentinel marking a property-level (not thread-level) failure.
      console.error(`[cron/check-messages] candidate build failed for ${group.id}`, groupErr);
      errors.push({
        threadId: -1,
        error: `[${group.id}] ${groupErr instanceof Error ? groupErr.message : "Unknown error."}`,
      });
    }
  }

  // INCIDENT FIX (2026-08-06, ~22:00 UTC): the previous "OPTIMIZATION"
  // comment here filtered on `c.booking.awaitingReply` — a field that does
  // not exist anywhere on the `Booking` type (confirmed via `tsc --noEmit`,
  // which only didn't fail the build because next.config.ts has
  // `ignoreBuildErrors: true`). At runtime this was always `undefined`
  // (falsy), so `hotCandidates` was unconditionally `[]` on every single
  // run, for every org — this cron has been doing NOTHING but the chat
  // escalation fallback sweep since the moment that change deployed earlier
  // today. This is what caused Nyree Tanielian's 2026-08-06 21:41 UTC
  // message ("recommend that you get the oven fixed...") to never trigger a
  // WhatsApp approval alert — not a rate limit, not a disabled cron job (both
  // were checked live and ruled out), just this dead filter silently
  // discarding every candidate. Restored to the pre-2026-08-06 behavior:
  // check every thread in the already-computed 45-day active window
  // (`ACTIVE_THREAD_WINDOW_DAYS` above already keeps this list small — most
  // of the account's history is excluded).
  //
  // INCIDENT FIX (2026-08-08): this list used to be sorted purely by
  // closest-checkout-first, on the theory that currently-hosted and
  // just-departed guests are far likelier to message than one whose stay is
  // months away. That's true on average, but the ordering was STATIC — the
  // same threads always ranked at the bottom, every single run — and this
  // account genuinely has 286 real message threads (confirmed via
  // /api/debug/bookings-raw), most of them future bookings, since this
  // business books many months ahead. OwnerRez's ~1 req/sec sustained rate
  // limit (see ownerrez-queue.ts) means the fetch loop below can only ever
  // live-fetch on the order of 40-50 threads per run inside its 45-second
  // budget. With a fixed priority order, any thread that consistently ranks
  // outside that top ~45 (e.g. Natalia Reynolds's booking, departing
  // 2027-03-21 — confirmed present in getBookings() with the correct
  // threadId the entire time, ruling out a data-sync gap like the earlier
  // Alicia Herrera incident) never gets promoted and is PERMANENTLY excluded
  // from ever being fetched, not just delayed — which is also the likely
  // real explanation for why this same bug *class* kept resurfacing for
  // different guests even after each specific past incident's own distinct
  // cause (a dead filter, a missing first-poll window, a WhatsApp
  // session-window issue) was fixed.
  //
  // Fix: order by least-recently-CHECKED instead of closest-departure. Every
  // thread this run actually attempts gets stamped via setLastCheckedAt
  // below (see pendingDrafts.ts for the full writeup), so servicing a thread
  // sends it to the back of the line for the next run — a fair rotation
  // instead of a fixed order, guaranteeing every active thread gets a turn
  // within roughly (candidate count / per-run capacity) runs, i.e. a few
  // minutes worst case for this account, never "forever." Threads that have
  // never been checked at all (brand-new bookings/threads) sort first —
  // `null` is treated as more overdue than any real timestamp — so a new
  // conversation always gets its first look promptly. Closest-departure is
  // kept only as a tiebreaker among equally-overdue threads, preserving the
  // original "currently-hosted guests are likelier to message" intuition
  // without letting it cause permanent starvation.
  const lastCheckedById = await getLastCheckedAtMany(
    candidates.map((c) => c.threadId),
    orgId
  );
  const hotCandidates = [...candidates].sort((a, b) => {
    const aChecked = lastCheckedById.get(a.threadId) ?? -Infinity; // never-checked = most overdue
    const bChecked = lastCheckedById.get(b.threadId) ?? -Infinity;
    if (aChecked !== bChecked) return aChecked - bChecked; // oldest/never-checked first
    const aDeparture = a.booking.departure ? new Date(a.booking.departure).getTime() : Infinity;
    const bDeparture = b.booking.departure ? new Date(b.booking.departure).getTime() : Infinity;
    return Math.abs(aDeparture - Date.now()) - Math.abs(bDeparture - Date.now());
  });

  // Hard stop for STARTING new fetch batches — leaves headroom under the 60s
  // maxDuration so a large candidate list degrades to "checks the most
  // likely-active threads this run, sweeps the rest next run" (crons every
  // 2 minutes) instead of risking a hard Vercel timeout that would silently
  // drop ALL of this run's work, including threads already fetched.
  //
  // runStartedAt is set ABOVE, before the per-property candidate build
  // (2026-08-17 audit), NOT here — so this one 45s budget now bounds the WHOLE
  // polling phase (all five properties' getBookings/getGuests/style-pool
  // fetches PLUS the thread-message fetch loop), keeping total runtime under
  // the 60s maxDuration even on a cold multi-property cache. If the candidate
  // build alone eats the budget on a bad day, the fetch loop simply starts
  // zero batches and the whole run degrades to "sweep next run" — safe now
  // that the cursor only advances after a successful alert (see below).
  const CRON_TIME_BUDGET_MS = 45_000;

  // Fetch only the hot thread's messages in parallel (bounded batches)
  // rather than one at a time — see the batch-size comment above. Routed
  // through the SAME cache lib/inbox.ts's Inbox-tab scan uses
  // (getCachedThreadMessages, 120s) rather than calling getThreadMessages
  // directly — this used to be a fully uncached live fetch of every active
  // thread on EVERY 60-second cron run, which was the actual cause of the
  // sustained OwnerRez 429s diagnosed 2026-08-05 (see lib/inbox.ts's
  // THREAD_MESSAGES_CACHE_SECONDS comment). A 429 that still slips through
  // (e.g. a fully cold cache right after a deploy) gets one retry after a
  // short backoff, bypassing the cache on the retry — same pattern already
  // used in lib/inbox.ts's own fetchAllThreadSummaries — so a transient
  // rate-limit hit drops that one thread from THIS run instead of silently
  // caching (and re-serving) a failure.
  const fetchResults: { threadId: number; messages: ThreadMessage[] | null }[] = [];
  for (let i = 0; i < hotCandidates.length; i += MESSAGE_FETCH_BATCH_SIZE) {
    if (Date.now() - runStartedAt > CRON_TIME_BUDGET_MS) break; // see CRON_TIME_BUDGET_MS above
    const batch = hotCandidates.slice(i, i + MESSAGE_FETCH_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async ({ threadId }) => {
        // Stamp this thread as "checked" the moment we commit to attempting
        // it this run — win or lose — so the fairness sort above rotates it
        // to the back of the line next run instead of it (or a repeated
        // failure) blocking the same slot forever. Fire-and-forget with a
        // swallowed catch, same philosophy as logAiActivity elsewhere in
        // this file: a Redis hiccup here should never fail the actual
        // message fetch.
        setLastCheckedAt(threadId, Date.now(), orgId).catch(() => {});
        try {
          try {
            return { threadId, messages: await getCachedThreadMessages(threadId, orgId) };
          } catch (err) {
            const isRateLimited = err instanceof Error && err.message.includes("429");
            if (!isRateLimited) throw err;
            await sleep(2000);
            return { threadId, messages: await getThreadMessages(threadId, orgId) }; // bypass cache on retry
          }
        } catch (err) {
          errors.push({ threadId, error: err instanceof Error ? err.message : "Unknown error." });
          return { threadId, messages: null };
        }
      })
    );
    fetchResults.push(...results);
    if (i + MESSAGE_FETCH_BATCH_SIZE < candidates.length) await sleep(MESSAGE_FETCH_BATCH_DELAY_MS);
  }
  const messagesByThreadId = new Map(fetchResults.map((r) => [r.threadId, r.messages]));

  for (const { booking, threadId, groupId } of hotCandidates) {
    const messages = messagesByThreadId.get(threadId);
    if (!messages || messages.length === 0) continue;

    // Per-property drafting context (guest directory + tone corpus) for the
    // property this thread belongs to. Guaranteed present: a thread only ever
    // becomes a candidate above once its group's context was set.
    const ctx = groupContext.get(groupId);
    if (!ctx) continue;
    const { guestsById, stylePool } = ctx;

    const lastSeenId = await getLastSeenMessageId(threadId, orgId);
    const isFirstPoll = lastSeenId === null;
    const newMessages = lastSeenId ? messages.filter((m) => m.id > lastSeenId) : messages;
    const maxId = Math.max(...messages.map((m) => m.id));

    // CURSOR ORDERING FIX (2026-08-17 audit). This setLastSeenMessageId used
    // to run HERE, up front, BEFORE any drafting/alerting happened — so a
    // timeout (or crash) after the cursor advanced but before the WhatsApp
    // approval alert went out PERMANENTLY dropped the guest message: next run
    // filtered it out as "already seen" and it was never drafted or alerted.
    // The cursor is now advanced only once the message has actually been
    // handled — in each of the "nothing to do" branches below, and after a
    // successful draft+alert (never in the failure/catch path). That way a
    // mid-run failure leaves the cursor untouched so the message is retried
    // next run, while the getPendingDraftByThreadId reuse and
    // alreadyAlertedRecently guards below stop that retry from re-drafting or
    // double-alerting the same message.

    // A guest can send several messages in a row (e.g. three separate
    // WhatsApp/OwnerRez sends a few seconds apart) — grab the whole trailing
    // run of them, not just the newest one, so nothing gets silently
    // dropped from what the AI drafts against and what Seni sees. See
    // lib/guestMessageGroup.ts for why.
    const newGuestMessages = trailingGuestMessages(newMessages);
    if (newGuestMessages.length === 0) {
      // No new INBOUND guest message — but there may be new HOST messages:
      // another admin replying to the guest directly in OwnerRez's own inbox
      // (2026-08-18, Seni's ask: "there are other admin that might reply
      // directly in OwnerRez" and he needs those on his WhatsApp too). The
      // webhook path already pings for these when OwnerRez's webhook fires;
      // this cron sweep is the reliable backstop, deduped against it via
      // alreadyNotifiedAdminReply's content hash.
      //
      // Guards, in order:
      //   - 6h age cap: on a thread's first-ever poll (or a Redis cursor
      //     reset) newMessages is the ENTIRE history — without the cap that
      //     would replay every past host message as "new admin activity".
      //   - wasCrmSentReply: the CRM's own sends (approval YES, dashboard
      //     replies, EDIT:) are Seni's own actions — never echo them back.
      //   - alreadyNotifiedAdminReply: content dedupe vs the webhook path
      //     and vs overlapping cron runs. Marks before sending, so a failed
      //     informational ping is dropped, never retried into a page loop.
      // Errors are swallowed per message and the cursor ALWAYS advances —
      // a missed admin FYI is tolerable; re-alerting forever is not.
      const ADMIN_REPLY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
      const newHostMessages = newMessages.filter((mm) => {
        if (mm.isGuest || !mm.body?.trim()) return false;
        const sentMs = mm.sentAt ? new Date(mm.sentAt).getTime() : NaN;
        return Number.isFinite(sentMs) && Date.now() - sentMs <= ADMIN_REPLY_MAX_AGE_MS;
      });
      for (const hostMsg of newHostMessages) {
        try {
          const hostBody = hostMsg.body.trim();
          if (await wasCrmSentReply(hostBody, orgId)) continue;
          if (await alreadyNotifiedAdminReply(hostBody, orgId)) continue;

          const adminGuestName = resolveGuestName(booking, guestsById);

          // English readings for Seni — Gabriel and other co-admins reply in
          // Spanish. Both the admin's reply and the guest message it answers
          // get an English pass; each degrades to the original on failure.
          let adminReplyEnglish = hostBody;
          let translatedNote = "";
          const det = await detectLanguageAndTranslateToEnglish(hostBody, orgId).catch(() => null);
          if (det && det.language !== "English" && det.english.trim()) {
            adminReplyEnglish = det.english.trim();
            translatedNote = ` [translated from ${det.language}]`;
          }
          const lastGuestMsg = [...messages].reverse().find((mm) => mm.isGuest && mm.body?.trim());
          let guestContext = lastGuestMsg?.body?.trim() ?? "(see OwnerRez thread)";
          if (lastGuestMsg) {
            const gDet = await detectLanguageAndTranslateToEnglish(guestContext, orgId).catch(() => null);
            if (gDet && gDet.language !== "English" && gDet.english.trim()) guestContext = gDet.english.trim();
          }

          // Delivery honesty (2026-08-18): this used to log "notified" even
          // when both the template AND the free-text fallback failed (the
          // fallback swallowed its own error) — six admin FYIs died with
          // 131047 that day while the activity log claimed success.
          // sendAdminReplyNotificationTemplate now carries its own durable
          // fallback (daily_summary_alert carrier — see lib/whatsapp.ts), and
          // the free-text rung here is a last resort only. Whatever happens,
          // the log records what actually happened.
          let adminFyiSent = false;
          let adminFyiError: string | undefined;
          try {
            await sendAdminReplyNotificationTemplate(
              {
                guestName: adminGuestName,
                guestMessage: guestContext.slice(0, 300),
                adminReply: adminReplyEnglish.slice(0, 350),
              },
              orgId
            );
            adminFyiSent = true;
          } catch (tmplErr) {
            adminFyiError = tmplErr instanceof Error ? tmplErr.message : String(tmplErr);
            try {
              await sendWhatsAppText(
                `✅ An admin replied to ${adminGuestName} (${booking.propertyName ?? "Legacy Colombia"}) directly in OwnerRez${translatedNote}:\n"${adminReplyEnglish.slice(0, 400)}"\n\nGuest's message: "${guestContext.slice(0, 250)}"\n\nFYI only — no action needed.`,
                orgId
              );
              adminFyiSent = true;
            } catch (textErr) {
              adminFyiError = textErr instanceof Error ? textErr.message : String(textErr);
            }
          }

          // Retry instead of losing it (2026-08-19, "Edgar's reply never
          // reached Seni"): alreadyNotifiedAdminReply marks BEFORE the send,
          // so a total delivery failure must un-mark or this reply is
          // skipped forever. Bounded by ADMIN_REPLY_MAX_AGE_MS above — a
          // reply that keeps failing stops being retried after 6h.
          if (!adminFyiSent) {
            await clearAdminReplyNotified(hostBody, orgId).catch(() => {});
          }

          await logAiActivity(
            {
              agentKey: AGENT_KEY,
              agentDisplayName: AGENT_NAME,
              task: "Notify admin reply",
              trigger: `Admin replied directly in OwnerRez on thread ${threadId} (${adminGuestName})`,
              actionTaken: adminFyiSent
                ? "Sent FYI WhatsApp to Seni with English reading of the admin's reply"
                : "FAILED to deliver the FYI WhatsApp to Seni",
              result: adminFyiSent ? "notified" : "failed",
              error: adminFyiSent ? undefined : adminFyiError,
            },
            orgId
          ).catch(() => {});
        } catch (adminNotifyErr) {
          console.error(`[check-messages] admin-reply notify failed for thread ${threadId}`, adminNotifyErr);
        }
      }

      // Safe to advance the cursor now — admin FYIs above are best-effort by
      // design (see the guard comment), and there's no pending guest alert a
      // later failure could drop.
      await setLastSeenMessageId(threadId, maxId, orgId);
      continue;
    }

    if (isFirstPoll) {
      // Normally a thread's first-ever poll means its whole backlog is old
      // and already resolved (e.g. a redeploy with a cold Redis cache) —
      // skip drafting then, to avoid spamming Seni with approval requests
      // for old, already-handled conversations. But see FIRST_POLL_MAX_AGE_MS
      // above: found 2026-08-05 that Alicia Herrera's brand-new booking
      // synced into OwnerRez with her entire pre-booking pricing-question
      // conversation attached as this thread's first-ever poll, unanswered
      // by a human — the old unconditional skip meant Seni got zero
      // WhatsApp alert for a genuinely new, actionable message, completely
      // silently (no error, nothing in the AI Activity log either, since
      // this branch returns before any logAiActivity call). Only stay
      // silent now if that trailing guest message is old enough that
      // treating it as "new" would risk being backlog instead.
      const newest = newGuestMessages[newGuestMessages.length - 1];
      const ageMs = newest.sentAt ? Date.now() - new Date(newest.sentAt).getTime() : Infinity;
      if (ageMs > FIRST_POLL_MAX_AGE_MS) {
        // Old backlog on this thread's first-ever poll — nothing to draft, but
        // advance the cursor to establish a baseline so we don't re-examine
        // the same ancient history every subsequent run.
        await setLastSeenMessageId(threadId, maxId, orgId);
        continue;
      }
    }

    const guestMessageBody = combineGuestMessageBodies(newGuestMessages);

    // Diagnostic only (Seni reported ~5+ minute delays between a guest
    // sending on WhatsApp and getting an approval text — this cron run
    // itself takes well under a second per cron-job.org's own execution
    // log, so if there's a real gap it has to be happening either before
    // OwnerRez's API reflects the message, or between us sending the
    // WhatsApp approval request and Meta delivering it — not in our
    // polling). Logged to ai_activity_log so the gap is measurable next
    // time this comes up, instead of guessing.
    const newestGuestMessage = newGuestMessages[newGuestMessages.length - 1];
    const detectionLatencyMs = newestGuestMessage.sentAt
      ? Date.now() - new Date(newestGuestMessage.sentAt).getTime()
      : null;

    let guestName = resolveGuestName(booking, guestsById);
    // Direct guest lookup when the property-scoped directory doesn't have
    // this guest yet — same OwnerRez sync-lag gap as bookingAlerts.ts
    // (2026-08-21, Seni: "I need all names for all whatsapp messages").
    if (guestName === "Guest" && booking.guestId != null) {
      const { getGuestById } = await import("@/lib/ownerrez");
      const g = await getGuestById(booking.guestId, orgId).catch(() => undefined);
      if (g?.fullName?.trim()) guestName = g.fullName.trim();
    }

    try {
      // The dashboard's Inbox tab can also generate a draft on demand for
      // this exact thread (opening the conversation while a new guest
      // message is showing) — if it already did, reuse that draft instead
      // of drafting (and billing) again. We only reuse it if it's for the
      // SAME guest message; if the guest has since sent something newer,
      // this falls through and drafts fresh.
      let draft = await getPendingDraftByThreadId(threadId, orgId);
      if (!draft || draft.guestMessage !== guestMessageBody) {
        const draftReply = await draftGuestReply({
          guestMessage: guestMessageBody,
          booking,
          hostMessages: stylePool.map((body) => ({
            id: 0,
            threadId,
            body,
            isGuest: false,
            fromRole: "co_host",
          })),
          organizationId: orgId,
        });

        // GUARANTEED ENGLISH FOR THE ALERT (2026-08-17). draftGuestReply asks
        // Claude for guest_message_english / reply_english as part of the
        // drafting call, but when the model omits them (returns "") the
        // parser falls back to the ORIGINAL text — so a Spanish conversation
        // produced a Spanish WhatsApp alert Seni couldn't read. That's what
        // happened today. Belt-and-braces: if the guest didn't write in
        // English and we don't have a genuine translation, translate
        // explicitly here. Failure is non-fatal — worst case we're back to
        // the original text rather than losing the alert.
        const wroteInEnglish = (draftReply.language || "English").toLowerCase() === "english";
        let englishGuestMessage = draftReply.guestMessageEnglish;
        let englishReply = draftReply.replyEnglish;
        if (!wroteInEnglish) {
          if (!englishGuestMessage || englishGuestMessage === guestMessageBody) {
            const t = await translateText(guestMessageBody, "en", orgId).catch(() => null);
            if (t?.ok && t.text.trim()) englishGuestMessage = t.text.trim();
          }
          if (!englishReply || englishReply === draftReply.reply) {
            const t = await translateText(draftReply.reply, "en", orgId).catch(() => null);
            if (t?.ok && t.text.trim()) englishReply = t.text.trim();
          }
        }

        draft = await createPendingDraft(
          {
            threadId,
            bookingId: booking.id,
            guestId: booking.guestId,
            guestName,
            guestMessage: guestMessageBody,
            draftReply: draftReply.reply,
            language: draftReply.language,
            guestMessageEnglish: englishGuestMessage,
            replyEnglish: englishReply,
            isServiceRequest: draftReply.isServiceRequest,
            guestPhone: draftReply.isServiceRequest
              ? resolveGuestPhone(booking, guestsById)
              : undefined,
          },
          orgId
        );

        await logAiActivity(
          {
            agentKey: AGENT_KEY,
            agentDisplayName: AGENT_NAME,
            task: "Draft guest reply",
            trigger: `New guest message${newGuestMessages.length > 1 ? "s" : ""} on thread ${threadId} (${guestName})`,
            dataReviewed: {
              threadId,
              bookingId: booking.id,
              guestMessages: newGuestMessages.map((m) => m.body),
              newestGuestMessageSentAt: newestGuestMessage.sentAt ?? null,
              detectionLatencyMs,
            },
            decision: draftReply.reply,
            policyUsed: "Host-style-matched reply grounded in Seni's past messages + property facts",
            actionTaken: "Created pending draft awaiting Seni's approval",
            result: "drafted",
          },
          orgId
        );
      }

      // Only text Seni if this draft hasn't already been sent to WhatsApp
      // (e.g. by a previous cron run, or it was just created above) — the
      // approval text to Seni is always English, regardless of what
      // language the guest wrote in; the reply that actually gets sent to
      // the guest on approval (draft.draftReply) stays in their language.
      // Content-level duplicate guard — see alreadyAlertedRecently's comment
      // for the two ways one guest message could alert twice.
      if (!draft.wamid && (await alreadyAlertedRecently(orgId, guestMessageBody))) {
        console.warn(
          `[check-messages] suppressed duplicate alert for thread ${threadId} — same guest text already alerted within the window`
        );
      } else if (!draft.wamid) {
        // FINAL ENGLISH GUARANTEE (2026-08-18 — Seni received an approval
        // alert entirely in Spanish). The creation-time translation above only
        // runs when THIS run drafted the reply; a REUSED draft (created by the
        // webhook path or the Inbox tab) can arrive here with no genuine
        // English previews, and the drafting model's self-reported `language`
        // has been observed flatly wrong for short messages. So never trust
        // stored state at send time: if the "English" preview is just the
        // original text, run an independent detection over the guest message
        // and translate both sides. When detection corrects the language, the
        // stored draft is fixed too (updateDraftEnglishFields) so the EDIT:
        // path translates Seni's English into the guest's REAL language. In
        // the normal case (genuine previews already stored) both checks
        // short-circuit at zero extra cost.
        let alertGuestMessage = draft.guestMessageEnglish ?? draft.guestMessage;
        let alertReply = draft.replyEnglish ?? draft.draftReply;
        let effectiveLanguage = draft.language && draft.language !== "English" ? draft.language : null;
        if (!draft.guestMessageEnglish || draft.guestMessageEnglish === draft.guestMessage) {
          const det = await detectLanguageAndTranslateToEnglish(draft.guestMessage, orgId).catch(() => null);
          if (det && det.language !== "English" && det.english.trim()) {
            alertGuestMessage = det.english.trim();
            effectiveLanguage = det.language;
          }
        }
        if (effectiveLanguage && (!draft.replyEnglish || draft.replyEnglish === draft.draftReply)) {
          const t = await translateText(draft.draftReply, "en", orgId).catch(() => null);
          if (t?.ok && t.text.trim()) alertReply = t.text.trim();
        }
        if (effectiveLanguage && effectiveLanguage !== draft.language) {
          await updateDraftEnglishFields(
            draft.id,
            {
              language: effectiveLanguage,
              guestMessageEnglish: alertGuestMessage !== draft.guestMessage ? alertGuestMessage : undefined,
              replyEnglish: alertReply !== draft.draftReply ? alertReply : undefined,
            },
            orgId
          ).catch(() => {});
        }

        const isNonEnglish = Boolean(effectiveLanguage);
        const languageNote = isNonEnglish ? ` [written in ${effectiveLanguage}]` : "";
        const customReplyNote = isNonEnglish
          ? `, or type your own reply in English to send that (auto-translated to ${effectiveLanguage}) instead`
          : ", or type your own reply to send that instead";
        // Service requests (chef, massage, jet ski, boat rental, etc.) get
        // the guest's WhatsApp number surfaced right in the title line, so
        // Seni can copy/paste it straight into a group with Gabriel — see
        // lib/aiReply.ts's isServiceRequest and the property facts service
        // menu it's grounded in.
        const serviceRequestNote = draft.isServiceRequest
          ? ` 🛎️ SERVICE REQUEST${draft.guestPhone ? ` — WhatsApp: ${draft.guestPhone}` : " — no phone on file"}`
          : "";
        const approvalText = `New message from ${guestName} (${booking.propertyName ?? "Legacy Colombia"}):${serviceRequestNote}\n"${alertGuestMessage}"\n\nSuggested reply${languageNote}:\n"${alertReply}"\n\nReply YES to send it, NO to discard${customReplyNote}.`;

        // Parallel email channel (2026-08-21, Seni's ask) — sent before the
        // WhatsApp attempt so a total WhatsApp failure still lands the
        // alert somewhere. Keyed by draft id (same identity the wamid guard
        // dedupes WhatsApp on), shared with the webhook path's email.
        {
          const { sendAlertEmailOnce } = await import("@/lib/alertEmail");
          await sendAlertEmailOnce(
            `guest-msg-alert:${orgId}:${draft.id}:email`,
            `💬 New message from ${guestName} (${booking.propertyName ?? "Legacy Colombia"})`,
            `${approvalText}\n\n(Reply from your WhatsApp — YES/NO there still works. This email is a backup copy.)`
          ).catch(() => {});
        }

        // DURABLE FIX (2026-08-07): try the real Meta-approved template
        // first — it reaches Seni whether or not his 24h session window is
        // open, unlike the free-text fallback below (see
        // config.whatsappGuestReplyApprovalTemplate's comment for the full
        // story on why the earlier session-opener approach didn't actually
        // fix this). Falls back to the old free-text send if the template
        // isn't configured/approved yet, so this never regresses a working
        // deployment while Meta reviews it — just loses the durability
        // guarantee until approval lands.
        let wamid: string;
        try {
          wamid = await sendGuestReplyApprovalTemplate(
            {
              guestName,
              propertyName: booking.propertyName ?? "Legacy Colombia",
              // The independently-verified English readings from above — NOT
              // the raw stored fields (2026-08-18; the template path is what
              // actually delivered Seni's untranslated Spanish alert).
              guestMessage: alertGuestMessage,
              suggestedReply: alertReply,
            },
            orgId
          );
        } catch {
          wamid = await sendWhatsAppText(approvalText, orgId);
        }
        await linkWhatsAppMessageId(draft.id, wamid, orgId);

        await logAiActivity(
          {
            agentKey: AGENT_KEY,
            agentDisplayName: AGENT_NAME,
            task: "Request approval for guest reply",
            trigger: `Draft ready for thread ${threadId} (${guestName})`,
            communicationSent: { channel: "whatsapp", to: "Seni", text: approvalText },
            actionTaken: "Sent WhatsApp approval request to Seni",
            result: "pending_approval",
          },
          orgId
        );
      }

      drafted.push({ threadId, guestName, draftId: draft.id });

      // CURSOR ADVANCE (2026-08-17 audit) — reached only after the draft was
      // created AND the approval alert was sent (or deliberately suppressed as
      // a recent duplicate / already-alerted). Advancing here, rather than up
      // front, guarantees that if anything above threw, the cursor is left
      // untouched and the guest message is retried next run instead of being
      // silently dropped. Any error advancing the cursor itself must NOT
      // discard the successful draft/alert, so it's swallowed — worst case the
      // thread is re-examined next run, where the pending-draft reuse and
      // alreadyAlertedRecently guards prevent a re-draft or duplicate alert.
      await setLastSeenMessageId(threadId, maxId, orgId).catch((err) => {
        console.error(
          `[check-messages] draft/alert succeeded for thread ${threadId} but advancing the cursor failed`,
          err
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      errors.push({ threadId, error: message });
      await logAiActivity(
        {
          agentKey: AGENT_KEY,
          agentDisplayName: AGENT_NAME,
          task: "Draft/notify guest reply",
          trigger: `Thread ${threadId} (${guestName})`,
          error: message,
          result: "failed",
        },
        orgId
      );
    }
  }

  // threadsChecked reflects what was ACTUALLY fetched this run (bounded by
  // CRON_TIME_BUDGET_MS above), not the full candidate count — keeping this
  // honest is what would have caught the awaitingReply bug immediately via
  // the AI Activity log instead of it going unnoticed for a live incident.
  return {
    threadsChecked: fetchResults.length,
    candidateCount: hotCandidates.length,
    drafted,
    errors,
    chatFallback: chatFallbackResult,
    newBookings: newBookingResults,
    inquiryPoll: inquiryPollResult,
  };
}

export async function GET(req: NextRequest) {
  // CRON AUTH — FAIL CLOSED IN PRODUCTION (2026-08-17 audit). Vercel signs its
  // own cron requests with this header when CRON_SECRET is set. The guard used
  // to be `if (config.cronSecret) { check }`, so an unset CRON_SECRET in
  // production skipped the check entirely and left this endpoint — which
  // drives live OwnerRez polling, AI drafting and guest-approval WhatsApp
  // sends — wide open to anyone who found the URL. Now a missing secret is
  // rejected in production (503 + loud console.error); only non-production
  // (VERCEL_ENV !== "production" — local dev / preview) may run without one.
  const isProd = process.env.VERCEL_ENV === "production";
  if (!config.cronSecret) {
    if (isProd) {
      console.error(
        "[cron/check-messages] CRON_SECRET is not set in production — refusing to run this endpoint unauthenticated. Set CRON_SECRET in Vercel."
      );
      return NextResponse.json({ error: "Cron not configured." }, { status: 503 });
    }
    console.warn("[cron/check-messages] CRON_SECRET unset — running WITHOUT auth (non-production only).");
  } else {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${config.cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  // Needed both for listActiveOrganizations() itself and for the chat
  // fallback sweep inside each org's run — same top-level DB gate used by
  // api/cron/detect-campaigns and api/cron/revenue-snapshot.
  if (!isDbConfigured()) {
    return NextResponse.json({ skipped: "Database isn't connected yet." });
  }

  const orgs = await listActiveOrganizations();
  const results: Record<string, unknown> = {};

  for (const org of orgs) {
    try {
      const result = await runCheckMessagesForOrg(org.id);
      results[org.slug] = { ok: true, ...result };
    } catch (err) {
      console.error(`[cron/check-messages] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}
