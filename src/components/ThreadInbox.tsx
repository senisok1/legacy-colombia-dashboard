"use client";

import { useEffect, useRef, useState } from "react";
import type { PendingDraft, ThreadMessage } from "@/lib/types";
import type { MessageTranslation } from "@/lib/translate";
import { formatDate, formatRelativeTime } from "@/lib/format";

// Translation retry ladder (2026-08-21, Seni's ask: "I need to see all
// messages in English no matter what language the guest is in", reported
// against a message from Natalia Velez that stayed in Spanish). The enrich
// endpoint does the actual translation work in the background after the
// conversation paints — before this fix, a single failed/slow enrich call
// (e.g. an OwnerRez rate-limit hiccup — this app really does hit those, see
// lib/inbox.ts) was silently swallowed by a bare `.catch(() => {})`, leaving
// the guest's message in its original language with no retry and no
// indication anything had gone wrong. Now it retries automatically with
// backoff, and MessageBubble shows a "Translating…" note on any guest
// message that hasn't resolved yet instead of silently presenting the
// original-language text as if it were final.
const TRANSLATE_RETRY_DELAYS_MS = [2000, 5000, 10000];

type InboxThread = {
  threadId: number;
  bookingId: number;
  guestId: number | null;
  guestName?: string;
  propertyName?: string;
  arrival: string;
  departure: string;
  source: string;
  lastMessagePreview: string;
  lastMessageAt?: string;
  awaitingReply: boolean;
};

type ThreadDetail = {
  threadId: number;
  booking: {
    id: number;
    guestId: number | null;
    propertyName?: string;
    arrival: string;
    departure: string;
    source: string;
  } | null;
  // Resolved server-side by joining the booking against OwnerRez's guest
  // list (see lib/guestName.ts) — booking.guestName from the bookings
  // endpoint itself is very often blank.
  guestName: string;
  // Best-known language the guest is writing in (e.g. "Spanish"), or null
  // if they've been writing in English / it's unknown. Anything Seni types
  // in the compose box or edits from the AI suggestion gets translated into
  // this before sending — see api/messages/reply.
  guestLanguage: string | null;
  messages: ThreadMessage[];
  translations: Record<number, MessageTranslation>;
  pendingDraft: PendingDraft | null;
  // "pending" while the enrich pass (still) hasn't successfully resolved a
  // translation for every guest message with text; "failed" once the retry
  // ladder is exhausted — drives the banner + manual retry button below.
  translationStatus: "pending" | "done" | "failed";
};

