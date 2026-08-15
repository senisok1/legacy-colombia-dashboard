import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getOrganizationById, updateOrganizationSecondaryCurrency } from "@/lib/organizations";

// Settings > Currency. Every signed-in user can turn on (or off) their OWN
// org's USD/<currency> display toggle (see CurrencyProvider.tsx) —
// deliberately not gated to the platform operator, same reasoning as
// Settings > Appearance (api/settings/theme/route.ts): each tenant decides
// for itself whether it needs this, and which currency.
const SUPPORTED_CURRENCIES = ["COP", "EUR", "GBP", "MXN", "CAD", "BRL"];

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const org = await getOrganizationById(session.organizationId);
  return NextResponse.json({ currencies: SUPPORTED_CURRENCIES, current: org?.secondaryCurrency ?? null });
}

export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { currency?: string | null } | null;
  const currency = body?.currency ?? null;
  if (currency !== null && !SUPPORTED_CURRENCIES.includes(currency)) {
    return NextResponse.json({ error: "Unsupported currency." }, { status: 400 });
  }

  await updateOrganizationSecondaryCurrency(session.organizationId, currency);
  return NextResponse.json({ ok: true });
}
