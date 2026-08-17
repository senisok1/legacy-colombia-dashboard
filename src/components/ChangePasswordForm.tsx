"use client";

import { useState } from "react";

// Settings → My Account (2026-08-17). Anyone with a personal login — admin
// or team member — can change their own password here. The server verifies
// the current password and only ever touches the caller's own row (see
// api/settings/password).
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/settings/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-black/50 dark:text-white/50">
        Pick something only you know — at least 8 characters. You&apos;ll use the new password the next time
        you sign in.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-black/60 dark:text-white/60">
          Current password
          <input
            type="password"
            required
            autoComplete="current-password"
            className="mt-0.5 block w-48 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="text-xs text-black/60 dark:text-white/60">
          New password
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="mt-0.5 block w-48 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label className="text-xs text-black/60 dark:text-white/60">
          Repeat new password
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="mt-0.5 block w-48 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save new password"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {done && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          Password changed. Use the new one next time you sign in.
        </p>
      )}
    </form>
  );
}