export function ThreadInbox({ messagingConfigured }: { messagingConfigured: boolean }) {
  const [threads, setThreads] = useState<InboxThread[] | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(messagingConfigured);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(20);
  // Guards the retry ladder below (2026-08-21) — if Seni opens a different
  // conversation while an earlier one's retries are still pending, a stale
  // retry's response must not get applied to whatever's on screen now.
  const activeThreadIdRef = useRef<number | null>(null);

  // Two layers, same idea as opening a conversation (see openThread below):
  // an instant paint from the short server cache, immediately followed by a
  // live (?fresh=1, uncached) re-fetch that hits OwnerRez directly and
  // replaces the list once it resolves — so a brand-new guest message shows
  // up here within seconds of existing in OwnerRez, not after waiting out a
  // cache window. A periodic re-poll of the live endpoint keeps this true
  // for as long as the Messaging tab stays open, without requiring Seni to
  // manually refresh the page. See lib/inbox.ts's getAllThreadSummaries
  // comment for the full story (a real multi-minute lag was observed and
  // traced to this list's old 5-minute cache, 2026-07-30).
  // BUG FIX (2026-08-07): fetchThreads used to be declared *inside* this
  // effect, which meant openThread()'s call to it below (after opening a
  // conversation) threw "Cannot find name 'fetchThreads'" — a real
  // ReferenceError on every single thread-open in production, silently
  // swallowed because next.config.ts has ignoreBuildErrors on (same failure
  // class as the awaitingReply bug documented in
  // api/cron/check-messages/route.ts). It also meant "Load more" — which
  // only ever called setLimit — never actually re-fetched with the new
  // limit, since `limit` wasn't in this effect's dependency array. Hoisting
  // fetchThreads to component scope and depending on `limit` fixes both:
  // the post-open refresh call now resolves, and paging in more
  // conversations actually re-fetches.
  async function fetchThreads(fresh = false) {
    try {
      const res = await fetch(`/api/messages/inbox?limit=${limit}${fresh ? "&fresh=1" : ""}`);
      const data = (await res.json()) as { threads?: InboxThread[]; error?: string; hasMore?: boolean };
      if (!res.ok || !Array.isArray(data.threads)) {
        throw new Error(data.error ?? `Inbox request failed (${res.status})`);
      }
      setThreads(data.threads);
      setHasMore(data.hasMore ?? false);
      setInboxError(null);
    } catch (err) {
      setInboxError(err instanceof Error ? err.message : "Couldn't refresh conversations.");
    }
  }

  useEffect(() => {
    if (!messagingConfigured) return;
    let cancelled = false;

    setLoadingThreads(true);
    // Instant paint from the server's Redis snapshot, then a fully-live
    // ?fresh=1 pass right behind it that replaces the list once it resolves
    // (2026-08-19, Seni: "the inbox under messaging took 20 seconds to
    // load") — same double-load pattern as ManagementBoard/CommissionsBoard.
    fetchThreads().then(() => {
      if (!cancelled) setLoadingThreads(false);
    });
    fetchThreads(true).catch(() => {});

    // Periodic live re-poll keeps the list current while the tab stays open.
    const REFRESH_INTERVAL_MS = 120_000;
    const interval = setInterval(() => {
      fetchThreads(true).catch(() => {});
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagingConfigured, limit]);

  // True once every guest message that has text also has a translations[]
  // entry — presence in that dict means translateThreadMessages() actually
  // attempted it (even a message that's already English gets an entry, just
  // with isEnglish: true), so this is the real signal that nothing was left
  // behind untranslated. Used to decide whether the retry ladder below
  // should keep going or can stop.
  function allGuestMessagesTranslated(messages: ThreadMessage[], translations: Record<number, MessageTranslation>) {
    return messages.every((m) => !m.isGuest || !m.body.trim() || Boolean(translations[m.id]));
  }

  async function openThread(threadId: number) {
    setSelectedThreadId(threadId);
    setDetail(null);
    setLoadingDetail(true);
    activeThreadIdRef.current = threadId;
    // Fast path first — real message history plus whatever's already
    // cached, with no live translation or AI drafting, so the conversation
    // itself appears instantly instead of waiting on Claude calls.
    const res = await fetch(`/api/messages/thread/${threadId}`);
    const data = (await res.json()) as ThreadDetail;
    setDetail({ ...data, translationStatus: "pending" });
    setLoadingDetail(false);

    // Slower work — translating anything not yet cached, generating a fresh
    // AI suggestion if needed, and (2026-08-08 speed fix) a fully live
    // re-fetch of the messages themselves — runs in the background and fills
    // in once it resolves, rather than blocking the conversation from
    // showing. The fast path above now reads messages from a 120s cache (see
    // that route's header comment for why), so this is what corrects any
    // staleness back to fully live a moment later.
    //
    // RETRY LADDER (2026-08-21, Seni's ask — see the header comment at the
    // top of this file for the full story). A single enrich call is no
    // longer trusted as the last word: if it errors, or it comes back but
    // some guest message still has no translation entry (e.g. OwnerRez's
    // live message fetch inside that route hit its rate limit and fell back
    // to a slightly-behind cached copy that's missing the newest message),
    // this automatically tries again a few times with backoff before giving
    // up and surfacing a visible "failed" state with a manual retry button —
    // never silently leaving a guest's message stuck in its original
    // language with no indication anything's wrong.
    runEnrich(threadId, 0);

    // Refresh list after opening a conversation (in case list is out of date).
    // Since route returns cached data only, refresh is just a safety poll.
    if (messagingConfigured) {
      fetchThreads().catch(() => {});
    }
  }

  function runEnrich(threadId: number, attempt: number) {
    fetch(`/api/messages/thread/${threadId}/enrich`)
      .then((r) => r.json())
      .then(
        (enriched: {
          threadId: number;
          guestLanguage: string | null;
          translations: Record<number, MessageTranslation>;
          pendingDraft: PendingDraft | null;
          messages?: ThreadMessage[];
          error?: string;
        }) => {
          if (enriched.threadId !== threadId || activeThreadIdRef.current !== threadId) return; // stale/abandoned

          let mergedMessages: ThreadMessage[] = [];
          let mergedTranslations: Record<number, MessageTranslation> = {};
          setDetail((prev) => {
            if (!prev || prev.threadId !== threadId) return prev;
            mergedMessages = enriched.messages ?? prev.messages;
            mergedTranslations = { ...prev.translations, ...enriched.translations };
            return {
              ...prev,
              guestLanguage: enriched.guestLanguage ?? prev.guestLanguage,
              translations: mergedTranslations,
              pendingDraft: enriched.pendingDraft ?? prev.pendingDraft,
              messages: mergedMessages,
              translationStatus: prev.translationStatus,
            };
          });

          const complete =
            !enriched.error && mergedMessages.length > 0 && allGuestMessagesTranslated(mergedMessages, mergedTranslations);

          if (complete) {
            setDetail((prev) => (prev && prev.threadId === threadId ? { ...prev, translationStatus: "done" } : prev));
            return;
          }

          if (attempt < TRANSLATE_RETRY_DELAYS_MS.length) {
            setTimeout(() => {
              if (activeThreadIdRef.current === threadId) runEnrich(threadId, attempt + 1);
            }, TRANSLATE_RETRY_DELAYS_MS[attempt]);
          } else {
            setDetail((prev) => (prev && prev.threadId === threadId ? { ...prev, translationStatus: "failed" } : prev));
          }
        }
      )
      .catch(() => {
        if (activeThreadIdRef.current !== threadId) return;
        if (attempt < TRANSLATE_RETRY_DELAYS_MS.length) {
          setTimeout(() => {
            if (activeThreadIdRef.current === threadId) runEnrich(threadId, attempt + 1);
          }, TRANSLATE_RETRY_DELAYS_MS[attempt]);
        } else {
          setDetail((prev) => (prev && prev.threadId === threadId ? { ...prev, translationStatus: "failed" } : prev));
        }
      });
  }

  function refreshAfterReply() {
    if (selectedThreadId) openThread(selectedThreadId);
  }

  if (!messagingConfigured) {
    return (
      <p className="text-sm text-black/50 dark:text-white/50 py-8 text-center">
        OwnerRez messaging isn&rsquo;t connected yet — ask Claude to finish the one-time setup (see README) to see
        real conversation threads here.
      </p>
    );
  }

  // Distinguish "genuinely zero conversations" from "we don't actually know
  // yet because the fetch failed" — the latter used to render identically
  // to the former (see fetchThreads above), which is exactly what made this
  // bug look like conversations had vanished.
  if (!loadingThreads && threads === null && inboxError) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400 py-8 text-center">
        Couldn&rsquo;t load conversations ({inboxError}). This is usually a transient OwnerRez API hiccup — try
        reopening the tab in a moment.
      </p>
    );
  }

  const filtered = (threads ?? []).filter((t) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (t.guestName || "").toLowerCase().includes(q) || t.source.toLowerCase().includes(q);
  });

  // Mobile fix (2026-08-08, Seni's ask): below the md breakpoint this grid
  // used to stack into a single column, so the conversation list and the
  // open thread (messages + reply box) both rendered in the same narrow
  // column at once — you had to scroll past the whole list to find the
  // reply box, and the fixed h-[70vh] height was shared between both
  // instead of going to whichever one you actually needed. Now on mobile
  // only, picking a conversation hides the list and shows just that thread
  // full-height with a "Back" button (the standard mail-app pattern);
  // desktop (md+) keeps the original side-by-side layout unchanged.
  const showListOnMobile = selectedThreadId === null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-4 h-[calc(100dvh-260px)] md:h-[70vh]">
      <div className={`flex-col min-h-0 ${showListOnMobile ? "flex" : "hidden"} md:flex`}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search guest or channel…"
          className="w-full text-sm rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2.5 py-1.5 mb-2 outline-none focus:border-black/30 dark:focus:border-white/30"
        />
        {/* A background refresh failed but we already have a good list from
            before — say so without touching the list itself (the whole
            point of this fix is to never let a failed refresh look like
            the conversations vanished). */}
        {inboxError && threads !== null && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400 mb-1.5 px-0.5">
            Last refresh failed ({inboxError}) — showing the last loaded list.
          </p>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-md border border-black/10 dark:border-white/10 divide-y divide-black/5 dark:divide-white/10">
          {loadingThreads && <p className="text-xs text-black/40 dark:text-white/40 p-3">Loading conversations…</p>}
          {!loadingThreads && filtered.length === 0 && (
            <p className="text-xs text-black/40 dark:text-white/40 p-3">No conversations found.</p>
          )}
          {filtered.map((t) => (
            <button
              key={t.threadId}
              onClick={() => openThread(t.threadId)}
              className={`w-full text-left px-3 py-2.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 ${
                selectedThreadId === t.threadId ? "bg-black/5 dark:bg-white/10" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{t.guestName || "Guest"}</span>
                <span className="text-black/40 dark:text-white/40 shrink-0">{formatRelativeTime(t.lastMessageAt)}</span>
              </div>
              <div className="text-black/50 dark:text-white/50 truncate mt-0.5">{t.lastMessagePreview || "—"}</div>
              <div className="flex items-center gap-1.5 mt-1 text-[11px] text-black/40 dark:text-white/40">
                {t.awaitingReply && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="Awaiting reply" />}
                <span className="truncate">
                  {t.source} · {formatDate(t.arrival)} → {formatDate(t.departure)}
                </span>
              </div>
            </button>
          ))}
          {hasMore && (
            <button
              onClick={() => setLimit((l) => l + 20)}
              className="w-full text-center px-3 py-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-black/5 dark:hover:bg-white/10"
            >
              Load more conversations
            </button>
          )}
        </div>
      </div>

      <div
        className={`min-h-0 flex-col rounded-md border border-black/10 dark:border-white/10 ${
          showListOnMobile ? "hidden" : "flex"
        } md:flex`}
      >
        {!selectedThreadId ? (
          <p className="text-sm text-black/50 dark:text-white/50 py-8 text-center m-auto">
            Pick a conversation on the left.
          </p>
        ) : loadingDetail || !detail ? (
          <p className="text-sm text-black/50 dark:text-white/50 py-8 text-center m-auto">Loading conversation…</p>
        ) : (
          <ThreadDetailView
            detail={detail}
            onReplied={refreshAfterReply}
            onBack={() => setSelectedThreadId(null)}
            onRetryTranslation={() => openThread(detail.threadId)}
          />
        )}
      </div>
    </div>
  );
}

function ThreadDetailView({
  detail,
  onReplied,
  onBack,
  onRetryTranslation,
}: {
  detail: ThreadDetail;
  onReplied: () => void;
  onBack: () => void;
  onRetryTranslation: () => void;
}) {
  const { booking, guestName, guestLanguage, messages, translations, pendingDraft, translationStatus } = detail;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-4 py-3 border-b border-black/10 dark:border-white/10">
        {/* Mobile-only back button — on desktop the list stays visible
            alongside this panel, so there's nothing to "go back" to. */}
        <button
          onClick={onBack}
          className="md:hidden -ml-1 mb-1.5 flex items-center gap-1 text-xs text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white"
        >
          ← All conversations
        </button>
        <div className="text-sm font-medium">{guestName}</div>
        <div className="text-xs text-black/50 dark:text-white/50">
          {booking ? `${formatDate(booking.arrival)} → ${formatDate(booking.departure)} · ${booking.source}` : ""}
        </div>
      </div>

      {/* Failed-state banner (2026-08-21) — the retry ladder in openThread()
          gave up after a few attempts. Rather than silently leaving whatever
          language each message happens to show, say so plainly and let Seni
          retry by hand. */}
      {translationStatus === "failed" && (
        <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 flex items-center justify-between gap-2">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Couldn&rsquo;t confirm every message is translated (likely an OwnerRez hiccup) — some text below may still
            be in the guest&rsquo;s original language.
          </p>
          <button
            onClick={onRetryTranslation}
            className="shrink-0 text-xs font-medium text-amber-700 dark:text-amber-400 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-black/40 dark:text-white/40 text-center py-6">No messages in this thread yet.</p>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            translation={translations[m.id]}
            translating={translationStatus === "pending" && m.isGuest && Boolean(m.body.trim()) && !translations[m.id]}
          />
        ))}
      </div>

      <div className="border-t border-black/10 dark:border-white/10 p-3 space-y-3">
        {pendingDraft && pendingDraft.status === "pending" && (
          <AiSuggestionCard
            key={pendingDraft.id}
            draft={pendingDraft}
            booking={booking}
            guestName={guestName}
            onReplied={onReplied}
          />
        )}
        <ComposeBox
          threadId={detail.threadId}
          booking={booking}
          guestName={guestName}
          guestLanguage={guestLanguage}
          onReplied={onReplied}
        />
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  translation,
  translating,
}: {
  message: ThreadMessage;
  translation?: MessageTranslation;
  // True while this guest message has no translations[] entry yet and the
  // retry ladder in openThread() is still working on it (2026-08-21) — shown
  // instead of silently displaying the original-language text as if
  // translation were done or simply not needed.
  translating?: boolean;
}) {
  const isGuest = message.isGuest;
  const showsTranslation = translation && !translation.isEnglish && translation.english;

  return (
    <div className={`flex ${isGuest ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
          isGuest
            ? "bg-black/5 dark:bg-white/10"
            : "bg-blue-600/10 dark:bg-blue-400/15 border border-blue-600/15 dark:border-blue-400/20"
        }`}
      >
        <div className="whitespace-pre-wrap">{showsTranslation ? translation.english : message.body}</div>
        {showsTranslation && (
          <div className="mt-1.5 pt-1.5 border-t border-black/10 dark:border-white/10 text-[11px] text-black/40 dark:text-white/40 whitespace-pre-wrap">
            Original ({translation.language}): {message.body}
          </div>
        )}
        {translating && (
          <div className="mt-1.5 pt-1.5 border-t border-black/10 dark:border-white/10 text-[11px] text-black/40 dark:text-white/40 italic">
            Translating…
          </div>
        )}
        <div className="mt-1 text-[10px] text-black/35 dark:text-white/35">
          {isGuest ? "Guest" : "Host"} · {formatRelativeTime(message.sentAt)}
        </div>
      </div>
    </div>
  );
}

function AiSuggestionCard({
  draft,
  booking,
  guestName,
  onReplied,
}: {
  draft: PendingDraft;
  booking: ThreadDetail["booking"];
  guestName: string;
  onReplied: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(draft.replyEnglish ?? draft.draftReply);
  const [busy, setBusy] = useState<"approve" | "edit" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const language = draft.language && draft.language !== "English" ? draft.language : null;

  async function act(action: "approve" | "edit" | "discard") {
    if (!booking) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/messages/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: draft.threadId,
          bookingId: booking.id,
          guestId: booking.guestId,
          guestName,
          draftId: draft.id,
          action,
          body: action === "approve" ? draft.draftReply : action === "edit" ? editText : undefined,
          targetLanguage: action === "edit" ? draft.language : undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed.");
      onReplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10 p-3 space-y-2">
      <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
        AI suggested reply{language ? ` — will send in ${language}` : ""}
      </div>
      {draft.isServiceRequest && (
        <div className="text-xs rounded-md bg-amber-100 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2 py-1">
          🛎️ Service request{draft.guestPhone ? ` — WhatsApp: ${draft.guestPhone}` : " — no phone on file"}. Approving
          will notify Gabriel to set up a group with the guest.
        </div>
      )}
      {!editing ? (
        <div className="space-y-1.5">
          <p className="text-sm whitespace-pre-wrap">{draft.replyEnglish ?? draft.draftReply}</p>
          {/* Shown for Seni's own reference only, since he doesn't read the
              guest's language — approve always sends draft.draftReply (the
              native-language text) regardless of what's displayed here. */}
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

function ComposeBox({
  threadId,
  booking,
  guestName,
  guestLanguage,
  onReplied,
}: {
  threadId: number;
  booking: ThreadDetail["booking"];
  guestName: string;
  guestLanguage: string | null;
  onReplied: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!booking || !body.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/messages/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          bookingId: booking.id,
          guestId: booking.guestId,
          guestName,
          action: "edit",
          body,
          targetLanguage: guestLanguage,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to send.");
      setBody("");
      onReplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        placeholder="Write your own reply…"
        className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
      />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={send}
          disabled={sending || !body.trim()}
          className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send"}
        </button>
        {guestLanguage && (
          <span className="text-[11px] text-black/40 dark:text-white/40">
            Write in English — auto-translated to {guestLanguage} before sending.
          </span>
        )}
      </div>
    </div>
  );
}
