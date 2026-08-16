import { NextRequest, NextResponse } from "next/server";
import { upsertUser } from "@/lib/users";
import { config, isDbConfigured } from "@/lib/config";

// Reusable alternative to api/admin/seed-user (which permanently locks
// itself once ANY user exists) and to Create My Login.command (which runs
// locally and can NEVER work — DATABASE_URL is a Vercel "Sensitive" env
// var, unreadable outside a live Vercel function, so the local script's
// `node scripts/seed-user.mjs` always fails with a DNS-lookup-style error
// against whatever placeholder ended up in .env.local). Found 2026-08-05
// when Seni ran that .command and it printed "Done!" despite a real
// "Failed: getaddrinfo ENOTFOUND base" error right above it — the script
// doesn't check the child process's exit code before declaring success.
//
// Protected by ADMIN_SECRET, same trust boundary as api/admin/migrate.
// Safe to leave deployed indefinitely: upsertUser() is idempotent (creates
// on first call, resets password/name/role on any later call for the same
// email), so this doubles as a "I forgot my password" reset tool too.
//
// GET renders a small self-contained HTML form so a non-technical user can
// do this from a browser instead of constructing a POST by hand — no
// secrets are embedded in the page; the admin secret is typed in by
// whoever is submitting it, same as every other admin-route credential
// handoff in this app.
export async function GET() {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Set up your login — Legacy Colombia Dashboard</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 420px; margin: 60px auto; padding: 0 16px; color: #171717; }
  h1 { font-size: 18px; }
  p { color: #666; font-size: 14px; }
  label { display: block; font-size: 13px; margin: 14px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
  button { margin-top: 20px; width: 100%; padding: 10px; border: none; border-radius: 6px; background: #4f46e5; color: white; font-size: 14px; cursor: pointer; }
  button:disabled { opacity: 0.5; }
  #result { margin-top: 16px; font-size: 14px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>Set up your personal login</h1>
  <p>This creates (or resets) your email + password login for the dashboard. You'll use it on the /login page by clicking "Have a personal login?".</p>
  <form id="f">
    <label>Admin secret</label>
    <input type="password" id="secret" autocomplete="off" required />
    <label>Your email</label>
    <input type="email" id="email" required />
    <label>Choose a password</label>
    <input type="password" id="password" required minlength="8" />
    <label>Your name (optional)</label>
    <input type="text" id="name" />
    <button type="submit">Save login</button>
  </form>
  <div id="result"></div>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      const result = document.getElementById('result');
      result.textContent = 'Saving...';
      try {
        const res = await fetch('/api/admin/set-user-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret: document.getElementById('secret').value,
            email: document.getElementById('email').value,
            password: document.getElementById('password').value,
            name: document.getElementById('name').value,
          }),
        });
        const body = await res.json();
        if (res.ok) {
          result.textContent = 'Done! You can now log in with that email + password on the /login page (click "Have a personal login?").';
        } else {
          result.textContent = 'Error: ' + (body.error || 'unknown error');
        }
      } catch (err) {
        result.textContent = 'Error: ' + (err instanceof Error ? err.message : 'network error');
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html" } });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { secret?: string; email?: string; password?: string; name?: string; role?: string }
    | null;

  if (!body || !config.adminSecret || body.secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }
  if (!body.email?.trim() || !body.password || body.password.length < 8) {
    return NextResponse.json({ error: "Email and an 8+ character password are required." }, { status: 400 });
  }

  // Optional role (2026-08-16, for the READ_ONLY team login) — restricted
  // to the two roles this app actually gates on so a typo can't create an
  // account with an unrecognized role string.
  const role = body.role === "READ_ONLY" ? ("READ_ONLY" as const) : ("CEO" as const);

  try {
    const user = await upsertUser({
      email: body.email.trim(),
      password: body.password,
      name: body.name?.trim() || undefined,
      role,
    });
    return NextResponse.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
