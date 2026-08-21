import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { canManageConstruction, canWriteConstruction } from "@/lib/construction";
import {
  applyFxRate,
  deleteConstructionBudgetItem,
  getConstructionBudgetFxRate,
  listConstructionBudgetActivityLog,
  listConstructionBudgetItems,
  replaceConstructionBudgetItems,
  updateConstructionBudgetItem,
  type ImportRow,
} from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Construction Budget (2026-08-20, Seni's ask). Access is property-scoped
// (2026-08-21, Seni's ask: "make them view only for Legacy Colombia only but
// give them same access as me on all the other properties" — clarified to
// mean full Seni-level access):
//   - VIEW: CEO role OR the CONSTRUCTION login, on every property.
//   - WRITE (enter Actual COP/notes): on Legacy Colombia, Seni or the
//     CONSTRUCTION login only; on every OTHER property, any CEO login.
//   - MANAGE (import/replace the whole budget, delete a line item, delete an
//     activity-log entry): on Legacy Colombia, Seni specifically; on every
//     OTHER property, any CEO login gets this too (full Seni-level access).
// Still lives at a sibling path/route (/construction-budget,
// /api/construction-budget) rather than nested under /construction —
// src/proxy.ts now explicitly allowlists this prefix for the CONSTRUCTION
// role (widened same day) so the team can reach it to enter actuals.
function canView(role: string | undefined): boolean {
  return role === "CEO" || role === "CONSTRUCTION";
}

async function resolveGroupId(req: NextRequest, email: string) {
  const user = await getUserByEmail(email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
}

function requireViewer(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Not logged in." }, { status: 401 }) };
  if (!canView(session.role)) {
    return { error: NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 }) };
  }
  return { session };
}

export async function GET(req: NextRequest) {
  const { session, error } = requireViewer(req);
  if (error) return error;
  try {
    const groupId = await resolveGroupId(req, session.email);
    const [rawItems, log, fxRate] = await Promise.all([
      listConstructionBudgetItems(session.organizationId, groupId),
      listConstructionBudgetActivityLog(session.organizationId, groupId),
      getConstructionBudgetFxRate(session.organizationId, groupId),
    ]);
    // Budgeted (USD) is recomputed live from each row's total_cop at the
    // current rate (2026-08-20, Seni's ask) rather than staying pinned to
    // whatever fixed rate the source spreadsheet baked in at import time.
    const items = applyFxRate(rawItems, fxRate);
    return NextResponse.json({
      items,
      log,
      fxRate,
      viewerRole: session.role,
      // Drives the Import panel, the per-row/per-log delete buttons, and the
      // FX rate edit box in ConstructionBudgetBoard.tsx — Seni on Legacy
      // Colombia; any CEO login on every other property (2026-08-21).
      canManage: canManageConstruction(session.email, session.role, groupId),
      // Drives the Actual (COP)/notes entry fields and the "Funds used"
      // allocation control — same property-scoped policy as canManage, plus
      // the CONSTRUCTION login.
      canWrite: canWriteConstruction(session.email, session.role, groupId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Full re-import — replaces the entire budget for this property group. Seni
// on Legacy Colombia; any CEO login on every other property (2026-08-21).
// See ConstructionBudgetBoard.tsx for the paste-from-spreadsheet parser that
// builds this payload.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

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
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can import or change the budget on this property." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
    const count = await replaceConstructionBudgetItems(session.organizationId, groupId, body.items, session.email, user?.name ?? null);
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Editing the Actual (COP)/notes on one row — the day-to-day use of this
// tab once the budget is imported. Property-scoped write access (2026-08-21):
// Seni or the CONSTRUCTION login on Legacy Colombia, any CEO login elsewhere.
export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  // COP is the entry currency since 2026-08-21 (Seni: "make everything COP
  // on the budget section"). actualCop replaces the old actualUsd field.
  const body = (await req.json().catch(() => null)) as
    | { id?: string; actualCop?: number | null; notes?: string | null }
    | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (body.actualCop !== undefined && body.actualCop !== null && (typeof body.actualCop !== "number" || body.actualCop < 0)) {
    return NextResponse.json({ error: "Actual spend must be a positive number (COP)." }, { status: 400 });
  }

  try {
    const groupId = await resolveGroupId(req, session.email);
    if (!canWriteConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "You have view-only access to the Construction Budget." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
    const item = await updateConstructionBudgetItem({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      id: body.id,
      actualCop: body.actualCop,
      notes: body.notes !== undefined ? body.notes?.trim() || null : undefined,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    if (!item) return NextResponse.json({ error: "No such row." }, { status: 404 });
    const fxRate = await getConstructionBudgetFxRate(session.organizationId, groupId);
    return NextResponse.json({ ok: true, item: applyFxRate([item], fxRate)[0] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("PATCH /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Seni on Legacy Colombia; any CEO login on every other property (2026-08-21).
export async function DELETE(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const groupId = await resolveGroupId(req, session.email);
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can change the budget on this property." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
    const ok = await deleteConstructionBudgetItem({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      id: body.id,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such row." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("DELETE /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
