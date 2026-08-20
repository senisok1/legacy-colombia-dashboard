import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import {
  createConstructionItem,
  deleteConstructionItem,
  isConstructionOwner,
  listConstructionActivityLog,
  listConstructionItems,
  setConstructionItemCompleted,
  setConstructionItemEstimatedCompletion,
} from "@/lib/construction";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dynamic = "force-dynamic";

// Construction Management tab (2026-08-20, Seni's ask). Admin/owner (CEO)
// and the dedicated CONSTRUCTION login type only — a regular READ_ONLY
// team login never sees this tab in the nav, and this route independently
// refuses it too (defense in depth, same posture as every other route in
// this app). src/proxy.ts additionally hard-blocks a CONSTRUCTION session
// from reaching anything OTHER than this prefix.
function canAccessConstruction(role: string | undefined): boolean {
  return role === "CEO" || role === "CONSTRUCTION";
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!canAccessConstruction(session.role)) {
    return NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 });
  }

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
    const [items, log] = await Promise.all([
      listConstructionItems(session.organizationId, groupId),
      listConstructionActivityLog(session.organizationId, groupId),
    ]);
    return NextResponse.json({
      items,
      log,
      viewerRole: session.role,
      // Drives the delete buttons in ConstructionBoard.tsx — restricted to
      // Seni specifically, not every CEO login (2026-08-20, Seni's ask).
      canDelete: isConstructionOwner(session.email),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/construction failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!canAccessConstruction(session.role)) {
    return NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { title?: string; notes?: string; category?: string }
    | null;
  const title = body?.title?.trim();
  if (!title) return NextResponse.json({ error: "Give the item a title." }, { status: 400 });
  if (title.length > 300) return NextResponse.json({ error: "Keep the title under 300 characters." }, { status: 400 });
  const notes = body?.notes?.trim() || null;
  if (notes && notes.length > 2000) return NextResponse.json({ error: "Keep notes under 2000 characters." }, { status: 400 });
  const category = body?.category?.trim() || null;
  if (category && category.length > 100) {
    return NextResponse.json({ error: "Keep the category under 100 characters." }, { status: 400 });
  }

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
    const item = await createConstructionItem({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      title,
      notes,
      category,
      authorEmail: session.email,
      authorName: user?.name ?? null,
    });
    return NextResponse.json({ ok: true, item });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/construction failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Toggle completed/reopened, OR set/clear the estimated completion date
// (2026-08-20, Seni's ask: "add estimated date of completion for each open
// item for the construction team to input") — anyone with tab access (CEO
// or CONSTRUCTION), same as toggling completed always was. A single PATCH
// body only ever carries one or the other; `completed` takes priority if
// somehow both are present.
export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!canAccessConstruction(session.role)) {
    return NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { id?: string; completed?: boolean; estimatedCompletionDate?: string | null }
    | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);

    if (typeof body.completed === "boolean") {
      const item = await setConstructionItemCompleted({
        organizationId: session.organizationId,
        propertyGroupId: groupId,
        id: body.id,
        completed: body.completed,
        actorEmail: session.email,
        actorName: user?.name ?? null,
      });
      return item ? NextResponse.json({ ok: true, item }) : NextResponse.json({ error: "No such item." }, { status: 404 });
    }

    if ("estimatedCompletionDate" in body) {
      if (body.estimatedCompletionDate !== null && !DATE_RE.test(body.estimatedCompletionDate ?? "")) {
        return NextResponse.json({ error: "estimatedCompletionDate must be YYYY-MM-DD or null." }, { status: 400 });
      }
      const item = await setConstructionItemEstimatedCompletion({
        organizationId: session.organizationId,
        propertyGroupId: groupId,
        id: body.id,
        estimatedCompletionDate: body.estimatedCompletionDate ?? null,
        actorEmail: session.email,
        actorName: user?.name ?? null,
      });
      return item ? NextResponse.json({ ok: true, item }) : NextResponse.json({ error: "No such item." }, { status: 404 });
    }

    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("PATCH /api/construction failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Seni only (2026-08-20, Seni's ask) — NOT every CEO login. Ahmed and Geo
// are CEO-role too but shouldn't be able to erase a checklist item.
export async function DELETE(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!isConstructionOwner(session.email)) {
    return NextResponse.json({ error: "Only Seni can delete an item." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
    const ok = await deleteConstructionItem({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      id: body.id,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such item." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("DELETE /api/construction failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
