import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

// Escapes text that gets interpolated into the HTML response below (2026-08-17
// audit). Reflected-XSS fix: `error`/`error_description` (and, defensively,
// the token-exchange response fields and the echoed access token) came
// straight from the query string / an upstream JSON body into the page markup
// unescaped — confirmed live that ?error=<script>alert(1)</script> executed.
// Escaping the five HTML-significant characters neutralizes any tag/attribute
// injection regardless of source.
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATE_COOKIE = "orez_oauth_state";

function htmlPage(title: string, bodyHtml: string, status = 200) {
  return new NextResponse(
    `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #111; }
  textarea { width: 100%; height: 70px; font-family: monospace; font-size: 13px; padding: 10px; box-sizing: border-box; }
  code { background: #f2f2f2; padding: 2px 5px; border-radius: 4px; }
  .error { color: #b00020; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// OwnerRez redirects back here after the account owner approves the
// connection at /api/oauth/start. This route is intentionally reachable
// without the dashboard password (see proxy.ts) since OwnerRez — not a
// logged-in browser session — is the one hitting it, exactly like the login
// endpoints already are. A valid `code` can only come from someone who just
// approved access inside the real OwnerRez account, so this doesn't leak
// anything sensitive.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const errorDescription = req.nextUrl.searchParams.get("error_description");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE)?.value;

  if (error) {
    // NOTE: every interpolated value below is escaped (see escapeHtml) — these
    // come straight from the query string and were the live XSS sink.
    return htmlPage(
      "OwnerRez connection failed",
      `<h2>Connection failed</h2><p class="error">${escapeHtml(error)}${
        errorDescription ? `: ${escapeHtml(errorDescription)}` : ""
      }</p>`,
      400
    );
  }

  if (!code) {
    return htmlPage("OwnerRez connection failed", `<h2>Connection failed</h2><p class="error">No code received.</p>`, 400);
  }

  // CSRF / state verification (2026-08-17 audit). The `state` OwnerRez echoes
  // back must exactly match the one we set in the httpOnly cookie at
  // /api/oauth/start. A missing or mismatched state means this callback wasn't
  // initiated by us in this browser (a forged/stale link), so refuse to
  // exchange the code. The cookie is single-use — it's cleared on every
  // terminal response below.
  if (!expectedState || !state || state !== expectedState) {
    const res = htmlPage(
      "OwnerRez connection failed",
      `<h2>Connection failed</h2><p class="error">Invalid or expired connection request (state check failed). Please start the connection again from the dashboard.</p>`,
      400
    );
    res.cookies.set(STATE_COOKIE, "", { path: "/api/oauth", maxAge: 0 });
    return res;
  }

  if (!config.ownerRezOAuthClientId || !config.ownerRezOAuthClientSecret) {
    return htmlPage(
      "OwnerRez connection failed",
      `<h2>Connection failed</h2><p class="error">OWNERREZ_OAUTH_CLIENT_ID / OWNERREZ_OAUTH_CLIENT_SECRET aren't set.</p>`,
      500
    );
  }

  const redirectUri = `${req.nextUrl.origin}/api/oauth/callback`;
  const basic = Buffer.from(`${config.ownerRezOAuthClientId}:${config.ownerRezOAuthClientSecret}`).toString("base64");

  const res = await fetch("https://api.ownerrez.com/oauth/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const failed = htmlPage(
      "OwnerRez connection failed",
      `<h2>Connection failed</h2><p class="error">${escapeHtml(res.status)}: ${escapeHtml(
        (data.error_description as string) || (data.error as string) || "Unknown error"
      )}</p>`,
      400
    );
    failed.cookies.set(STATE_COOKIE, "", { path: "/api/oauth", maxAge: 0 });
    return failed;
  }

  const accessToken = data.access_token as string | undefined;

  // Both the echoed token and the raw JSON dump are escaped — the token value
  // is attacker-influenceable in principle (it's whatever the upstream token
  // endpoint returned for the presented code) and the raw response can contain
  // arbitrary upstream strings, so neither is trusted into raw HTML.
  const success = htmlPage(
    "OwnerRez connected",
    `<h2>OwnerRez messaging connected ✅</h2>
     <p>Copy the access token below into the <code>OWNERREZ_OAUTH_TOKEN</code> environment
     variable (locally in <code>.env.local</code>, or in Vercel's Environment Variables
     settings), then restart or redeploy the app.</p>
     <textarea readonly onclick="this.select()">${escapeHtml(
       accessToken ?? "(no access_token returned — see raw response below)"
     )}</textarea>
     <p>Raw response (for troubleshooting):</p>
     <pre style="white-space:pre-wrap;background:#f2f2f2;padding:10px;border-radius:6px;">${escapeHtml(
       JSON.stringify(data, null, 2)
     )}</pre>`
  );
  success.cookies.set(STATE_COOKIE, "", { path: "/api/oauth", maxAge: 0 });
  return success;
}
