"use client";

import { useState } from "react";
import type { LifecycleCampaignCandidate, LifecycleCampaignType } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

// Same posture as ApprovalsQueue.tsx: every card is a distinct, individually
// reviewed decision. Approve & Send is the ONLY action anywhere in this app
// that actually messages a guest for a lifecycle-marketing reason — see
// lib/lifecycleMarketing.ts's header comment. Nothing here auto-sends.

const TYPE_LABELS: Record<LifecycleCampaignType, string> = {
  win_back: "Win-back",
  referral: "Referral ask",
  abandoned_booking: "Abandoned booking",
  review_request: "Review request",
};

const TYPE_STYLES: Record<LifecycleCampaignType, string> = {
  win_back: "border-sky-400/30 bg-sky-50 dark:bg-sky-500/10",
  referral: "border-violet-400/30 bg-violet-50 dark:bg-violet-500/10",
  abandoned_booking: "border-amber-400/30 bg-amber-50 dark:bg-amber-500/10",
  review_request: "border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10",
};

export function CrmCampaignsExplorer({ initialCandidates }: { initialCandidates: LifecycleCampaignCandidate[] }) {
  const [candidates, setCandidates] = useState<LifecycleCampaignCandidate[]>(initialCandidates);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const pending = candidates.filter((c) => c.status === "candidate");
  const history = candidates
    .filter((c) => c.status !== "candidate")
    .sort((a, b) => (b.reviewedAt ?? b.updatedAt).localeCompare(a.reviewedAt ?? a.updatedAt));

  const byType: Record<LifecycleCampaignType, LifecycleCampaignCandidate[]> = {
    win_back: pending.filter((c) => c.campaignType === "win_back"),
    referral: pending.filter((c) => c.campaignType === "referral"),
    abandoned_booking: pending.filter((c) => c.campaignType === "abandoned_booking"),
    review_request: pending.filter((c) => c.campaignType === "review_request"),
  };

  function updateCandidate(updated: LifecycleCampaignCandidate) {
    setCandidates((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }

  async function scanNow() {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch("/api/campaigns/detect", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        winBack?: number;
        referral?: number;
        abandonedBooking?: number;
        reviewRequest?: number;
        capped?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error || "Scan failed.");
      const total = (data.winBack ?? 0) + (data.referral ?? 0) + (data.abandonedBooking ?? 0) + (data.reviewRequest ?? 0);
      const cappedNote = data.capped
        ? " (stopped early to stay fast — run the scan again to keep finding more.)"
        : "";
      setScanResult(
        total === 0
          ? "Scan complete — no new candidates found."
          : `Scan complete — found ${total} new candidate${total === 1 ? "" : "s"} (${data.winBack ?? 0} win-back, ${data.referral ?? 0} referral, ${data.abandonedBooking ?? 0} abandoned booking, ${data.reviewRequest ?? 0} review request).${cappedNote}`
      );
      const listRes = await fetch("/api/campaigns");
      const listData = (await listRes.json()) as { candidates: LifecycleCampaignCandidate[] };
      setCandidates(listData.candidates);
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
          {pending.length} awaiting your decision · win-back, referral, review request, and abandoned-booking
          outreach only — nothing is ever sent without your approval.
        </p>
        <button
          onClick={scanNow}
          disabled={scanning}
          className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40 whitespace-nowrap"
        >
          {scanning ? "Scanning…" : "Scan for new candidates"}
        </button>
      </div>

      {scanResult && <p className="text-xs text-black/50 dark:text-white/50">{scanResult}</p>}

      {pending.length === 0 ? (
        <div className="text-center py-12 text-sm text-black/50 dark:text-white/50">
          Nothing waiting on you right now. Run a scan, or wait for tomorrow&rsquo;s daily check.
        </div>
      ) : (
        (Object.keys(TYPE_LABELS) as LifecycleCampaignType[]).map((type) =>
          byType[type].length === 0 ? null : (
            <div key={type} className="space-y-2">
              <h3 className="text-sm font-medium">
                {TYPE_LABELS[type]} <span className="text-black/40 dark:text-white/40">({byType[type].length})</span>
              </h3>
              <div className="space-y-3">
                {byType[type].map((c) => (
                  <CandidateCard key={c.id} candidate={c} onResolved={updateCandidate} />
                ))}
              </div>
            </div>
          )
        )
      )}

      <div className="pt-2 border-t border-black/10 dark:border-white/10">
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="text-xs text-black/40 dark:text-white/40 hover:underline"
        >
          {showHistory ? "Hide" : "Show"} history ({history.length})
        </button>
        {showHistory && (
          <div className="mt-3 space-y-2">
            {history.length === 0 ? (
              <p className="text-xs text-black/40 dark:text-white/40">Nothing resolved yet.</p>
            ) : (
              history.map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-xs flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <span className="font-medium">{c.guestName}</span>{" "}
                    <span className="text-black/40 dark:text-white/40">
                      · {TYPE_LABELS[c.campaignType]} · {c.status}
                      {c.status === "failed" && c.sendError ? ` — ${c.sendError}` : ""}
                    </span>
                  </div>
                  <span className="text-black/40 dark:text-white/40 whitespace-nowrap">
                    {formatRelativeTime(c.reviewedAt ?? c.updatedAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  onResolved,
}: {
  candidate: LifecycleCampaignCandidate;
  onResolved: (updated: LifecycleCampaignCandidate) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "skip" | "optout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOptOutPrompt, setShowOptOutPrompt] = useState(false);
  const [optOutReason, setOptOutReason] = useState("");

  const language = candidate.language && candidate.language !== "English" ? candidate.language : null;

  async function act(action: "approve" | "skip") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${candidate.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as { candidate?: LifecycleCampaignCandidate; error?: string };
      if (!res.ok || !data.candidate) throw new Error(data.error || "Failed.");
      onResolved(data.candidate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmOptOut() {
    if (!candidate.guestId) {
      setError("No OwnerRez guest id on file — can't opt this guest out automatically.");
      return;
    }
    setBusy("optout");
    setError(null);
    try {
      await fetch("/api/campaigns/opt-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestId: candidate.guestId, optedOut: true, reason: optOutReason || undefined }),
      });
      await act("skip");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(null);
    }
  }

  return (
    <div className={`rounded-xl border p-4 space-y-2.5 ${TYPE_STYLES[candidate.campaignType]}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{candidate.guestName}</div>
        <div className="text-xs text-black/40 dark:text-white/40">{formatRelativeTime(candidate.createdAt)}</div>
      </div>

      <div className="text-xs text-black/50 dark:text-white/50">{candidate.triggerReason}</div>

      {!candidate.threadId && (
        <div className="text-xs rounded-md bg-red-100 dark:bg-red-500/10 text-red-800 dark:text-red-300 px-2 py-1">
          No OwnerRez message thread on file — approving will mark this failed rather than send. Reach out
          manually instead ({candidate.guestEmail || candidate.guestPhone || "no contact info on file"}).
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-xs font-medium opacity-80">
          Draft message{language ? ` — will send in ${language}` : ""}
        </div>
        <p className="text-sm whitespace-pre-wrap">{candidate.draftMessageEnglish ?? candidate.draftMessage}</p>
        {language && candidate.draftMessageEnglish && (
          <div className="pt-1.5 border-t border-black/10 dark:border-white/10 text-xs opacity-70 whitespace-pre-wrap">
            <span className="font-medium">{language} (what the guest will see):</span> {candidate.draftMessage}
          </div>
        )}
      </div>

      {showOptOutPrompt && (
        <div className="space-y-1.5 pt-1">
          <input
            value={optOutReason}
            onChange={(e) => setOptOutReason(e.target.value)}
            placeholder="Reason (optional)"
            className="w-full rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-3 py-1.5 text-xs outline-none focus:border-black/30 dark:focus:border-white/30"
          />
          <div className="flex gap-2">
            <button
              onClick={confirmOptOut}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white disabled:opacity-40"
            >
              {busy === "optout" ? "Opting out…" : "Confirm opt-out"}
            </button>
            <button
              onClick={() => setShowOptOutPrompt(false)}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {!showOptOutPrompt && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => act("approve")}
            disabled={busy !== null}
            className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
          >
            {busy === "approve" ? "Sending…" : "Approve & send"}
          </button>
          <button
            onClick={() => act("skip")}
            disabled={busy !== null}
            className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
          >
            {busy === "skip" ? "Skipping…" : "Skip"}
          </button>
          <button
            onClick={() => setShowOptOutPrompt(true)}
            disabled={busy !== null}
            className="text-xs px-3 py-1.5 rounded-md text-red-600 dark:text-red-400 hover:underline disabled:opacity-40"
          >
            Opt guest out of marketing
          </button>
        </div>
      )}
    </div>
  );
}
