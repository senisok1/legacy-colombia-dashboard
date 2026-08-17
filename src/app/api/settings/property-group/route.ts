import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { PROPERTY_GROUP_COOKIE, isValidPropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// Sets the active property view (Legacy Colombia / Legacy Alva ...) as a
// cookie — the whole dashboard re-scopes to it on the next render. A view
// preference, not a data change, so every role may set it (allowlisted for
// READ_ONLY in src/proxy.ts).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { groupId?: string } | null;
  if (!isValidPropertyGroupId(body?.groupId)) {
    return NextResponse.json({ error: "Unknown property." }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, groupId: body!.groupId });
  res.cookies.set(PROPERTY_GROUP_COOKIE, body!.groupId!, {
    httpOnly: false, // nothing secret — just a view preference
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
