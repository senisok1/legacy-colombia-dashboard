import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { addConstructionBudgetItemNote, listConstructionBudgetItemNotes } from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Per-budget-item notes thread (2026-08-20, Seni's ask: "add a notes button
// for each item in the budget for any user to add notes"). Same viewer gate
// as api/construction-budget/route.ts's GET/PATCH — CEO or the CONSTRUCTION
// login, both of whom can read and add notes. Deliberately NOT restricted to
// Seni like import/delete/FX-rate — Seni's ask was explicitly "any user" —
// and there's no delete here at all (append-only progress log, same as
// Construction Management's Progress Notes), so no owner-only branch needed.
function canView(role: string | undefined): boolean {
  return role === "CEO" || role === "CONSTRUCTION";
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!canView(session.role)) {
    return NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 });
  }
  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!itemId) return NextResponse.json({ error: "itemId is required." }, { status: 400 });

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
    const notes = await listConstructionBudgetItemNotes(session.organizationId, groupId, itemId);
    return NextResponse.json({ notes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/construction-budget/notes failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!canView(session.role)) {
    return NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { itemId?: string; body?: string } | null;
  const itemId = body?.itemId;
  const text = body?.body?.trim();
  if (!itemId) return NextResponse.json({ error: "itemId is required." }, { status: 400 });
  if (!text) return NextResponse.json({ error: "Write something before posting." }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: "Keep notes under 2000 characters." }, { status: 400 });

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
    const note = await addConstructionBudgetItemNote({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      itemId,
      body: text,
      authorEmail: session.email,
      authorName: user?.name ?? null,
    });
    return note ? NextResponse.json({ ok: true, note }) : NextResponse.json({ error: "No such row." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/construction-budget/notes failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
