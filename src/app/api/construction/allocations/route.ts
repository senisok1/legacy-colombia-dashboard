import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import {
  addConstructionFundAllocation,
  canManageConstruction,
  canWriteConstruction,
  deleteConstructionFundAllocation,
} from "@/lib/construction";

export const dynamic = "force-dynamic";

// Fund allocations (2026-08-21, Seni's ask: "allocate deposited
// construction funds in COP to those open item expenses as well so every
// dollar is accounted for"). Access is property-scoped (2026-08-21, later
// same day: "make them view only for Legacy Colombia only but give them
// same access as me on all the other properties" — Seni-level access, not
// just standard write): on Legacy Colombia, adding is Seni-or-CONSTRUCTION
// only and removing is Seni-only; on every other property, any CEO login
// gets full Seni-level rights (add AND remove) via canManageConstruction.
async function resolveGroupId(req: NextRequest, email: string) {
  const user = await getUserByEmail(email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, user?.propertyAccess);
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

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
    const groupId = await resolveGroupId(req, session.email);
    if (!canWriteConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "You have view-only access to Construction." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
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

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const groupId = await resolveGroupId(req, session.email);
    if (!canManageConstruction(session.email, session.role, groupId)) {
      return NextResponse.json({ error: "Only Seni can remove an allocation on this property." }, { status: 403 });
    }
    const user = await getUserByEmail(session.email).catch(() => null);
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
