import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

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

  if (error) {
    return htmlPage(
      "OwnerRez connection failed",
      `<h2>Connection failed</h2><p class="error">${error}${errorDescription ? `: ${errorDescription}` : ""}</p>`,
      400
    );
  }

  if (!code) {
    return htmlPage("OwnerRez connection failed", `<h2>Connection failed</h2><p class="error">No code received.</p>`, 400);
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
    return htmlPage(
      "OwnerRez connection failed",
      `<h2>Connection failed</h2><p class="error">${res.status}: ${
        (data.error_description as string) || (data.error as string) || "Unknown error"
      }</p>`,
      400
    );
  }

  const accessToken = data.access_token as string | undefined;

  return htmlPage(
    "OwnerRez connected",
    `<h2>OwnerRez messaging connected ✅</h2>
     <p>Copy the access token below into the <code>OWNERREZ_OAUTH_TOKEN</code> environment
     variable (locally in <code>.env.local</code>, or in Vercel's Environment Variables
     settings), then restart or redeploy the app.</p>
     <textarea readonly onclick="this.select()">${accessToken ?? "(no access_token returned — see raw response below)"}</textarea>
     <p>Raw response (for troubleshooting):</p>
     <pre style="white-space:pre-wrap;background:#f2f2f2;padding:10px;border-radius:6px;">${JSON.stringify(
       data,
       null,
       2
     )}</pre>`
  );
}
