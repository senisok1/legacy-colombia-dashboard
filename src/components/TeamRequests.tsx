"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Team Requests (2026-08-18, Seni's ask: "add an activity under the Team
// Activity Log tab like 'tour guide requested on August 25th, please accept
// or deny' — tag someone from the team to accept or deny it, notified by
// email/WhatsApp"). Sits above TeamActivityLog's free-text feed on the same
// /team-log tab. A decision here also gets written into that feed (see
// api/team-requests/route.ts) so the running log stays the single place to
// scan "what happened" even though this has its own structured lifecycle.

type TeamMember = { email: string; name: string | null; isYou: boolean };

// Threaded back-and-forth on a request (2026-08-18, Seni's ask: "add a
// notes section where each team member can put in their notes back and
// forth... make sure each note is time stamped identifying the team member
// that enters it"). See api/team-requests/notes/route.ts.
type TeamRequestNoteEntry = {
  id: string;
  requestId: string;
  authorEmail: string;
  authorName: string | null;
  body: string;
  bodyOriginal: string | null;
  authorLanguage: string | null;
  createdAt: string;
};

type TeamRequestEntry = {
  id: string;
  title: string;
  description: string | null;
  descriptionOriginal: string | null;
  authorLanguage: string | null;
  neededBy: string | null;
  requestedByEmail: string;
  requestedByName: string | null;
  requestedAt: string;
  taggedEmail: string;
  taggedName: string | null;
  accepted: boolean;
  declined: boolean;
  decidedByName: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  completed: boolean;
  completedByName: string | null;
  completedAt: string | null;
  notes: TeamRequestNoteEntry[];
};

