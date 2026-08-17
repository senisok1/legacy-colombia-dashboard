import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createContentPiece, listContentPieces } from "@/lib/contentMarketing";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import type { ContentPieceType } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_TYPES: ContentPieceType[] = ["blog", "social", "email"];

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ pieces: [] });
  const session = getSessionFromRequest(req);
  const pieces = await listContentPieces(session?.organizationId);
  return NextResponse.json({ pieces });
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const body = await req.json().catch(() => null);
  if (!body || !body.topic || !VALID_TYPES.includes(body.contentType)) {
    return NextResponse.json({ error: `Provide topic and contentType (one of: ${VALID_TYPES.join(", ")}).` }, { status: 400 });
  }
  const piece = await createContentPiece(
    {
      contentType: body.contentType,
      topic: body.topic,
      channel: body.channel,
      targetKeyword: body.targetKeyword,
    },
    session?.organizationId,
    await (async () =>
      effectivePropertyGroupId(
        req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
        (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
      ))()
  );
  return NextResponse.json({ piece });
}
