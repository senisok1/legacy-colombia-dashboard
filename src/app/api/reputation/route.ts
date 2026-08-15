import { NextRequest, NextResponse } from "next/server";
import { listReputationEntries } from "@/lib/reputationManager";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const entries = await listReputationEntries(session?.organizationId);
  return NextResponse.json({ entries });
}
