import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { canManageConstruction } from "@/lib/construction";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { getUserByEmail } from "@/lib/users";
import { deleteConstructionBudgetActivityLogEntry } from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Property-scoped (2026-08-21) — Seni only on Legacy Colombia (same policy
// as import/delete on the budget itself, and as Construction Management's
// own log-entry delete); any CEO login on every other property.
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
    const ok = await deleteConstructionBudgetActivityLogEntry(session.organizationId, groupId, body.id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such log entry." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("DELETE /api/construction-budget/log failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
