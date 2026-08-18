import { randomUUID } from "node:crypto";
import { redisGet, redisSet, redisDel, redisMGet, redisSetNX } from "./redis";
import { logAiActivity } from "./aiActivity";
import { getDefaultOrganizationId } from "./organizations";
import { getBookings } from "./ownerrez";
import type { PendingDraft } from "./types";

// Redis-backed store for AI-drafted guest replies awaiting Seni's approval
// over WhatsApp, plus the small bits of cron state (per-thread "last seen
// message" cursor) that need to survive between separate serverless
// invocations of the polling cron job. See lib/redis.ts for the connection,
// and lib/config.ts's isRedisConfigured() for the "not set up yet" guard.
//
// Phase 3 smoke-test finding (2026-08-05): every key here used to have NO
// organization namespace at all — a flat `draft:{id}` / `draft:pending-ids` /
// `cron:last-seen:{threadId}` keyspace shared across every tenant. That meant
// a second tenant's Approvals tab would show (and could approve/reject) the
// FIRST tenant's real guest-reply drafts, and two tenants' independent
// OwnerRez accounts could collide on the same numeric threadId and silently
// overwrite each other's "current draft for this thread" pointer. Every
// exported function below now takes an optional trailing `organizationId`
// (same pattern as every other lib/*.ts file since Phase 3) and every key is
// namespaced by org id, same as revenueManager.ts's getWeekdayWeekendRates
// cache key and cooBriefing.ts's cacheKeyForToday.
//
// Migration note: this intentionally does NOT migrate any pre-existing
// un-namespaced keys (old `draft:{id}` etc.) — drafts have a 3-day TTL and
// are meant to be resolved same-day, so the worst case of deploying this is
// any single draft that's genuinely still awaiting approval at deploy time
// drops out of the Approvals queue and expires unseen (self-healing: the
// next guest message on that thread drafts a fresh one). The `cron:last-seen`
// cursor also resets once per thread, which can at most cause one duplicate
// draft attempt — already handled by createPendingDraft's "supersede stale
// draft" logic below.
//
// Keys used (per organization id `org`):
//   draft:{org}:{id}                 -> JSON PendingDraft                 (TTL 3 days)
//   draft:{org}:by-wamid:{wamid}     -> draft id                           (TTL 3 days)
//   draft:{org}:by-thread:{threadId} -> draft id                          (TTL 3 days)
//   draft:{org}:pending-ids          -> JSON string[] of ids awaiting reply (no TTL)
//   draft:{org}:response-times       -> JSON ResponseTimeEntry[] rolling log (no TTL)
//   cron:{org}:last-seen:{threadId}  -> last inbound OwnerRez message id    (no TTL)

const DRAFT_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 days — stale approvals aren't useful past that

function draftKey(orgId: string, id: string): string {
  return `draft:${orgId}:${id}`;
}

function wamidKey(orgId: string, wamid: string): string {
  return `draft:${orgId}:by-wamid:${wamid}`;
}

function threadKey(orgId: string, threadId: number): string {
  return `draft:${orgId}:by-thread:${threadId}`;
}

function pendingIdsKey(orgId: string): string {
  return `draft:${orgId}:pending-ids`;
}

