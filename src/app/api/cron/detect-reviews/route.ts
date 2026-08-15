import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { detectAndDraftResponses } from "@/lib/reputationManager";
import { listActiveOrganizations } from "@/lib/organizations";

// Daily scan for reviews with no host response yet — drafts an AI response
// for each and notifies Seni once over WhatsApp (see
// lib/reputationManager.ts's header comment). Runs once a day via
// vercel.json's cron entry, same pattern as api/cron/detect-campaigns. Only
// ever CREATES 'pending_review' rows for Seni to review in the Reputation
// tab — never posts anything anywhere.
//
// Phase 3: loops over every organization in good standing rather than
// running once for the single default org — see detect-campaigns' matching
// comment for the reasoning.
export const maxDuration = 60;

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
      const result = await detectAndDraftResponses(org.id);
      results[org.slug] = { ok: true, ...result };
    } catch (err) {
      console.error(`[cron/detect-reviews] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}
