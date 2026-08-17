import { NextRequest, NextResponse } from "next/server";
import { getBookings, getGuests, getThreadMessages } from "@/lib/ownerrez";
import { translateThreadMessages } from "@/lib/translate";
import { draftGuestReply } from "@/lib/aiReply";
import { getGlobalHostStyleExamples } from "@/lib/inbox";
import { resolveGuestName, resolveGuestPhone, buildGuestsById } from "@/lib/guestName";
import { createPendingDraft, getPendingDraftByThreadId } from "@/lib/pendingDrafts";
import { isAiReplyConfigured, isMessagingConfigured } from "@/lib/config";
import { trailingGuestMessages, combineGuestMessageBodies } from "@/lib/guestMessageGroup";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

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

  const session = getSessionFromRequest(req);
  // Property scoping (2026-08-17): without it, getBookings/getGuests below
  // defaulted to Legacy Colombia, so an Alva thread resolved to no booking,
  // showed the guest as "Guest", and never got an AI-drafted reply.
  const groupId = effectivePropertyGroupId(
    req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
  );
  const { threadId: threadIdParam } = await params;
  const threadId = Number(threadIdParam);
  if (!threadId || Number.isNaN(threadId)) {
    return NextResponse.json({ error: "Invalid threadId." }, { status: 400 });
  }

  const [messages, bookings, guests] = await Promise.all([
    getThreadMessages(threadId, session?.organizationId),
    getBookings(session?.organizationId, groupId),
    getGuests(session?.organizationId, groupId),
  ]);
  const booking = bookings.find((b) => b.threadIds.includes(threadId));
  const guestsById = buildGuestsById(guests);
  const guestName = booking ? resolveGuestName(booking, guestsById) : "Guest";

  const translations = await translateThreadMessages(
    threadId,
    messages.map((m) => ({ id: m.id, body: m.body })),
    session?.organizationId
  );

  let pendingDraft = await getPendingDraftByThreadId(threadId, session?.organizationId);
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
