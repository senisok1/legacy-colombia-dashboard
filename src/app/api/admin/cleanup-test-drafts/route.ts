import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getAllPendingDrafts, deletePendingDraft } from "@/lib/pendingDrafts";
import { listActiveOrganizations } from "@/lib/organizations";

export const dynamic = "force-dynamic";

// One-off cleanup for the synthetic drafts created by api/debug/test-service-request
// (still kept around deliberately — task #73 needs to re-run it once Meta approves
// the Gabriel-notify template) — every hit of that route creates a new pending draft
// against fake thread id 999999999 that nothing ever resolves, so they pile up in the
// Redis pending-ids list and flood the real Approvals tab now that it's shipped.
// Safe to leave this cleanup route in place indefinitely (same ADMIN_SECRET gate as
// the other bootstrap routes) — it only ever touches drafts whose guestName is
// exactly "Test Guest", and simply reports 0 removed once the backlog is clear. Run
// it again after the next A-to-Z re-test to clear that one out too.
// Runs once per organization in good standing (see listActiveOrganizations())
// so cleanup only ever reads/deletes that org's own drafts — see
// pendingDrafts.ts's Phase 3 header comment for why un-scoped
// getAllPendingDrafts/deletePendingDraft calls were a cross-tenant risk. One
// org's failure is isolated and reported per-org rather than aborting the
// whole run, same pattern as the cron jobs (see api/cron/detect-campaigns and
// api/cron/detect-reviews).
async function cleanupTestDraftsForOrg(orgId: string) {
  const drafts = await getAllPendingDrafts(orgId);
  // "E2E Pipeline Test" / thread 99999999 added 2026-08-15 — the synthetic
  // webhook end-to-end tests create drafts under those markers.
  const TEST_GUEST_NAMES = new Set(["Test Guest", "E2E Pipeline Test", "Delivery Diagnostic"]);
  const testDrafts = drafts.filter(
    (d) => TEST_GUEST_NAMES.has(d.guestName ?? "") || d.bookingId === 999999999 || d.threadId === 99999999
  );

  for (const draft of testDrafts) {
    await deletePendingDraft(draft.id, orgId);
  }

  return {
    ok: true,
    totalPendingBefore: drafts.length,
    removed: testDrafts.length,
    remaining: drafts.length - testDrafts.length,
  };
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const orgs = await listActiveOrganizations();
  const results: Record<string, unknown> = {};

  for (const org of orgs) {
    try {
      results[org.slug] = await cleanupTestDraftsForOrg(org.id);
    } catch (err) {
      console.error(`[admin/cleanup-test-drafts] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}
