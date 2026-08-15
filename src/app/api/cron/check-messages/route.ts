import { NextRequest, NextResponse } from "next/server";
import { config, isAiReplyConfigured, isDbConfigured, isMessagingConfigured, isWhatsAppConfigured } from "@/lib/config";
import { getBookings, getGuests, getThreadMessages } from "@/lib/ownerrez";
import { getGlobalHostStyleExamples, getCachedThreadMessages } from "@/lib/inbox";
import { resolveGuestName, resolveGuestPhone, buildGuestsById } from "@/lib/guestName";
import { draftGuestReply } from "@/lib/aiReply";
import { sendWhatsAppText, sendGuestReplyApprovalTemplate } from "@/lib/whatsapp";
import {
  createPendingDraft,
  getLastSeenMessageId,
  setLastSeenMessageId,
  linkWhatsAppMessageId,
  getPendingDraftByThreadId,
  getLastCheckedAtMany,
  setLastCheckedAt,
} from "@/lib/pendingDrafts";
import { logAiActivity } from "@/lib/aiActivity";
import { trailingGuestMessages, combineGuestMessageBodies } from "@/lib/guestMessageGroup";
import { sweepChatEscalationFallbacks } from "@/lib/chatEscalationFallback";
import { checkNewBookingAlerts } from "@/lib/bookingAlerts";
import { listActiveOrganizations } from "@/lib/organizations";
import type { ThreadMessage } from "@/lib/types";

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
  let newBookingResult: Awaited<ReturnType<typeof checkNewBookingAlerts>> | { skipped: string } = {
    skipped: "WhatsApp not configured yet.",
  };
  if (isWhatsAppConfigured()) {
    try {
      const [bookingsForAlert, guestsForAlert] = await Promise.all([getBookings(orgId), getGuests(orgId)]);
      newBookingResult = await checkNewBookingAlerts(bookingsForAlert, buildGuestsById(guestsForAlert), orgId);
    } catch (err) {
      newBookingResult = { skipped: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  if (!isMessagingConfigured()) {
    return {
      skipped: "OwnerRez messaging not connected yet.",
      chatFallback: chatFallbackResult,
      newBookings: newBookingResult,
    };
  }
  if (!isAiReplyConfigured()) {
    return {
      skipped: "ANTHROPIC_API_KEY not set (or has no credits).",
      chatFallback: chatFallbackResult,
      newBookings: newBookingResult,
    };
  }
  if (!isWhatsAppConfigured()) {
    return {
      skipped: "WhatsApp not configured yet.",
      chatFallback: chatFallbackResult,
      newBookings: newBookingResult,
    };
  }

  const [allBookings, guests] = await Promise.all([getBookings(orgId), getGuests(orgId)]);
  const bookings = allBookings.filter(
    (b) => !b.isBlock && b.status !== "Cancelled" && b.threadIds.length > 0 && isActiveEnoughForPolling(b.departure)
  );
  const guestsById = buildGuestsById(guests);

  // Grounded in Seni's own replies across every recent conversation (see
  // inbox.ts), not just whatever's in each individual thread — most threads
  // only have a couple of prior host messages, nowhere near enough for the
  // AI to reliably match his tone. Computed once per run since it's the
  // same regardless of which thread is being drafted for.
  const stylePool = await getGlobalHostStyleExamples(MAX_STYLE_EXAMPLES, orgId);
  const drafted: { threadId: number; guestName?: string; draftId: string }[] = [];
  const errors: { threadId: number; error: string }[] = [];

  // Dedup (booking, threadId) pairs up front — a guest can theoretically
  // appear on more than one booking's threadIds list, and we only want to
  // check each real thread once per run.
  const seenThreadIds = new Set<number>();
  const candidates: { booking: (typeof bookings)[number]; threadId: number }[] = [];
  for (const booking of bookings) {
    for (const threadId of booking.threadIds) {
      if (seenThreadIds.has(threadId)) continue;
      seenThreadIds.add(threadId);
      candidates.push({ booking, threadId });
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
  const CRON_TIME_BUDGET_MS = 45_000;
  const runStartedAt = Date.now();

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

  for (const { booking, threadId } of hotCandidates) {
    const messages = messagesByThreadId.get(threadId);
    if (!messages || messages.length === 0) continue;

    const lastSeenId = await getLastSeenMessageId(threadId, orgId);
    const isFirstPoll = lastSeenId === null;
    const newMessages = lastSeenId ? messages.filter((m) => m.id > lastSeenId) : messages;
    const maxId = Math.max(...messages.map((m) => m.id));
    await setLastSeenMessageId(threadId, maxId, orgId);

    // A guest can send several messages in a row (e.g. three separate
    // WhatsApp/OwnerRez sends a few seconds apart) — grab the whole trailing
    // run of them, not just the newest one, so nothing gets silently
    // dropped from what the AI drafts against and what Seni sees. See
    // lib/guestMessageGroup.ts for why.
    const newGuestMessages = trailingGuestMessages(newMessages);
    if (newGuestMessages.length === 0) continue;

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
      if (ageMs > FIRST_POLL_MAX_AGE_MS) continue;
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

    const guestName = resolveGuestName(booking, guestsById);

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

        draft = await createPendingDraft(
          {
            threadId,
            bookingId: booking.id,
            guestId: booking.guestId,
            guestName,
            guestMessage: guestMessageBody,
            draftReply: draftReply.reply,
            language: draftReply.language,
            guestMessageEnglish: draftReply.guestMessageEnglish,
            replyEnglish: draftReply.replyEnglish,
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
      if (!draft.wamid) {
        const isNonEnglish = Boolean(draft.language) && draft.language !== "English";
        const languageNote = isNonEnglish ? ` [written in ${draft.language}]` : "";
        const customReplyNote = isNonEnglish
          ? `, or type your own reply in English to send that (auto-translated to ${draft.language}) instead`
          : ", or type your own reply to send that instead";
        // Service requests (chef, massage, jet ski, boat rental, etc.) get
        // the guest's WhatsApp number surfaced right in the title line, so
        // Seni can copy/paste it straight into a group with Gabriel — see
        // lib/aiReply.ts's isServiceRequest and the property facts service
        // menu it's grounded in.
        const serviceRequestNote = draft.isServiceRequest
          ? ` 🛎️ SERVICE REQUEST${draft.guestPhone ? ` — WhatsApp: ${draft.guestPhone}` : " — no phone on file"}`
          : "";
        const approvalText = `New message from ${guestName} (${booking.propertyName ?? "Legacy Colombia"}):${serviceRequestNote}\n"${draft.guestMessageEnglish ?? draft.guestMessage}"\n\nSuggested reply${languageNote}:\n"${draft.replyEnglish ?? draft.draftReply}"\n\nReply YES to send it, NO to discard${customReplyNote}.`;

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
              guestMessage: draft.guestMessageEnglish ?? draft.guestMessage,
              suggestedReply: draft.replyEnglish ?? draft.draftReply,
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
    newBookings: newBookingResult,
  };
}

export async function GET(req: NextRequest) {
  // Vercel signs its own cron requests with this header when CRON_SECRET is
  // set, so we can reject anyone else who finds/guesses this URL.
  if (config.cronSecret) {
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
