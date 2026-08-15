import { query, queryOne } from "./db";
import { config, isAiReplyConfigured } from "./config";
import { PROPERTY_FACTS } from "./propertyFacts";
import { logAiActivity } from "./aiActivity";
import { getDefaultOrganizationId } from "./organizations";
import { resolveAnthropicApiKey } from "./credentials";
import type {
  ContentCampaign,
  ContentCampaignStatus,
  ContentPiece,
  ContentPieceStatus,
  ContentPieceType,
  SocialChannel,
} from "./types";

// Phase 7 — Marketing, social & SEO. See
// db/migrations/0006_marketing_content.sql's header comment for the full
// scope note. Standalone pieces (idea/blog/email) are DRAFTING AND REVIEW
// ONLY — this file never posts those anywhere. Phase 7b (Social Media
// Manager, db/migrations/0020_content_campaigns.sql) adds content_campaigns
// (one pillar asset -> one piece per social channel) and the columns needed
// for approved social pieces to be pushed to Postiz for real
// scheduling/publishing — see lib/postiz.ts, which is intentionally NOT
// imported here to avoid a circular dependency; the push happens in the API
// route layer right after a status update to "approved" succeeds. This file
// also never queries a live SEO-data API (SEMrush/Ahrefs/Google Search
// Console/etc.) — none is configured. AI-drafted SEO notes/keyword
// suggestions come from Claude's general knowledge only, not live search
// data, and should be treated as a starting point for Seni's own judgment,
// not verified market research.

const AGENT_KEY = "marketing_seo";
const AGENT_NAME = "AI Marketing Director & SEO Manager";

type ContentRow = {
  id: string;
  content_type: ContentPieceType;
  topic: string;
  channel: string | null;
  target_keyword: string | null;
  body: string | null;
  meta_description: string | null;
  seo_notes: string | null;
  property_id: string | null;
  status: ContentPieceStatus;
  created_at: Date;
  updated_at: Date;
  campaign_id: string | null;
  media_url: string | null;
  postiz_post_id: string | null;
  scheduled_at: Date | null;
};

function fromRow(row: ContentRow): ContentPiece {
  return {
    id: row.id,
    contentType: row.content_type,
    topic: row.topic,
    channel: row.channel ?? undefined,
    targetKeyword: row.target_keyword ?? undefined,
    body: row.body ?? undefined,
    metaDescription: row.meta_description ?? undefined,
    seoNotes: row.seo_notes ?? undefined,
    propertyId: row.property_id ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    campaignId: row.campaign_id ?? undefined,
    mediaUrl: row.media_url ?? undefined,
    postizPostId: row.postiz_post_id ?? undefined,
    scheduledAt: row.scheduled_at ? row.scheduled_at.toISOString() : undefined,
  };
}

type CampaignRow = {
  id: string;
  pillar_asset_description: string;
  pillar_asset_media_url: string | null;
  status: ContentCampaignStatus;
  created_at: Date;
  updated_at: Date;
};

function campaignFromRow(row: CampaignRow): ContentCampaign {
  return {
    id: row.id,
    pillarAssetDescription: row.pillar_asset_description,
    pillarAssetMediaUrl: row.pillar_asset_media_url ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listContentPieces(organizationId?: string): Promise<ContentPiece[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<ContentRow>(
    "select * from content_pieces where organization_id = $1 order by created_at desc",
    [orgId]
  );
  return rows.map(fromRow);
}

export async function getContentPiece(id: string, organizationId?: string): Promise<ContentPiece | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ContentRow>(
    "select * from content_pieces where id = $1 and organization_id = $2",
    [id, orgId]
  );
  return row ? fromRow(row) : null;
}

export async function createContentPiece(
  input: {
    contentType: ContentPieceType;
    topic: string;
    channel?: string;
    targetKeyword?: string;
    campaignId?: string;
    mediaUrl?: string;
  },
  organizationId?: string
): Promise<ContentPiece> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ContentRow>(
    `insert into content_pieces (organization_id, content_type, topic, channel, target_keyword, campaign_id, media_url)
     values ($1, $2::content_piece_type, $3, $4, $5, $6, $7)
     returning *`,
    [
      orgId,
      input.contentType,
      input.topic,
      input.channel ?? null,
      input.targetKeyword ?? null,
      input.campaignId ?? null,
      input.mediaUrl ?? null,
    ]
  );
  if (!row) throw new Error("Failed to create content piece.");
  const piece = fromRow(row);
  await logAiActivity(
    {
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Log content idea",
      trigger: `New ${piece.contentType} idea: ${piece.topic}`,
      decision: "queued as idea",
      result: "idea",
    },
    orgId
  ).catch(() => {});
  return piece;
}

