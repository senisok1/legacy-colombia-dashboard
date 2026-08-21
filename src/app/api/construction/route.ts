import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, isColombiaGroup } from "@/lib/propertyGroups";
import {
  canManageConstruction,
  canWriteConstruction,
  createConstructionItem,
  deleteConstructionItem,
  listConstructionActivityLog,
  listConstructionFundAllocations,
  listConstructionItems,
  setConstructionItemCompleted,
  setConstructionItemEstimatedCompletion,
  setConstructionItemEstimatedCost,
  updateConstructionItem,
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

async function resolveGroupId(req: NextRequest, session: { email: string }): Promise<string> {
  const user = await getUserByEmail(session.email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!canAccessConstruction(session.role)) {
    return NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 });
  }

  try {
    const groupId = await resolveGroupId(req, session);
    const [items, log, allocations] = await Promise.all([
      listConstructionItems(session.organizationId, groupId),
      listConstructionActivityLog(session.organizationId, groupId),
      // Fund allocations (2026-08-21) — COP drawn from the deposited
      // construction funds against specific open items; the board sums
      // these per item client-side.
      listConstructionFundAllocations(session.organizationId, groupId),
    ]);
    return NextResponse.json({
      items,
      log,
      allocations,
      // Drives ConstructionBoard.tsx: Legacy Colombia labels estimated
      // cost/allocations "(COP)"; every other property labels the same
      // fields "(USD)" (2026-08-21, Seni's ask: "USD ONLY for all tabs and
      // sections") — no conversion either way, just the correct label for
      // what's actually being entered on that property.
      currencyMode: isColombiaGroup(groupId) ? "cop" : "usd",
      viewerRole: session.role,
      // Drives the delete buttons in ConstructionBoard.tsx — Seni always;
      // any other CEO login also gets it on every property EXCEPT Legacy
      // Colombia (2026-08-21, Seni's ask: view-only on Colombia, Seni-level
      // access elsewhere).
      canDelete: canManageConstruction(session.email, session.role, groupId),
      // Drives add/edit/toggle/estimated-cost/allocate controls — same tiers
      // as canDelete, plus the CONSTRUCTION login (Colombia-only in
      // practice).
      canWrite: canWriteConstruction(session.email, session.role, groupId),
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
    const groupId = await resolveGroupId(req, session);
    if (!canWriteConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "You have view-only access to Construction Management." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
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

// Toggle completed/reopened, set/clear the estimated completion date, OR
// edit title/notes/category (2026-08-20, Seni's ask: "an edit tab next to
// progress notes so that I can modify the 'add an item' description") —
// anyone with tab access (CEO or CONSTRUCTION), same as everything else
// here. A single PATCH body only ever carries one kind of update; checked
// in order (completed, then estimatedCompletionDate, then title/notes/
// category) with `completed` taking priority if somehow more than one is
// present.
export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        id?: string;
        completed?: boolean;
        estimatedCompletionDate?: string | null;
        estimatedCostCop?: number | null;
        title?: string;
        notes?: string | null;
        category?: string | null;
      }
    | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const groupId = await resolveGroupId(req, session);
    if (!canWriteConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "You have view-only access to Construction Management." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);

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

    if ("estimatedCostCop" in body) {
      if (body.estimatedCostCop !== null && (typeof body.estimatedCostCop !== "number" || body.estimatedCostCop < 0)) {
        return NextResponse.json({ error: "Estimated cost must be a positive number or null." }, { status: 400 });
      }
      const item = await setConstructionItemEstimatedCost({
        organizationId: session.organizationId,
        propertyGroupId: groupId,
        id: body.id,
        estimatedCostCop: body.estimatedCostCop ?? null,
        actorEmail: session.email,
        actorName: user?.name ?? null,
      });
      return item ? NextResponse.json({ ok: true, item }) : NextResponse.json({ error: "No such item." }, { status: 404 });
    }

    if (body.title !== undefined || body.notes !== undefined || body.category !== undefined) {
      const title = body.title !== undefined ? body.title.trim() : undefined;
      if (title !== undefined) {
        if (!title) return NextResponse.json({ error: "Give the item a title." }, { status: 400 });
        if (title.length > 300) return NextResponse.json({ error: "Keep the title under 300 characters." }, { status: 400 });
      }
      const notes = body.notes !== undefined ? body.notes?.trim() || null : undefined;
      if (notes && notes.length > 2000) return NextResponse.json({ error: "Keep notes under 2000 characters." }, { status: 400 });
      const category = body.category !== undefined ? body.category?.trim() || null : undefined;
      if (category && category.length > 100) {
        return NextResponse.json({ error: "Keep the category under 100 characters." }, { status: 400 });
      }
      const item = await updateConstructionItem({
        organizationId: session.organizationId,
        propertyGroupId: groupId,
        id: body.id,
        title,
        notes,
        category,
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

// Seni always; any other CEO login also gets this on every property EXCEPT
// Legacy Colombia (2026-08-21, Seni's ask: view-only for Ahmed/Geo on
// Colombia, full Seni-level access — including delete — everywhere else).
export async function DELETE(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const groupId = await resolveGroupId(req, session);
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can delete an item on this property." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
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
