import { query, queryOne } from "./db";
import { config, isAiReplyConfigured } from "./config";
import { GOOGLE_REVIEW_LINK } from "./googleReview";
import { PROPERTY_FACTS } from "./propertyFacts";
import { buildGuestsById, resolveGuestPhone } from "./guestName";
import { buildGuestsWithStats } from "./guests";
import { isRevenueCounting } from "./finance";
import { sendMessage as sendOwnerRezMessage, OwnerRezApiError } from "./ownerrez";
import { logAiActivity } from "./aiActivity";
import { getDefaultOrganizationId } from "./organizations";
import { resolveAnthropicApiKey } from "./credentials";
import type { Booking, Guest, LifecycleCampaignCandidate, LifecycleCampaignStatus, LifecycleCampaignType } from "./types";

// Phase 6 (second half) — CRM & Lifecycle Marketing. See
// db/migrations/0005_lifecycle_campaigns.sql's header comment for the full
// scope/guardrail rationale. Three campaign types for v1: win_back
// (dormant past guests), referral (recently-checked-out happy guests, asked
// to send friends/family our way), abandoned_booking (a stale OwnerRez
// Inquiry/Quote/Hold that never converted). No 'birthday' type yet — OwnerRez
// has no guest birthdate field and this file doesn't invent one.
//
// EVERY candidate this file creates starts at 'candidate' and stays there
// until Seni explicitly approves it (see approveCandidate below) — nothing
// in this file ever sends a message on its own initiative. Sending itself
// goes through OwnerRez's own message-thread API (the same channel regular
// guest replies use), because that's the only channel this app has that
// reaches a guest through whatever platform they originally booked on —
// there is no "message an arbitrary phone number" capability here (the
// WhatsApp Business number this app owns is a private approval/ops channel
// between Seni and Gabriel only, see lib/whatsapp.ts).

const AGENT_KEY = "crm_lifecycle";
const AGENT_NAME = "AI CRM & Lifecycle Marketing Manager";

const DAY_MS = 24 * 60 * 60 * 1000;

// Win-back window: too soon (<6mo) and it's premature; too long (>24mo) and
// the contact is stale enough that a cold re-approach is unlikely to land
// and more likely to read as spam.
const WIN_BACK_MIN_DAYS = 6 * 30;
const WIN_BACK_MAX_DAYS = 24 * 30;

// Referral ask: shortly after a good stay, while it's fresh, but not the
// instant they walk out the door.
const REFERRAL_MIN_DAYS_AFTER_CHECKOUT = 3;
const REFERRAL_MAX_DAYS_AFTER_CHECKOUT = 21;

// Review request: sent a little earlier than the referral ask (separate,
// more specific ask — "leave us a review" vs. "send us a friend") so the
// two don't land in the guest's inbox back to back. 2 days gives them time
// to settle back home; 14 days is roughly the window where a stay is still
// fresh enough to write about in detail.
const REVIEW_REQUEST_MIN_DAYS_AFTER_CHECKOUT = 2;
const REVIEW_REQUEST_MAX_DAYS_AFTER_CHECKOUT = 14;

// Abandoned booking: give a real inquiry a few days to resolve itself
// naturally (Seni or the guest may still be mid-conversation) before
// flagging it, but don't resurrect something so old the original dates are
// long gone and the guest has likely moved on entirely.
const ABANDONED_BOOKING_MIN_AGE_DAYS = 5;
const ABANDONED_BOOKING_MAX_AGE_DAYS = 120;

// Don't re-flag the same guest+campaign combo more often than this, even if
// they still technically qualify on every scan — avoids daily re-nagging
// Seni with a candidate he already dismissed or hasn't gotten to yet.
const RECHECK_COOLDOWN_DAYS = 90;

// Each new candidate costs one sequential Claude call (~2-5s). A first-ever
// scan against months of booking history can easily find more candidates
// than fit in one serverless invocation's maxDuration (60s, see
// api/cron/detect-campaigns and api/campaigns/detect) — confirmed live
// 2026-08-01, a scan with no cap timed out and returned a non-JSON Vercel
// error page. Capping per-run keeps each call fast; anything not reached
// this run simply gets picked up by tomorrow's cron (or the next manual
// scan) since nothing here marks a still-qualifying guest as "already
// considered" — only actual inserted candidates are deduped.
const MAX_NEW_CANDIDATES_PER_RUN = 8;

