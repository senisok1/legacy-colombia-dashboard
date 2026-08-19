import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { listActiveOrganizations } from "@/lib/organizations";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { buildGuestsById } from "@/lib/guestName";
import { getUserByEmail } from "@/lib/users";
import { checkBalanceDueAlerts } from "@/lib/balanceDueAlerts";

// Daily balance-due scan (2026-08-19, Seni's ask) — WhatsApps Geo when a
// stay arriving within 60 or 30 days still has an unpaid balance. See
// lib/balanceDueAlerts.ts for the milestone windows and once-per-milestone
// dedupe. Runs once a day via vercel.json's cron entry.
//
// Loops the FULL PROPERTY_GROUPS list, not AUTOMATION_PROPERTY_GROUPS —
// Seni's ask was explicitly "for all properties", and this is an internal
// team alert, not the guest-facing automation the 2026-08-18 pullback
// scoped to Legacy Colombia. Each group is wrapped in its own try/catch so
// one property's OwnerRez hiccup never stops the others being scanned —
// same fan-out pattern as detect-reviews.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // CRON AUTH — FAIL CLOSED IN PRODUCTION, same guard as every other cron
  // route here (2026-08-17 audit — see detect-reviews for the full story).
  const isProd = process.env.VERCEL_ENV === "production";
  if (!config.cronSecret) {
    if (isProd) {
      console.error(
        "[cron/balance-due] CRON_SECRET is not set in production — refusing to run this endpoint unauthenticated. Set CRON_SECRET in Vercel."
      );
      return NextResponse.json({ error: "Cron not configured." }, { status: 503 });
    }
    console.warn("[cron/balance-due] CRON_SECRET unset — running WITHOUT auth (non-production only).");
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
    try {
      // Recipient resolved fresh each run: Geo's row in the users table
      // (Settings → Team) is the source of truth for the phone number, so
      // updating it there retargets these alerts with no deploy. If the
      // login is missing, deactivated, or has no WhatsApp number, skip
      // loudly in the response rather than failing the whole run.
      const recipientUser = await getUserByEmail(config.balanceDueAlertEmail).catch(() => null);
      if (
        !recipientUser ||
        !recipientUser.active ||
        recipientUser.organizationId !== org.id ||
        !recipientUser.whatsappPhone
      ) {
        results[org.slug] = {
          skipped: `No active login with a WhatsApp number for ${config.balanceDueAlertEmail} in this org.`,
        };
        continue;
      }
      const recipient = { phone: recipientUser.whatsappPhone, name: recipientUser.name || "Geo" };

      const perProperty: Record<string, unknown> = {};
      for (const group of PROPERTY_GROUPS) {
        try {
          const [bookings, guests] = await Promise.all([
            getBookings(org.id, group.id),
            getGuests(org.id, group.id).catch(() => []),
          ]);
          const guestsById = buildGuestsById(guests);
          perProperty[group.id] = await checkBalanceDueAlerts(bookings, guestsById, org.id, recipient, group.label);
        } catch (groupErr) {
          console.error(`[cron/balance-due] ${org.slug}/${group.id} failed`, groupErr);
          perProperty[group.id] = {
            error: groupErr instanceof Error ? groupErr.message : "Unknown error.",
          };
        }
      }
      results[org.slug] = { ok: true, perProperty };
    } catch (err) {
      console.error(`[cron/balance-due] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}
