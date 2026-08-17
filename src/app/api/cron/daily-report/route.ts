import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { buildExecutiveReport, deliverExecutiveReport } from "@/lib/executiveReport";
import { listActiveOrganizations } from "@/lib/organizations";
import { listUsers } from "@/lib/users";
import { PROPERTY_GROUPS, allowedPropertyGroups } from "@/lib/propertyGroups";

// Daily executive report, 5:10am ET.
//
// PER-PROPERTY, PER-OWNER FAN-OUT (2026-08-17, Seni's ask: "send one daily
// summary specific for each property to each admin/owner ONLY based on the
// properties that that specific admin/owner has access to").
//
// Previously this built ONE report per organization — implicitly Legacy
// Colombia's, since buildExecutiveReport defaulted to the default property
// group — and mailed it to the single account-wide REPORT_EMAIL_TO address.
// With five properties and per-login property access that was both wrong
// (one property's numbers presented as the whole account) and a privacy
// problem (an owner restricted to one property would still have received a
// report about another).
//
// Now, for each organization:
//   1. Find the admin/owner (CEO) logins that are still active.
//   2. Work out which property groups are actually needed — the union of
//      what those admins can see. A property nobody can see is never built,
//      so adding a property doesn't cost a report nobody reads.
//   3. Build each needed property's report ONCE (these are expensive: live
//      OwnerRez calls plus an AI briefing), then fan the finished report out
//      to every admin entitled to it.
//
// An admin with no property restriction (empty propertyAccess) gets one
// email per property, which is the intended behaviour for a full owner.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (config.cronSecret) {
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
    try {
      const users = await listUsers(org.id);
      const admins = users.filter((u) => u.active && u.role === "CEO");

      // Map each property group to the admins entitled to receive it.
      const recipientsByGroup = new Map<string, { email: string; name: string | null }[]>();
      for (const admin of admins) {
        for (const group of allowedPropertyGroups(admin.propertyAccess)) {
          const list = recipientsByGroup.get(group.id) ?? [];
          list.push({ email: admin.email, name: admin.name });
          recipientsByGroup.set(group.id, list);
        }
      }

      // Safety net: if there are no admin logins at all (or the users table
      // is unreachable), fall back to the old single account-wide report so
      // a misconfiguration means "one report" rather than "silence".
      if (recipientsByGroup.size === 0) {
        const report = await buildExecutiveReport(org.id);
        const delivery = await deliverExecutiveReport(report, "Scheduled 5:10am ET run", org.id);
        results[org.slug] = { ok: true, mode: "fallback-single-report", delivery };
        continue;
      }

      const perProperty: Record<string, unknown> = {};
      for (const group of PROPERTY_GROUPS) {
        const recipients = recipientsByGroup.get(group.id);
        if (!recipients || recipients.length === 0) continue; // nobody can see it

        try {
          // Built once, delivered many — see the note at the top of the file.
          const report = await buildExecutiveReport(org.id, group.id);
          const deliveries: Record<string, unknown> = {};
          for (const recipient of recipients) {
            deliveries[recipient.email] = await deliverExecutiveReport(
              report,
              `Scheduled 5:10am ET run — ${group.label}`,
              org.id,
              recipient.email
            );
          }
          perProperty[group.id] = { ok: true, recipients: recipients.length, deliveries };
        } catch (err) {
          // One property failing must not cost the others their report.
          console.error(`[cron/daily-report] ${org.slug}/${group.id} failed`, err);
          perProperty[group.id] = {
            ok: false,
            error: err instanceof Error ? err.message : "Unknown error.",
          };
        }
      }

      results[org.slug] = { ok: true, mode: "per-property", admins: admins.length, perProperty };
    } catch (err) {
      console.error(`[cron/daily-report] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}