function textFor(descriptionOriginal: string | null, authorLanguage: string | null, description: string | null, viewerLanguage?: string): string | null {
  const viewer = (viewerLanguage || "English").toLowerCase();
  if (
    viewer !== "english" &&
    authorLanguage &&
    authorLanguage.toLowerCase() === viewer &&
    descriptionOriginal
  ) {
    return descriptionOriginal;
  }
  return description;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusBadge(r: TeamRequestEntry): { label: string; className: string } {
  if (r.completed) return { label: "Completed", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" };
  if (r.declined) return { label: "Declined", className: "bg-red-500/15 text-red-600 dark:text-red-400" };
  if (r.accepted) return { label: "Accepted", className: "bg-[var(--accent)]/15 text-[var(--accent)]" };
  return { label: "Awaiting decision", className: "bg-black/10 dark:bg-white/10 text-black/60 dark:text-white/60" };
}

export function TeamRequests() {
  const [entries, setEntries] = useState<TeamRequestEntry[] | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [viewerEmail, setViewerEmail] = useState("");
  const [viewerIsCeo, setViewerIsCeo] = useState(false);
  const [viewerLanguage, setViewerLanguage] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", neededBy: "", taggedEmail: "" });
  const [creating, setCreating] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [postingNoteId, setPostingNoteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: "", description: "", neededBy: "", taggedEmail: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/team-requests");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEntries(json.requests ?? []);
      setTeamMembers(json.teamMembers ?? []);
      setViewerEmail(json.viewerEmail ?? "");
      setViewerIsCeo(Boolean(json.viewerIsCeo));
      setViewerLanguage(json.viewerLanguage);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : "Failed to load requests.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.taggedEmail || creating) return;
    setCreating(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/team-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const taggedLabel =
        teamMembers.find((m) => m.email === form.taggedEmail)?.name || form.taggedEmail;
      const n = json.notify as { whatsappSent?: boolean; emailSent?: boolean } | undefined;
      const reached = n?.whatsappSent || n?.emailSent;
      setNotice(
        reached
          ? `Sent to ${taggedLabel} — awaiting their decision.`
          : `Saved, but couldn't reach ${taggedLabel} by WhatsApp or email — let them know directly.`
      );
      setForm({ title: "", description: "", neededBy: "", taggedEmail: "" });
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the request.");
    } finally {
      setCreating(false);
    }
  }

  async function decide(id: string, accepted: boolean) {
    if (busyId) return;
    let declineReason: string | undefined;
    if (!accepted) {
      declineReason = window.prompt("Reason (optional):") || undefined;
    }
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/team-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, accepted, declined: !accepted, declineReason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice(accepted ? "Accepted." : "Declined.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save your decision.");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleCompleted(id: string, completed: boolean) {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/team-requests", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, completed }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update.");
    } finally {
      setBusyId(null);
    }
  }

  async function addNote(requestId: string) {
    const body = (noteDrafts[requestId] ?? "").trim();
    if (!body || postingNoteId) return;
    setPostingNoteId(requestId);
    setError(null);
    try {
      const res = await fetch("/api/team-requests/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNoteDrafts((d) => ({ ...d, [requestId]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post the note.");
    } finally {
      setPostingNoteId(null);
    }
  }

  function startEdit(r: TeamRequestEntry) {
    setEditingId(r.id);
    setEditForm({
      title: r.title,
      description: textFor(r.descriptionOriginal, r.authorLanguage, r.description, viewerLanguage) ?? "",
      neededBy: r.neededBy ?? "",
      taggedEmail: r.taggedEmail,
    });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id: string) {
    if (!editForm.title.trim() || !editForm.taggedEmail || savingEdit) return;
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch("/api/team-requests/edit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...editForm }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save your edits.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function remove(id: string) {
    if (busyId || !window.confirm("Remove this request?")) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/team-requests", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Requests needing accept or deny</h2>
          <p className="text-xs text-black/50 dark:text-white/50">
            Tag a teammate to approve something — they&apos;re notified on WhatsApp and email.
          </p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="rounded-md bg-black/80 dark:bg-white/80 px-3 py-1.5 text-sm text-white dark:text-black"
        >
          {showForm ? "Cancel" : "New request"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}

      {showForm && (
        <form onSubmit={submit} className="space-y-2 rounded-lg border border-black/10 dark:border-white/10 p-3">
          <input
            className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            placeholder='What do you need? (e.g. "Tour guide for Aug 25 group")'
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            required
          />
          <textarea
            className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            placeholder="Any details they should know (optional)"
            rows={2}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <div className="flex flex-wrap gap-2">
            <label className="text-xs text-black/60 dark:text-white/60">
              Needed by
              <input
                type="date"
                className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.neededBy}
                onChange={(e) => setForm((f) => ({ ...f, neededBy: e.target.value }))}
              />
            </label>
            <label className="text-xs text-black/60 dark:text-white/60">
              Tag someone to decide
              <select
                required
                className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={form.taggedEmail}
                onChange={(e) => setForm((f) => ({ ...f, taggedEmail: e.target.value }))}
              >
                <option value="">Choose…</option>
                {teamMembers.map((m) => (
                  <option key={m.email} value={m.email}>
                    {m.name || m.email}
                    {m.isYou ? " (you)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={creating || !form.title.trim() || !form.taggedEmail}
              className="ml-auto self-end rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {creating ? "Sending…" : "Send request"}
            </button>
          </div>
        </form>
      )}

      {!entries ? (
        <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-black/50 dark:text-white/50">No requests yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((r) => {
            const badge = statusBadge(r);
            // Only the tagged person may decide (2026-08-18, Seni: "whoever
            // is tagged in that request should be the only one who can
            // accept or deny that request") — no CEO override.
            const canDecide = !r.accepted && !r.declined && r.taggedEmail.toLowerCase() === viewerEmail.toLowerCase();
            const canComplete = r.accepted && !r.completed;
            // Admin/Owner only (2026-08-18, Seni's explicit ask) — the
            // requester can no longer remove their own; they can edit it
            // instead.
            const canRemove = viewerIsCeo;
            // Only the original requester may edit (2026-08-18, Seni: "only
            // that person should be able to edit that request") — no CEO
            // override — and only before a decision's been made, matching
            // the API route's own gate.
            const canEdit =
              r.requestedByEmail.toLowerCase() === viewerEmail.toLowerCase() && !r.accepted && !r.declined;
            const body = textFor(r.descriptionOriginal, r.authorLanguage, r.description, viewerLanguage);
            const isEditing = editingId === r.id;
            return (
              <li key={r.id} className="rounded-lg border border-black/10 dark:border-white/10 p-3 text-sm space-y-1.5">
                {isEditing ? (
                  <div className="space-y-2 rounded-lg border border-black/10 dark:border-white/10 p-2">
                    <input
                      className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                      placeholder="What do you need?"
                      value={editForm.title}
                      onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                    />
                    <textarea
                      className="w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                      placeholder="Any details they should know (optional)"
                      rows={2}
                      value={editForm.description}
                      onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                    />
                    <div className="flex flex-wrap gap-2">
                      <label className="text-xs text-black/60 dark:text-white/60">
                        Needed by
                        <input
                          type="date"
                          className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                          value={editForm.neededBy}
                          onChange={(e) => setEditForm((f) => ({ ...f, neededBy: e.target.value }))}
                        />
                      </label>
                      <label className="text-xs text-black/60 dark:text-white/60">
                        Tag someone to decide
                        <select
                          className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                          value={editForm.taggedEmail}
                          onChange={(e) => setEditForm((f) => ({ ...f, taggedEmail: e.target.value }))}
                        >
                          {teamMembers.map((m) => (
                            <option key={m.email} value={m.email}>
                              {m.name || m.email}
                              {m.isYou ? " (you)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="ml-auto flex items-end gap-1.5">
                        <button
                          onClick={() => cancelEdit()}
                          disabled={savingEdit}
                          className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1.5 text-xs disabled:opacity-40"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void saveEdit(r.id)}
                          disabled={savingEdit || !editForm.title.trim() || !editForm.taggedEmail}
                          className="rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-xs text-white disabled:opacity-40"
                        >
                          {savingEdit ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.title}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                      {r.neededBy && (
                        <span className="text-xs text-black/50 dark:text-white/50">needed by {fmtDate(r.neededBy)}</span>
                      )}
                    </div>
                    {body && <p className="text-black/70 dark:text-white/70">{body}</p>}
                    <p className="text-xs text-black/40 dark:text-white/40">
                      {r.requestedByName || r.requestedByEmail} tagged {r.taggedName || r.taggedEmail} —{" "}
                      {fmtWhen(r.requestedAt)}
                      {r.decidedAt && (
                        <>
                          {" · "}
                          {r.accepted ? "accepted" : "declined"} by {r.decidedByName || r.taggedName || r.taggedEmail},{" "}
                          {fmtWhen(r.decidedAt)}
                          {r.declineReason ? ` — ${r.declineReason}` : ""}
                        </>
                      )}
                      {r.completedAt && (
                        <>
                          {" · "}completed by {r.completedByName}, {fmtWhen(r.completedAt)}
                        </>
                      )}
                    </p>
                  </>
                )}
                {!isEditing && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {canDecide && (
                    <>
                      <button
                        onClick={() => void decide(r.id, true)}
                        disabled={busyId === r.id}
                        className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs text-white disabled:opacity-40"
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => void decide(r.id, false)}
                        disabled={busyId === r.id}
                        className="rounded-md border border-red-500/40 px-2.5 py-1 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                      >
                        Deny
                      </button>
                    </>
                  )}
                  {canComplete && (
                    <button
                      onClick={() => void toggleCompleted(r.id, true)}
                      disabled={busyId === r.id}
                      className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                    >
                      Mark completed
                    </button>
                  )}
                  {r.completed && (
                    <button
                      onClick={() => void toggleCompleted(r.id, false)}
                      disabled={busyId === r.id}
                      className="rounded-md border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                    >
                      Undo completed
                    </button>
                  )}
                  {(canEdit || canRemove) && (
                    <div className="ml-auto flex gap-1.5">
                      {/* Edit — original requester only, no CEO override
                          (2026-08-18, Seni's explicit ask). */}
                      {canEdit && (
                        <button
                          onClick={() => startEdit(r)}
                          disabled={busyId === r.id}
                          className="rounded-md px-2.5 py-1 text-xs text-black/40 hover:text-[var(--accent)] dark:text-white/40 disabled:opacity-40"
                        >
                          Edit
                        </button>
                      )}
                      {canRemove && (
                        <button
                          onClick={() => void remove(r.id)}
                          disabled={busyId === r.id}
                          className="rounded-md px-2.5 py-1 text-xs text-black/40 hover:text-red-500 dark:text-white/40 disabled:opacity-40"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </div>
                )}

                {/* Notes back-and-forth (2026-08-18, Seni's ask): open to any
                    team member, not just the requester/tagged person —
                    each note timestamped and attributed below. */}
                <div className="mt-1.5 space-y-1.5 border-t border-black/10 pt-1.5 dark:border-white/10">
                  {r.notes.length > 0 && (
                    <ul className="space-y-1.5">
                      {r.notes.map((n) => (
                        <li key={n.id} className="rounded-md bg-black/[0.03] px-2 py-1.5 text-xs dark:bg-white/[0.04]">
                          <p className="text-black/80 dark:text-white/80">
                            {textFor(n.bodyOriginal, n.authorLanguage, n.body, viewerLanguage)}
                          </p>
                          <p className="mt-0.5 text-black/40 dark:text-white/40">
                            {n.authorName || n.authorEmail} — {fmtWhen(n.createdAt)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void addNote(r.id);
                    }}
                    className="flex gap-1.5"
                  >
                    <input
                      className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-xs dark:border-white/15"
                      placeholder="Add a note…"
                      value={noteDrafts[r.id] ?? ""}
                      onChange={(e) => setNoteDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    />
                    <button
                      type="submit"
                      disabled={postingNoteId === r.id || !(noteDrafts[r.id] ?? "").trim()}
                      className="rounded-md bg-black/80 px-2.5 py-1 text-xs text-white disabled:opacity-40 dark:bg-white/80 dark:text-black"
                    >
                      {postingNoteId === r.id ? "Posting…" : "Post"}
                    </button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
