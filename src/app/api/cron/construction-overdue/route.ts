import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { listActiveOrganizations } from "@/lib/organizations";
import { listUsers } from "@/lib/users";
import { listConstructionItems } from "@/lib/construction";
import { DEFAULT_PROPERTY_GROUP_ID, PROPERTY_GROUPS, allowedPropertyGroups } from "@/lib/propertyGroups";
import { checkConstructionOverdueAlerts } from "@/lib/constructionAlerts";

// Daily overdue-construction-item scan (2026-08-20, Seni's ask: "when the
// est. completion date is due... send out whatsapp messages to me and all
// users that have access to"; extended 2026-08-21, Seni's ask: "send an
// email and a whatsapp message to each user that has access to view or edit
// that tab... add the name of the specific property... so the user can
// identify it immediately"). See lib/constructionAlerts.ts for the
// per-item-per-date dedupe and the WhatsApp+email send logic. Runs once a
// day via vercel.json's cron entry.
//
// Runs across EVERY property group (widened 2026-08-21 — Construction
// Management's nav became visible on every property that same day, see
// [[project_construction_management_tab]]; used to be Legacy-Colombia-only
// like the tab itself originally was). For each property, recipients =
// everyone who can actually SEE that property's tab: CEO role with that
// property in their allowed list (allowedPropertyGroups — an empty
// propertyAccess means unrestricted/every property), OR the CONSTRUCTION
// role but ONLY for Legacy Colombia — that login is hard-locked to Colombia
// in src/proxy.ts regardless of nav visibility, so including it for any
// other property would alert someone who can't even open the tab to look.
// A recipient needs a WhatsApp number and/or an email on file — either
// alone is enough to be included, resolved fresh each run from Settings >
// Team, same as balance-due's Geo lookup.
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

  const orgs = await listActiveOrganizations();
  const results: Record<string, unknown> = {};

  for (const org of orgs) {
    const orgResults: Record<string, unknown> = {};
    try {
      const users = await listUsers(org.id).catch(() => []);

      for (const group of PROPERTY_GROUPS) {
        try {
          const recipients = users
            .filter((u) => {
              if (!u.active) return false;
              if (u.role === "CEO") return allowedPropertyGroups(u.propertyAccess).some((g) => g.id === group.id);
              // CONSTRUCTION is proxy-locked to Legacy Colombia only — see
              // this file's header comment.
              if (u.role === "CONSTRUCTION") return group.id === DEFAULT_PROPERTY_GROUP_ID;
              return false;
            })
            .filter((u) => u.whatsappPhone || u.email)
            .map((u) => ({ phone: u.whatsappPhone || null, email: u.email || null, name: u.name || u.email }));

          if (recipients.length === 0) {
            orgResults[group.id] = { skipped: "No active CEO/CONSTRUCTION login with contact info for this property." };
            continue;
          }

          const items = await listConstructionItems(org.id, group.id);
          orgResults[group.id] = await checkConstructionOverdueAlerts(items, org.id, recipients, group.label);
        } catch (err) {
          console.error(`[cron/construction-overdue] failed for org ${org.slug}, property ${group.id}`, err);
          orgResults[group.id] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
        }
      }

      results[org.slug] = orgResults;
    } catch (err) {
      console.error(`[cron/construction-overdue] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}
