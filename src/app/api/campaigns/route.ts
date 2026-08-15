import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { listCampaignCandidates } from "@/lib/lifecycleMarketing";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ candidates: [] });
  const session = getSessionFromRequest(req);
  const candidates = await listCampaignCandidates(session?.organizationId);
  return NextResponse.json({ candidates });
}
