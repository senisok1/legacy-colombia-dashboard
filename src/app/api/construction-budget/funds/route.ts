import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { isConstructionOwner } from "@/lib/construction";
import {
  addConstructionFundsDeposit,
  deleteConstructionFundsDeposit,
  getConstructionFundsSpendByCategory,
  listConstructionBudgetItems,
  listConstructionFundsDeposits,
} from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Construction Funds (2026-08-20, Seni's ask: "a 'remaining balance' box
// that shows construction funds I've deposited but haven't been used yet...
// a column that shows where the balance is spent so that funds that I
// deposit are always accounted for"). Same two-tier access as
// /api/construction-budget: viewing is CEO or the CONSTRUCTION login;
// logging/removing a deposit is Seni specifically — a real money event, not
// day-to-day budget upkeep.
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
    return { error: NextResponse.json({ error: "Only Seni can log or remove deposits." }, { status: 403 }) };
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
    const [deposits, items, spendByCategory] = await Promise.all([
      listConstructionFundsDeposits(session.organizationId, groupId),
      listConstructionBudgetItems(session.organizationId, groupId),
      getConstructionFundsSpendByCategory(session.organizationId, groupId),
    ]);
    const totalDeposited = deposits.reduce((s, d) => s + d.amountUsd, 0);
    // Same figure as the "Actual spend recorded" card on the main budget
    // table — total real spend against deposited cash, not against budget.
    const totalSpent = items.reduce((s, i) => s + (i.actualUsd ?? 0), 0);
    return NextResponse.json({
      deposits,
      totalDeposited,
      totalSpent,
      remaining: totalDeposited - totalSpent,
      spendByCategory,
      canManage: isConstructionOwner(session.email),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/construction-budget/funds failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { session, error } = requireManager(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { amountUsd?: number; note?: string; depositedAt?: string } | null;
  if (typeof body?.amountUsd !== "number" || !Number.isFinite(body.amountUsd) || body.amountUsd <= 0) {
    return NextResponse.json({ error: "Enter a positive deposit amount." }, { status: 400 });
  }
  if (body.depositedAt && !/^\d{4}-\d{2}-\d{2}$/.test(body.depositedAt)) {
    return NextResponse.json({ error: "Invalid date." }, { status: 400 });
  }
  if (body.note && body.note.length > 500) {
    return NextResponse.json({ error: "Note is too long (500 characters max)." }, { status: 400 });
  }

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = await resolveGroupId(req, session.email);
    const deposit = await addConstructionFundsDeposit({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      amountUsd: body.amountUsd,
      note: body.note?.trim() || null,
      depositedAt: body.depositedAt ?? null,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    return NextResponse.json({ ok: true, deposit });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/construction-budget/funds failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { session, error } = requireManager(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = await resolveGroupId(req, session.email);
    const ok = await deleteConstructionFundsDeposit({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      id: body.id,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such deposit." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("DELETE /api/construction-budget/funds failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
