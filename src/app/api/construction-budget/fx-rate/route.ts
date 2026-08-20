import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { isConstructionOwner } from "@/lib/construction";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { setConstructionBudgetFxRate } from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Editable COP -> USD exchange rate (2026-08-20, Seni's ask: "add a box
// somewhere where I can modify that rate which will then modify the USD
// budget"). Seni only — the rate materially changes every Budgeted (USD)
// figure on the tab, same "changing the budget" policy as import/delete
// (see api/construction-budget/route.ts's requireManager, mirrored here).
export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!isConstructionOwner(session.email)) {
    return NextResponse.json({ error: "Only Seni can change the exchange rate." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { rate?: number } | null;
  if (typeof body?.rate !== "number" || !Number.isFinite(body.rate) || body.rate <= 0) {
    return NextResponse.json({ error: "Rate must be a positive number." }, { status: 400 });
  }
  if (body.rate > 100000) {
    return NextResponse.json({ error: "That doesn't look like a COP/USD rate — check the number." }, { status: 400 });
  }

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
    const rate = await setConstructionBudgetFxRate({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      rate: body.rate,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    return NextResponse.json({ ok: true, fxRate: rate });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("PATCH /api/construction-budget/fx-rate failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
