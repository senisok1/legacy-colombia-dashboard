"use client";

import { useState } from "react";
import type { ContentCampaign, ContentPiece, ContentPieceStatus, SocialChannel } from "@/lib/types";
import { formatShortDate } from "@/lib/format";

// Social Media Manager (Agent #4 formalization, 2026-08-07). One pillar
// asset (a video, photo set, or theme) -> one campaign -> one drafted piece
// per social channel. Approving a piece whose channel is in
// `pushableChannels` (Seni has connected that account in Postiz) actually
// stages it as a real draft on that account — see lib/postiz.ts and the
// PATCH handler in api/marketing/content/[id]/route.ts. Channels not yet
// connected (or, for Substack, never connectable — Postiz has no provider
// for it) stay CRM-only, same as the rest of this Marketing tab.

const CHANNEL_LABELS: Record<SocialChannel, string> = {
  instagram_reel: "Instagram Reel",
  tiktok: "TikTok",
  facebook: "Facebook",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  youtube_short: "YouTube Short",
  substack: "Substack",
};

const STATUS_LABELS: Record<ContentPieceStatus, string> = {
  idea: "Idea",
  draft: "Draft",
  approved: "Approved",
  published_externally: "Published (by Seni)",
  archived: "Archived",
};

const STATUS_STYLES: Record<ContentPieceStatus, string> = {
  idea: "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60",
  draft: "bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
  approved: "bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
  published_externally: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  archived: "bg-black/5 text-black/40 dark:bg-white/5 dark:text-white/40",
};

type CampaignWithPieces = { campaign: ContentCampaign; pieces: ContentPiece[] };

