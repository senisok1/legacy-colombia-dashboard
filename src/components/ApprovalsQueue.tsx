"use client";

import { useEffect, useState } from "react";
import type { PendingDraft } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

// Same approve/edit/discard action set as ThreadInbox.tsx's AiSuggestionCard
// (both post to /api/messages/reply, which is the single place that actually
// sends to the guest and resolves the draft — see that route for why). This
// is a deliberate, small duplication rather than a shared component: this
// card renders standalone in a flat queue (no open thread/booking object
// around it — everything it needs is already on the PendingDraft itself),
// while ThreadInbox's version renders nested inside a specific conversation.
// Refactoring the two into one shared component is a reasonable future
// cleanup, not required for this to work correctly today.

const REFRESH_INTERVAL_MS = 30_000;

export function ApprovalsQueue({ initialDrafts }: { initialDrafts: PendingDraft[] }) {
  const [drafts, setDrafts] = useState<PendingDraft[]>(initialDrafts);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      setChecking(true);
      try {
        const res = await fetch("/api/approvals");
        const data = (await res.json()) as { drafts: PendingDraft[] };
        if (!cancelled) setDrafts(data.drafts);
      } catch {
        // Keep showing the last known list rather than blanking it on a
        // transient network hiccup.
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  function removeDraft(id: string) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  if (drafts.length === 0) {
    return (
      <div className="text-center py-16 text-sm text-black/50 dark:text-white/50">
        Nothing waiting on you right now — every AI-suggested reply has been handled.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-black/40 dark:text-white/40">
        {drafts.length} awaiting your decision{checking ? " · checking for updates…" : ""}
      </p>
      {drafts.map((draft) => (
        <ApprovalCard key={draft.id} draft={draft} onResolved={() => removeDraft(draft.id)} />
      ))}
    </div>
  );
}

function ApprovalCard({ draft, onResolved }: { draft: PendingDraft; onResolved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(draft.replyEnglish ?? draft.draftReply);
  const [busy, setBusy] = useState<"approve" | "edit" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const language = draft.language && draft.language !== "English" ? draft.language : null;

  async function act(action: "approve" | "edit" | "discard") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/messages/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: draft.threadId,
          bookingId: draft.bookingId,
          guestId: draft.guestId,
          guestName: draft.guestName,
          draftId: draft.id,
          action,
          body: action === "approve" ? draft.draftReply : action === "edit" ? editText : undefined,
          targetLanguage: action === "edit" ? draft.language : undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed.");
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10 p-4 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{draft.guestName || "Guest"}</div>
        <div className="text-xs text-black/40 dark:text-white/40">{formatRelativeTime(draft.createdAt)}</div>
      </div>

      <div className="text-xs text-black/50 dark:text-white/50">
        Guest wrote{language ? ` (${language})` : ""}: &ldquo;{draft.guestMessageEnglish ?? draft.guestMessage}
        &rdquo;
      </div>

      {draft.isServiceRequest && (
        <div className="text-xs rounded-md bg-amber-100 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2 py-1">
          🛎️ Service request{draft.guestPhone ? ` — WhatsApp: ${draft.guestPhone}` : " — no phone on file"}. Approving
          will notify Gabriel.
        </div>
      )}

      {!editing ? (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
            AI suggested reply{language ? ` — will send in ${language}` : ""}
          </div>
          <p className="text-sm whitespace-pre-wrap">{draft.replyEnglish ?? draft.draftReply}</p>
          {language && draft.replyEnglish && (
            <div className="pt-1.5 border-t border-emerald-400/20 text-xs text-emerald-800/70 dark:text-emerald-300/70 whitespace-pre-wrap">
              <span className="font-medium">{language} (what the guest will see):</span> {draft.draftReply}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
          />
          {language && (
            <p className="text-[11px] text-black/40 dark:text-white/40">
              Write in English above — it&rsquo;ll be automatically translated to {language} before sending.
            </p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex gap-2">
        {!editing ? (
          <>
            <button
              onClick={() => act("approve")}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
            >
              {busy === "approve" ? "Sending…" : "Approve & send"}
            </button>
            <button
              onClick={() => setEditing(true)}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
            >
              Edit
            </button>
            <button
              onClick={() => act("discard")}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md text-red-600 dark:text-red-400 hover:underline disabled:opacity-40"
            >
              {busy === "discard" ? "Discarding…" : "Discard"}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => act("edit")}
              disabled={busy !== null || !editText.trim()}
              className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
            >
              {busy === "edit" ? "Sending…" : "Send edited reply"}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
