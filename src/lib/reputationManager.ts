import { query, queryOne } from "./db";
import { config, isAiReplyConfigured, isDbConfigured } from "./config";
import { getReviews, getTargetProperty } from "./ownerrez";
import { PROPERTY_FACTS } from "./propertyFacts";
import { logAiActivity } from "./aiActivity";
import { sendWhatsAppText, WhatsAppError } from "./whatsapp";
import { getDefaultOrganizationId } from "./organizations";
import { resolveAnthropicApiKey } from "./credentials";
import type { Review, ReputationEntry, ReputationResponse, ReputationResponseStatus } from "./types";

// Agent #9 of the Legacy AI Company roadmap (docs/VISION.md) — Reputation
// Manager. Scope locked in by Seni 2026-08-01: a Reputation tab showing every
// review with an AI-drafted response queued for WhatsApp/dashboard approval —
// NOT auto-posting anything. See db/migrations/0008_reputation.sql's header
// comment for why that's a hard constraint, not just a v1 choice: OwnerRez's
// API has no write endpoint for reviews at all, so even "approved" here can
// only ever mean "ready for Seni to paste into OwnerRez's own Quality Center
// himself" — matches every other public-facing action in this app (Guest
// Experience, lifecycle marketing) staying behind an explicit human click.
//
// Reviews are never duplicated into Postgres — lib/ownerrez.ts's getReviews()
// already reads them live (5-min cache). This file only persists the draft
// response text and Seni's decision, in reputation_responses, keyed by
// (property_id, review_id).

const AGENT_KEY = "reputation_manager";
const AGENT_NAME = "AI Reputation Manager";

// Same rationale as lifecycleMarketing.ts's MAX_NEW_CANDIDATES_PER_RUN: each
// new draft costs one sequential Claude call, and a first-ever scan against
// 100+ historical reviews could otherwise blow past a single serverless
// invocation's time budget. Anything not reached this run is picked up by the
// next cron tick or manual "scan now" — nothing here marks a still-unanswered
// review as "already considered," only an inserted row is deduped.
const MAX_NEW_DRAFTS_PER_RUN = 8;

