import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import {
  addConstructionFundAllocation,
  deleteConstructionFundAllocation,
  isConstructionOwner,
} from "@/lib/construction";

export const dynamic = "force-dynamic";

// Fund allocations (2026-08-21, Seni's ask: "allocate deposited
// construction funds in COP to those open item expenses as well so every
// dollar is accounted for"). Adding is open to anyone with tab access (CEO
// or CONSTRUCTION — same policy as entering an estimated cost or a budget
// line's actual); removing changes the funds accounting and is Seni-only,
// same trust tier as removing a deposit. The list itself rides the main
// GET /api/construction response.
function canAccess(role: string | undefined): boolean {
  return role === "CEO" || role === "CONSTRUCTION";
}

// Adding an allocation is write access, narrower than view (2026-08-21,
// Seni's ask: "Do not allow Ahmed and Geo to have any add edit allocate on
// the construction tabs. They can have view only") — Seni or the dedicated
// CONSTRUCTION login only. A plain CEO login that isn't Seni is view-only.
function canWrite(session: { role?: string; email: string }): boolean {
  return isConstructionOwner(session.email) || session.role === "CONSTRUCTION";
}

async function resolveGroupId(req: NextRequest, email: string) {
  const user = await getUserByEmail(email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!canWrite(session)) {
    return NextResponse.json({ error: "You have view-only access to Construction." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { itemId?: string; amountCop?: number; note?: string }
    | null;
  if (!body?.itemId) return NextResponse.json({ error: "itemId is required." }, { status: 400 });
  if (typeof body.amountCop !== "number" || !Number.isFinite(body.amountCop) || body.amountCop <= 0) {
    return NextResponse.json({ error: "Enter a positive amount (COP)." }, { status: 400 });
  }
  if (body.note && body.note.length > 500) {
    return NextResponse.json({ error: "Note is too long (500 characters max)." }, { status: 400 });
  }

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = await resolveGroupId(req, session.email);
    const allocation = await addConstructionFundAllocation({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      itemId: body.itemId,
      amountCop: body.amountCop,
      note: body.note?.trim() || null,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    if (!allocation) return NextResponse.json({ error: "No such item." }, { status: 404 });
    return NextResponse.json({ ok: true, allocation });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/construction/allocations failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!isConstructionOwner(session.email)) {
    return NextResponse.json({ error: "Only Seni can remove an allocation." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const user = await getUserByEmail(session.email).catch(() => null);
    const groupId = await resolveGroupId(req, session.email);
    const ok = await deleteConstructionFundAllocation({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      id: body.id,
      actorEmail: session.email,
      actorName: user?.name ?? null,
    });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such allocation." }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("DELETE /api/construction/allocations failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
