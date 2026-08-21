import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { canManageConstruction, deleteConstructionActivityLogEntry } from "@/lib/construction";

export const dynamic = "force-dynamic";

// Deleting a Construction Management activity-log entry (2026-08-20, Seni's
// ask: "only allow me, Seni Sok, to delete the activity logs"; property-
// scoped 2026-08-21 — any CEO login gets Seni-level access on every property
// except Legacy Colombia). Split out from api/construction/route.ts's DELETE
// (which removes a checklist item) since these are two different tables/
// actions — same reasoning as api/management/activities being its own route
// from api/management. Already covered by src/proxy.ts's CONSTRUCTION-role
// allowlist (it matches on the "/api/construction" prefix), though a
// CONSTRUCTION login never passes the manage check below regardless of
// property.
export async function DELETE(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can delete a log entry on this property." }, { status: 403 });
    }
    const ok = await deleteConstructionActivityLogEntry(session.organizationId, groupId, body.id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such log entry." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("DELETE /api/construction/log failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
