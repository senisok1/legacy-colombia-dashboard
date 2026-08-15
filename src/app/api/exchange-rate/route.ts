import { NextRequest, NextResponse } from "next/server";
import { getUsdToRate } from "@/lib/exchangeRate";

export const dynamic = "force-dynamic";

// Backs each org's USD/<secondary currency> display toggle (see
// CurrencyProvider.tsx, lib/organizations.ts's secondaryCurrency field) —
// every page reads the current rate through this route rather than each
// component hitting the upstream FX API itself. getUsdToRate() already
// caches the live lookup in Redis for ~1h per currency with a fallback rate,
// so this route is cheap to poll from the client. `?currency=` names the
// org's chosen secondary currency (e.g. "COP"); defaults to COP for any
// caller that omits it (there's currently only one org using this feature).
export async function GET(req: NextRequest) {
  const currency = req.nextUrl.searchParams.get("currency") || "COP";
  const rate = await getUsdToRate(currency);
  return NextResponse.json(rate);
}
