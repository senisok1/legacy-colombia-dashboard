import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { listMarketingContacts, getMarketingContactStats, deleteMarketingContact } from "@/lib/marketingContacts";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ contacts: [], stats: { total: 0, bySource: [] } });
  const session = getSessionFromRequest(req);
  const [contacts, stats] = await Promise.all([
    listMarketingContacts(session?.organizationId),
    getMarketingContactStats(session?.organizationId),
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
