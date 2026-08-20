import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import {
  deleteConstructionBudgetItem,
  listConstructionBudgetItems,
  replaceConstructionBudgetItems,
  updateConstructionBudgetItem,
  type ImportRow,
} from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Construction Budget (2026-08-20, Seni's ask) — admin/owner (CEO) ONLY,
// stricter than the Construction Management checklist (which the
// CONSTRUCTION login role can also use): real budget numbers (unit prices,
// totals) are more sensitive than an open-items checklist, and the
// dedicated CONSTRUCTION login is meant for the construction team, not for
// seeing the owner's budget. Lives at a sibling path/route
// (/construction-budget, /api/construction-budget) rather than nested under
// /construction so it does NOT match src/proxy.ts's CONSTRUCTION-role
// allowlist (which only covers the literal "/construction" prefix) — that
// login is hard-blocked here without needing any proxy.ts changes.
function requireCeo(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Not logged in." }, { status: 401 }) };
  if (session.role !== "CEO") {
    return { error: NextResponse.json({ error: "Admin/owner only." }, { status: 403 }) };
  }
  return { session };
}

async function resolveGroupId(req: NextRequest, email: string) {
  const user = await getUserByEmail(email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
}

export async function GET(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;
  try {
    const groupId = await resolveGroupId(req, session.email);
    const items = await listConstructionBudgetItems(session.organizationId, groupId);
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Full re-import — replaces the entire budget for this property group. See
// ConstructionBudgetBoard.tsx for the paste-from-spreadsheet parser that
// builds this payload.
export async function POST(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { items?: ImportRow[] } | null;
  if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "No rows to import." }, { status: 400 });
  }
  if (body.items.length > 2000) {
    return NextResponse.json({ error: "That's more rows than expected (2000 max) — check the paste." }, { status: 400 });
  }
  for (const item of body.items) {
    if (!item.category?.trim() || !item.description?.trim()) {
      return NextResponse.json({ error: "Every row needs a category and a description." }, { status: 400 });
    }
  }

  try {
    const groupId = await resolveGroupId(req, session.email);
    const count = await replaceConstructionBudgetItems(session.organizationId, groupId, body.items);
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Editing the Actual (USD)/notes on one row — the day-to-day use of this
// tab once the budget is imported.
export async function PATCH(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | { id?: string; actualUsd?: number | null; notes?: string | null }
    | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (body.actualUsd !== undefined && body.actualUsd !== null && (typeof body.actualUsd !== "number" || body.actualUsd < 0)) {
    return NextResponse.json({ error: "Actual spend must be a positive number." }, { status: 400 });
  }

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = await resolveGroupId(req, session.email);
    const item = await updateConstructionBudgetItem({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      id: body.id,
      actualUsd: body.actualUsd,
      notes: body.notes !== undefined ? body.notes?.trim() || null : undefined,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    return item ? NextResponse.json({ ok: true, item }) : NextResponse.json({ error: "No such row." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("PATCH /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const groupId = await resolveGroupId(req, session.email);
    const ok = await deleteConstructionBudgetItem(session.organizationId, groupId, body.id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such row." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("DELETE /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
