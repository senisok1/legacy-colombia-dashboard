import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

// ADMIN_SECRET-gated diagnostic: asks OwnerRez's own API which webhook
// subscriptions exist for this OAuth connection (GET /v2/webhooksubscriptions
// — OAuth Bearer only; PATs can't see webhooks at all). Exists because every
// OwnerRez credential is a Sensitive Vercel env var that can't be pulled
// locally (see memory: vercel-sensitive-db-secret-workaround) — so the only
// place this question can be answered is server-side, where the real token
// lives. Same pattern as api/admin/debug-thread-activity.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!config.ownerRezOAuthToken) {
    return NextResponse.json({ ok: false, error: "OWNERREZ_OAUTH_TOKEN isn't set server-side." });
  }

  try {
    const res = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
      headers: {
        Authorization: `Bearer ${config.ownerRezOAuthToken}`,
        "User-Agent": config.userAgent,
      },
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      subscriptions: body,
      expectedUrl: "https://legacy-colombia-dashboard.vercel.app/api/webhook",
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
