"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

// One-time bootstrap page: creates the first per-user CRM login. Reads a
// `key` query param (the same CRON_SECRET already used elsewhere) so the
// underlying /api/admin/seed-user call is authorized — Seni fills in his
// own email/password here, in his own browser, so it never passes through
// Claude. See api/admin/seed-user/route.ts for why this exists (Vercel
// marks DATABASE_URL "Sensitive", so account creation has to happen inside
// a live deployment, not on anyone's local machine) and why it's safe to
// leave deployed (it silently refuses once any user already exists).
function SetupForm() {
  const params = useSearchParams();
  const secret = params.get("key") ?? "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/admin/seed-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, email, password, name, role: "CEO" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (status === "done") {
    return (
      <div className="mx-auto max-w-sm mt-24 text-center space-y-3">
        <h1 className="text-xl font-semibold">You&apos;re all set ✅</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Your login has been created. You can now sign in at{" "}
          <a href="/login" className="underline">
            /login
          </a>{" "}
          with that email and password.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm mt-24 space-y-4">
      <h1 className="text-xl font-semibold">Create your dashboard login</h1>
      <p className="text-sm text-black/60 dark:text-white/60">
        This only works once — the first time you use it, it creates your personal login. After that it
        refuses to run again, so it&apos;s safe to leave this page here.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">Your name (optional)</label>
          <input
            className="w-full rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Email</label>
          <input
            type="email"
            required
            className="w-full rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-3 py-2 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Choose a password</label>
          <input
            type="password"
            required
            className="w-full rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-3 py-2 text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button
          type="submit"
          disabled={status === "loading"}
          className="w-full rounded-lg bg-black text-white dark:bg-white dark:text-black py-2 text-sm font-medium disabled:opacity-50"
        >
          {status === "loading" ? "Creating..." : "Create login"}
        </button>
        {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      </form>
    </div>
  );
}

export default function AdminSetupPage() {
  return (
    <Suspense fallback={null}>
      <SetupForm />
    </Suspense>
  );
}