async function getPendingIds(orgId: string): Promise<string[]> {
  const raw = await redisGet(pendingIdsKey(orgId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function setPendingIds(orgId: string, ids: string[]): Promise<void> {
  await redisSet(pendingIdsKey(orgId), JSON.stringify(ids));
}

export async function createPendingDraft(
  data: Omit<PendingDraft, "id" | "status" | "createdAt">,
  organizationId?: string
): Promise<PendingDraft> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());

  // If the guest sent another message before Seni ever acted on the last
  // draft for this thread, that old draft is now stale — nobody rejected or
  // approved it, the conversation just moved on. Mark it superseded rather
  // than leaving it sitting in the pending queue forever (this is exactly
  // what built up ~100 stale entries in the Approvals tab before it existed
  // to surface them — see api/admin/reconcile-stale-approvals for the
  // one-time cleanup of the backlog this created). Every caller of this
  // function already only calls it once it's decided a fresh draft is
  // needed, so it's safe to always supersede here rather than re-checking
  // that decision.
  const previous = await getPendingDraftByThreadId(data.threadId, orgId);
  if (previous) {
    await resolvePendingDraft(previous.id, { status: "superseded" }, orgId);
    // Fire-and-forget, matching aiActivity.ts's own fail-safe philosophy —
    // this is a nice-to-have audit trail entry, never worth blocking or
    // failing draft creation over. Hardcoded agent identity is fine here:
    // this is currently the only pipeline that creates pending drafts.
    await logAiActivity({
      agentKey: "guest_experience",
      agentDisplayName: "AI Guest Experience Manager",
      task: "Supersede stale guest-reply draft",
      trigger: `New message on thread ${data.threadId} arrived before draft ${previous.id} was resolved`,
      decision: "superseded — nobody approved or rejected it, the guest said something new",
      actionTaken: "Marked prior draft superseded so it drops out of the Approvals queue",
      result: "superseded",
    }, orgId).catch(() => {});
  }

  const draft: PendingDraft = {
    ...data,
    id: randomUUID().slice(0, 8),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await redisSet(draftKey(orgId, draft.id), JSON.stringify(draft), { exSeconds: DRAFT_TTL_SECONDS });
  // Points at the newest draft for this thread — lets both the cron poll
  // and the dashboard Inbox check "is there already a pending draft for
  // this exact guest message" before drafting, so whichever one gets there
  // first doesn't get duplicated (and re-billed) by the other.
  await redisSet(threadKey(orgId, draft.threadId), draft.id, { exSeconds: DRAFT_TTL_SECONDS });
  const ids = await getPendingIds(orgId);
  ids.push(draft.id);
  await setPendingIds(orgId, ids);
  return draft;
}

export async function linkWhatsAppMessageId(
  draftId: string,
  wamid: string,
  organizationId?: string
): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await redisSet(wamidKey(orgId, wamid), draftId, { exSeconds: DRAFT_TTL_SECONDS });
  // Also stamp the draft itself with the wamid, so callers can tell "has
  // this draft already been texted to Seni" without a second lookup.
  const draft = await getPendingDraft(draftId, orgId);
  if (draft) {
    await redisSet(draftKey(orgId, draftId), JSON.stringify({ ...draft, wamid }), { exSeconds: DRAFT_TTL_SECONDS });
  }
}

/** Corrects a stored draft's language / English-preview fields in place
 * (2026-08-18). Exists because the check-messages alert builder now runs an
 * INDEPENDENT language detection at send time (never trusting the drafting
 * model's self-reported `language` — observed wrong for short messages like
 * "Si gracias, todo bien", which produced a Spanish alert Seni couldn't
 * read). When that detection corrects the language, the fix must ALSO land
 * on the stored draft, because the EDIT: path later translates Seni's typed
 * English into `draft.language` before sending — a draft mislabeled
 * "English" would send his English text untranslated to a Spanish guest. */
export async function updateDraftEnglishFields(
  id: string,
  fields: { language?: string; guestMessageEnglish?: string; replyEnglish?: string },
  organizationId?: string
): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const draft = await getPendingDraft(id, orgId);
  if (!draft) return;
  const next: PendingDraft = {
    ...draft,
    ...(fields.language ? { language: fields.language } : {}),
    ...(fields.guestMessageEnglish ? { guestMessageEnglish: fields.guestMessageEnglish } : {}),
    ...(fields.replyEnglish ? { replyEnglish: fields.replyEnglish } : {}),
  };
  await redisSet(draftKey(orgId, id), JSON.stringify(next), { exSeconds: DRAFT_TTL_SECONDS });
}

// ---------- Atomic send-claim (2026-08-17 audit: double-send fix) ----------
// The bug: resolvePendingDraft is a read-modify-write with no compare-and-set,
// and the WhatsApp approval path does the slow OwnerRez send BETWEEN reading
// the draft's status and writing "sent". Two approvals racing (dashboard +
// WhatsApp "yes", or a Meta webhook retry replaying the same "yes") both saw
// status:"pending" and both sent — the guest got the message twice. The
// dashboard path was worse: it never read the draft's status at all.
//
// The fix is a claim key set with NX: exactly one caller can transition a
// draft from pending to in-flight, and it must hold the claim before it calls
// OwnerRez. A 2-minute TTL means a crash mid-send self-heals rather than
// wedging the draft forever. releaseDraftClaim() lets a caller hand the claim
// back if its own send genuinely failed, so a real retry can re-acquire it.

function claimKey(orgId: string, id: string): string {
  return `draft:${orgId}:send-claim:${id}`;
}

