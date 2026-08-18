import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { getDefaultOrganizationId } from "@/lib/organizations";
import {
  createTeamRequest,
  deleteTeamRequest,
  getOldestPendingTeamRequestForTaggedEmail,
  setCompleted,
  setDecision,
} from "@/lib/teamRequests";
import { findUserByWhatsAppPhone } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proves the Team Requests feature's DB wiring end to end against LIVE
// production Postgres (2026-08-18) — same philosophy as
// api/admin/selftest-claim: a live round trip proves something a code
// review can't. Creates a throwaway request tagged to Gabriel's real login,
// verifies the "oldest pending for this email" lookup finds it (the same
// query the WhatsApp-reply fallback uses), accepts it, completes it, then
// deletes it — self-cleaning. ADMIN_SECRET-gated.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set." }, { status: 400 });
  }

  const taggedEmail = req.nextUrl.searchParams.get("taggedEmail") || "";
  const taggedPhone = req.nextUrl.searchParams.get("taggedPhone") || "";
  if (!taggedEmail) {
    return NextResponse.json({ error: "?taggedEmail= required (a real, active login's email)." }, { status: 400 });
  }

  const steps: Record<string, unknown> = {};
  let id: string | null = null;
  try {
    const orgId = await getDefaultOrganizationId();
    steps.organizationId = orgId;

    const created = await createTeamRequest({
      organizationId: orgId,
      title: "[selftest] delete me",
      description: "Automated self-test row — safe to ignore.",
      requestedByEmail: "selftest@internal",
      requestedByName: "Self-test",
      taggedEmail,
    });
    id = created.id;
    steps.created = { id: created.id, taggedEmail: created.taggedEmail };

    const foundByLookup = await getOldestPendingTeamRequestForTaggedEmail(orgId, taggedEmail);
    steps.pendingLookupFoundIt = foundByLookup?.id === id;

    if (taggedPhone) {
      const phoneMatch = await findUserByWhatsAppPhone(orgId, taggedPhone);
      steps.phoneResolvesToTaggedEmail = phoneMatch?.email.toLowerCase() === taggedEmail.toLowerCase();
    }

    const accepted = await setDecision({
      organizationId: orgId,
      id,
      accepted: true,
      byEmail: taggedEmail,
      byName: "Self-test",
    });
    steps.accepted = accepted?.accepted === true;

    const completed = await setCompleted({
      organizationId: orgId,
      id,
      completed: true,
      byEmail: taggedEmail,
      byName: "Self-test",
    });
    steps.completed = completed?.completed === true;

    const deleted = await deleteTeamRequest(orgId, id);
    steps.deleted = deleted;
    id = null; // cleaned up

    const pass =
      steps.pendingLookupFoundIt === true &&
      steps.accepted === true &&
      steps.completed === true &&
      steps.deleted === true &&
      (taggedPhone ? steps.phoneResolvesToTaggedEmail === true : true);

    return NextResponse.json({ pass, steps });
  } catch (err) {
    if (id) await deleteTeamRequest(await getDefaultOrganizationId(), id).catch(() => {});
    return NextResponse.json(
      { pass: false, error: err instanceof Error ? err.message : "Unknown error.", steps },
      { status: 500 }
    );
  }
}
