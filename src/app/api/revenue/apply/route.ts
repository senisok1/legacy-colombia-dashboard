import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { applyRateOverride, RevenueManagerError } from "@/lib/revenueManager";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, DEFAULT_PROPERTY_GROUP_ID, propertyGroupById } from "@/lib/propertyGroups";

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

  // SAFETY GUARD (2026-08-17): applyRateOverride resolves the target
  // property from config (getTargetProperty) and pushes through the single
  // configured PriceLabs listing — Legacy Colombia's. Clicking Apply while
  // another property was selected would therefore have changed COLOMBIA's
  // price. Refuse rather than push to the wrong listing; per-property
  // PriceLabs credentials are what this needs to support other properties.
  const groupId = effectivePropertyGroupId(
    request.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
  );
  if (groupId !== DEFAULT_PROPERTY_GROUP_ID) {
    return NextResponse.json(
      {
        error: `Applying rates isn't set up for ${propertyGroupById(groupId).label} yet — it needs its own PriceLabs listing. Switch to ${propertyGroupById(DEFAULT_PROPERTY_GROUP_ID).label} to apply a rate.`,
      },
      { status: 400 }
    );
  }

  try {
    const result = await applyRateOverride({ stayDate, priceCents, reason }, session?.organizationId);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof RevenueManagerError || err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
