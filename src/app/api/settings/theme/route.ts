import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getOrganizationById, updateOrganizationTheme } from "@/lib/organizations";
import { THEMES, isValidThemeId } from "@/lib/themes";

// Settings > Appearance. Every signed-in user can change their OWN org's
// color scheme (see lib/themes.ts) — unlike coupon management, this is
// deliberately not gated to the platform operator, since theming your own
// dashboard is exactly the kind of thing any tenant should be able to do.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const org = await getOrganizationById(session.organizationId);
  return NextResponse.json({ themes: THEMES, current: org?.theme ?? "indigo" });
}

export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { theme?: string } | null;
  if (!body?.theme || !isValidThemeId(body.theme)) {
    return NextResponse.json({ error: "Unknown theme." }, { status: 400 });
  }

  await updateOrganizationTheme(session.organizationId, body.theme);
  return NextResponse.json({ ok: true });
}