export type ClaimResult =
  | { ok: true; draft: PendingDraft }
  | { ok: false; reason: "not_found" | "already_resolved" | "in_flight"; draft: PendingDraft | null };

/**
 * Atomically claim a pending draft for sending. Succeeds only if the draft
 * exists, is still "pending", AND no other actor holds the claim. The claim
 * MUST be acquired before the OwnerRez send, and the caller should mark the
 * draft "sent" (via resolvePendingDraft) once the send returns.
 */
export async function claimDraftForSend(id: string, organizationId?: string): Promise<ClaimResult> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const draft = await getPendingDraft(id, orgId);
  if (!draft) return { ok: false, reason: "not_found", draft: null };
  if (draft.status !== "pending") return { ok: false, reason: "already_resolved", draft };
  const claimed = await redisSetNX(claimKey(orgId, id), new Date().toISOString(), 120);
  if (!claimed) return { ok: false, reason: "in_flight", draft };
  return { ok: true, draft };
}

/** Hand a claim back after a send that genuinely failed, so a legitimate
 * retry can re-acquire it. Never called on success — a sent draft must stay
 * unclaimable. */
export async function releaseDraftClaim(id: string, organizationId?: string): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await redisDel(claimKey(orgId, id)).catch(() => {});
}

// Inbound-message idempotency (2026-08-17 audit). Meta retries a webhook POST
// if our handler is slow, and this handler does translation + OwnerRez sends
// inline — so the same "yes" can arrive twice and race past the claim on two
// instances. Deduping the Meta message id (wamid) of the INBOUND reply means a
// retry is dropped before it can act. Returns true the first time a given
// inbound id is seen, false on every replay.
export async function markInboundProcessed(
  inboundId: string,
  organizationId?: string,
  ttlSeconds = 60 * 60 * 24
): Promise<boolean> {
  if (!inboundId) return true; // nothing to dedupe on — don't block real traffic
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  return redisSetNX(`draft:${orgId}:inbound-seen:${inboundId}`, "1", ttlSeconds);
}

export async function getPendingDraft(id: string, organizationId?: string): Promise<PendingDraft | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const raw = await redisGet(draftKey(orgId, id));
  if (!raw) return null;
  return JSON.parse(raw) as PendingDraft;
}

export async function getPendingDraftByWamid(wamid: string, organizationId?: string): Promise<PendingDraft | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const id = await redisGet(wamidKey(orgId, wamid));
  if (!id) return null;
  return getPendingDraft(id, orgId);
}

/** The current pending draft for a thread, if any — used to avoid drafting
 * (and WhatsApp-notifying) the same guest message twice when both the cron
 * poll and the dashboard Inbox might see it. Returns null once the draft
 * has been resolved (sent/rejected/failed), so a genuinely new guest
 * message still gets a fresh draft. */
export async function getPendingDraftByThreadId(
  threadId: number,
  organizationId?: string
): Promise<PendingDraft | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const id = await redisGet(threadKey(orgId, threadId));
  if (!id) return null;
  const draft = await getPendingDraft(id, orgId);
  if (!draft || draft.status !== "pending") return null;
  return draft;
}

/** The single oldest draft still awaiting a reply — fallback when a WhatsApp
 * reply doesn't quote/reference a specific approval message. Fine for a
 * single-property, low-volume inbox where it's rare to have more than one
 * open approval at once. */
export async function getOldestPendingDraft(organizationId?: string): Promise<PendingDraft | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const ids = await getPendingIds(orgId);
  for (const id of ids) {
    const draft = await getPendingDraft(id, orgId);
    if (draft && draft.status === "pending") return draft;
  }
  return null;
}

/** Every draft still awaiting Seni's decision, newest first — powers the
 * standalone Approvals tab (app/approvals/page.tsx), which flattens every
 * open AI-suggested reply across every conversation into one queue instead
 * of requiring him to click into each thread individually to find them. */
export async function getAllPendingDrafts(
  organizationId?: string,
  propertyGroupId?: string
): Promise<PendingDraft[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const ids = await getPendingIds(orgId);
  const drafts = await Promise.all(ids.map((id) => getPendingDraft(id, orgId)));
  const pending = drafts
    .filter((d): d is PendingDraft => d !== null && d.status === "pending")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  // Property scoping (2026-08-17). The Redis keyspace is org-level, and
  // rekeying it per property would strand every draft already queued — so
  // instead each draft is matched to the active group through its booking,
  // which getBookings() already returns group-scoped. A draft whose booking
  // isn't in this group (or no longer exists) is hidden here rather than
  // deleted, so switching property brings it straight back.
  if (!propertyGroupId) return pending;
  try {
    const bookings = await getBookings(orgId, propertyGroupId);
    const ourBookingIds = new Set(bookings.map((b) => b.id));
    return pending.filter((d) => ourBookingIds.has(d.bookingId));
  } catch {
    // Never hide the approvals queue just because OwnerRez hiccuped.
    return pending;
  }
}

