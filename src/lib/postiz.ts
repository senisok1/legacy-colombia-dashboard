import { config, isPostizConfigured } from "./config";
import { logAiActivity } from "./aiActivity";
import { getDefaultOrganizationId } from "./organizations";
import { updateContentPiecePostizFields } from "./contentMarketing";
import type { ContentPiece, SocialChannel } from "./types";

// Social Media Manager (Agent #4 formalization) — real push to Postiz.
// See db/migrations/0020_content_campaigns.sql and docs/VISION.md's Agent #4
// entry. Only fires for content_pieces that (a) have contentType "social",
// (b) have a channel Postiz actually has a provider for, and (c) have a
// Postiz integration id configured for that channel in
// config.postizChannelMap (i.e. Seni has connected that account in Postiz).
// Everything else (blog/email pieces, or a social channel Postiz doesn't
// support / isn't connected yet) stays CRM-only, same as before this file
// existed — see contentMarketing.ts's header comment.

const AGENT_KEY = "marketing_seo";
const AGENT_NAME = "AI Marketing Director & SEO Manager";

// Maps our channel names to Postiz's `settings.__type` value. Only channels
// with a real Postiz provider are listed — see
// https://docs.postiz.com/public-api/introduction for the full platform
// list. Substack has no Postiz provider, so it's intentionally absent here:
// those pieces are always CRM-only drafts, same as blog/email.
const POSTIZ_PROVIDER_TYPE: Partial<Record<SocialChannel, string>> = {
  instagram_reel: "instagram",
  tiktok: "tiktok",
  facebook: "facebook",
  x: "x",
  linkedin: "linkedin",
  pinterest: "pinterest",
  youtube_short: "youtube",
};

/** Whether this specific channel could ever be pushed to Postiz (i.e. Postiz
 * has a provider for it), independent of whether Seni has actually connected
 * that account yet. Used by the UI to explain why a channel shows
 * "CRM-only" (e.g. Substack) vs. "not connected yet" (e.g. TikTok before
 * he's linked it in Postiz). */
export function isPostizSupportedChannel(channel: string | undefined): boolean {
  return Boolean(channel && POSTIZ_PROVIDER_TYPE[channel as SocialChannel]);
}

/** Whether THIS channel is ready to actually push right now — Postiz is
 * configured at all, the channel has a real Postiz provider, and Seni has
 * connected that specific account (mapped in POSTIZ_CHANNEL_MAP). */
export function isChannelPushable(channel: string | undefined): boolean {
  if (!isPostizConfigured() || !channel) return false;
  if (!POSTIZ_PROVIDER_TYPE[channel as SocialChannel]) return false;
  return Boolean(config.postizChannelMap[channel]);
}

/** Which of our channels currently have a Postiz integration id configured
 * (i.e. Seni has connected that account) — used by the UI to label pieces
 * "will push to Instagram on approve" vs. "CRM-only for now". */
export function getPushableChannels(): SocialChannel[] {
  if (!isPostizConfigured()) return [];
  return (Object.keys(POSTIZ_PROVIDER_TYPE) as SocialChannel[]).filter((c) => config.postizChannelMap[c]);
}

async function postizFetch<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${config.postizApiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: config.postizApiKey,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Postiz API ${path} returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

type PostizMediaFile = { id: string; path: string };

async function uploadFromUrl(url: string): Promise<PostizMediaFile> {
  return postizFetch<PostizMediaFile>("/upload-from-url", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

type PostizPostResponse = { id?: string; postId?: string }[] | { id?: string; postId?: string };

/** Pushes one approved content_piece to Postiz as a real DRAFT staged
 * against the connected social account — NOT auto-published. Postiz's
 * "draft" post type stores the post against the integration but doesn't
 * schedule or publish it; Seni finishes by opening Postiz (or, once wired,
 * the equivalent view in this CRM) and clicking Post — that's the "approve
 * or edit" step he asked for, just one click instead of copy-pasting text
 * into Instagram/Facebook by hand. Throws if Postiz isn't configured yet,
 * the channel has no Postiz provider, or that channel isn't connected — call
 * isChannelPushable() first to check gracefully.
 *
 * Safe to call from an "approved" status transition: never called
 * automatically on idea/draft — only once Seni has approved the piece in
 * the CRM. */
export async function pushPieceToPostiz(piece: ContentPiece, organizationId?: string): Promise<ContentPiece> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());

  if (!isPostizConfigured()) {
    throw new Error("Postiz isn't connected yet — set POSTIZ_API_KEY once Seni has a Postiz account.");
  }
  const channel = piece.channel;
  const providerType = channel ? POSTIZ_PROVIDER_TYPE[channel as SocialChannel] : undefined;
  if (!providerType) {
    throw new Error(
      `"${channel || "(no channel)"}" has no Postiz provider (e.g. Substack isn't supported by Postiz) — this piece stays CRM-only.`
    );
  }
  const integrationId = config.postizChannelMap[channel!];
  if (!integrationId) {
    throw new Error(`Seni hasn't connected a ${channel} account in Postiz yet (no integration id configured for it).`);
  }
  if (!piece.body) {
    throw new Error("This piece has no drafted body yet — generate it before pushing to Postiz.");
  }

  const images: { id: string; path: string }[] = [];
  if (piece.mediaUrl) {
    try {
      const uploaded = await uploadFromUrl(piece.mediaUrl);
      images.push({ id: uploaded.id, path: uploaded.path });
    } catch (err) {
      throw new Error(`Failed to upload media to Postiz: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const settings: Record<string, unknown> = { __type: providerType };
  if (providerType === "instagram" && channel === "instagram_reel") settings.post_type = "reel";
  if (providerType === "youtube") settings.title = piece.topic.slice(0, 95);

  const payload = {
    type: "draft",
    date: new Date().toISOString(),
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: integrationId },
        value: [{ content: piece.body, image: images }],
        settings,
      },
    ],
  };

  const result = await postizFetch<PostizPostResponse>("/posts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const first = Array.isArray(result) ? result[0] : result;
  const postizPostId = first?.id || first?.postId || "";

  const updated = await updateContentPiecePostizFields(piece.id, { postizPostId }, orgId);

  await logAiActivity(
    {
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Push approved content to Postiz",
      trigger: `Seni approved "${piece.topic}" (${channel})`,
      decision: "push as Postiz draft",
      actionTaken: `Staged a real draft on the connected ${channel} account via Postiz — Seni finishes by approving/editing it in Postiz`,
      result: postizPostId ? `Postiz post ${postizPostId}` : "pushed",
    },
    orgId
  ).catch(() => {});

  return updated ?? piece;
}