type ResponseRow = {
  id: string;
  property_id: string | null;
  review_id: number;
  review_source: string;
  review_rating: number | null;
  guest_name: string | null;
  review_created_at: Date | null;
  review_comment: string | null;
  draft_text: string;
  status: ReputationResponseStatus;
  decided_at: Date | null;
  posted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function fromResponseRow(row: ResponseRow): ReputationResponse {
  return {
    id: row.id,
    propertyId: row.property_id ?? undefined,
    reviewId: row.review_id,
    reviewSource: row.review_source,
    reviewRating: row.review_rating ?? undefined,
    guestName: row.guest_name ?? undefined,
    reviewCreatedAt: row.review_created_at ? row.review_created_at.toISOString() : undefined,
    reviewComment: row.review_comment ?? undefined,
    draftText: row.draft_text,
    status: row.status,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : undefined,
    postedAt: row.posted_at ? row.posted_at.toISOString() : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Same lookup/insert pattern as revenueManager.ts's getOrCreateDbPropertyId
 * — the `properties` table keys on OwnerRez's numeric property id, separate
 * from OwnerRez review/booking ids. Returns null if the DB isn't configured
 * at all (demo mode). */
async function getOrCreateDbPropertyId(ownerRezPropertyId: number, name: string): Promise<string | null> {
  if (!isDbConfigured()) return null;
  const existing = await queryOne<{ id: string }>(
    "select id from properties where ownerrez_property_id = $1",
    [ownerRezPropertyId]
  );
  if (existing) return existing.id;
  const created = await queryOne<{ id: string }>(
    `insert into properties (ownerrez_property_id, name) values ($1, $2)
     on conflict (ownerrez_property_id) do update set name = excluded.name
     returning id`,
    [ownerRezPropertyId, name]
  );
  return created?.id ?? null;
}

async function listResponsesByReviewId(organizationId: string): Promise<Map<number, ReputationResponse>> {
  if (!isDbConfigured()) return new Map();
  const rows = await query<ResponseRow>(
    "select * from reputation_responses where organization_id = $1 order by created_at desc",
    [organizationId]
  );
  const map = new Map<number, ReputationResponse>();
  for (const row of rows) {
    // Reviews (not property_id+review_id) are the join key here since a
    // review only ever belongs to one property in this single-property
    // account's data — see fetchReviews()'s client-side scoping.
    if (!map.has(row.review_id)) map.set(row.review_id, fromResponseRow(row));
  }
  return map;
}

/** The Reputation tab's main read: every live OwnerRez review joined with
 * whatever draft/decision state exists for it, newest review first. Safe to
 * call with no DB configured — every entry just comes back with no response. */
export async function listReputationEntries(organizationId?: string): Promise<ReputationEntry[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const [reviews, responsesByReviewId] = await Promise.all([getReviews(orgId), listResponsesByReviewId(orgId)]);
  const entries: ReputationEntry[] = reviews.map((review) => ({
    review,
    response: responsesByReviewId.get(review.id),
  }));
  entries.sort((a, b) => (b.review.createdAt ?? "").localeCompare(a.review.createdAt ?? ""));
  return entries;
}

export type ReputationSummary = {
  totalReviews: number;
  avgRating: number | null;
  pendingResponseCount: number;
  needsResponseCount: number; // no host response on OwnerRez AND no draft queued yet
};

/** Feeds the daily executive report — avg rating and how much is sitting in
 * Seni's queue, without pulling every review's full text. */
export async function getReputationSummary(organizationId?: string): Promise<ReputationSummary> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const entries = await listReputationEntries(orgId);
  const rated = entries.map((e) => e.review.rating).filter((r): r is number => typeof r === "number");
  const avgRating = rated.length > 0 ? rated.reduce((sum, r) => sum + r, 0) / rated.length : null;
  const pendingResponseCount = entries.filter((e) => e.response?.status === "pending_review").length;
  const needsResponseCount = entries.filter(
    (e) => !e.review.hostResponse && e.review.visible !== false && !e.response
  ).length;
  return { totalReviews: entries.length, avgRating, pendingResponseCount, needsResponseCount };
}

/** Drafts a response to one review via Claude. Rating-aware tone: warm/brief
 * thanks for a strong review, empathetic and resolution-focused (without
 * admitting fault to specifics we can't verify) for a weak one. Grounded in
 * PROPERTY_FACTS only — same guardrail as lifecycleMarketing.ts's
 * draftLifecycleMessage, since this draft is guest-facing text once posted. */
async function draftReviewResponse(review: Review, organizationId?: string): Promise<string> {
  if (!isAiReplyConfigured()) {
    throw new Error("ANTHROPIC_API_KEY isn't set (or has no credits) — can't draft review responses yet.");
  }

  const rating = review.rating;
  const toneInstructions =
    rating != null && rating <= 3
      ? "This review is lukewarm or negative. Write a sincere, non-defensive response: thank them for the honest feedback, briefly acknowledge the specific issue they raised (only using what they actually wrote — never invent a cause or admit to a fault we can't verify), and note that we take it seriously and are looking into it. Do not argue with the reviewer, offer a refund/discount, or make promises about specific fixes or timelines."
      : "This review is positive. Write a short, genuine thank-you that references something specific they mentioned, and invite them to stay again. Keep it warm but brief — a couple of sentences, not a sales pitch.";

  const systemPrompt = `You are drafting a public response to a guest review of a short-term rental property, on behalf of the hosts (Carolina y Ana Escobar). This response is shown to Seni for approval before it is ever posted anywhere — you are never posting this yourself, and it will only go live once Seni copies it into OwnerRez himself.

${toneInstructions}

Here are the only verified facts about the property you may reference. Do not invent anything beyond this:
--- Property facts ---
${PROPERTY_FACTS}
--- end property facts ---

Rules:
- Match the language the review itself is written in (respond in Spanish if the review is in Spanish, English if English).
- Sign off as "Carolina y Ana" or leave it unsigned — never invent a different host name.
- No preamble, no "Here's a draft:", no quotation marks.
- Never promise a refund, discount, or specific corrective action.
- Respond with ONLY a single JSON object (no markdown fences), with exactly this key:
{ "response": "the drafted review response text" }`;

  const userPrompt = `Guest: ${review.guestName ?? "Guest"}\nPlatform: ${review.source}\nRating: ${rating != null ? `${rating}/5` : "not provided"}\nReview text: ${review.comment ?? "(no text provided)"}\n\nDraft the response.`;

  const apiKey = await resolveAnthropicApiKey(organizationId);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 500,
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
  const response = typeof parsed.response === "string" ? parsed.response.trim() : "";
  if (!response) throw new Error("Drafted response was empty.");
  return response;
}

async function insertDraft(
  review: Review,
  draftText: string,
  dbPropertyId: string | null,
  organizationId: string
): Promise<void> {
  await query(
    `insert into reputation_responses
       (organization_id, property_id, review_id, review_source, review_rating, guest_name, review_created_at, review_comment, draft_text)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (property_id, review_id) do nothing`,
    [
      organizationId,
      dbPropertyId,
      review.id,
      review.source,
      review.rating ?? null,
      review.guestName ?? null,
      review.createdAt ?? null,
      review.comment ?? null,
      draftText,
    ]
  );
  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Draft review response",
    trigger: `${review.source} review from ${review.guestName ?? "a guest"}${review.rating != null ? ` (${review.rating}/5)` : ""} has no host response yet`,
    decision: "queued for Seni's approval",
    actionTaken: "Drafted a response via Claude",
    result: "pending_review",
  }).catch(() => {});
}

