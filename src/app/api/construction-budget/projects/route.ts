import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { canManageConstruction } from "@/lib/construction";
import { createConstructionBudgetProject, listConstructionBudgetProjects } from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Construction Budget projects (2026-08-21, Seni's ask: "we need to be able
// to toggle between different projects within that property... House 17
// Construction... Pool Construction... upload the spreadsheet and do the
// same thing for this project"). Viewing is CEO or the CONSTRUCTION login,
// same as the rest of this tab. Creating a new project is a "manage"-tier
// action — same property-scoped policy as import/delete/FX-rate on this
// tab (Seni on Legacy Colombia; any CEO login on every other property).
function canView(role: string | undefined): boolean {
  return role === "CEO" || role === "CONSTRUCTION";
}

async function resolveGroupId(req: NextRequest, email: string) {
  const user = await getUserByEmail(email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!canView(session.role)) {
    return NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 });
  }
  try {
    const groupId = await resolveGroupId(req, session.email);
    const projects = await listConstructionBudgetProjects(session.organizationId, groupId);
    return NextResponse.json({ projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/construction-budget/projects failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) return NextResponse.json({ error: "Give the project a name." }, { status: 400 });
  if (name.length > 150) return NextResponse.json({ error: "Keep the name under 150 characters." }, { status: 400 });

  try {
    const groupId = await resolveGroupId(req, session.email);
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can add a project on this property." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
    const project = await createConstructionBudgetProject({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      name,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    return NextResponse.json({ ok: true, project });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/construction-budget/projects failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
