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
  // Property scoping (2026-08-17). POST below already stamped the active
  // group on every campaign it creates, but this GET was org-wide — so every
  // property's Content tab listed every property's campaigns. Resolve the
  // group the same way POST does; the cookie is only a request, and
  // effectivePropertyGroupId() re-checks it against the viewer's
  // propertyAccess. listPiecesForCampaign() below needs no group of its own:
  // it's keyed by campaign_id, so filtering the campaigns filters the pieces.
  const viewer = await getUserByEmail(session?.email ?? "").catch(() => null);
  const campaigns = await listContentCampaigns(
    session?.organizationId,
    effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess)
  );
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