const SPANISH_SPEAKING_COUNTRIES = new Set(
  [
    "colombia",
    "mexico",
    "méxico",
    "spain",
    "españa",
    "argentina",
    "venezuela",
    "chile",
    "peru",
    "perú",
    "ecuador",
    "bolivia",
    "paraguay",
    "uruguay",
    "panama",
    "panamá",
    "costa rica",
    "guatemala",
    "honduras",
    "el salvador",
    "nicaragua",
    "dominican republic",
    "cuba",
  ].map((c) => c.toLowerCase())
);

function guessGuestLanguage(guest: Guest | undefined): "Spanish" | "English" {
  const country = guest?.country?.trim().toLowerCase();
  if (country && SPANISH_SPEAKING_COUNTRIES.has(country)) return "Spanish";
  return "English";
}

type CandidateRow = {
  id: string;
  campaign_type: LifecycleCampaignType;
  guest_id: number | null;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  booking_id: number | null;
  thread_id: number | null;
  trigger_reason: string;
  draft_message: string;
  draft_message_english: string | null;
  language: string | null;
  status: LifecycleCampaignStatus;
  send_error: string | null;
  sent_at: Date | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function fromRow(row: CandidateRow): LifecycleCampaignCandidate {
  return {
    id: row.id,
    campaignType: row.campaign_type,
    guestId: row.guest_id ?? undefined,
    guestName: row.guest_name,
    guestEmail: row.guest_email ?? undefined,
    guestPhone: row.guest_phone ?? undefined,
    bookingId: row.booking_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    triggerReason: row.trigger_reason,
    draftMessage: row.draft_message,
    draftMessageEnglish: row.draft_message_english ?? undefined,
    language: row.language ?? undefined,
    status: row.status,
    sendError: row.send_error ?? undefined,
    sentAt: row.sent_at ? row.sent_at.toISOString() : undefined,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listCampaignCandidates(organizationId?: string): Promise<LifecycleCampaignCandidate[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<CandidateRow>(
    "select * from lifecycle_campaign_candidates where organization_id = $1 order by created_at desc",
    [orgId]
  );
  return rows.map(fromRow);
}

export async function getCampaignCandidate(
  id: string,
  organizationId?: string
): Promise<LifecycleCampaignCandidate | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<CandidateRow>(
    "select * from lifecycle_campaign_candidates where id = $1 and organization_id = $2",
    [id, orgId]
  );
  return row ? fromRow(row) : null;
}

export async function getOptedOutGuestIds(organizationId?: string): Promise<Set<number>> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<{ guest_id: number }>(
    "select guest_id from guest_marketing_preferences where organization_id = $1 and opted_out = true",
    [orgId]
  );
  return new Set(rows.map((r) => r.guest_id));
}

export async function setGuestMarketingOptOut(
  guestId: number,
  optedOut: boolean,
  reason?: string,
  organizationId?: string
): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  // ON CONFLICT target must match migration 0015's composite primary key
  // (organization_id, guest_id) — the old single-column guest_id primary
  // key this used to target was dropped there (two tenants' OwnerRez
  // accounts can reuse the same numeric guest id), so "on conflict
  // (guest_id)" alone would now error with "no unique or exclusion
  // constraint matching the ON CONFLICT specification" instead of upserting.
  await query(
    `insert into guest_marketing_preferences (organization_id, guest_id, opted_out, reason, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (organization_id, guest_id) do update set opted_out = excluded.opted_out, reason = excluded.reason, updated_at = now()`,
    [orgId, guestId, optedOut, reason ?? null]
  );
  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Update guest marketing preference",
    trigger: `Seni ${optedOut ? "opted out" : "opted back in"} guest ${guestId}${reason ? `: ${reason}` : ""}`,
    decision: optedOut ? "opted_out" : "opted_in",
    result: optedOut ? "opted_out" : "opted_in",
  }).catch(() => {});
}

/** Drafts the outreach message text via Claude. Deliberately instructed to
 * never promise a specific discount/incentive amount or confirm availability
 * — see this file's header comment. Not a reply to anything, so there's no
 * inbound guest message to translate; language is guessed from the guest's
 * country (see guessGuestLanguage) since that's the best signal available. */
