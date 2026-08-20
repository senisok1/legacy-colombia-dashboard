import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { isConstructionOwner } from "@/lib/construction";
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

// Construction Budget (2026-08-20, Seni's ask). Two tiers of access, tightened
// further 2026-08-20 (Seni: "make sure that I, Seni Sok, is the only one that
// can import budgets or change budgets. The construction team member can
// enter actual amount as well"):
//   - VIEW + enter Actual (USD)/notes: CEO role OR the CONSTRUCTION login.
//   - Import (replace the whole budget) / delete a line item / delete an
//     activity-log entry: Seni specifically (isConstructionOwner), not any
//     CEO login — Ahmed and Geo are CEO-role too but can no longer restructure
//     the budget, same policy as Construction Management's checklist deletes.
// Still lives at a sibling path/route (/construction-budget,
// /api/construction-budget) rather than nested under /construction —
// src/proxy.ts now explicitly allowlists this prefix for the CONSTRUCTION
// role (widened same day) so the team can reach it to enter actuals.
function canView(role: string | undefined): boolean {
  return role === "CEO" || role === "CONSTRUCTION";
}

function requireViewer(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Not logged in." }, { status: 401 }) };
  if (!canView(session.role)) {
    return { error: NextResponse.json({ error: "This area is admin/construction-team only." }, { status: 403 }) };
  }
  return { session };
}

function requireManager(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Not logged in." }, { status: 401 }) };
  if (!isConstructionOwner(session.email)) {
    return { error: NextResponse.json({ error: "Only Seni can import or change the budget." }, { status: 403 }) };
  }
  return { session };
}

async function resolveGroupId(req: NextRequest, email: string) {
  const user = await getUserByEmail(email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
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
      // FX rate edit box in ConstructionBudgetBoard.tsx — Seni specifically,
      // not every CEO login.
      canManage: isConstructionOwner(session.email),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Full re-import — replaces the entire budget for this property group. See
// ConstructionBudgetBoard.tsx for the paste-from-spreadsheet parser that
// builds this payload. Seni only.
export async function POST(req: NextRequest) {
  const { session, error } = requireManager(req);
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
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = await resolveGroupId(req, session.email);
    const count = await replaceConstructionBudgetItems(session.organizationId, groupId, body.items, session.email, user?.name ?? null);
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Editing the Actual (USD)/notes on one row — the day-to-day use of this
// tab once the budget is imported. Open to CEO or the CONSTRUCTION login
// (2026-08-20, Seni's ask: "the construction team member can enter actual
// amount as well") — this is deliberately NOT gated to Seni like POST/DELETE.
export async function PATCH(req: NextRequest) {
  const { session, error } = requireViewer(req);
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
    if (!item) return NextResponse.json({ error: "No such row." }, { status: 404 });
    const fxRate = await getConstructionBudgetFxRate(session.organizationId, groupId);
    return NextResponse.json({ ok: true, item: applyFxRate([item], fxRate)[0] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("PATCH /api/construction-budget failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Seni only (2026-08-20, Seni's ask) — NOT every CEO login.
export async function DELETE(req: NextRequest) {
  const { session, error } = requireManager(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = await resolveGroupId(req, session.email);
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
