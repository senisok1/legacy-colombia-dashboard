import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

// Was only clearing the legacy shared-password cookie — once Phase 2 added
// the per-user session cookie (lc_user_session), "Log out" stopped actually
// logging per-user sessions out: the redirect to /login looked like it
// worked, but the session cookie stayed valid, so the next request was still
// authenticated as that user/org. Found via the Phase 3 smoke test: a stale
// lc_user_session from an earlier deleted signup-flow test org kept getting
// used for every write, causing foreign-key violations on every save.
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("lc_dashboard_auth", "", { path: "/", maxAge: 0 });
  res.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
