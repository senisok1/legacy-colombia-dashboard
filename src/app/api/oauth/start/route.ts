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

  return NextResponse.redirect(url.toString());
}
