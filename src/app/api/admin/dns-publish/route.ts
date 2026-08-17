import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Publishes Resend's sending records into Cloudflare DNS, then asks Resend to
// verify (2026-08-17). This is the piece that makes team onboarding
// self-service: without a verified sending domain, Resend refuses to deliver
// to anyone except the Resend account owner, which is why the Ahmed/Geo/
// Gabriel onboarding emails 403'd and why the per-property daily summaries
// can currently only reach Seni.
//
// SAFETY — this route will not touch existing mail. legacyestaterentals.com
// runs Google Workspace (MX smtp.google.com, SPF include:_spf.google.com).
// The Resend domain is the SUBDOMAIN send.legacyestaterentals.com, so every
// record written here sits under that subdomain. Before writing, we refuse
// any record whose name is the bare root or which would collide with a
// root-level MX/SPF record.
//
// Requires CLOUDFLARE_API_TOKEN with Zone:DNS:Edit + Zone:Zone:Read on the
// zone. POST ?secret=…&dryRun=1 to see exactly what would be written.
type CfRecord = { id: string; type: string; name: string; content: string };
type ResendRecord = {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
};

async function cf(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const json = (await res.json()) as { success: boolean; result?: unknown; errors?: unknown };
  if (!json.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      {
        error:
          "CLOUDFLARE_API_TOKEN isn't set. Create a token with Zone:DNS:Edit + Zone:Zone:Read scoped to legacyestaterentals.com and add it in Vercel → Settings → Environment Variables.",
      },
      { status: 400 }
    );
  }
  if (!config.resendApiKey) {
    return NextResponse.json({ error: "RESEND_API_KEY isn't set." }, { status: 400 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const rootDomain = req.nextUrl.searchParams.get("zone") ?? "legacyestaterentals.com";
  const sendingDomain = req.nextUrl.searchParams.get("domain") ?? `send.${rootDomain}`;

  // 1. Find the Resend domain and its required records.
  const dList = (await (
    await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${config.resendApiKey}` },
      cache: "no-store",
    })
  ).json()) as { data?: { id: string; name: string }[] };
  const target = (dList.data ?? []).find((d) => d.name === sendingDomain);
  if (!target) {
    return NextResponse.json(
      { error: `${sendingDomain} isn't registered in Resend. POST /api/admin/email-domain-setup first.` },
      { status: 400 }
    );
  }
  const detail = (await (
    await fetch(`https://api.resend.com/domains/${target.id}`, {
      headers: { Authorization: `Bearer ${config.resendApiKey}` },
      cache: "no-store",
    })
  ).json()) as { status: string; records?: ResendRecord[] };
  const wanted = detail.records ?? [];

  // 2. Guard: everything must live under the sending subdomain.
  const subLabel = sendingDomain.replace(`.${rootDomain}`, ""); // "send"
  const unsafe = wanted.filter((r) => {
    const fq = r.name.endsWith(rootDomain) ? r.name : `${r.name}.${rootDomain}`;
    return !fq.endsWith(`.${sendingDomain}`) && fq !== sendingDomain;
  });
  if (unsafe.length > 0) {
    return NextResponse.json(
      {
        error:
          "Refusing to write: Resend returned a record outside the sending subdomain, which could disturb Google Workspace mail on the root domain.",
        unsafe,
        subLabel,
      },
      { status: 409 }
    );
  }

  // 3. Resolve the zone and read what's already there.
  const zones = (await cf(`/zones?name=${rootDomain}`, token)) as { id: string; name: string }[];
  if (zones.length === 0) {
    return NextResponse.json({ error: `Zone ${rootDomain} not found on this token.` }, { status: 404 });
  }
  const zoneId = zones[0].id;
  const existing = (await cf(`/zones/${zoneId}/dns_records?per_page=200`, token)) as CfRecord[];

  const plan = wanted.map((r) => {
    const fq = r.name.endsWith(rootDomain) ? r.name : `${r.name}.${rootDomain}`;
    const match = existing.find((e) => e.name === fq && e.type === r.type);
    return {
      type: r.type,
      name: fq,
      value: r.value,
      priority: r.priority,
      action: !match ? "create" : match.content === r.value ? "unchanged" : "update",
      existingId: match?.id,
    };
  });

  if (dryRun) {
    return NextResponse.json({ dryRun: true, zone: rootDomain, sendingDomain, status: detail.status, plan });
  }

  // 4. Write.
  const written: unknown[] = [];
  for (const p of plan) {
    if (p.action === "unchanged") {
      written.push({ ...p, ok: true });
      continue;
    }
    const payload: Record<string, unknown> = {
      type: p.type,
      name: p.name,
      content: p.value,
      ttl: 1,
      proxied: false,
    };
    if (p.priority !== undefined) payload.priority = p.priority;
    try {
      if (p.action === "create") {
        await cf(`/zones/${zoneId}/dns_records`, token, { method: "POST", body: JSON.stringify(payload) });
      } else {
        await cf(`/zones/${zoneId}/dns_records/${p.existingId}`, token, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
      written.push({ ...p, ok: true });
    } catch (err) {
      written.push({ ...p, ok: false, error: err instanceof Error ? err.message : "Unknown" });
    }
  }

  // 5. Ask Resend to verify. DNS propagation means this often needs a retry;
  // the caller can re-POST or PATCH /api/admin/email-domain-setup.
  const verify = await fetch(`https://api.resend.com/domains/${target.id}/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}` },
  });
  const after = (await (
    await fetch(`https://api.resend.com/domains/${target.id}`, {
      headers: { Authorization: `Bearer ${config.resendApiKey}` },
      cache: "no-store",
    })
  ).json()) as { status?: string };

  return NextResponse.json({
    ok: true,
    zone: rootDomain,
    sendingDomain,
    written,
    verifyRequested: verify.ok,
    status: after.status,
    note:
      after.status === "verified"
        ? "Verified. Set REPORT_EMAIL_FROM to use this domain and redeploy."
        : "Records published. Resend re-checks automatically; re-run this route in a few minutes if status isn't 'verified' yet.",
  });
}