const CONTENT_TYPE_INSTRUCTIONS: Record<ContentPieceType, string> = {
  blog: "Write a full blog post (600-900 words) in Markdown, with a clear H1 title, a few H2 subheadings, and a natural, helpful tone — not keyword-stuffed. Also produce a meta description (under 155 characters) and a short SEO rationale note (why this topic/keyword, what search intent it serves).",
  social: "Write a short social media caption (2-4 sentences, suitable for Instagram/Facebook), warm and inviting, with 3-6 relevant hashtags at the end. No meta description needed.",
  email: "Write a short marketing email (100-200 words) with a clear subject line as the first line prefixed 'Subject: ', warm and personal in tone, one clear call to action. No meta description needed.",
};

// Per-channel voice instructions for the Social Media Manager (Agent #4),
// used instead of the generic "social" instruction above whenever a piece's
// channel matches one of these. Condensed from the ai-marketing-director
// skill's repurposing framework (same brand-voice rules, applied here so the
// real CRM agent produces the same quality of output the skill's manual
// stand-in does). Substack has no Postiz provider (see lib/postiz.ts) but
// still gets a voice here since it's a valid CRM-only content piece.
const SOCIAL_CHANNEL_INSTRUCTIONS: Record<SocialChannel, string> = {
  instagram_reel:
    "Write an Instagram Reel caption (2-4 sentences) plus a short on-screen text/hook suggestion for the first 2 seconds of footage. Polished but warm tone, 1-2 luxury words max (never stacked), 5-8 relevant hashtags at the end. Weave in the direct-booking value prop naturally (no platform fees, real team on WhatsApp) without a hard sell.",
  tiktok:
    "Write a TikTok caption in a native/casual voice (not polished marketing-speak) with a comment-bait question or CTA to drive engagement. Short, 1-3 sentences, 3-5 hashtags, no more than one luxury adjective.",
  facebook:
    "Write a Facebook post (3-5 sentences, slightly longer and warmer than X/Instagram, emoji-light) inviting engagement. Mention the direct-booking value prop naturally at least once.",
  x: "Write an X (Twitter) post: one short, punchy line plus a clear CTA. Under 250 characters total.",
  linkedin:
    "Write a LinkedIn post reframing this asset for a B2B/corporate-retreat or founder-story angle — professional but still warm, 3-5 sentences, ending with a soft CTA to enquire.",
  pinterest:
    "Write a Pinterest pin title (under 100 characters, keyword-rich for search/save behavior, not engagement) and a short description (1-2 sentences). Put the title as the first line prefixed 'Title: ' and the description on the next line.",
  youtube_short:
    "Write a YouTube Short title (built for search, under 95 characters) and description (2-3 sentences with 3-5 relevant keywords). Put the title as the first line prefixed 'Title: ' and the description below it.",
  substack:
    "Write a long-form, personal, storytelling Substack post (400-700 words) in a 'why we built this' voice — first person, reflective, more intimate than the blog article. End with a soft invitation to book direct.",
};

const BRAND_VOICE = `Brand voice for Legacy Estate Rentals / Legacy Colombia:
- Family-owned, personal — writes like a friend who owns beautiful properties, not a hotel chain.
- Aspirational but grounded in specific real details over generic superlatives.
- Luxury vocabulary (breathtaking, stunning, elegant, unforgettable) used sparingly — one or two per piece, never stacked.
- Hospitality-forward: "we love to help," "personalized," "seamless," "24/7."
- Weave in the direct-booking value prop naturally, without a hard sell: no platform fees, a real team on WhatsApp, vs. Airbnb/VRBO.
- For Legacy Colombia specifically, lead with the wellness-retreat angle (barrel sauna, cold plunge, ice bath, private dock, tennis court) when relevant — that's the property's real differentiator.
- CTAs are invitations ("Enquire today," "Let's plan your stay") not commands.

Confidentiality — never violate these: never publish an exact address, map pin, or gate/door code; never publish internal ops details (rate strategy, deposit/cleaning fee amounts, wifi passwords); never publish safety-disclosure items meant only for direct guest comms; never invent guest quotes, reviews, pricing, or availability that weren't supplied.`;