async function draftLifecycleMessage(params: {
  campaignType: LifecycleCampaignType;
  guestName: string;
  language: "Spanish" | "English";
  context: string;
  organizationId?: string;
}): Promise<{ message: string; messageEnglish: string }> {
  if (!isAiReplyConfigured()) {
    throw new Error("ANTHROPIC_API_KEY isn't set (or has no credits) — can't draft lifecycle messages yet.");
  }

  const campaignInstructions: Record<LifecycleCampaignType, string> = {
    win_back:
      "This guest stayed with us before but hasn't booked again in a while. Write a short, warm check-in message — genuinely glad to hear from them again, mention we'd love to host them again, and softly invite them to reach out if they're thinking about a return trip. Do not mention or imply any specific discount, promo code, or price.",
    referral:
      "This guest recently had a stay with us. Write a short, warm thank-you message and ask them to send any friends or family who might be interested in the property our way — we'll take great care of them. Do NOT state a specific discount percentage, dollar amount, or promo code (none has been set up) — keep any incentive language soft and unspecific, e.g. 'we'll make sure they're well taken care of.'",
    abandoned_booking:
      "This is someone who started an inquiry/quote for a stay but never completed the booking. Write a short, low-pressure check-in — ask if they're still interested, offer to help finalize the dates or find alternatives, and make clear there's no pressure. Do not claim their original dates are still available (we don't know that) and do not promise a specific discount.",
    review_request:
      "This guest recently checked out. Write a short, warm thank-you message and ask them, if they enjoyed their stay, to leave a quick Google review — mention it helps other travelers find the place and means a lot to a small host operation. Do NOT include any link or URL yourself (one will be appended automatically after your draft) and do not reference 'the link below' or similar, since you don't know where it will be placed. Do NOT offer any discount, refund, or incentive in exchange for a review — that would violate Google's review policies. If their stay had any issue, keep the tone warm and non-presumptuous rather than assuming a positive experience.",
  };

  const systemPrompt = `You are drafting a proactive outreach message on behalf of Seni, the host of a short-term rental property, to a past or prospective guest. The draft you write will be shown to Seni for approval before anything is sent — you are never sending this directly yourself.

${campaignInstructions[params.campaignType]}

Here are the only verified facts about the property you may reference. Do not invent anything beyond this:
--- Property facts ---
${PROPERTY_FACTS}
--- end property facts ---

Rules:
- Write in ${params.language}.
- Keep it short — a few warm sentences, not a sales pitch. This is a message from a host to a past/prospective guest, not marketing copy.
- Never invent or imply specific discount amounts, promo codes, or guaranteed availability.
- No preamble, no "Here's a draft:", no quotation marks, no signature block.
- Respond with ONLY a single JSON object (no markdown fences), with exactly these keys:
{
  "message": "the drafted message, in ${params.language}",
  "message_english": "an English translation of the message, or \\"\\" if ${params.language} is already English"
}`;

  const userPrompt = `Guest name: ${params.guestName}\nContext: ${params.context}\n\nDraft the outreach message.`;

  const apiKey = await resolveAnthropicApiKey(params.organizationId);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((c) => c.type === "text")?.text?.trim();
  if (!text) throw new Error("Anthropic API returned no draft text.");

  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  if (!message) throw new Error("Drafted message was empty.");
  const messageEnglish =
    typeof parsed.message_english === "string" && parsed.message_english.trim()
      ? parsed.message_english.trim()
      : message;

  return { message, messageEnglish };
}

async function candidateAlreadyExistsRecently(
  guestId: number | null,
  campaignType: LifecycleCampaignType,
  organizationId: string
): Promise<boolean> {
  if (guestId == null) return false;
  const cutoff = new Date(Date.now() - RECHECK_COOLDOWN_DAYS * DAY_MS).toISOString();
  const existing = await queryOne<{ id: string }>(
    `select id from lifecycle_campaign_candidates
     where organization_id = $1 and guest_id = $2 and campaign_type = $3::lifecycle_campaign_type and created_at >= $4
     limit 1`,
    [organizationId, guestId, campaignType, cutoff]
  );
  return Boolean(existing);
}

