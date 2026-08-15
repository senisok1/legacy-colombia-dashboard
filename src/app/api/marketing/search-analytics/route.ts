import { NextResponse } from "next/server";
import { isSearchAnalyticsConfigured, isGa4Configured } from "@/lib/config";
import { getSearchConsolePerformance, getGa4Overview } from "@/lib/searchAnalytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const [gsc, ga4] = await Promise.all([
    isSearchAnalyticsConfigured()
      ? getSearchConsolePerformance().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      : null,
    isGa4Configured()
      ? getGa4Overview().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      : null,
  ]);
  return NextResponse.json({ gsc, ga4 });
}
