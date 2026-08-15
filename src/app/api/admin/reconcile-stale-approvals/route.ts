import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getAllPendingDrafts, deletePendingDraft } from "@/lib/pendingDrafts";
import { getThreadMessages } from "@/lib/ownerrez";
import { trailingGuestMessages, combineGuestMessageBodies } from "@/lib/guestMessageGroup";
import { listActiveOrganizations } from "@/lib/organizations";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One-off (and safe-to-rerun) cleanup for pending drafts that are no longer
// actually pending in reality — the guest's message got answered through
// some channel OTHER than our approve flow (a manual OwnerRez reply, an
// OwnerRez automated pre-arrival template, etc.), so nothing ever called
// resolvePendingDraft() to clear it out of the Redis queue. Discovered
// 2026-07-30 when the new Approvals tab surfaced ~100 old drafts instead of
// the handful of genuinely open ones — thread 11411424 (Derick Cruz) was the
// clearest example: three separate drafts for the SAME July 20th guest
// message, even though real host replies had already gone out on the 20th,
// 28th, and 30th.
//
// This is NOT a Redis eviction issue (checked: 2.2MB used of a 30MB limit,
// 0 evictions in the last hour) — it's a real gap in the pipeline: nothing
// currently notices when a thread gets answered outside our own send path.
// This route papers over that gap after the fact by re-checking each
// affected thread's actual current state against OwnerRez directly, rather
// than guessing from guestName or age. A draft is only removed when the
// thread's own message history proves it's stale:
//   - the trailing run of guest messages is now empty (host has since
//     replied, one way or another), or
//   - that trailing run no longer matches what the draft was drafted
//     against (the guest has said something newer since, and a fresh draft
//     will form for that on the next cron pass or Inbox open).
// Anything still genuinely awaiting a first reply is left untouched.
//
// Runs once per organization in good standing (see listActiveOrganizations())
// so reconciliation only ever reads/deletes that org's own drafts and OwnerRez
// threads — see pendingDrafts.ts's Phase 3 header comment for why this
// mattered: getAllPendingDrafts/getThreadMessages/deletePendingDraft with no
// org scoping would otherwise reconcile (and delete) drafts across every
// tenant in one pass. One org's failure is isolated and reported per-org
// rather than aborting the whole run, same pattern as the cron jobs (see
// api/cron/detect-campaigns and api/cron/detect-reviews).
async function reconcileStaleApprovalsForOrg(orgId: string, dryRun: boolean) {
  const drafts = await getAllPendingDrafts(orgId);
  const threadIds = [...new Set(drafts.map((d) => d.threadId))];

  const staleDraftIds = new Set<string>();
  const errors: { threadId: number; error: string }[] = [];

  for (const threadId of threadIds) {
    let currentGuestMessage: string | null;
    try {
      const messages = await getThreadMessages(threadId, orgId);
      const trailing = trailingGuestMessages(messages);
      currentGuestMessage = trailing.length > 0 ? combineGuestMessageBodies(trailing) : null;
    } catch (err) {
      // Can't verify this thread right now (OwnerRez hiccup, deleted thread,
      // etc.) — leave its drafts alone rather than guess.
      errors.push({ threadId, error: err instanceof Error ? err.message : "Unknown error." });
      continue;
    }

    for (const draft of drafts.filter((d) => d.threadId === threadId)) {
      const isStale = currentGuestMessage === null || currentGuestMessage !== draft.guestMessage;
      if (isStale) staleDraftIds.add(draft.id);
    }
  }

  if (!dryRun) {
    for (const id of staleDraftIds) {
      await deletePendingDraft(id, orgId);
    }
  }

  return {
    ok: true,
    totalPendingBefore: drafts.length,
    threadsChecked: threadIds.length,
    threadsWithErrors: errors.length,
    stale: staleDraftIds.size,
    remaining: drafts.length - staleDraftIds.size,
    errors,
  };
}

// Pass ?dryRun=1 to see what would be removed without actually removing it.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const orgs = await listActiveOrganizations();
  const results: Record<string, unknown> = {};

  for (const org of orgs) {
    try {
      results[org.slug] = await reconcileStaleApprovalsForOrg(org.id, dryRun);
    } catch (err) {
      console.error(`[admin/reconcile-stale-approvals] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, dryRun, organizations: results });
}