export function SocialMediaManager({
  initialCampaigns,
  pushableChannels,
  postizConfigured,
}: {
  initialCampaigns: CampaignWithPieces[];
  pushableChannels: string[];
  postizConfigured: boolean;
}) {
  const [campaigns, setCampaigns] = useState<CampaignWithPieces[]>(initialCampaigns);
  const [showForm, setShowForm] = useState(false);

  function addCampaign(entry: CampaignWithPieces) {
    setCampaigns((prev) => [entry, ...prev]);
    setShowForm(false);
  }

  function updatePiece(campaignId: string, piece: ContentPiece) {
    setCampaigns((prev) =>
      prev.map((c) => (c.campaign.id === campaignId ? { ...c, pieces: c.pieces.map((p) => (p.id === piece.id ? piece : p)) } : c))
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold">Social Media Manager</h3>
          <p className="text-xs text-black/40 dark:text-white/40 max-w-2xl">
            One pillar asset repurposed into a draft for every channel.{" "}
            {postizConfigured
              ? pushableChannels.length > 0
                ? `Approving a piece on ${pushableChannels.map((c) => CHANNEL_LABELS[c as SocialChannel]).join(", ")} stages it as a real draft there via Postiz — you finish with one click in Postiz. Other channels are still CRM-only until connected.`
                : "Postiz is connected but no channels are linked yet — everything is CRM-only until Seni connects an account in Postiz."
              : "Postiz isn't connected yet, so every piece is CRM-only for now — approve here, then copy/post it yourself. Once Seni sets up Postiz, approved pieces on connected channels will push automatically."}
          </p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black"
        >
          {showForm ? "Cancel" : "+ New weekly batch"}
        </button>
      </div>

      {showForm && <NewCampaignForm onCreated={addCampaign} />}

      {campaigns.length === 0 ? (
        <div className="text-center py-12 text-sm text-black/50 dark:text-white/50">
          No campaigns yet — describe a pillar asset (a video, photo set, or theme) to generate a draft for every
          channel.
        </div>
      ) : (
        <div className="space-y-5">
          {campaigns.map(({ campaign, pieces }) => (
            <div key={campaign.id} className="rounded-xl border border-black/10 dark:border-white/10 p-4 space-y-3">
              <div>
                <div className="text-sm font-medium">{campaign.pillarAssetDescription}</div>
                <div className="text-xs text-black/40 dark:text-white/40">{formatShortDate(campaign.createdAt)}</div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {pieces.map((piece) => (
                  <PieceCard
                    key={piece.id}
                    piece={piece}
                    pushable={Boolean(piece.channel && pushableChannels.includes(piece.channel))}
                    onUpdated={(p) => updatePiece(campaign.id, p)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewCampaignForm({ onCreated }: { onCreated: (entry: CampaignWithPieces) => void }) {
  const [description, setDescription] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!description.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/marketing/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pillarAssetDescription: description, pillarAssetMediaUrl: mediaUrl || undefined }),
      });
      const data = (await res.json()) as { campaign?: ContentCampaign; pieces?: ContentPiece[]; error?: string };
      if (!res.ok || !data.campaign || !data.pieces) throw new Error(data.error || "Failed to create batch.");
      onCreated({ campaign: data.campaign, pieces: data.pieces });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 space-y-2.5">
      <label className="text-xs space-y-1 block">
        <span className="text-black/50 dark:text-white/50">Pillar asset — what's this week's video, photo set, or theme? *</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="e.g. New drone footage of the lake at sunrise + the barrel sauna deck"
          className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-3 py-2 text-sm"
        />
      </label>
      <label className="text-xs space-y-1 block">
        <span className="text-black/50 dark:text-white/50">Media URL (optional — a public image/video link for channels that need one)</span>
        <input
          value={mediaUrl}
          onChange={(e) => setMediaUrl(e.target.value)}
          placeholder="https://…"
          className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2 py-1.5 text-sm"
        />
      </label>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button
        onClick={submit}
        disabled={busy || !description.trim()}
        className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
      >
        {busy ? "Creating…" : "Generate weekly batch"}
      </button>
    </div>
  );
}

function PieceCard({
  piece,
  pushable,
  onUpdated,
}: {
  piece: ContentPiece;
  pushable: boolean;
  onUpdated: (piece: ContentPiece) => void;
}) {
  const [busy, setBusy] = useState<"generate" | "approve" | "archive" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(piece.body ?? "");
  const [expanded, setExpanded] = useState(false);

  async function generate() {
    setBusy("generate");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/marketing/content/${piece.id}/generate`, { method: "POST" });
      const data = (await res.json()) as { piece?: ContentPiece; error?: string };
      if (!res.ok || !data.piece) throw new Error(data.error || "Failed to generate.");
      onUpdated(data.piece);
      setEditBody(data.piece.body ?? "");
      setExpanded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setBusy("approve");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/marketing/content/${piece.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      const data = (await res.json()) as { piece?: ContentPiece; error?: string; postizError?: string };
      if (!res.ok || !data.piece) throw new Error(data.error || "Failed.");
      onUpdated(data.piece);
      if (data.postizError) {
        setNotice(`Approved here, but didn't push to Postiz: ${data.postizError}`);
      } else if (data.piece.postizPostId) {
        setNotice("Approved and staged as a real draft in Postiz — finish it there when ready.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    setBusy("archive");
    setError(null);
    try {
      const res = await fetch(`/api/marketing/content/${piece.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });
      const data = (await res.json()) as { piece?: ContentPiece; error?: string };
      if (!res.ok || !data.piece) throw new Error(data.error || "Failed.");
      onUpdated(data.piece);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/marketing/content/${piece.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { body: editBody } }),
      });
      const data = (await res.json()) as { piece?: ContentPiece; error?: string };
      if (!res.ok || !data.piece) throw new Error(data.error || "Failed to save.");
      onUpdated(data.piece);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function copyToClipboard() {
    if (piece.body) await navigator.clipboard.writeText(piece.body).catch(() => {});
  }

  const channelLabel = piece.channel ? CHANNEL_LABELS[piece.channel as SocialChannel] ?? piece.channel : "—";

  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 p-3 space-y-2 bg-white dark:bg-white/5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-medium">
          {channelLabel}
          {pushable && <span className="ml-1.5 text-[10px] text-blue-600 dark:text-blue-400">(pushes to Postiz)</span>}
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLES[piece.status]}`}>
          {STATUS_LABELS[piece.status]}
          {piece.postizPostId ? " · in Postiz" : ""}
        </span>
      </div>

      {!piece.body ? (
        <button
          onClick={generate}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
        >
          {busy === "generate" ? "Drafting…" : "Generate draft"}
        </button>
      ) : (
        <>
          <button onClick={() => setExpanded((v) => !v)} className="text-xs text-black/50 dark:text-white/50 hover:underline">
            {expanded ? "Hide draft" : "Show draft"}
          </button>
          {expanded &&
            (editing ? (
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={6}
                className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-3 py-2 text-sm font-mono outline-none focus:border-black/30 dark:focus:border-white/30"
              />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{piece.body}</p>
            ))}
        </>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="text-xs text-blue-600 dark:text-blue-400">{notice}</p>}

      {expanded && piece.body && (
        <div className="flex gap-2 flex-wrap">
          {editing ? (
            <>
              <button
                onClick={saveEdit}
                disabled={busy !== null}
                className="text-xs px-2.5 py-1 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
              >
                {busy === "save" ? "Saving…" : "Save edit"}
              </button>
              <button
                onClick={() => setEditing(false)}
                disabled={busy !== null}
                className="text-xs px-2.5 py-1 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={copyToClipboard} className="text-xs px-2.5 py-1 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10">
                Copy
              </button>
              <button
                onClick={() => setEditing(true)}
                disabled={busy !== null}
                className="text-xs px-2.5 py-1 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
              >
                Edit
              </button>
              <button
                onClick={generate}
                disabled={busy !== null}
                className="text-xs px-2.5 py-1 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
              >
                {busy === "generate" ? "Redrafting…" : "Regenerate"}
              </button>
              {piece.status !== "approved" && piece.status !== "published_externally" && (
                <button
                  onClick={approve}
                  disabled={busy !== null}
                  className="text-xs px-2.5 py-1 rounded-md bg-blue-600 text-white disabled:opacity-40"
                >
                  {busy === "approve" ? "…" : pushable ? "Approve & push" : "Approve"}
                </button>
              )}
              {piece.status !== "archived" && (
                <button
                  onClick={archive}
                  disabled={busy !== null}
                  className="text-xs px-2.5 py-1 rounded-md text-red-600 dark:text-red-400 hover:underline disabled:opacity-40"
                >
                  Archive
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
