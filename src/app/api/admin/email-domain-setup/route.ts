import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Registers a sending domain with Resend and returns the exact DNS records
// to publish (2026-08-17).
//
// WHY A SUBDOMAIN. legacyestaterentals.com already runs Google Workspace
// mail: MX -> smtp.google.com and SPF "v=spf1 include:_spf.google.com ~all".
// Adding a second sending provider at the ROOT means editing that SPF record,
// and an SPF mistake silently breaks delivery of the business's real email.
// Resend supports (and recommends) a dedicated subdomain — send.<domain> —
// which gets its own SPF/DKIM and leaves Google Workspace completely
// untouched. Mail still shows as coming from the brand.
//
//   POST /api/admin/email-domain-setup?secret=…   { "domain": "send.legacyestaterentals.com" }
//   GET  /api/admin/email-domain-setup?secret=…   → current domains + records
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!config.resendApiKey) {
    return NextResponse.json({ error: "RESEND_API_KEY isn't set." }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { domain?: string };
  const domain = body.domain?.trim() || "send.legacyestaterentals.com";

  const res = await fetch("https://api.resend.com/domains", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: domain, region: "us-east-1" }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return NextResponse.json({ ok: false, status: res.status, error: json }, { status: 502 });
  }
  return NextResponse.json({ ok: true, domain, resend: json });
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!config.resendApiKey) {
    return NextResponse.json({ error: "RESEND_API_KEY isn't set." }, { status: 400 });
  }

  const list = await fetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${config.resendApiKey}` },
    cache: "no-store",
  });
  const listJson = (await list.json()) as { data?: { id: string; name: string; status: string }[] };
  const domains = listJson.data ?? [];

  // Fetch full record sets — the list endpoint omits them.
  const detailed = await Promise.all(
    domains.map(async (d) => {
      const r = await fetch(`https://api.resend.com/domains/${d.id}`, {
        headers: { Authorization: `Bearer ${config.resendApiKey}` },
        cache: "no-store",
      });
      return r.ok ? await r.json() : { id: d.id, name: d.name, status: d.status };
    })
  );

  return NextResponse.json({ currentFrom: config.reportEmailFrom, domains: detailed });
}

/** Ask Resend to re-check DNS for a domain. */
export async function PATCH(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  if (!body.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const res = await fetch(`https://api.resend.com/domains/${body.id}/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}` },
  });
  return NextResponse.json({ ok: res.ok, status: res.status, body: await res.json().catch(() => null) });
}