/**
 * `propertyGroupId` (added 2026-08-17) only affects WHICH property's
 * response-time bucket a "sent" resolution is recorded against — see
 * recordResponseTime() below for the mis-namespacing bug it fixes. It's
 * optional so the existing callers keep compiling and keep their current
 * (default-group) behaviour:
 *   - src/app/api/messages/reply/route.ts — can and should pass the active
 *     group (it already reads the PROPERTY_GROUP_COOKIE for other purposes);
 *     still to be updated.
 *   - src/app/api/whatsapp/webhook/route.ts — inbound Meta webhook, no
 *     session/cookie available, so it stays on the default bucket.
 */
export async function resolvePendingDraft(
  id: string,
  update: { status: PendingDraft["status"]; draftReply?: string },
  organizationId?: string,
  propertyGroupId?: string
): Promise<PendingDraft | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const draft = await getPendingDraft(id, orgId);
  if (!draft) return null;

  const resolvedAt = new Date().toISOString();
  const updated: PendingDraft = {
    ...draft,
    status: update.status,
    draftReply: update.draftReply ?? draft.draftReply,
    resolvedAt,
  };
  await redisSet(draftKey(orgId, id), JSON.stringify(updated), { exSeconds: DRAFT_TTL_SECONDS });

  if (update.status !== "pending") {
    const ids = (await getPendingIds(orgId)).filter((x) => x !== id);
    await setPendingIds(orgId, ids);
  }

  // A guest actually got a reply — record how long that took, for the
  // "guest response-time SLA" executive-report metric. Only "sent" counts:
  // "rejected"/"failed" don't mean the guest heard back yet, and "superseded"
  // means the guest sent a new message before Seni ever acted (see
  // createPendingDraft's comment) so there's no real response time to record.
  if (update.status === "sent") {
    const minutes = (new Date(resolvedAt).getTime() - new Date(draft.createdAt).getTime()) / 60000;
    if (minutes >= 0) {
      await recordResponseTime(minutes, resolvedAt, orgId, propertyGroupId);
    }
  }

  return updated;
}

// ---------- Guest response-time SLA (Phase 8 extension) ----------
// Redis alone can't answer "average response time over the last N days"
// after the fact — draft:{org}:pending-ids only tracks currently-OPEN drafts
// (an id is removed the moment it resolves), so there's no index of resolved
// drafts to look back over, and draft:{org}:{id} keys expire after
// DRAFT_TTL_SECONDS anyway. Instead, this keeps its own small rolling log:
// a capped-length JSON array written every time a reply actually goes out.
// Starts accumulating from whenever this shipped — there's no way to
// backfill response times for replies sent before this existed, which
// executiveReport.ts's dataGaps should say plainly rather than implying a
// longer history than really exists.

// Group-namespaced 2026-08-17: response-time stats fed the daily executive
// summary, so one property's reply speed was being reported on every other
// property's report. Default group keeps the original key so existing
// history isn't orphaned.
/** Short-lived guard against alerting twice for the SAME guest text
 * (2026-08-17). Seni received two WhatsApp alerts for one guest message
 * ("Exacto, pero deberían poner eso de una vez en el precio") a few seconds
 * apart, each carrying a DIFFERENT AI draft — i.e. it was drafted twice.
 *
 * The existing guard compares the pending draft's stored guestMessage, which
 * only protects within a single thread's pending draft. It can't stop the
 * same text arriving on two OwnerRez threads for one guest (Airbnb + direct
 * are separate threads), nor two overlapping cron runs that both read
 * last-seen before either wrote it. Keying on the message CONTENT closes
 * both, and a short TTL means a guest legitimately repeating themselves
 * later still gets through. */
