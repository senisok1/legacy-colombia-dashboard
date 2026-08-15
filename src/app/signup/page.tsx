"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

// Phase 2 self-serve signup. Deliberately not linked from any nav or the
// marketing site yet — see api/signup/route.ts's header comment for why
// (Phase 3's per-tenant query scoping isn't done, so a second real org
// would currently see Legacy Estate Rentals' live data). Reachable directly
// at /signup for internal testing only until that's resolved.
export default function SignupPage() {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName, name, email, password }),
    });
    setLoading(false);
    if (res.ok) {
      // New signups land in the guided onboarding wizard, not straight on
      // the dashboard — see app/onboarding/page.tsx.
      router.push("/onboarding");
      router.refresh();
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error || "That didn't work — try again.");
    }
  }

  return (
    <div className="min-h-[calc(100vh-1px)] flex items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-black/10 dark:border-white/10 p-6 bg-white dark:bg-white/5 space-y-4"
      >
        <div>
          <h1 className="text-lg font-semibold">Start your free trial</h1>
          <p className="text-sm text-black/50 dark:text-white/50">14 days, no card required.</p>
        </div>
        <input
          autoFocus
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          placeholder="Company or property name"
          className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (min. 8 characters)"
          className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
        />
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
        >
          {loading ? "Creating your account…" : "Create account"}
        </button>
        <a href="/login" className="block w-full text-xs text-center text-black/40 dark:text-white/40 hover:underline">
          Already have an account? Log in
        </a>
      </form>
    </div>
  );
}
