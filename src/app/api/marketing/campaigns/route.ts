import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createCampaignBatch, listContentCampaigns, listPiecesForCampaign } from "@/lib/contentMarketing";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// GET returns every campaign plus its pieces in one shot (small dataset —
// weekly batches, not worth a separate N+1-avoiding join query yet).
export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ campaigns: [] });
  const session = getSessionFromRequest(req);
  const campaigns = await listContentCampaigns(session?.organizationId);
  const withPieces = await Promise.all(
    campaigns.map(async (campaign) => ({
      campaign,
      pieces: await listPiecesForCampaign(campaign.id, session?.organizationId),
    }))
  );
  return NextResponse.json({ campaigns: withPieces });
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const body = await req.json().catch(() => null);
  if (!body || !body.pillarAssetDescription || typeof body.pillarAssetDescription !== "string") {
    return NextResponse.json({ error: "Provide pillarAssetDescription." }, { status: 400 });
  }
  const { campaign, pieces } = await createCampaignBatch(
    {
      pillarAssetDescription: body.pillarAssetDescription,
      pillarAssetMediaUrl: body.pillarAssetMediaUrl,
      channels: Array.isArray(body.channels) ? body.channels : undefined,
    },
    session?.organizationId,
    await (async () =>
      effectivePropertyGroupId(
        req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
        (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
      ))()
  );
  return NextResponse.json({ campaign, pieces });
}
