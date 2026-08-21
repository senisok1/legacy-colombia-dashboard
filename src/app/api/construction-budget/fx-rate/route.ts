import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { canManageConstruction } from "@/lib/construction";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, isColombiaGroup } from "@/lib/propertyGroups";
import { setConstructionBudgetFxRate } from "@/lib/constructionBudget";

export const dynamic = "force-dynamic";

// Editable COP -> USD exchange rate (2026-08-20, Seni's ask: "add a box
// somewhere where I can modify that rate which will then modify the USD
// budget"). Property-scoped (2026-08-21, Seni's ask): Seni only on Legacy
// Colombia — the rate materially changes every Budgeted (USD) figure on the
// tab, same "changing the budget" policy as import/delete (see
// api/construction-budget/route.ts) — but any CEO login gets this on every
// other property (full Seni-level access there).
//
// USD-ONLY GATE (2026-08-21, Seni's ask: "for all properties except Legacy
// Colombia... remove the toggle and exchange rate feature. USD ONLY for all
// tabs and sections"). Legacy Colombia is the only property that tracks its
// construction project in COP at all — every other property is hard-blocked
// from ever setting a rate here, not just hidden from the UI, so a stray
// client call (or a future UI bug) can't silently start converting a
// USD-only property's figures.
export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

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
    if (!isColombiaGroup(groupId)) {
      return NextResponse.json(
        { error: "This property tracks construction spend in USD only — there's no exchange rate to set." },
        { status: 400 }
      );
    }
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can change the exchange rate on this property." }, { status: 403 });
    }
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