export async function alreadyAlertedRecently(
  orgId: string,
  guestMessage: string,
  ttlSeconds = 15 * 60
): Promise<boolean> {
  const body = guestMessage.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 400);
  if (!body) return false;
  let h = 0;
  for (let i = 0; i < body.length; i++) h = (Math.imul(31, h) + body.charCodeAt(i)) | 0;
  const key = `draft:${orgId}:alerted:${(h >>> 0).toString(36)}`;
  const seen = await redisGet(key).catch(() => null);
  if (seen) return true;
  await redisSet(key, "1", { exSeconds: ttlSeconds }).catch(() => {});
  return false;
}

function responseTimesKey(orgId: string, propertyGroupId?: string): string {
  const suffix =
    propertyGroupId && propertyGroupId !== "legacy-colombia" ? `:${propertyGroupId}` : "";
  return `draft:${orgId}:response-times${suffix}`;
}
const RESPONSE_TIMES_MAX = 300; // plenty for any "last N days" window this app looks at

type ResponseTimeEntry = { resolvedAt: string; minutes: number };

/**
 * BUG FIX (2026-08-17 audit): this wrote to `responseTimesKey(orgId)` with NO
 * property group, while getRecentResponseTimes() below reads
 * `responseTimesKey(orgId, propertyGroupId)`. Because the key builder only
 * omits the suffix for the DEFAULT group, that meant:
 *   - every property's response times were appended to one shared,
 *     un-namespaced bucket, and
 *   - all four non-default properties read a key nothing ever wrote to, so
 *     their executive summary's response-time SLA was permanently empty and
 *     read as "no data yet" forever, not just at launch.
 * The write now takes the same propertyGroupId the read expects.
 *
 * The parameter is OPTIONAL because not every caller can supply it, and
 * omitting it reproduces exactly the old (correct-for-Legacy-Colombia)
 * default-group key rather than inventing a new one:
 *   - src/app/api/messages/reply/route.ts — HAS the session + property-group
 *     cookie and should pass it (out of this fix's file scope; see the note
 *     on resolvePendingDraft).
 *   - src/app/api/whatsapp/webhook/route.ts — an inbound Meta webhook with no
 *     session and no cookie, so it genuinely cannot resolve a group here; its
 *     approvals fall back to the default group's bucket.
 */
async function recordResponseTime(
  minutes: number,
  resolvedAt: string,
  orgId: string,
  propertyGroupId?: string
): Promise<void> {
  const raw = await redisGet(responseTimesKey(orgId, propertyGroupId));
  let entries: ResponseTimeEntry[] = [];
  if (raw) {
    try {
      entries = JSON.parse(raw) as ResponseTimeEntry[];
    } catch {
      entries = [];
    }
  }
  entries.push({ resolvedAt, minutes });
  if (entries.length > RESPONSE_TIMES_MAX) {
    entries = entries.slice(entries.length - RESPONSE_TIMES_MAX);
  }
  await redisSet(responseTimesKey(orgId, propertyGroupId), JSON.stringify(entries));
}

/** Response times for replies sent within the last `days` days, oldest
 * first. Empty until enough real approvals have happened since this
 * shipped — see the header comment above. */
export async function getRecentResponseTimes(
  days: number,
  organizationId?: string,
  propertyGroupId?: string
): Promise<ResponseTimeEntry[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const raw = await redisGet(responseTimesKey(orgId, propertyGroupId));
  if (!raw) return [];
  let entries: ResponseTimeEntry[] = [];
  try {
    entries = JSON.parse(raw) as ResponseTimeEntry[];
  } catch {
    return [];
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return entries.filter((e) => new Date(e.resolvedAt) >= cutoff);
}

// ---------- Cron polling cursor ----------
// Tracks the last inbound guest message id we've already drafted a reply
// for, per OwnerRez thread, so the 5-minute poll doesn't re-draft the same
// message over and over.

function lastSeenKey(orgId: string, threadId: number): string {
  return `cron:${orgId}:last-seen:${threadId}`;
}

export async function getLastSeenMessageId(threadId: number, organizationId?: string): Promise<number | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const raw = await redisGet(lastSeenKey(orgId, threadId));
  return raw ? Number(raw) : null;
}

export async function setLastSeenMessageId(
  threadId: number,
  messageId: number,
  organizationId?: string
): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await redisSet(lastSeenKey(orgId, threadId), String(messageId));
}

