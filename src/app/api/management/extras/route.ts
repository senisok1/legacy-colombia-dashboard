import { NextRequest, NextResponse } from "next/server";
import {
  createBookingExtra,
  updateBookingExtra,
  deleteBookingExtra,
  isValidExtraKind,
  EXTRAS_PROPERTY_GROUP_ID,
} from "@/lib/bookingExtras";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// Paid extras per stay (2026-08-17, Seni's ask) — Management tab.
// Allowlisted for READ_ONLY team logins in src/proxy.ts: Gabriel is the one
// who actually arranges these, so he has to be able to record them.
//
// LEGACY COLOMBIA ONLY. Enforced here on the server, not just hidden in the
// UI — the property group comes from the same cookie the board reads, so a
// request made while another property is selected is rejected rather than
// silently writing an extra that would then surface under the wrong house.
//
// APPROVAL LOCK (2026-08-19, Seni's ask): editing/deleting an extra used to
// have NO owner gate at all — see the removed proxy.ts comment this fixes.
// PATCH is now blocked server-side (in updateBookingExtra's WHERE clause)
// once approved or settled, and DELETE is CEO-only. Approve/decline itself
// lives in /api/management/commissions, not here — this route only ever
// creates/edits/deletes an extra's raw figures.

// Resolved the same way the board itself resolves it, INCLUDING the user's
// propertyAccess — so someone whose access doesn't include Legacy Colombia
// can't write Colombia extras by hand-setting the cookie.
async function activeGroup(req: NextRequest, email: string): Promise<string> {
  const viewer = await getUserByEmail(email).catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
}

/** Money from an untrusted client: finite, non-negative, 2dp, capped. */
function parseMoney(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[$,\s]/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return null;
  return Math.round(n * 100) / 100;
}

type Body = {
  id?: string;
  bookingId?: number;
  kind?: string;
  customLabel?: string | null;
  serviceDate?: string | null;
  guestPaid?: unknown;
  vendorPaid?: unknown;
  notes?: string | null;
};

function validate(body: Body | null): { error: string } | {
  kind: string;
  customLabel: string | null;
  serviceDate: string | null;
  guestPaid: number;
  vendorPaid: number;
  notes: string | null;
} {
  if (!body) return { error: "Invalid body." };
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!isValidExtraKind(kind)) return { error: "Unknown extra type." };

  const customLabel =
    kind === "other" && typeof body.customLabel === "string" && body.customLabel.trim()
      ? body.customLabel.trim().slice(0, 80)
      : null;
  if (kind === "other" && !customLabel) return { error: "Describe the extra when choosing Other." };

  const serviceDate =
    typeof body.serviceDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.serviceDate) ? body.serviceDate : null;

  const guestPaid = parseMoney(body.guestPaid ?? 0);
  const vendorPaid = parseMoney(body.vendorPaid ?? 0);
  if (guestPaid === null) return { error: "Amount paid by guest isn't a valid number." };
  if (vendorPaid === null) return { error: "Amount paid to the vendor isn't a valid number." };
  // Margin is guestPaid - vendorPaid, split 50/50 between the house and
  // Gabriel — so a vendor cost above what the guest paid would render a
  // negative margin. Catch it at the door with a plain-English reason
  // rather than displaying a number that looks like a bug.
  if (vendorPaid > guestPaid) {
    return { error: "Amount paid to the vendor can't be more than the guest paid — that would make the margin negative." };
  }

  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;
  return { kind, customLabel, serviceDate, guestPaid, vendorPaid, notes };
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if ((await activeGroup(req, session.email)) !== EXTRAS_PROPERTY_GROUP_ID) {
    return NextResponse.json({ error: "Extras are only tracked for Legacy Colombia." }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (typeof body?.bookingId !== "number" || !Number.isFinite(body.bookingId)) {
    return NextResponse.json({ error: "bookingId is required." }, { status: 400 });
  }
  const parsed = validate(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const extra = await createBookingExtra({
      organizationId: session.organizationId,
      bookingId: body.bookingId,
      ...parsed,
      createdBy: session.email,
    });
    return NextResponse.json({ ok: true, extra });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/management/extras failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if ((await activeGroup(req, session.email)) !== EXTRAS_PROPERTY_GROUP_ID) {
    return NextResponse.json({ error: "Extras are only tracked for Legacy Colombia." }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (typeof body?.id !== "string" || !body.id) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }
  const parsed = validate(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const extra = await updateBookingExtra({
      organizationId: session.organizationId,
      id: body.id,
      ...parsed,
      updatedBy: session.email,
      requesterIsOwner: session.role === "CEO",
    });
    if (!extra) {
      return NextResponse.json(
        {
          error:
            "That extra no longer exists, it's already been approved or settled and can't be edited, or it belongs to someone else.",
        },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, extra });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("PATCH /api/management/extras failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// CEO-only (2026-08-19, Seni's ask). Same posture as team-expenses' DELETE —
// deleting a commission line entirely is the owner's call, not the team
// member who logged it. proxy.ts no longer reaches this for a READ_ONLY
// session at all; this check is the real gate either way.
export async function DELETE(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (session.role !== "CEO") {
    return NextResponse.json({ error: "Only the owner can delete an extra." }, { status: 403 });
  }
  if ((await activeGroup(req, session.email)) !== EXTRAS_PROPERTY_GROUP_ID) {
    return NextResponse.json({ error: "Extras are only tracked for Legacy Colombia." }, { status: 400 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    await deleteBookingExtra(session.organizationId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("DELETE /api/management/extras failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
