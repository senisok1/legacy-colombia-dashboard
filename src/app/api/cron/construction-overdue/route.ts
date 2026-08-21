import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { listActiveOrganizations } from "@/lib/organizations";
import { listUsers } from "@/lib/users";
import { listConstructionItems } from "@/lib/construction";
import { DEFAULT_PROPERTY_GROUP_ID, PROPERTY_GROUPS } from "@/lib/propertyGroups";
import { checkConstructionOverdueAlerts } from "@/lib/constructionAlerts";

// Daily overdue-construction-item scan (2026-08-20, Seni's ask: "when the
// est. completion date is due... send out whatsapp messages to me and all
// users that have access to"). See lib/constructionAlerts.ts for the
// per-item-per-date dedupe. Runs once a day via vercel.json's cron entry.
//
// Legacy-Colombia-only (DEFAULT_PROPERTY_GROUP_ID) — Construction
// Management itself is scoped there (see construction.ts / db/migrations/
// 0042_construction.sql), unlike balance-due which intentionally covers all
// properties. Recipients = everyone with tab access: CEO or CONSTRUCTION
// role, active, with a WhatsApp number on file — resolved fresh each run
// from Settings > Team, same as balance-due's Geo lookup.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // CRON AUTH — FAIL CLOSED IN PRODUCTION, same guard as every other cron
  // route here (2026-08-17 audit — see detect-reviews for the full story).
  const isProd = process.env.VERCEL_ENV === "production";
  if (!config.cronSecret) {
    if (isProd) {
      console.error(
        "[cron/construction-overdue] CRON_SECRET is not set in production — refusing to run this endpoint unauthenticated. Set CRON_SECRET in Vercel."
      );
      return NextResponse.json({ error: "Cron not configured." }, { status: 503 });
    }
    console.warn("[cron/construction-overdue] CRON_SECRET unset — running WITHOUT auth (non-production only).");
  } else {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${config.cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ skipped: "Database isn't connected yet." });
  }

  const propertyLabel = PROPERTY_GROUPS.find((g) => g.id === DEFAULT_PROPERTY_GROUP_ID)?.label ?? "Construction";

  const orgs = await listActiveOrganizations();
  const results: Record<string, unknown> = {};

  for (const org of orgs) {
    try {
      const users = await listUsers(org.id).catch(() => []);
      const recipients = users
        .filter((u) => u.active && (u.role === "CEO" || u.role === "CONSTRUCTION") && u.whatsappPhone)
        .map((u) => ({ phone: u.whatsappPhone as string, name: u.name || u.email }));

      if (recipients.length === 0) {
        results[org.slug] = { skipped: "No active CEO/CONSTRUCTION login with a WhatsApp number in this org." };
        continue;
      }

      const items = await listConstructionItems(org.id, DEFAULT_PROPERTY_GROUP_ID);
      results[org.slug] = await checkConstructionOverdueAlerts(items, org.id, recipients, propertyLabel);
    } catch (err) {
      console.error(`[cron/construction-overdue] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}
