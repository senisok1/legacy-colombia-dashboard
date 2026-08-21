import { NextRequest, NextResponse } from "next/server";
import { getBookings, getGuests, getThreadMessages } from "@/lib/ownerrez";
import { translateThreadMessages, type MessageTranslation } from "@/lib/translate";
import { draftGuestReply } from "@/lib/aiReply";
import { getGlobalHostStyleExamples, getCachedThreadMessages, getSnapshotThreadMessages } from "@/lib/inbox";
import { resolveGuestName, resolveGuestPhone, buildGuestsById } from "@/lib/guestName";
import { createPendingDraft, getPendingDraftByThreadId } from "@/lib/pendingDrafts";
import { isAiReplyConfigured, isMessagingConfigured } from "@/lib/config";
import { trailingGuestMessages, combineGuestMessageBodies } from "@/lib/guestMessageGroup";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import type { Booking, Guest, ThreadMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_STYLE_EXAMPLES = 20;

// SLOW PATH — called by the frontend right after the fast thread route
// above has already rendered the conversation, so this runs in the
// background instead of blocking the initial view. Does the actual Claude
// work: translating any message that isn't cached yet, and generating a
// fresh AI-suggested reply if the newest guest message doesn't already
// have one pending (shared with the cron poll via the by-thread draft
// index — see pendingDrafts.ts — so neither side drafts or bills twice).
//
// SPEED FIX (2026-08-08): also returns `messages` now — a fully live,
// uncached getThreadMessages() call, same as this route always did. The
// fast route above switched to the 120s-cached getCachedThreadMessages so
// opening a conversation doesn't pay for a live OwnerRez round trip (or
// worse, queue behind the cron — see that route's header comment) on every
// click; this slow path is what corrects that up to 120s of staleness back
// to fully live, a moment after the fast paint, the same way it already did
// for translations and the AI draft. The frontend merges this in — see
// ThreadInbox.tsx's openThread().
export async function GET(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  if (!isMessagingConfigured()) {
    return NextResponse.json({ error: "OwnerRez messaging isn't connected yet." }, { status: 400 });
  }

  const { threadId: threadIdParam } = await params;
  const threadId = Number(threadIdParam);
  if (!threadId || Number.isNaN(threadId)) {
    return NextResponse.json({ error: "Invalid threadId." }, { status: 400 });
  }

  // Top-level try/catch (2026-08-21, Seni's ask: "I need to see all messages
  // in English no matter what language the guest is in" — reported against
  // Natalia Velez's thread staying untranslated). Root cause: this route
  // previously had NO error handling at all around its live OwnerRez calls —
  // if OwnerRez rate-limited or hiccuped (it does: ~300 req/5min, see
  // lib/inbox.ts) the whole handler threw unhandled, Next returned a
  // non-JSON error response, and ThreadInbox.tsx's `.catch(() => {})` on
  // this fetch silently swallowed it — the guest's message stayed in its
  // original language forever, with no retry and no on-screen indication
  // anything failed. Wrapping the entire handler guarantees this route
  // always returns valid JSON the frontend can act on (see the `error` field
  // it now sets on failure, used to drive an automatic retry client-side).
  try {
    return await buildEnrichedThread(req, threadId);
  } catch (err) {
    console.error(`GET /api/messages/thread/${threadId}/enrich failed:`, err);
    return NextResponse.json({ threadId, guestLanguage: null, translations: {}, pendingDraft: null, error: "enrich_failed" });
  }
}

async function buildEnrichedThread(req: NextRequest, threadId: number) {
  const session = getSessionFromRequest(req);
  const groupId = effectivePropertyGroupId(
    req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
  );

  // Message fetch with a fallback ladder (2026-08-21, Seni's ask: "I need to
  // see all messages in English no matter what language the guest is in" —
  // reported against Natalia Velez's thread staying untranslated). Root
  // cause: this route had NO top-level error handling, and getThreadMessages
  // is a fully-live, uncached OwnerRez call — if OwnerRez rate-limits or
  // hiccups (confirmed happens for real: OwnerRez enforces ~300 req/5min,
  // see lib/inbox.ts), the live call throws, the whole handler throws
  // unhandled, Next returns a non-JSON error response, and
  // ThreadInbox.tsx's `.catch(() => {})` on this fetch silently swallows it
  // — the guest's message is left showing in its original language forever,
  // with no retry and no on-screen indication anything failed. Falling back
  // to the 120s-cached copy, then the Redis snapshot (same two layers the
  // FAST route already trusts), means a single live-fetch hiccup no longer
  // blocks translation — translateThreadMessages below still runs against
  // whatever message set we DO have.
  let messages: ThreadMessage[];
  try {
    messages = await getThreadMessages(threadId, session?.organizationId);
  } catch {
    try {
      messages = await getCachedThreadMessages(threadId, session?.organizationId);
    } catch {
      messages = (await getSnapshotThreadMessages(threadId, session?.organizationId).catch(() => null)) ?? [];
    }
  }

  // Booking/guest lookup is best-effort here too — a failure just means the
  // guest name/booking context can't be resolved this pass (the fast route
  // already has a warm/cached fallback for that), but it must never block
  // translation, which is the one thing this ask is about guaranteeing.
  let booking: Booking | undefined;
  let guestName = "Guest";
  let guestsById = new Map<number, Guest>();
  try {
    const [bookings, guests] = await Promise.all([
      getBookings(session?.organizationId, groupId),
      getGuests(session?.organizationId, groupId),
    ]);
    booking = bookings.find((b) => b.threadIds.includes(threadId));
    guestsById = buildGuestsById(guests);
    guestName = booking ? resolveGuestName(booking, guestsById) : "Guest";
  } catch {
    // booking stays undefined, guestName stays "Guest" — translation below
    // is unaffected.
  }

  // The actual guarantee: always attempt translation for whatever messages
  // we have, and never let a failure here produce an unhandled exception —
  // translateThreadMessages() itself already never throws (see its own
  // per-message fallback), but wrapping defensively means a future change
  // there can't silently regress this guarantee either.
  const translations = await translateThreadMessages(
    threadId,
    messages.map((m) => ({ id: m.id, body: m.body })),
    session?.organizationId
  ).catch(() => ({}) as Record<number, MessageTranslation>);

  let pendingDraft = await getPendingDraftByThreadId(threadId, session?.organizationId).catch(() => null);
  // A guest can send several messages in a row — draft against (and dedupe
  // on) the whole trailing run of them, not just the very last one. See
  // lib/guestMessageGroup.ts.
  const newestGuestMessageGroup = trailingGuestMessages(messages);
  const newestGuestMessage = newestGuestMessageGroup[newestGuestMessageGroup.length - 1];
  const combinedGuestMessage = combineGuestMessageBodies(newestGuestMessageGroup);

  const needsFreshDraft =
    Boolean(booking) &&
    isAiReplyConfigured() &&
    Boolean(newestGuestMessage) &&
    (!pendingDraft || pendingDraft.guestMessage !== combinedGuestMessage);

  if (needsFreshDraft && booking && newestGuestMessage) {
    try {
      // Grounded in Seni's own replies across every recent conversation, not
      // just this one thread's (often sparse) history — see inbox.ts.
      const stylePool = await getGlobalHostStyleExamples(MAX_STYLE_EXAMPLES, session?.organizationId, groupId);
      const drafted = await draftGuestReply({
        guestMessage: combinedGuestMessage,
        booking,
        hostMessages: stylePool.map((body) => ({ id: 0, threadId, body, isGuest: false, fromRole: "co_host" })),
        organizationId: session?.organizationId,
      });

      // Deliberately silent — no WhatsApp text here. Seni is already looking
      // at this exact conversation right now; the cron poll (which does
      // ping WhatsApp) will see this same draft via getPendingDraftByThreadId
      // next time it runs and skip re-drafting it, so nothing gets billed
      // or sent twice either way.
      pendingDraft = await createPendingDraft(
        {
          threadId,
          bookingId: booking.id,
          guestId: booking.guestId,
          guestName,
          guestMessage: combinedGuestMessage,
          draftReply: drafted.reply,
          language: drafted.language,
          guestMessageEnglish: drafted.guestMessageEnglish,
          replyEnglish: drafted.replyEnglish,
          isServiceRequest: drafted.isServiceRequest,
          guestPhone: drafted.isServiceRequest ? resolveGuestPhone(booking, guestsById) : undefined,
        },
        session?.organizationId
      );
    } catch {
      // Draft generation failing shouldn't break the thread view — Seni can
      // still read the conversation and reply manually.
    }
  }

  const newestGuestTranslation = newestGuestMessage ? translations[newestGuestMessage.id] : undefined;
  const guestLanguage =
    pendingDraft?.language ??
    (newestGuestTranslation && !newestGuestTranslation.isEnglish ? newestGuestTranslation.language : null) ??
    null;

  return NextResponse.json({ threadId, guestLanguage, translations, pendingDraft, messages });
}
