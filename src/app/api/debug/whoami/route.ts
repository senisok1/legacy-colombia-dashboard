import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getOrganizationById, getDefaultOrganizationId } from "@/lib/organizations";

// One-off diagnostic for the Phase 3 smoke-test finding that guest-notes
// PATCH was throwing "violates foreign key constraint
// guest_notes_organization_id_fkey" — the working theory is a stale
// lc_user_session cookie (left over from an earlier signup-flow smoke test
// whose org was since deleted via api/admin/delete-test-org) pointing
// session.organizationId at an org id that no longer exists. Reports what
// the current request's session/cookie actually resolves to server-side, and
// whether that org id is still valid, without needing raw cookie access
// (lc_user_session is httpOnly). Read-only, no secrets exposed. Safe to
// leave deployed alongside the other one-off debug routes.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const defaultOrgId = await getDefaultOrganizationId();
  const sessionOrg = session ? await getOrganizationById(session.organizationId) : null;

  return NextResponse.json({
    hasSessionCookie: Boolean(session),
    session: session ? { email: session.email, organizationId: session.organizationId, role: session.role } : null,
    sessionOrgStillExists: session ? Boolean(sessionOrg) : null,
    defaultOrgId,
  });
}
