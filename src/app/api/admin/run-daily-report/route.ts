import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { buildExecutiveReport, deliverExecutiveReport } from "@/lib/executiveReport";
import { listActiveOrganizations } from "@/lib/organizations";
import { listUsers } from "@/lib/users";
import { PROPERTY_GROUPS, allowedPropertyGroups } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Manual trigger for the per-property daily executive summary (2026-08-17).
//
// Same fan-out logic as api/cron/daily-report, but gated on ADMIN_SECRET
// rather than CRON_SECRET — Vercel marks CRON_SECRET sensitive, so its value
// can't be read back out to fire the cron by hand. Used to send an
// out-of-band run ("create a new daily executive summary now for each
// property") without waiting for 5:10am.
//
//   GET /api/admin/run-daily-report?secret=…            → all properties
//   GET /api/admin/run-daily-report?secret=…&group=legacy-alva  → just one
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ skipped: "Database isn't connected yet." });
  }

  const onlyGroup = req.nextUrl.searchParams.get("group");
  const orgs = await listActiveOrganizations();
  const results: Record<string, unknown> = {};

  for (const org of orgs) {
    const users = await listUsers(org.id);
    const admins = users.filter((u) => u.active && u.role === "CEO");

    const recipientsByGroup = new Map<string, string[]>();
    for (const admin of admins) {
      for (const group of allowedPropertyGroups(admin.propertyAccess)) {
        recipientsByGroup.set(group.id, [...(recipientsByGroup.get(group.id) ?? []), admin.email]);
      }
    }

    const perProperty: Record<string, unknown> = {};
    for (const group of PROPERTY_GROUPS) {
      if (onlyGroup && group.id !== onlyGroup) continue;
      const recipients = recipientsByGroup.get(group.id);
      if (!recipients?.length) {
        perProperty[group.id] = { skipped: "No admin has access to this property." };
        continue;
      }
      try {
        const report = await buildExecutiveReport(org.id, group.id);
        const sent: Record<string, unknown> = {};
        for (const email of recipients) {
          const delivery = await deliverExecutiveReport(
            report,
            `Manual run — ${group.label}`,
            org.id,
            email
          );
          sent[email] = delivery.email;
        }
        perProperty[group.id] = {
          ok: true,
          label: group.label,
          // A quick sanity read so the caller can see at a glance that each
          // property really did produce its own distinct numbers.
          occupancy30d: report.occupancy30d,
          adrGross: Math.round(report.adrGross),
          revenueMtdGross: Math.round(report.revenueMtdGross),
          campaignCandidates: report.campaignCandidates,
          sent,
        };
      } catch (err) {
        perProperty[group.id] = { ok: false, error: err instanceof Error ? err.message : "Unknown." };
      }
    }
    results[org.slug] = { admins: admins.length, perProperty };
  }

  return NextResponse.json({ ok: true, organizations: results });
}