async function insertCandidate(input: {
  campaignType: LifecycleCampaignType;
  guestId: number | null;
  guestName: string;
  guestEmail?: string;
  guestPhone?: string;
  bookingId: number | null;
  threadId: number | null;
  triggerReason: string;
  draftMessage: string;
  draftMessageEnglish: string;
  language: string;
}, organizationId: string): Promise<void> {
  await query(
    `insert into lifecycle_campaign_candidates
       (organization_id, campaign_type, guest_id, guest_name, guest_email, guest_phone, booking_id, thread_id,
        trigger_reason, draft_message, draft_message_english, language)
     values ($1, $2::lifecycle_campaign_type, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      organizationId,
      input.campaignType,
      input.guestId,
      input.guestName,
      input.guestEmail ?? null,
      input.guestPhone ?? null,
      input.bookingId,
      input.threadId,
      input.triggerReason,
      input.draftMessage,
      input.draftMessageEnglish,
      input.language,
    ]
  );
  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Flag lifecycle-marketing candidate",
    trigger: input.triggerReason,
    decision: `queued ${input.campaignType} candidate for ${input.guestName}`,
    actionTaken: "Drafted outreach message, awaiting Seni's approval",
    result: "candidate",
  }).catch(() => {});
}

export type DetectionResult = {
  winBack: number;
  referral: number;
  abandonedBooking: number;
  reviewRequest: number;
  skipped: number;
  capped: boolean;
};

/** Scans OwnerRez guest/booking data for new lifecycle-campaign candidates
 * and inserts them at 'candidate' status. Safe to call repeatedly (daily
 * cron + manual "scan now" button) — dedupes via candidateAlreadyExistsRecently
 * and never touches a guest who's opted out. Every insert here is a DRAFT
 * only; nothing is sent until Seni approves it via approveCandidate. Stops
 * early once MAX_NEW_CANDIDATES_PER_RUN new candidates have been drafted —
 * see that constant's comment. */
export async function detectCandidates(
  guests: Guest[],
  bookings: Booking[],
  organizationId?: string
): Promise<DetectionResult> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const result: DetectionResult = {
    winBack: 0,
    referral: 0,
    abandonedBooking: 0,
    reviewRequest: 0,
    skipped: 0,
    capped: false,
  };
  const guestsById = buildGuestsById(guests);
  const optedOut = await getOptedOutGuestIds(orgId);
  const now = Date.now();

  function totalNew() {
    return result.winBack + result.referral + result.abandonedBooking + result.reviewRequest;
  }

  // --- Win-back + referral: both keyed off each guest's most recent
  // completed (revenue-counting) stay. ---
  const guestsWithStats = await buildGuestsWithStats(guests, bookings, orgId);
  for (const g of guestsWithStats) {
    if (totalNew() >= MAX_NEW_CANDIDATES_PER_RUN) {
      result.capped = true;
      break;
    }
    if (g.id == null) continue;
    if (optedOut.has(g.id)) continue;

    const revenueBookings = g.bookings.filter(isRevenueCounting).sort((a, b) => a.departure.localeCompare(b.departure));
    if (revenueBookings.length === 0) continue;
    const lastStay = revenueBookings[revenueBookings.length - 1];
    if (!lastStay.departure) continue;
    const departureMs = new Date(lastStay.departure).getTime();
    if (Number.isNaN(departureMs)) continue;
    const daysSinceCheckout = (now - departureMs) / DAY_MS;
    if (daysSinceCheckout < 0) continue; // still upcoming/current, not a past stay yet

    const hasUpcoming = revenueBookings.some((b) => {
      const arrivalMs = new Date(b.arrival).getTime();
      return !Number.isNaN(arrivalMs) && arrivalMs >= now;
    });

    const language = guessGuestLanguage(guestsById.get(g.id));

    // Win-back: dormant long enough, and no upcoming stay already on the books.
    if (!hasUpcoming && daysSinceCheckout >= WIN_BACK_MIN_DAYS && daysSinceCheckout <= WIN_BACK_MAX_DAYS) {
      if (await candidateAlreadyExistsRecently(g.id, "win_back", orgId)) {
        result.skipped += 1;
      } else {
        try {
          const monthsAgo = Math.round(daysSinceCheckout / 30);
          const drafted = await draftLifecycleMessage({
            campaignType: "win_back",
            guestName: g.fullName,
            language,
            context: `Last stayed and checked out on ${lastStay.departure} (about ${monthsAgo} months ago). Hasn't booked again since.`,
            organizationId: orgId,
          });
          await insertCandidate({
            campaignType: "win_back",
            guestId: g.id,
            guestName: g.fullName,
            guestEmail: g.email,
            guestPhone: resolveGuestPhone({ guestId: g.id }, guestsById),
            bookingId: lastStay.id,
            threadId: lastStay.threadIds[0] ?? null,
            triggerReason: `Last stayed ${lastStay.departure} (~${monthsAgo} months ago), hasn't rebooked since.`,
            draftMessage: drafted.message,
            draftMessageEnglish: drafted.messageEnglish,
            language,
          }, orgId);
          result.winBack += 1;
        } catch (err) {
          console.error("[lifecycleMarketing] win_back draft failed (non-fatal)", err);
        }
      }
    }

    // Referral: recently checked out, assumed to be a good stay (no
    // complaint-tracking exists yet to filter on — Seni reviews before send).
    if (daysSinceCheckout >= REFERRAL_MIN_DAYS_AFTER_CHECKOUT && daysSinceCheckout <= REFERRAL_MAX_DAYS_AFTER_CHECKOUT) {
      if (await candidateAlreadyExistsRecently(g.id, "referral", orgId)) {
        result.skipped += 1;
      } else {
        try {
          const drafted = await draftLifecycleMessage({
            campaignType: "referral",
            guestName: g.fullName,
            language,
            context: `Checked out on ${lastStay.departure} (${Math.round(daysSinceCheckout)} days ago).`,
            organizationId: orgId,
          });
          await insertCandidate({
            campaignType: "referral",
            guestId: g.id,
            guestName: g.fullName,
            guestEmail: g.email,
            guestPhone: resolveGuestPhone({ guestId: g.id }, guestsById),
            bookingId: lastStay.id,
            threadId: lastStay.threadIds[0] ?? null,
            triggerReason: `Checked out ${lastStay.departure} (${Math.round(daysSinceCheckout)} days ago) — good window to ask for a referral.`,
            draftMessage: drafted.message,
            draftMessageEnglish: drafted.messageEnglish,
            language,
          }, orgId);
          result.referral += 1;
        } catch (err) {
          console.error("[lifecycleMarketing] referral draft failed (non-fatal)", err);
        }
      }
    }

    // Review request: sooner than the referral ask — see the window
    // constants' comment above for why the two are staggered.
    if (
      daysSinceCheckout >= REVIEW_REQUEST_MIN_DAYS_AFTER_CHECKOUT &&
      daysSinceCheckout <= REVIEW_REQUEST_MAX_DAYS_AFTER_CHECKOUT
    ) {
      if (await candidateAlreadyExistsRecently(g.id, "review_request", orgId)) {
        result.skipped += 1;
      } else {
        try {
          const drafted = await draftLifecycleMessage({
            campaignType: "review_request",
            guestName: g.fullName,
            language,
            context: `Checked out on ${lastStay.departure} (${Math.round(daysSinceCheckout)} days ago).`,
            organizationId: orgId,
          });
          // The Google review link is appended here, not trusted to the
          // model — see googleReview.ts's header comment for why.
          const reviewAsk =
            language === "Spanish"
              ? `Puedes dejarnos una reseña aquí: ${GOOGLE_REVIEW_LINK}`
              : `You can leave us a review here: ${GOOGLE_REVIEW_LINK}`;
          const message = `${drafted.message}\n\n${reviewAsk}`;
          const messageEnglish = `${drafted.messageEnglish}\n\nYou can leave us a review here: ${GOOGLE_REVIEW_LINK}`;
          await insertCandidate({
            campaignType: "review_request",
            guestId: g.id,
            guestName: g.fullName,
            guestEmail: g.email,
            guestPhone: resolveGuestPhone({ guestId: g.id }, guestsById),
            bookingId: lastStay.id,
            threadId: lastStay.threadIds[0] ?? null,
            triggerReason: `Checked out ${lastStay.departure} (${Math.round(daysSinceCheckout)} days ago) — good window to ask for a Google review.`,
            draftMessage: message,
            draftMessageEnglish: messageEnglish,
            language,
          }, orgId);
          result.reviewRequest += 1;
        } catch (err) {
          console.error("[lifecycleMarketing] review_request draft failed (non-fatal)", err);
        }
      }
    }
  }

  // --- Abandoned booking: OwnerRez Inquiry/Quote/Hold that went stale. ---
  const abandonedStatuses = new Set(["Inquiry", "Quote", "Hold"]);
  for (const b of bookings) {
    if (totalNew() >= MAX_NEW_CANDIDATES_PER_RUN) {
      result.capped = true;
      break;
    }
    if (b.isBlock || !abandonedStatuses.has(b.status)) continue;
    if (b.guestId != null && optedOut.has(b.guestId)) continue;
    const createdMs = b.createdAt ? new Date(b.createdAt).getTime() : NaN;
    if (Number.isNaN(createdMs)) continue;
    const ageDays = (now - createdMs) / DAY_MS;
    if (ageDays < ABANDONED_BOOKING_MIN_AGE_DAYS || ageDays > ABANDONED_BOOKING_MAX_AGE_DAYS) continue;
    if (b.threadIds.length === 0) continue; // nothing to send into

    if (await candidateAlreadyExistsRecently(b.guestId, "abandoned_booking", orgId)) {
      result.skipped += 1;
      continue;
    }

    const guest = b.guestId != null ? guestsById.get(b.guestId) : undefined;
    const guestName = b.guestName?.trim() || guest?.fullName || "Guest";
    const language = guessGuestLanguage(guest);

    try {
      const drafted = await draftLifecycleMessage({
        campaignType: "abandoned_booking",
        guestName,
        language,
        context: `Started a ${b.status.toLowerCase()} for ${b.arrival} to ${b.departure} (${Math.round(ageDays)} days ago) but never completed the booking.`,
        organizationId: orgId,
      });
      await insertCandidate({
        campaignType: "abandoned_booking",
        guestId: b.guestId,
        guestName,
        guestEmail: guest?.email,
        guestPhone: guest?.phone,
        bookingId: b.id,
        threadId: b.threadIds[0] ?? null,
        triggerReason: `${b.status} for ${b.arrival} → ${b.departure}, opened ${Math.round(ageDays)} days ago, never converted.`,
        draftMessage: drafted.message,
        draftMessageEnglish: drafted.messageEnglish,
        language,
      }, orgId);
      result.abandonedBooking += 1;
    } catch (err) {
      console.error("[lifecycleMarketing] abandoned_booking draft failed (non-fatal)", err);
    }
  }

  return result;
}

