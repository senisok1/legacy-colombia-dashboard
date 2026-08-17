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
  // Property scoping (2026-08-17). POST below already stamped the active
  // group on every new piece, but this GET was org-wide — so a piece written
  // for Legacy Pompano still showed up on Legacy Miami's Content tab. Resolve
  // the group the same way POST does; the cookie is only a request, and
  // effectivePropertyGroupId() re-checks it against the viewer's
  // propertyAccess.
  const viewer = await getUserByEmail(session?.email ?? "").catch(() => null);
  const pieces = await listContentPieces(
    session?.organizationId,
    effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess)
  );
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
