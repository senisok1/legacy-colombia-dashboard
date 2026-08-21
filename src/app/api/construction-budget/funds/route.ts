import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, isColombiaGroup } from "@/lib/propertyGroups";
import {
  canManageConstruction,
  getTotalConstructionFundAllocationsCop,
  listConstructionFundAllocations,
} from "@/lib/construction";
import {
  addConstructionFundsDeposit,
  deleteConstructionFundsDeposit,
  getConstructionBudgetFxRate,
  getConstructionFundsSpendByCategory,
  listConstructionBudgetItems,
  listConstructionFundsDeposits,
} from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Construction Funds (2026-08-20, Seni's ask: "a 'remaining balance' box
// that shows construction funds I've deposited but haven't been used yet...
// a column that shows where the balance is spent so that funds that I
// deposit are always accounted for"). Viewing is CEO or the CONSTRUCTION
// login, on every property. Logging/removing a deposit — a real money event,
// not day-to-day budget upkeep — is property-scoped (2026-08-21, Seni's
// ask): Seni specifically on Legacy Colombia, any CEO login on every other
// property (full Seni-level access there).
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

async function resolveGroupId(req: NextRequest, email: string) {
  const user = await getUserByEmail(email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
}

export async function GET(req: NextRequest) {
  const { session, error } = requireViewer(req);
  if (error) return error;
  try {
    const groupId = await resolveGroupId(req, session.email);
    const colombia = isColombiaGroup(groupId);
    // ALL COP since 2026-08-21 (Seni: "make everything COP... I will enter
    // the amounts deposited in COP as well"). USD is display-only, derived
    // client-side from fxRate. "Spent" = budget lines' actual COP + fund
    // allocations to Construction Management open items ("every dollar is
    // accounted for"). USD-only properties (2026-08-21) skip the rate
    // lookup entirely — see api/construction-budget/route.ts's header
    // comment for why rate 1 is the correct passthrough.
    const [deposits, items, spendByCategory, allocations, allocatedCop, fxRate] = await Promise.all([
      listConstructionFundsDeposits(session.organizationId, groupId),
      listConstructionBudgetItems(session.organizationId, groupId),
      getConstructionFundsSpendByCategory(session.organizationId, groupId),
      listConstructionFundAllocations(session.organizationId, groupId),
      getTotalConstructionFundAllocationsCop(session.organizationId, groupId),
      colombia ? getConstructionBudgetFxRate(session.organizationId, groupId) : Promise.resolve(1),
    ]);
    const totalDepositedCop = deposits.reduce((s, d) => s + d.amountCop, 0);
    const budgetSpentCop = items.reduce((s, i) => s + (i.actualCop ?? 0), 0);
    const totalSpentCop = budgetSpentCop + allocatedCop;
    return NextResponse.json({
      deposits,
      totalDepositedCop,
      budgetSpentCop,
      allocatedCop,
      totalSpentCop,
      remainingCop: totalDepositedCop - totalSpentCop,
      spendByCategory,
      allocations,
      fxRate,
      currencyMode: colombia ? "cop" : "usd",
      canManage: canManageConstruction(session.email, session.role, groupId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/construction-budget/funds failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { amountCop?: number; note?: string; depositedAt?: string } | null;
  if (typeof body?.amountCop !== "number" || !Number.isFinite(body.amountCop) || body.amountCop <= 0) {
    return NextResponse.json({ error: "Enter a positive deposit amount." }, { status: 400 });
  }
  if (body.depositedAt && !/^\d{4}-\d{2}-\d{2}$/.test(body.depositedAt)) {
    return NextResponse.json({ error: "Invalid date." }, { status: 400 });
  }
  if (body.note && body.note.length > 500) {
    return NextResponse.json({ error: "Note is too long (500 characters max)." }, { status: 400 });
  }

  try {
    const groupId = await resolveGroupId(req, session.email);
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can log deposits on this property." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
    const deposit = await addConstructionFundsDeposit({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      amountCop: body.amountCop,
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
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const groupId = await resolveGroupId(req, session.email);
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can remove deposits on this property." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
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
