"use client";

import { useState } from "react";
import type { Review, ReputationEntry, ReputationResponse, ReputationResponseStatus } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

// OwnerRez's own review-response editor for a specific review — confirmed by
// following the "Write a response" link from Quality Center > Reviews
// (2026-08-05): /bookings/{bookingId}/reviews/{reviewId}/writeresponse. Falls
// back to the plain Reviews list if a review has no linked booking (host
// reviews, or an edge case OwnerRez itself doesn't expose a booking for).
function ownerRezWriteResponseUrl(review: Review): string {
  return review.bookingId
    ? `https://app.ownerrez.com/bookings/${review.bookingId}/reviews/${review.id}/writeresponse`
    : "https://app.ownerrez.com/reviews";
}

/** Approving a drafted response sends it directly to the guest via WhatsApp.
 * One click: approve and send. The guest receives the message immediately.
 * A separate "Mark as sent" step lets Seni confirm the WhatsApp send worked. */
async function sendResponseToGuest(
  review: Review,
  text: string
): Promise<{ success: boolean; message: string }> {
  // Send the approved response directly to the guest via WhatsApp
  try {
    const res = await fetch(`/api/reputation/${review.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || "Failed to send.");
    return {
      success: true,
      message: data.message || "Sent to guest via WhatsApp",
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : "Failed to send to guest.",
    };
  }
}

// Same posture as CrmCampaignsExplorer.tsx / ApprovalsQueue.tsx: every card
// is a distinct, individually reviewed decision. Approving a response sends it
// directly to the guest via WhatsApp. "Mark as sent" confirms completion.

function StarRating({ rating }: { rating?: number }) {
  if (rating == null) return <span className="text-black/40 dark:text-white/40 text-xs">Unrated</span>;
  return (
    <span className="text-amber-500 text-sm" title={`${rating}/5`}>
      {"★".repeat(rating)}
      <span className="text-black/20 dark:text-white/15">{"★".repeat(Math.max(0, 5 - rating))}</span>
    </span>
  );
}

export function ReputationExplorer({ initialEntries }: { initialEntries: ReputationEntry[] }) {
  const [entries, setEntries] = useState<ReputationEntry[]>(initialEntries);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [filter, setFilter] = useState<"needs_response" | "pending_review" | "all">("needs_response");

  const rated = entries.map((e) => e.review.rating).filter((r): r is number => typeof r === "number");
  const avgRating = rated.length > 0 ? rated.reduce((s, r) => s + r, 0) / rated.length : null;
  const pendingReview = entries.filter((e) => e.response?.status === "pending_review");
  const needsResponse = entries.filter(
    (e) => !e.review.hostResponse && e.review.visible !== false && !e.response
  );

  const visible =
    filter === "needs_response" ? needsResponse : filter === "pending_review" ? pendingReview : entries;

  function updateEntry(reviewId: number, response: ReputationResponse) {
    setEntries((prev) => prev.map((e) => (e.review.id === reviewId ? { ...e, response } : e)));
  }

  async function scanNow() {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch("/api/reputation/detect", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; drafted?: number; capped?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Scan failed.");
      const cappedNote = data.capped ? " (stopped early to stay fast — run again to keep finding more.)" : "";
      setScanResult(
        !data.drafted
          ? "Scan complete — no reviews needed a new draft."
          : `Scan complete — drafted ${data.drafted} new response${data.drafted === 1 ? "" : "s"}.${cappedNote}`
      );
      const listRes = await fetch("/api/reputation");
      const listData = (await listRes.json()) as { entries: ReputationEntry[] };
      setEntries(listData.entries);
    } catch (err) {
      setScanResult(err instanceof Error ? err.message : "Scan failed.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-black/40 dark:text-white/40">
          {avgRating !== null ? `${avgRating.toFixed(2)}★ avg over ${entries.length} reviews` : `${entries.length} reviews`}
          {" · "}
          {needsResponse.length} unanswered · {pendingReview.length} draft{pendingReview.length === 1 ? "" : "s"}{" "}
          awaiting your decision
        </p>
        <button
          onClick={scanNow}
          disabled={scanning}
          className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40 whitespace-nowrap"
        >
          {scanning ? "Scanning…" : "Scan for new responses"}
        </button>
      </div>

      {scanResult && <p className="text-xs text-black/50 dark:text-white/50">{scanResult}</p>}

      <div className="flex gap-1.5 text-xs">
        {(
          [
            ["needs_response", `Needs a draft (${needsResponse.length})`],
            ["pending_review", `Awaiting your decision (${pendingReview.length})`],
            ["all", `All reviews (${entries.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-md ${
              filter === key
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "bg-black/5 dark:bg-white/10 hover:bg-black/10"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-12 text-sm text-black/50 dark:text-white/50">
          {filter === "needs_response"
            ? "Nothing needs a new draft right now — run a scan, or wait for tomorrow's daily check."
            : filter === "pending_review"
              ? "Nothing waiting on your decision right now."
              : "No reviews came back from OwnerRez yet."}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((entry) => (
            <ReviewCard key={entry.review.id} entry={entry} onDecided={updateEntry} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewCard({
  entry,
  onDecided,
}: {
  entry: ReputationEntry;
  onDecided: (reviewId: number, response: ReputationResponse) => void;
}) {
  const { review, response } = entry;
  const [draftText, setDraftText] = useState(response?.draftText ?? "");
  const [busy, setBusy] = useState<ReputationResponseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function decide(status: ReputationResponseStatus) {
    if (!response) return;
    setBusy(status);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/reputation/${response.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, draftText: status === "approved" ? draftText : undefined }),
      });
      const data = (await res.json()) as { response?: ReputationResponse; error?: string };
      if (!res.ok || !data.response) throw new Error(data.error || "Failed.");
      onDecided(review.id, data.response);
      // One-click approve: send the just-approved text directly to the guest via WhatsApp
      if (status === "approved") {
        const result = await sendResponseToGuest(review, draftText);
        if (result.success) {
          setNote("✓ Sent to guest");
        } else {
          setError(result.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const statusStyles: Record<ReputationResponseStatus, string> = {
    pending_review: "border-sky-400/30 bg-sky-50 dark:bg-sky-500/10",
    approved: "border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10",
    rejected: "border-black/10 dark:border-white/10 opacity-60",
    posted: "border-emerald-400/30 bg-emerald-50/50 dark:bg-emerald-500/5",
  };

  return (
    <div className={`rounded-xl border p-4 space-y-2.5 ${response ? statusStyles[response.status] : "border-black/10 dark:border-white/10"}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{review.guestName ?? "Guest"}</span>
          <span className="text-xs text-black/40 dark:text-white/40">· {review.source}</span>
          <StarRating rating={review.rating} />
        </div>
        <span className="text-xs text-black/40 dark:text-white/40">{formatRelativeTime(review.createdAt)}</span>
      </div>

      {review.comment && <p className="text-sm whitespace-pre-wrap">{review.comment}</p>}

      {review.hostResponse ? (
        <div className="text-xs rounded-md bg-black/5 dark:bg-white/10 px-2 py-1.5">
          <span className="font-medium">Already answered on {review.source}:</span> {review.hostResponse}
        </div>
      ) : !response ? (
        <p className="text-xs text-black/40 dark:text-white/40 italic">
          No response drafted yet — run a scan to have the AI draft one.
        </p>
      ) : (
        <div className="space-y-1.5 pt-1">
          <div className="text-xs font-medium opacity-80">
            AI-drafted response {response.status !== "pending_review" ? `· ${response.status.replace("_", " ")}` : ""}
          </div>
          {response.status === "pending_review" ? (
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
            />
          ) : (
            <p className="text-sm whitespace-pre-wrap">{response.draftText}</p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {note && <p className="text-xs text-emerald-600 dark:text-emerald-400">{note}</p>}

      {response && !review.hostResponse && (
        <div className="flex gap-2 flex-wrap">
          {response.status === "pending_review" && (
            <>
              <button
                onClick={() => decide("approved")}
                disabled={busy !== null}
                className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
              >
                {busy === "approved" ? "Sending…" : "Approve and send to guest"}
              </button>
              <button
                onClick={() => decide("rejected")}
                disabled={busy !== null}
                className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
              >
                {busy === "rejected" ? "Rejecting…" : "Reject"}
              </button>
            </>
          )}
          {response.status === "approved" && (
            <button
              onClick={() => decide("posted")}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
            >
              {busy === "posted" ? "Marking…" : "Mark as sent"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
