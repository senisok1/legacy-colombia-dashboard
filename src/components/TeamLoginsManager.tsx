"use client";

import { useCallback, useEffect, useState } from "react";

// Settings → "Team logins" (2026-08-16): CEO-only self-serve management of
// the org's logins. Admin (CEO) logins get full access; Team member
// (READ_ONLY) logins can view every tab but only write Management
// notes/activities (enforced in src/proxy.ts). Renders nothing for
// non-admin viewers (the API refuses them anyway).

type ManagedUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  active: boolean;
  isYou: boolean;
};

export function TeamLoginsManager() {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "READ_ONLY" });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/users");
      if (res.status === 401 || res.status === 403) {
        setHidden(true); // not an admin — this section isn't for them
        return;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setUsers(json.users as ManagedUser[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logins.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) return null;

  async function createLogin(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice(
        json.reset
          ? `Updated ${json.user.email} — new password is set.`
          : `Created ${json.user.email}. Share the email + password with them.`
      );
      setForm({ name: "", email: "", password: "", role: "READ_ONLY" });
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save login.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u: ManagedUser) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: u.id, active: !u.active }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update login.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(u: ManagedUser) {
    if (busy) return;
    if (!window.confirm(`Permanently delete the login for ${u.name || u.email}? This can't be undone.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: u.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice(`Deleted ${json.deleted}.`);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete login.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-black/70 dark:text-white/70">Team logins</h2>
        <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
          Create logins for your team. <strong>Admin</strong> logins can do everything.{" "}
          <strong>Team member</strong> logins can view every tab but only add notes and activities on the
          Management tab — they can&apos;t message guests or change anything. Submitting an existing email
          resets that person&apos;s password.
        </p>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}

      {users && users.length > 0 && (
        <div className="rounded-lg border border-black/10 dark:border-white/10 divide-y divide-black/5 dark:divide-white/5">
          {users.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="font-medium">{u.name || u.email}</span>
              {u.name && <span className="text-black/50 dark:text-white/50">{u.email}</span>}
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  u.role === "CEO"
                    ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                    : "bg-black/10 dark:bg-white/10 text-black/60 dark:text-white/60"
                }`}
              >
                {u.role === "CEO" ? "Admin" : "Team member"}
              </span>
              {u.isYou && <span className="text-xs text-black/40 dark:text-white/40">(you)</span>}
              {!u.active && <span className="text-xs text-red-500">deactivated</span>}
              {!u.isYou && (
                <span className="ml-auto flex gap-1.5">
                  <button
                    onClick={() => void toggleActive(u)}
                    disabled={busy}
                    className="rounded-md border border-black/15 dark:border-white/15 px-2 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                  >
                    {u.active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button
                    onClick={() => void remove(u)}
                    disabled={busy}
                    className="rounded-md border border-red-500/40 px-2 py-0.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={createLogin} className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-black/60 dark:text-white/60">
          Name
          <input
            className="mt-0.5 block w-36 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Gabriel"
          />
        </label>
        <label className="text-xs text-black/60 dark:text-white/60">
          Email
          <input
            type="email"
            required
            className="mt-0.5 block w-52 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="pm@legacycolombia.com"
          />
        </label>
        <label className="text-xs text-black/60 dark:text-white/60">
          Password (8+ chars)
          <input
            type="text"
            required
            minLength={8}
            className="mt-0.5 block w-40 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          />
        </label>
        <label className="text-xs text-black/60 dark:text-white/60">
          Access
          <select
            className="mt-0.5 block rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
          >
            <option value="READ_ONLY">Team member (view only)</option>
            <option value="CEO">Admin (full access)</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {busy ? "Saving…" : "Create login"}
        </button>
      </form>
    </div>
  );
}
