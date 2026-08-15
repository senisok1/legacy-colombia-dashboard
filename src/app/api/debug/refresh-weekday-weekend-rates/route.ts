import { NextRequest, NextResponse } from "next/server";
import { redisDel } from "@/lib/redis";
import { isRedisConfigured } from "@/lib/config";
import { getWeekdayWeekendRates, WEEKDAY_WEEKEND_CACHE_KEY } from "@/lib/revenueManager";
import { getDefaultOrganizationId } from "@/lib/organizations";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Manual cache-bust for the weekday/weekend rate KPI (see
// lib/revenueManager.ts's getWeekdayWeekendRates — it's cached ~20h so the
// Reports page doesn't hit OwnerRez on every view). Same protection level as
// the rest of /api/debug/* — behind the dashboard session, not CRON_SECRET.
// Useful right after a real pricing change, or after fixing how the sample
// dates are picked, rather than waiting out the cache TTL to see it reflected.
//
// Phase 3: this used to always bust/refresh the DEFAULT org's cache entry
// regardless of who was logged in, AND used a hardcoded literal cache key
// that no longer matches the real (now org-namespaced) key
// getWeekdayWeekendRates actually reads/writes — so the cache-bust was
// silently a no-op even for the default org. Resolve the same orgId
// getWeekdayWeekendRates itself falls back to (session org, else the
// default org) so the key we delete is exactly the key it will re-populate.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  try {
    const orgId = session?.organizationId ?? (await getDefaultOrganizationId());
    if (isRedisConfigured()) {
      await redisDel(`${WEEKDAY_WEEKEND_CACHE_KEY}:${orgId}`);
    }
    const rates = await getWeekdayWeekendRates(session?.organizationId);
    return NextResponse.json({ ok: true, rates });
  } catch (err) {
    return NextResponse.json(
      { error: `Refresh failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