/** The only place a lifecycle-campaign message actually gets sent. Requires
 * an explicit approval click — see api/campaigns/[id]/route.ts. Posts into
 * the OwnerRez thread on file (same channel/mechanism as a normal guest
 * reply); if no thread exists, or the send fails (e.g. an old OTA thread
 * that's been closed), this is surfaced as a real error rather than silently
 * marked sent. */
export async function approveCandidate(
  id: string,
  organizationId?: string
): Promise<LifecycleCampaignCandidate | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const candidate = await getCampaignCandidate(id, orgId);
  if (!candidate) return null;
  if (candidate.status !== "candidate") return candidate; // already resolved, no-op

  if (!candidate.threadId) {
    const row = await queryOne<CandidateRow>(
      `update lifecycle_campaign_candidates set
         status = 'failed'::lifecycle_campaign_status,
         send_error = $2,
         reviewed_at = now(), updated_at = now()
       where id = $1 and organization_id = $3
       returning *`,
      [
        id,
        "No OwnerRez message thread on file for this guest/booking — can't send automatically. Reach out manually instead.",
        orgId,
      ]
    );
    return row ? fromRow(row) : candidate;
  }

  try {
    await sendOwnerRezMessage(candidate.threadId, candidate.draftMessage, orgId);
    const row = await queryOne<CandidateRow>(
      `update lifecycle_campaign_candidates set
         status = 'sent'::lifecycle_campaign_status,
         reviewed_at = now(), sent_at = now(), updated_at = now()
       where id = $1 and organization_id = $2
       returning *`,
      [id, orgId]
    );
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Send lifecycle-marketing message",
      trigger: `Seni approved ${candidate.campaignType} message for ${candidate.guestName}`,
      decision: "sent",
      actionTaken: `Posted into OwnerRez thread ${candidate.threadId}`,
      communicationSent: candidate.draftMessage,
      result: "sent",
    }).catch(() => {});
    return row ? fromRow(row) : candidate;
  } catch (err) {
    const message = err instanceof OwnerRezApiError ? err.message : err instanceof Error ? err.message : "Unknown error.";
    const row = await queryOne<CandidateRow>(
      `update lifecycle_campaign_candidates set
         status = 'failed'::lifecycle_campaign_status,
         send_error = $2,
         reviewed_at = now(), updated_at = now()
       where id = $1 and organization_id = $3
       returning *`,
      [id, message, orgId]
    );
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Send lifecycle-marketing message",
      trigger: `Seni approved ${candidate.campaignType} message for ${candidate.guestName}`,
      decision: "sent",
      actionTaken: `Attempted OwnerRez thread ${candidate.threadId}`,
      result: "failed",
      error: message,
    }).catch(() => {});
    return row ? fromRow(row) : candidate;
  }
}

export async function skipCandidate(
  id: string,
  organizationId?: string
): Promise<LifecycleCampaignCandidate | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<CandidateRow>(
    `update lifecycle_campaign_candidates set
       status = 'skipped'::lifecycle_campaign_status,
       reviewed_at = now(), updated_at = now()
     where id = $1 and organization_id = $2
     returning *`,
    [id, orgId]
  );
  return row ? fromRow(row) : null;
}
