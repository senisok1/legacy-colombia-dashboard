import { NextRequest, NextResponse } from "next/server";
import { getAllPendingDrafts } from "@/lib/pendingDrafts";
import { isMessagingConfigured } from "@/lib/config";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// Powers the Approvals tab (app/approvals/page.tsx + components/ApprovalsQueue.tsx)
// and the pending-count badge in the nav bar. Reads the exact same Redis-backed
// queue the WhatsApp approval flow and the Messaging inbox's per-thread
// suggestion card already use (see lib/pendingDrafts.ts) — this just flattens
// it into one list across every conversation, so nothing here is a second
// source of truth for "what's awaiting approval."
//
// Phase 3 smoke-test finding (2026-08-05): this route had NO session wiring
// at all — approvals/page.tsx's initial server-render was already correctly
// org-scoped, but ApprovalsQueue.tsx (and the nav bar's badge poll) both
// re-fetch this route client-side to refresh, which was silently swapping in
// the DEFAULT org's approval queue for every tenant after the first load.
export async function GET(req: NextRequest) {
  if (!isMessagingConfigured()) {
    return NextResponse.json({ drafts: [] });
  }
  const session = getSessionFromRequest(req);
  const drafts = await getAllPendingDrafts(
      session?.organizationId,
      effectivePropertyGroupId(
        req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
        (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
      )
    );
  return NextResponse.json({ drafts });
}
