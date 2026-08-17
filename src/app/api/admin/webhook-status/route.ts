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

  const authHeaders = {
    Authorization: `Bearer ${config.ownerRezOAuthToken}`,
    "User-Agent": config.userAgent,
  };

  // ?message_id=X — fetch the raw OwnerRez message entity, since the
  // webhook's `entity` field is documented to be exactly this object.
  // The fastest way to learn the REAL field names of a payload we mishandled.
  const messageId = req.nextUrl.searchParams.get("message_id");
  if (messageId && /^\d+$/.test(messageId)) {
    const res = await fetch(`https://api.ownerrez.com/v2/messages/${messageId}`, {
      headers: authHeaders,
      cache: "no-store",
    });
    return NextResponse.json({ ok: res.ok, status: res.status, message: await res.json().catch(() => null) });
  }

  // ?guest_id=X — raw guest entity (contact-info debugging: what does
  // OwnerRez actually have on file for this guest).
  const guestId = req.nextUrl.searchParams.get("guest_id");
  if (guestId && /^\d+$/.test(guestId)) {
    const res = await fetch(`https://api.ownerrez.com/v2/guests/${guestId}`, {
      headers: authHeaders,
      cache: "no-store",
    });
    return NextResponse.json({ ok: res.ok, status: res.status, guest: await res.json().catch(() => null) });
  }

  // ?booking_id=X — same idea for booking entities (used to replay missed
  // booking-created webhooks).
  const bookingId = req.nextUrl.searchParams.get("booking_id");
  if (bookingId && /^\d+$/.test(bookingId)) {
    const res = await fetch(`https://api.ownerrez.com/v2/bookings/${bookingId}`, {
      headers: authHeaders,
      cache: "no-store",
    });
    return NextResponse.json({ ok: res.ok, status: res.status, booking: await res.json().catch(() => null) });
  }

  try {
    const res = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
      headers: authHeaders,
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    const { redisGet } = await import("@/lib/redis");
    const samplesRaw = await redisGet("webhook:raw-samples").catch(() => null);
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      subscriptions: body,
      rawSamples: samplesRaw ? JSON.parse(samplesRaw) : [],
      expectedUrl: "https://legacy-colombia-dashboard.vercel.app/api/webhook",
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}

// The secret travels in the URL because OwnerRez doesn't sign its webhooks
// (2026-08-17 audit — /api/webhook previously had no authentication at all).
// Built from the same env var the endpoint checks, so subscribing and
// verifying can never drift apart: change WEBHOOK_SECRET, re-POST here, done.
const WEBHOOK_URL = (() => {
  const base = "https://legacy-colombia-dashboard.vercel.app/api/webhook";
  const secret = (process.env.WEBHOOK_SECRET || "").trim();
  return secret ? `${base}?secret=${encodeURIComponent(secret)}` : base;
})();

// POST { create: ["message", "booking", ...] } — subscribes THIS dashboard's
// /api/webhook to the given OwnerRez entity types. Found 2026-08-15 that the
// account's existing "message"/"booking" subscriptions point at an unknown
// AWS API Gateway URL (qcaopmsu2a.execute-api...), i.e. OwnerRez was firing
// guest-message webhooks all along — just never at this app. Deliberately
// ADDS subscriptions for our URL rather than touching the AWS ones, in case
// that endpoint belongs to some other tool still in use.
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!config.ownerRezOAuthToken) {
    return NextResponse.json({ ok: false, error: "OWNERREZ_OAUTH_TOKEN isn't set server-side." });
  }

  const body = (await req.json().catch(() => ({}))) as { create?: string[] };
  const types = Array.isArray(body.create) && body.create.length > 0 ? body.create : ["message", "booking"];

  const headers = {
    Authorization: `Bearer ${config.ownerRezOAuthToken}`,
    "User-Agent": config.userAgent,
    "Content-Type": "application/json",
  };

  const results: Record<string, unknown> = {};
  for (const type of types) {
    // Try the fuller shape first (matches what the existing subscriptions
    // show), fall back to the minimal one if OwnerRez rejects it.
    let res = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
      method: "POST",
      headers,
      body: JSON.stringify({ type, action: "entity_create", webhook_url: WEBHOOK_URL }),
    });
    if (!res.ok) {
      res = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
        method: "POST",
        headers,
        body: JSON.stringify({ type, webhook_url: WEBHOOK_URL }),
      });
    }
    results[type] = { status: res.status, body: await res.json().catch(() => null) };
  }

  // Re-list so the response shows the final state in one shot.
  const listRes = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
    headers: { Authorization: headers.Authorization, "User-Agent": headers["User-Agent"] },
    cache: "no-store",
  });
  return NextResponse.json({
    ok: true,
    created: results,
    subscriptionsAfter: await listRes.json().catch(() => null),
  });
}

// DELETE ?secret=...&ids=26703,26704 — removes OwnerRez webhook
// subscriptions by id. Built to clean up the two stale subscriptions
// pointing at the unknown AWS API Gateway URL (see POST comment above) once
// Seni confirmed he doesn't recognize that endpoint. Note: if a subscription
// belongs to a different OAuth connection than this token's, OwnerRez may
// refuse — in that case removal has to happen from OwnerRez's own UI
// (Settings → API Access → the authorized app's webhooks section).
export async function DELETE(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!config.ownerRezOAuthToken) {
    return NextResponse.json({ ok: false, error: "OWNERREZ_OAUTH_TOKEN isn't set server-side." });
  }

  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "Pass ?ids=<id>,<id> (numeric)." }, { status: 400 });
  }

  const authHeaders = {
    Authorization: `Bearer ${config.ownerRezOAuthToken}`,
    "User-Agent": config.userAgent,
  };

  const results: Record<string, unknown> = {};
  for (const id of ids) {
    const res = await fetch(`https://api.ownerrez.com/v2/webhooksubscriptions/${id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    results[id] = { status: res.status, body: await res.text().then((t) => t.slice(0, 300)).catch(() => null) };
  }

  const listRes = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
    headers: authHeaders,
    cache: "no-store",
  });
  return NextResponse.json({
    ok: true,
    deleted: results,
    subscriptionsAfter: await listRes.json().catch(() => null),
  });
}
