import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { buildGuestsById, resolveGuestName } from "@/lib/guestName";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";

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

  // ?resubscribe=1 — deletes THIS app's webhook subscriptions and creates
  // fresh ones (2026-08-19, "Shlomo's inquiry never arrived"): OwnerRez
  // silently stopped delivering to the existing subscriptions after
  // 2026-08-18 01:11 UTC (webhook:raw-samples went dead while the endpoint
  // itself verifiably worked — a signed webhook_test POST returned 200 and
  // was sampled), and no `inquiry`-type subscription had ever been created
  // at all, so handleOwnerRezInquiryEvent was unreachable dead code.
  // Recreating resets any failed/disabled delivery state on OwnerRez's side
  // and adds the missing inquiry type. Only touches subscriptions pointing
  // at THIS app's /api/webhook URL — the other connection's AWS-gateway
  // subscriptions are someone else's and are left alone.
  if (req.nextUrl.searchParams.get("resubscribe") === "1") {
    const webhookUrl = `https://legacy-colombia-dashboard.vercel.app/api/webhook?secret=${(process.env.WEBHOOK_SECRET || "").trim()}`;
    const listRes = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
      headers: authHeaders,
      cache: "no-store",
    });
    const listBody = (await listRes.json().catch(() => null)) as { items?: { id: number; type: string; webhook_url: string }[] } | null;
    const mine = (listBody?.items ?? []).filter((s) =>
      s.webhook_url.startsWith("https://legacy-colombia-dashboard.vercel.app/api/webhook")
    );
    const deleted: Record<number, number> = {};
    for (const sub of mine) {
      const del = await fetch(`https://api.ownerrez.com/v2/webhooksubscriptions/${sub.id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      deleted[sub.id] = del.status;
    }
    const created: Record<string, unknown> = {};
    for (const type of ["message", "booking", "inquiry"]) {
      const res = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ type, action: "entity_create", webhook_url: webhookUrl }),
      });
      created[type] = { status: res.status, body: await res.json().catch(() => null) };
    }
    return NextResponse.json({ ok: true, deleted, created });
  }

  // ?find_guest=<name substring> — scans every property GROUP's bookings
  // (2026-08-19, "I don't see the new booking from Shlomo Nehama") for a
  // guest whose resolved name contains the given substring, case-insensitive.
  // Reuses the SAME getBookings()/resolveGuestName() every tab already calls
  // — so a match here is proof the booking really is reachable through the
  // normal data path, and which property group it lives under. OwnerRez has
  // no bookings-level name search (and /v2/guests?q= doesn't search by name
  // either — see memory), so this is the only way to answer "where is this
  // guest's booking" without paging through the OwnerRez UI by hand.
  // ?property_month_report=<propertyId>:<YYYY-MM> — one-off reconciliation
  // helper (2026-08-19, Seni: "check the property management numbers against
  // the CRM revenue numbers"). Pulls every CRM-side booking for ONE physical
  // OwnerRez property (e.g. Nukak Casa #19 = 492014, distinct from the other
  // listing merged into the same "Legacy Colombia" property GROUP) whose
  // CHECK-IN falls in the given month — matches how Gutierrez Group's
  // "Operational Income" table groups a stay (e.g. their July sheet includes
  // a guest checking in 31-Jul/out 2-Aug under "JULY"). Read-only, same
  // isOccupying() definition as the Dashboard/Team Management calendars —
  // Cancelled/blocks/Inquiry/Quote excluded, matching what an actual paid
  // stay is.
  const propertyMonthReport = req.nextUrl.searchParams.get("property_month_report");
  if (propertyMonthReport) {
    const [propertyIdRaw, month] = propertyMonthReport.split(":");
    const propertyId = Number(propertyIdRaw);
    if (!Number.isFinite(propertyId) || !/^\d{4}-\d{2}$/.test(month || "")) {
      return NextResponse.json({ ok: false, error: "Use ?property_month_report=<propertyId>:<YYYY-MM>" }, { status: 400 });
    }
    const { getBookings: gb, getGuests: gg } = await import("@/lib/ownerrez");
    const { isOccupying } = await import("@/lib/finance");
    const { resolveGuestName: rgn, buildGuestsById: bgb } = await import("@/lib/guestName");
    const { PROPERTY_GROUPS: groups } = await import("@/lib/propertyGroups");
    // ?include_cancelled=1 — also lists Cancelled bookings for this property/
    // month (excluded from totals), so a property-manager statement claiming
    // income for a stay OwnerRez shows cancelled is visible instead of just
    // silently missing.
    const includeCancelled = req.nextUrl.searchParams.get("include_cancelled") === "1";
    const rows: Record<string, unknown>[] = [];
    for (const group of groups) {
      try {
        const [bookings, guests] = await Promise.all([gb(undefined, group.id), gg(undefined, group.id).catch(() => [])]);
        const guestsById = bgb(guests);
        for (const b of bookings) {
          if (b.propertyId !== propertyId) continue;
          if (b.isBlock) continue;
          const occupying = isOccupying(b);
          if (!occupying && !(includeCancelled && b.status === "Cancelled")) continue;
          if (!b.arrival || !b.arrival.slice(0, 7).startsWith(month)) continue;
          rows.push({
            guestName: rgn(b, guestsById),
            checkIn: b.arrival,
            checkOut: b.departure,
            nights: b.nights,
            totalAmountUsd: b.totalAmount,
            hostFeeUsd: b.hostFee,
            netAmountUsd: Math.round((b.totalAmount - (b.hostFee || 0)) * 100) / 100,
            status: b.status,
            source: b.source,
            propertyGroup: group.id,
            countsTowardTotal: occupying,
          });
        }
      } catch (err) {
        console.error(`[property_month_report] ${group.id} failed:`, err);
      }
    }
    rows.sort((a, b) => String(a.checkIn).localeCompare(String(b.checkIn)));
    const counted = rows.filter((r) => r.countsTowardTotal);
    const totalUsd = Math.round(counted.reduce((s, r) => s + (Number(r.totalAmountUsd) || 0), 0) * 100) / 100;
    const totalNetUsd = Math.round(counted.reduce((s, r) => s + (Number(r.netAmountUsd) || 0), 0) * 100) / 100;
    const totalNights = counted.reduce((s, r) => s + (Number(r.nights) || 0), 0);
    return NextResponse.json({
      ok: true,
      propertyId,
      month,
      count: counted.length,
      totalUsd,
      totalNetUsd,
      totalNights,
      rows,
    });
  }

  const findGuest = req.nextUrl.searchParams.get("find_guest");
  if (findGuest) {
    const needle = findGuest.toLowerCase();
    const results: Record<string, unknown>[] = [];
    const errors: Record<string, string> = {};
    for (const group of PROPERTY_GROUPS) {
      try {
        const [bookings, guests] = await Promise.all([
          getBookings(undefined, group.id),
          getGuests(undefined, group.id).catch(() => []),
        ]);
        const guestsById = buildGuestsById(guests);
        for (const b of bookings) {
          const name = resolveGuestName(b, guestsById) || b.guestName || "";
          if (name.toLowerCase().includes(needle)) {
            results.push({
              propertyGroup: group.id,
              propertyGroupLabel: group.label,
              bookingId: b.id,
              propertyName: b.propertyName,
              guestName: name,
              status: b.status,
              isBlock: b.isBlock,
              arrival: b.arrival,
              departure: b.departure,
              source: b.source,
              totalAmount: b.totalAmount,
              createdAt: b.createdAt,
              updatedAt: b.updatedAt,
            });
          }
        }
      } catch (err) {
        errors[group.id] = err instanceof Error ? err.message : String(err);
      }
    }
    return NextResponse.json({ ok: true, needle, matches: results, errors });
  }

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