/** Drafts (or re-drafts) the body/meta/SEO-notes for an existing content
 * piece via Claude, grounded only in the static property facts file — see
 * this file's header comment on why there's no live SEO/search data behind
 * this. Overwrites body/metaDescription/seoNotes and bumps status to
 * 'draft' if it was still 'idea'. */
export async function generateContentDraft(id: string, organizationId?: string): Promise<ContentPiece | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const piece = await getContentPiece(id, orgId);
  if (!piece) return null;
  if (!isAiReplyConfigured()) {
    throw new Error("ANTHROPIC_API_KEY isn't set (or has no credits) — can't draft content yet.");
  }

  const channelInstruction =
    piece.contentType === "social" && piece.channel && piece.channel in SOCIAL_CHANNEL_INSTRUCTIONS
      ? SOCIAL_CHANNEL_INSTRUCTIONS[piece.channel as SocialChannel]
      : CONTENT_TYPE_INSTRUCTIONS[piece.contentType];

  const systemPrompt = `You are the marketing/SEO content drafter for a short-term rental property. You write content Seni (the host) will review, edit, and approve — for social pieces on a channel he's connected in Postiz, approving in the CRM stages this as a real draft on that account; for everything else, he still posts it himself.

${channelInstruction}

${BRAND_VOICE}

Here are the only verified facts about the property you may reference. Do not invent amenities, prices, or policies beyond this:
--- Property facts ---
${PROPERTY_FACTS}
--- end property facts ---

Important: you have no access to live search data, analytics, or keyword-volume tools — any SEO reasoning you give is based on general best-practice knowledge only, not verified market research. Say so implicitly by keeping seo_notes modest and directional, not presented as verified data.

Respond with ONLY a single JSON object (no markdown fences), with exactly these keys:
{
  "body": "the drafted content",
  "meta_description": "meta description, or \\"\\" if not applicable to this content type",
  "seo_notes": "a short rationale note, or \\"\\" if not applicable"
}`;

  const userPrompt = `Content type: ${piece.contentType}\nTopic: ${piece.topic}\nTarget keyword: ${piece.targetKeyword || "(none specified)"}\nChannel: ${piece.channel || "(unspecified)"}\n\nDraft this content piece.`;

  const apiKey = await resolveAnthropicApiKey(orgId);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 2000,
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
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!body) throw new Error("Drafted content was empty.");
  const metaDescription = typeof parsed.meta_description === "string" ? parsed.meta_description.trim() : "";
  const seoNotes = typeof parsed.seo_notes === "string" ? parsed.seo_notes.trim() : "";

  const row = await queryOne<ContentRow>(
    `update content_pieces set
       body = $2,
       meta_description = nullif($3, ''),
       seo_notes = nullif($4, ''),
       status = case when status = 'idea'::content_piece_status then 'draft'::content_piece_status else status end,
       updated_at = now()
     where id = $1 and organization_id = $5
     returning *`,
    [id, body, metaDescription, seoNotes, orgId]
  );
  if (!row) return null;
  const updated = fromRow(row);

  await logAiActivity(
    {
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Draft content piece",
      trigger: `Drafted ${piece.contentType} content for topic "${piece.topic}"`,
      decision: "drafted",
      actionTaken: "Generated body/meta/SEO notes via Claude, awaiting Seni's review",
      result: "drafted",
    },
    orgId
  ).catch(() => {});

  return updated;
}

export async function listContentCampaigns(organizationId?: string): Promise<ContentCampaign[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<CampaignRow>(
    "select * from content_campaigns where organization_id = $1 order by created_at desc",
    [orgId]
  );
  return rows.map(campaignFromRow);
}

export async function getContentCampaign(id: string, organizationId?: string): Promise<ContentCampaign | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<CampaignRow>(
    "select * from content_campaigns where id = $1 and organization_id = $2",
    [id, orgId]
  );
  return row ? campaignFromRow(row) : null;
}

export async function listPiecesForCampaign(campaignId: string, organizationId?: string): Promise<ContentPiece[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<ContentRow>(
    "select * from content_pieces where campaign_id = $1 and organization_id = $2 order by channel",
    [campaignId, orgId]
  );
  return rows.map(fromRow);
}

