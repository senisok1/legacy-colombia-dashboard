import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { config } from "@/lib/config";

// Kicks off the one-time OAuth connection needed for sending messages
// (OwnerRez's Personal Access Tokens can't touch the messaging endpoints).
// Visiting this route sends you to OwnerRez to approve the connection;
// OwnerRez then redirects back to /api/oauth/callback with a temporary code.
export async function GET(req: NextRequest) {
  if (!config.ownerRezOAuthClientId) {
    return NextResponse.json(
      {
        error:
          "OWNERREZ_OAUTH_CLIENT_ID is not set. Create an OAuth App in OwnerRez (Developer/API Settings) and add its Client Id/Secret as env vars first.",
      },
      { status: 500 }
    );
  }

  const redirectUri = `${req.nextUrl.origin}/api/oauth/callback`;
  const state = crypto.randomBytes(16).toString("hex");

  const url = new URL("https://app.ownerrez.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.ownerRezOAuthClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  // CSRF protection (2026-08-17 audit). A `state` was already generated and
  // sent to OwnerRez, but the callback never verified it came back unchanged —
  // so an attacker could feed the account owner a forged callback URL with
  // their OWN `code` and connect the attacker's OwnerRez account to this
  // dashboard. Persist the expected state in a short-lived, httpOnly cookie
  // and have the callback require an exact match. sameSite "lax" so the cookie
  // still rides along on the top-level GET redirect back from OwnerRez.
  const res = NextResponse.redirect(url.toString());
  res.cookies.set("orez_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/oauth",
    maxAge: 600, // 10 minutes is plenty to complete the approval round trip
  });
  return res;
}