// ---------- Cron round-robin fairness cursor (2026-08-08 incident fix) ----------
// Records the last time we ATTEMPTED to check each thread at all, regardless
// of whether that attempt found a new message, succeeded, or failed. This is
// deliberately separate from getLastSeenMessageId/setLastSeenMessageId above,
// which only ever gets written once messages are SUCCESSFULLY fetched — that
// field can't distinguish "never reached this run" from "reached it, zero
// messages" and carries no timestamp, so it can't answer "how overdue is
// this thread for a check", which is exactly what's needed to fix the bug
// below.
//
// Incident: Natalia Reynolds (thread 11580998, Nukak booking departing
// 2027-03-21) sent messages that never triggered a WhatsApp approval alert.
// Confirmed via /api/debug/bookings-raw that her booking + threadId were
// present in getBookings() the whole time — not a data-sync gap like the
// earlier Alicia Herrera incident — and that this account has 632 total
// bookings, 286 of them with a message thread, most of them FUTURE stays
// (this business books many months ahead). check-messages/route.ts used to
// sort every run's candidate threads by proximity-to-checkout ("closest
// departure first") to fit the likeliest-active threads inside its 45-second
// per-run time budget under OwnerRez's ~1 req/sec sustained rate limit (see
// ownerrez-queue.ts). That ordering is STATIC — it never changes from one
// run to the next — so with 286 real threads and a budget that only fits
// roughly 40-50 live OwnerRez fetches per run, any thread whose checkout is
// far enough in the future to rank outside that top ~45 loses the sort on
// literally every single run, forever. It doesn't matter how many times the
// cron runs (it runs every ~1 minute): a thread that's always ranked #100+
// out of 286 by "distance from now" never gets promoted, so it's not merely
// delayed, it's PERMANENTLY excluded until enough nearer-term bookings
// happen to check out and drop out of the active window. That's what
// silently ate Natalia's messages, and — since which specific guest gets
// starved depends only on which bookings the account happens to have on the
// books at the time — it's also the most likely explanation for why this
// same *class* of bug kept resurfacing for different guests (Alicia, Nyree,
// Lilian) even after each of those specific incidents' own distinct root
// causes (a dead filter, a missing first-poll grace window, a WhatsApp
// session-window issue) were each fixed in isolation.
//
// Fix: replace the static "closest checkout" priority with a rotating
// "least-recently-checked" priority. Every thread this run actually attempts
// (see check-messages/route.ts's fetch loop) gets stamped with `Date.now()`
// here, win or lose. Sorting candidates ascending by this timestamp (treating
// a thread that's never been stamped at all as the oldest/highest priority)
// means whichever threads got serviced this run go to the BACK of the line
// next run — a fair rotation instead of a fixed order — which guarantees
// every active thread gets checked at least once within roughly
// (candidate count / per-run capacity) runs. For this account's real numbers
// that's a worst case of a few minutes, not "never" — see
// ACTIVE_THREAD_WINDOW_DAYS's neighboring comment in check-messages/route.ts
// for the full sort-key implementation.

function lastCheckedKey(orgId: string, threadId: number): string {
  return `cron:${orgId}:last-checked:${threadId}`;
}

/** Batch-fetches "last attempted" timestamps (ms since epoch) for many
 * threads in one Redis round trip — used to build this run's fairness sort
 * key without doing one GET per candidate thread. A thread that's never been
 * stamped comes back as `null` (treat as "most overdue"). */
export async function getLastCheckedAtMany(
  threadIds: number[],
  organizationId?: string
): Promise<Map<number, number | null>> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const map = new Map<number, number | null>();
  if (threadIds.length === 0) return map;
  const values = await redisMGet(threadIds.map((id) => lastCheckedKey(orgId, id)));
  threadIds.forEach((id, i) => {
    const raw = values[i];
    map.set(id, raw ? Number(raw) : null);
  });
  return map;
}

/** Stamps a thread as "attempted just now" for the round-robin fairness
 * ordering above. Call this for every thread this run actually tries to
 * fetch, regardless of whether the fetch succeeds — a thread that keeps
 * failing should still rotate to the back of the line rather than being
 * retried every run ahead of threads that haven't been looked at in far
 * longer. No TTL: this is recurring scheduling metadata for an
 * always-running cron, not per-conversation state that should ever expire. */
export async function setLastCheckedAt(
  threadId: number,
  timestampMs: number,
  organizationId?: string
): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await redisSet(lastCheckedKey(orgId, threadId), String(timestampMs));
}

export async function deletePendingDraft(id: string, organizationId?: string): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await redisDel(draftKey(orgId, id));
  const ids = (await getPendingIds(orgId)).filter((x) => x !== id);
  await setPendingIds(orgId, ids);
}
