import { NextRequest, NextResponse } from "next/server";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { PROPERTY_GROUP_COOKIE, normalizePropertyGroupId } from "@/lib/propertyGroups";
import { getCachedThreadSummaryLite, getCachedThreadMessages } from "@/lib/inbox";
import { getCachedTranslations } from "@/lib/translate";
import { resolveGuestName, buildGuestsById } from "@/lib/guestName";
import { getPendingDraftByThreadId } from "@/lib/pendingDrafts";
import { isMessagingConfigured } from "@/lib/config";
import { getSessionFromRequest } from "@/lib/session";
import type { Booking } from "@/lib/types";

export const dynamic = "force-dynamic";

// FAST PATH — opening a conversation. Deliberately does NOT call Claude for
// anything here (neither translating new messages nor generating a fresh AI
// draft) — that used to make opening a thread with even one uncached
// message take several seconds. See .../enrich/route.ts, which does that
// slower work in the background after this response has already rendered
// the conversation on screen.
//
// SPEED FIX (2026-08-08, Seni's ask: "conversations are taking a long time
// to load"): this used to always call getBookings()/getGuests() fresh (to
// resolve the booking + guest name) and the fully-live, always-uncached
// getThreadMessages() — up to three separate live OwnerRez round trips on
// every single click. getBookings()/getGuests() already have a documented
// failure mode where a cache miss "queues behind cron" and can take up to
// ~25s (see lib/inbox.ts's getAllThreadSummaries comment, discovered
// 2026-08-06) — the check-messages cron calls those exact same two
// functions every ~1 minute, so a real fraction of thread-opens were landing
// in that window.
//
// ROOT CAUSE FIX (2026-08-10): the first version of this fix tried calling
// getAllThreadSummaries() directly here, assuming its 30-min unstable_cache
// entry would already be warm (kept hot by the Inbox list's own poll). Real
// production timing proved that wrong — the SAME cached function, same org
// id, took ~20-29s when called from THIS route just seconds after
// api/messages/inbox/route.ts got a 210ms hit for it, meaning Next's
// unstable_cache Data Cache isn't reliably shared across separate API route
// handlers in this deployment. Now reads a small Redis-backed lite cache
// (booking + guestName only) that lib/inbox.ts's fetchAllThreadSummaries
// writes every time it computes the list — see getCachedThreadSummaryLite's
// comment in lib/inbox.ts for the full story. A single Redis GET is what
// actually gets us the near-instant "warm" path for the ~20 most-recently-
// active threads; falls back to the original direct getBookings/getGuests
// fetch for anything not in it (an older thread, a brand-new one, or if
// Redis genuinely has no entry yet), so correctness never regresses. Message
// bodies still always go through the same 120s-cached getCachedThreadMessages
// the cron/Inbox already keep warm — the .../enrich route does a fully live
// re-fetch a moment later and the frontend merges it in, so up-to-the-second
// accuracy is preserved without paying for it on the very first paint.
export async function GET(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  if (!isMessagingConfigured()) {
    return NextResponse.json({ error: "OwnerRez messaging isn't connected yet." }, { status: 400 });
  }

  const session = getSessionFromRequest(req);
  const __groupId = normalizePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value);
  const orgId = session?.organizationId;
  const { threadId: threadIdParam } = await params;
  const threadId = Number(threadIdParam);
  if (!threadId || Number.isNaN(threadId)) {
    return NextResponse.json({ error: "Invalid threadId." }, { status: 400 });
  }

  const warm = await getCachedThreadSummaryLite(threadId, orgId);

  const [messages, pendingDraft, coldLookup] = await Promise.all([
    getCachedThreadMessages(threadId, orgId),
    getPendingDraftByThreadId(threadId, orgId),
    warm ? Promise.resolve(null) : Promise.all([getBookings(orgId, __groupId), getGuests(orgId, __groupId)]),
  ]);

  let booking: Booking | null;
  let guestName: string;
  if (warm) {
    booking = warm.booking;
    guestName = warm.guestName;
  } else {
    const [bookings, guests] = coldLookup!;
    booking = bookings.find((b) => b.threadIds.includes(threadId)) ?? null;
    guestName = booking ? resolveGuestName(booking, buildGuestsById(guests)) : "Guest";
  }

  const translations = await getCachedTranslations(
    threadId,
    messages.map((m) => ({ id: m.id, body: m.body })),
    orgId
  );

  const newestGuestMessage = [...messages].reverse().find((m) => m.isGuest);
  const newestGuestTranslation = newestGuestMessage ? translations[newestGuestMessage.id] : undefined;
  const guestLanguage =
    pendingDraft?.language ??
    (newestGuestTranslation && !newestGuestTranslation.isEnglish ? newestGuestTranslation.language : null) ??
    null;

  return NextResponse.json({
    threadId,
    booking: booking ?? null,
    guestName,
    guestLanguage,
    messages,
    translations,
    pendingDraft,
  });
}
