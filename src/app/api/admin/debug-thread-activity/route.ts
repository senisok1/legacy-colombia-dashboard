import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { query } from "@/lib/db";
import { redisGet, redisSet } from "@/lib/redis";
import { getPendingDraftByThreadId } from "@/lib/pendingDrafts";
import { listActiveOrganizations } from "@/lib/organizations";

// One-off diagnostic for "Nyree's WhatsApp alert never arrived" (thread
// 11265042, 2026-08-05). The /activity UI only shows the last 100 rows
// across the whole org, and a same-day bulk Nukak bill import flooded that
// window with ~100 unrelated Bill Pay entries — burying anything from the
// guest_experience agent regardless of whether it ran. This bypasses that by
// querying ai_activity_log directly (no limit) for anything mentioning the
// threadId, plus the live Redis cursor/draft state check-messages/route.ts
// actually reads. Read-only. Same ADMIN_SECRET gate as the other one-off
// admin routes. Safe to leave deployed.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const threadId = Number(req.nextUrl.searchParams.get("threadId"));
  if (!threadId) {
    return NextResponse.json({ error: "?threadId= required." }, { status: 400 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }

  const activityRows = await query<{
    id: string;
    occurred_at: string;
    org_slug: string;
    agent_key: string;
    task: string;
    trigger: string | null;
    result: string | null;
    error: string | null;
  }>(
    `select l.id, l.occurred_at, o.slug as org_slug, a.key as agent_key, l.task, l.trigger, l.result, l.error
     from ai_activity_log l
     left join agents a on a.id = l.agent_id
     left join organizations o on o.id = l.organization_id
     where l.trigger ilike $1 or l.data_reviewed::text ilike $1
     order by l.occurred_at desc
     limit 25`,
    [`%${threadId}%`]
  );

  // All orgs' billing status — listActiveOrganizations() (what the cron
  // actually loops over) only includes subscription_status in
  // ('trialing','active'), so if this org silently fell out of that set
  // (lapsed trial, failed Stripe payment, webhook glitch, etc.) the ENTIRE
  // cron — every thread, not just this one — would skip it with zero
  // errors and zero activity log entries, since the org is never even
  // reached inside the GET() loop in check-messages/route.ts.
  const allOrgs = await query<{
    id: string;
    slug: string;
    subscription_status: string;
    plan: string;
    trial_ends_at: string | null;
  }>(`select id, slug, subscription_status, plan, trial_ends_at from organizations order by created_at asc`);

  const activeOrgs = await listActiveOrganizations();
  const activeIds = new Set(activeOrgs.map((o) => o.id));
  const redisState = [];
  for (const org of allOrgs) {
    const lastSeenId = await redisGet(`cron:${org.id}:last-seen:${threadId}`);
    const draft = await getPendingDraftByThreadId(threadId, org.id).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
    }));
    redisState.push({ org: org.slug, includedInCronLoop: activeIds.has(org.id), lastSeenId, draft });
  }

  // Broader sanity checks: (1) has the guest_experience agent logged
  // ANYTHING at all in roughly the last 24h, across every thread — if not,
  // the cron itself is silently dying before it ever reaches a per-thread
  // logAiActivity call (getLastSeenMessageId/setLastSeenMessageId in
  // check-messages/route.ts run OUTSIDE any try/catch in the per-thread
  // loop, so a Redis error there would abort that org's whole run silently,
  // caught only by GET()'s top-level try/catch which never logs to the DB).
  // (2) a live Redis round-trip right now, to catch a current outage vs. a
  // one-time blip.
  const recentAnyActivity = await query<{
    id: string;
    occurred_at: string;
    agent_key: string;
    task: string;
    trigger: string | null;
    result: string | null;
  }>(
    `select l.id, l.occurred_at, a.key as agent_key, l.task, l.trigger, l.result
     from ai_activity_log l
     left join agents a on a.id = l.agent_id
     where a.key = 'guest_experience'
     order by l.occurred_at desc
     limit 10`
  );

  let redisHealthCheck: { ok: boolean; error?: string } = { ok: true };
  try {
    const probeKey = `debug:health-check:${Date.now()}`;
    await redisSet(probeKey, "1");
    const readBack = await redisGet(probeKey);
    if (readBack !== "1") redisHealthCheck = { ok: false, error: "wrote '1' but read back " + JSON.stringify(readBack) };
  } catch (err) {
    redisHealthCheck = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return NextResponse.json({
    threadId,
    activityRows,
    orgBillingStatus: allOrgs,
    redisState,
    recentAnyGuestExperienceActivity: recentAnyActivity,
    redisHealthCheck,
  });
}