const ALL_SOCIAL_CHANNELS = Object.keys(SOCIAL_CHANNEL_INSTRUCTIONS) as SocialChannel[];

/** The Social Media Manager's core repurposing step (Agent #4, formalizing
 * the ai-marketing-director skill's manual framework): one pillar asset ->
 * one content_campaign row + one content_piece (idea stage, not yet
 * AI-drafted) per social channel. Drafting each piece's actual body still
 * happens one at a time via generateContentDraft() — kept separate so a bad
 * draft on one channel doesn't block the others and so this stays fast. */
export async function createCampaignBatch(
  input: { pillarAssetDescription: string; pillarAssetMediaUrl?: string; channels?: SocialChannel[] },
  organizationId?: string
): Promise<{ campaign: ContentCampaign; pieces: ContentPiece[] }> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const channels = input.channels && input.channels.length > 0 ? input.channels : ALL_SOCIAL_CHANNELS;

  const campaignRow = await queryOne<CampaignRow>(
    `insert into content_campaigns (organization_id, pillar_asset_description, pillar_asset_media_url, status)
     values ($1, $2, $3, 'draft'::content_campaign_status)
     returning *`,
    [orgId, input.pillarAssetDescription, input.pillarAssetMediaUrl ?? null]
  );
  if (!campaignRow) throw new Error("Failed to create campaign.");
  const campaign = campaignFromRow(campaignRow);

  const pieces: ContentPiece[] = [];
  for (const channel of channels) {
    const piece = await createContentPiece(
      {
        contentType: "social",
        topic: input.pillarAssetDescription,
        channel,
        campaignId: campaign.id,
        mediaUrl: input.pillarAssetMediaUrl,
      },
      orgId
    );
    pieces.push(piece);
  }

  await logAiActivity(
    {
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Create weekly social campaign",
      trigger: `New pillar asset: ${input.pillarAssetDescription}`,
      decision: `Queued ${pieces.length} channel-specific drafts (idea stage)`,
      result: "queued",
    },
    orgId
  ).catch(() => {});

  return { campaign, pieces };
}

/** Records the Postiz post id (and optionally a scheduled time) on a piece
 * after lib/postiz.ts successfully pushes it. Pure data-layer write — no
 * Postiz API calls happen here, which is what keeps this file free of a
 * circular import with lib/postiz.ts (see this file's header comment). */
export async function updateContentPiecePostizFields(
  id: string,
  updates: { postizPostId?: string; scheduledAt?: string },
  organizationId?: string
): Promise<ContentPiece | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ContentRow>(
    `update content_pieces set
       postiz_post_id = coalesce($2, postiz_post_id),
       scheduled_at = coalesce($3::timestamptz, scheduled_at),
       updated_at = now()
     where id = $1 and organization_id = $4
     returning *`,
    [id, updates.postizPostId ?? null, updates.scheduledAt ?? null, orgId]
  );
  return row ? fromRow(row) : null;
}

export async function updateContentStatus(
  id: string,
  status: ContentPieceStatus,
  organizationId?: string
): Promise<ContentPiece | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ContentRow>(
    `update content_pieces set status = $2::content_piece_status, updated_at = now() where id = $1 and organization_id = $3 returning *`,
    [id, status, orgId]
  );
  if (!row) return null;
  const piece = fromRow(row);
  await logAiActivity(
    {
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Update content status",
      trigger: `Seni moved "${piece.topic}" to ${status}`,
      decision: status,
      actionTaken:
        status === "published_externally"
          ? "Seni confirmed he posted this himself — no system action was taken"
          : `Status changed to ${status}`,
      result: status,
    },
    orgId
  ).catch(() => {});
  return piece;
}

export async function updateContentFields(
  id: string,
  updates: Partial<{ topic: string; channel: string; targetKeyword: string; body: string; metaDescription: string }>,
  organizationId?: string
): Promise<ContentPiece | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const existing = await getContentPiece(id, orgId);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  const row = await queryOne<ContentRow>(
    `update content_pieces set
       topic = $2, channel = $3, target_keyword = $4, body = $5, meta_description = $6, updated_at = now()
     where id = $1 and organization_id = $7
     returning *`,
    [
      id,
      merged.topic,
      merged.channel ?? null,
      merged.targetKeyword ?? null,
      merged.body ?? null,
      merged.metaDescription ?? null,
      orgId,
    ]
  );
  return row ? fromRow(row) : null;
}
