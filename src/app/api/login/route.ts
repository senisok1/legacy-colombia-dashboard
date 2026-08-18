import { NextRequest, NextResponse } from "next/server";
import { isPerUserLoginConfigured } from "@/lib/config";
import { getUserByEmail, verifyPassword, touchLastLogin } from "@/lib/users";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/session";
import { checkRateLimit, getClientIp } from "@/lib/publicApiGuard";

// Per-user login only. The legacy password-only path (a single shared
// DASHBOARD_PASSWORD, no email, granting a "lc_dashboard_auth" cookie with
// no organizationId attached) was retired 2026-08-10 — it was still the
// LoginForm's default mode, and a browser that logged in that way got past
// proxy.ts into every page but with no org on the session at all. Pages with
// a defensive default-org fallback rendered stale/wrong data; the Messaging
// API routes have no such fallback and correctly-but-confusingly returned
// nothing ("no conversations found"). This is exactly what happened on
// Seni's phone — see proxy.ts's header comment and api/debug/whoami.
export async function POST(req: NextRequest) {
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };

  if (!isPerUserLoginConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Login isn't set up yet." },
      { status: 400 }
    );
  }
  if (!email || !email.trim()) {
    return NextResponse.json({ ok: false, error: "Enter your email and password." }, { status: 400 });
  }

  // Brute-force throttle (2026-08-17 audit): this route was previously
  // unthrottled, so an attacker could grind unlimited email/password guesses
  // against it (each guess runs a real bcrypt compare). Cap attempts per-IP
  // AND per-email at 10 per 15 minutes using the same Redis fixed-window
  // limiter the public chat widget already uses. Both keys are checked so one
  // attacker IP can't spray many accounts, and one target account can't be
  // ground down from many IPs. checkRateLimit FAILS OPEN (returns true) when
  // Redis is unconfigured or hiccups — deliberately, so a Redis outage can
  // never lock the real owner out of his own dashboard. A 429 here is generic
  // and reveals nothing about whether the email exists (same reasoning as the
  // shared 401 below).
  const ip = getClientIp(req);
  const emailKey = email.trim().toLowerCase();
  const RL_MAX = 10;
  const RL_WINDOW = 15 * 60; // 15 minutes
  const [ipOk, emailOk] = await Promise.all([
    checkRateLimit(ip, "login-ip", RL_MAX, RL_WINDOW),
    checkRateLimit(emailKey, "login-email", RL_MAX, RL_WINDOW),
  ]);
  if (!ipOk || !emailOk) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429 }
    );
  }

  const user = await getUserByEmail(email.trim());
  if (!user || !user.active || !password || !(await verifyPassword(user, password))) {
    return NextResponse.json({ ok: false, error: "Incorrect email or password." }, { status: 401 });
  }
  const token = createSessionToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    // 2026-08-17 audit: stamp the current session epoch into the token so the
    // proxy can revoke it later (see lib/session.ts + lib/users.ts).
    epoch: user.sessionEpoch,
  });
  await touchLastLogin(user.id).catch(() => {}); // best-effort, never blocks login
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