export type DetectionResult = { drafted: number; skipped: number; capped: boolean };

/** Scans live OwnerRez reviews for ones with no host response and no draft
 * queued yet, drafts a response for each (up to the per-run cap), and
 * notifies Seni once via WhatsApp that new drafts are waiting — a plain
 * notification, not a yes/no message, so it can't collide with the existing
 * guest-reply approval flow's WhatsApp webhook parsing (see
 * lib/pendingDrafts.ts). The actual approve/reject/edit happens in the
 * Reputation dashboard tab, not over WhatsApp. Safe to call repeatedly. */
export async function detectAndDraftResponses(organizationId?: string): Promise<DetectionResult> {
  const result: DetectionResult = { drafted: 0, skipped: 0, capped: false };
  if (!isDbConfigured()) return result;
  const orgId = organizationId ?? (await getDefaultOrganizationId());

  const [entries, property] = await Promise.all([listReputationEntries(orgId), getTargetProperty(orgId)]);
  const dbPropertyId = await getOrCreateDbPropertyId(property.id, property.name);

  const needsDraft = entries.filter((e) => !e.review.hostResponse && e.review.visible !== false && !e.response);

  const toDraft = needsDraft.slice(0, MAX_NEW_DRAFTS_PER_RUN);
  result.capped = needsDraft.length > toDraft.length;
  result.skipped = 0;

  for (const entry of toDraft) {
    try {
      const draftText = await draftReviewResponse(entry.review, orgId);
      await insertDraft(entry.review, draftText, dbPropertyId, orgId);
      result.drafted += 1;
    } catch (err) {
      console.error("[reputationManager] draft failed (non-fatal)", entry.review.id, err);
    }
  }

  if (result.drafted > 0) {
    const latest = toDraft[0]?.review;
    const summary = [
      `🌟 Reputation Manager: ${result.drafted} new review response${result.drafted === 1 ? "" : "s"} drafted and waiting in the Reputation tab.`,
      latest ? `Most recent: ${latest.rating != null ? `${latest.rating}★` : "unrated"} on ${latest.source} from ${latest.guestName ?? "a guest"}.` : "",
      "Review and approve in the dashboard — nothing is posted automatically.",
    ]
      .filter(Boolean)
      .join(" ");
    try {
      await sendWhatsAppText(summary);
    } catch (err) {
      const message = err instanceof WhatsAppError ? err.message : err instanceof Error ? err.message : "Unknown error.";
      console.error("[reputationManager] WhatsApp notify failed (non-fatal)", message);
    }
  }

  return result;
}

/** Seni's decision on a drafted response. `draftText` lets him edit the copy
 * as part of approving it (mirrors how other approval flows in this app let
 * the human adjust text before it's used) — only meaningful when moving to
 * 'approved'. 'posted' is a separate, later step: Seni confirming he actually
 * copied the approved text into OwnerRez himself. */
export async function decideReputationResponse(
  id: string,
  update: { status: ReputationResponseStatus; draftText?: string },
  organizationId?: string
): Promise<ReputationResponse | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const setsDecided = update.status === "approved" || update.status === "rejected";
  const row = await queryOne<ResponseRow>(
    `update reputation_responses set
       draft_text = coalesce($2, draft_text),
       status = $3::reputation_response_status,
       decided_at = case when $4 then now() else decided_at end,
       posted_at = case when $3::reputation_response_status = 'posted' then now() else posted_at end,
       updated_at = now()
     where id = $1 and organization_id = $5
     returning *`,
    [id, update.draftText ?? null, update.status, setsDecided, orgId]
  );
  if (!row) return null;
  const response = fromResponseRow(row);

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Decide review response",
    trigger: `Seni set review response ${id} (${response.guestName ?? "guest"}, ${response.reviewSource}) to ${update.status}`,
    decision: update.status,
    actionTaken:
      update.status === "approved"
        ? "Marked approved — ready for Seni to paste into OwnerRez's Quality Center"
        : update.status === "posted"
          ? "Seni confirmed he posted this response in OwnerRez"
          : update.status === "rejected"
            ? "Marked rejected — no response will be posted"
            : `Status changed to ${update.status}`,
    result: update.status,
  }).catch(() => {});

  return response;
}
