import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { listMarketingContacts, getMarketingContactStats, deleteMarketingContact } from "@/lib/marketingContacts";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ contacts: [], stats: { total: 0, bySource: [] } });
  const session = getSessionFromRequest(req);
  // Property scoping (2026-08-17). Both calls were org-wide, so every
  // property saw the same marketing list and the same source counts. The
  // switcher cookie is only a request — effectivePropertyGroupId() re-checks
  // it against the viewer's propertyAccess so a restricted login can't read
  // another property's contacts. Same shape as api/bills/route.ts. Note the
  // stats query must use the SAME group as the list, or the totals wouldn't
  // add up to the rows on screen.
  const viewer = await getUserByEmail(session?.email ?? "").catch(() => null);
  const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const [contacts, stats] = await Promise.all([
    listMarketingContacts(session?.organizationId, groupId),
    getMarketingContactStats(session?.organizationId, groupId),
  ]);
  return NextResponse.json({ contacts, stats });
}

export async function DELETE(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  const session = getSessionFromRequest(req);
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Provide ?id=" }, { status: 400 });
  const deleted = await deleteMarketingContact(id, session?.organizationId);
  return NextResponse.json({ ok: deleted });
}
