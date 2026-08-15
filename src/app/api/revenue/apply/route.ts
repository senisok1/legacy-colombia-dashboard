import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { applyRateOverride, RevenueManagerError } from "@/lib/revenueManager";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The ONLY write path in the Revenue Manager feature. Every call here is the
// direct result of an explicit "Apply this rate" click Seni makes on ONE
// date in the Revenue Management tab — there is no batch endpoint and no
// cron/scheduled trigger anywhere that calls this. See
// lib/revenueManager.ts's applyRateOverride() for what actually happens (a
// PriceLabs Date Specific Override push, which PriceLabs then syncs into
// OwnerRez on its own schedule — not instant).
export async function POST(request: NextRequest) {
  const session = getSessionFromRequest(request);
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }

  let body: { stayDate?: unknown; priceCents?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const stayDate = typeof body.stayDate === "string" ? body.stayDate : "";
  const priceCents = typeof body.priceCents === "number" ? body.priceCents : NaN;
  const reason = typeof body.reason === "string" ? body.reason : undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(stayDate)) {
    return NextResponse.json({ error: "stayDate must be YYYY-MM-DD." }, { status: 400 });
  }
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    return NextResponse.json({ error: "priceCents must be a positive number." }, { status: 400 });
  }

  try {
    const result = await applyRateOverride({ stayDate, priceCents, reason }, session?.organizationId);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof RevenueManagerError || err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
