"use client";

import { useMemo, useState } from "react";
import type { ContentPiece, ContentPieceStatus, ContentPieceType } from "@/lib/types";
import { formatShortDate } from "@/lib/format";

// Phase 7 — Marketing, social & SEO. DRAFTING AND REVIEW ONLY, see
// db/migrations/0006_marketing_content.sql's header comment: no social/CMS
// platform is connected, so nothing here posts anywhere. "Mark published
// externally" just records that Seni posted it himself through his own
// tools — it's not a system action.

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

const TYPE_LABELS: Record<ContentPieceType, string> = { blog: "Blog", social: "Social", email: "Email" };

const FILTERS: { key: "active" | "all" | ContentPieceStatus; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "approved", label: "Approved" },
  { key: "published_externally", label: "Published" },
  { key: "archived", label: "Archived" },
  { key: "all", label: "All" },
];

export function MarketingExplorer({ initialPieces }: { initialPieces: ContentPiece[] }) {
  const [pieces, setPieces] = useState<ContentPiece[]>(initialPieces);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<"active" | "all" | ContentPieceStatus>("active");

  function upsert(piece: ContentPiece) {
    setPieces((prev) => {
      const exists = prev.some((p) => p.id === piece.id);
      const next = exists ? prev.map((p) => (p.id === piece.id ? piece : p)) : [piece, ...prev];
      return next.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    });
  }

  const filtered = useMemo(() => {
    if (filter === "all") return pieces;
    if (filter === "active") return pieces.filter((p) => p.status === "idea" || p.status === "draft");
    return pieces.filter((p) => p.status === filter);
  }, [pieces, filter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-black/40 dark:text-white/40">
          {pieces.filter((p) => p.status === "idea" || p.status === "draft").length} in progress · content is
          drafted here for you to copy and post yourself — nothing is published automatically.
        </p>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black"
        >
          {showForm ? "Cancel" : "+ New content idea"}
        </button>
      </div>

      {showForm && <NewPieceForm onCreated={(p) => { upsert(p); setShowForm(false); }} />}

      <div className="flex gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`text-xs px-2.5 py-1 rounded-md ${
              filter === f.key
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "bg-black/5 dark:bg-white/10 text-black/60 dark:text-white/60 hover:bg-black/10"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-sm text-black/50 dark:text-white/50">
          Nothing here yet — add a content idea to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((p) => (
            <PieceCard key={p.id} piece={p} onUpdated={upsert} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewPieceForm({ onCreated }: { onCreated: (piece: ContentPiece) => void }) {
  const [contentType, setContentType] = useState<ContentPieceType>("blog");
  const [topic, setTopic] = useState("");
  const [channel, setChannel] = useState("");
  const [targetKeyword, setTargetKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!topic.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/marketing/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, topic, channel: channel || undefined, targetKeyword: targetKeyword || undefined }),
      });
      const data = (await res.json()) as { piece?: ContentPiece; error?: string };
      if (!res.ok || !data.piece) throw new Error(data.error || "Failed to create.");
      onCreated(data.piece);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <label className="text-xs space-y-1">
          <span className="text-black/50 dark:text-white/50">Type</span>
          <select
            value={contentType}
            onChange={(e) => setContentType(e.target.value as ContentPieceType)}
            className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2 py-1.5 text-sm"
          >
            <option value="blog">Blog</option>
            <option value="social">Social</option>
            <option value="email">Email</option>
          </select>
        </label>
        <label className="text-xs space-y-1">
          <span className="text-black/50 dark:text-white/50">Channel (optional)</span>
          <input
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="Instagram, Blog, Email newsletter…"
            className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="text-xs space-y-1 block">
        <span className="text-black/50 dark:text-white/50">Topic *</span>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. Why Peñol is the best waterfront escape near Medellín"
          className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2 py-1.5 text-sm"
        />
      </label>
      <label className="text-xs space-y-1 block">
        <span className="text-black/50 dark:text-white/50">Target keyword (optional, mainly for blog)</span>
        <input
          value={targetKeyword}
          onChange={(e) => setTargetKeyword(e.target.value)}
          placeholder="e.g. waterfront villa rental Peñol"
          className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2 py-1.5 text-sm"
        />
      </label>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button
        onClick={submit}
        disabled={busy || !topic.trim()}
        className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
      >
        {busy ? "Adding…" : "Add idea"}
      </button>
    </div>
  );
}

function PieceCard({ piece, onUpdated }: { piece: ContentPiece; onUpdated: (piece: ContentPiece) => void }) {
  const [busy, setBusy] = useState<"generate" | "approve" | "publish" | "archive" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(piece.body ?? "");
  const [expanded, setExpanded] = useState(false);

  async function generate() {
    setBusy("generate");
    setError(null);
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

  async function setStatus(status: ContentPieceStatus, busyKey: "approve" | "publish" | "archive") {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await fetch(`/api/marketing/content/${piece.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
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

  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 space-y-2.5 bg-white dark:bg-white/5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{piece.topic}</div>
          <div className="text-xs text-black/40 dark:text-white/40">
            {TYPE_LABELS[piece.contentType]}
            {piece.channel ? ` · ${piece.channel}` : ""}
            {piece.targetKeyword ? ` · keyword: ${piece.targetKeyword}` : ""} · {formatShortDate(piece.createdAt)}
          </div>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLES[piece.status]}`}>
          {STATUS_LABELS[piece.status]}
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
          {expanded && (
            <div className="space-y-2">
              {editing ? (
                <textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={10}
                  className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-3 py-2 text-sm font-mono outline-none focus:border-black/30 dark:focus:border-white/30"
                />
              ) : (
                <p className="text-sm whitespace-pre-wrap">{piece.body}</p>
              )}
              {piece.metaDescription && !editing && (
                <p className="text-xs text-black/40 dark:text-white/40">
                  <span className="font-medium">Meta description:</span> {piece.metaDescription}
                </p>
              )}
              {piece.seoNotes && !editing && (
                <p className="text-xs text-black/40 dark:text-white/40">
                  <span className="font-medium">SEO notes:</span> {piece.seoNotes}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {expanded && piece.body && (
        <div className="flex gap-2 flex-wrap">
          {editing ? (
            <>
              <button
                onClick={saveEdit}
                disabled={busy !== null}
                className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
              >
                {busy === "save" ? "Saving…" : "Save edit"}
              </button>
              <button
                onClick={() => setEditing(false)}
                disabled={busy !== null}
                className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={copyToClipboard}
                className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10"
              >
                Copy text
              </button>
              <button
                onClick={() => setEditing(true)}
                disabled={busy !== null}
                className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
              >
                Edit
              </button>
              <button
                onClick={generate}
                disabled={busy !== null}
                className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
              >
                {busy === "generate" ? "Redrafting…" : "Regenerate"}
              </button>
              {piece.status !== "approved" && piece.status !== "published_externally" && (
                <button
                  onClick={() => setStatus("approved", "approve")}
                  disabled={busy !== null}
                  className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white disabled:opacity-40"
                >
                  {busy === "approve" ? "…" : "Mark approved"}
                </button>
              )}
              {piece.status !== "published_externally" && (
                <button
                  onClick={() => setStatus("published_externally", "publish")}
                  disabled={busy !== null}
                  className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white disabled:opacity-40"
                >
                  {busy === "publish" ? "…" : "I posted this myself"}
                </button>
              )}
              {piece.status !== "archived" && (
                <button
                  onClick={() => setStatus("archived", "archive")}
                  disabled={busy !== null}
                  className="text-xs px-3 py-1.5 rounded-md text-red-600 dark:text-red-400 hover:underline disabled:opacity-40"
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
