import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail, updateUser, verifyPassword } from "@/lib/users";

export const dynamic = "force-dynamic";

// Self-serve password change (2026-08-17, Seni's ask: "let's also allow the
// team member to change their own password if they want to"). Deliberately
// scoped to the CALLER'S OWN login only — the userId is never taken from the
// request body, it's resolved from the signed session cookie, so this can't
// be used to reset anyone else's password. The current password must be
// supplied and verified, so a borrowed/unattended browser session can't
// lock the real owner out.
//
// Allowlisted for READ_ONLY sessions in src/proxy.ts (it's a POST, but the
// only thing it can touch is the caller's own credential).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { currentPassword?: string; newPassword?: string }
    | null;

  if (!body?.currentPassword || !body?.newPassword) {
    return NextResponse.json({ error: "Current and new password are both required." }, { status: 400 });
  }
  if (body.newPassword.length < 8) {
    return NextResponse.json({ error: "Your new password must be at least 8 characters." }, { status: 400 });
  }
  if (body.newPassword === body.currentPassword) {
    return NextResponse.json({ error: "That's the same password you already have." }, { status: 400 });
  }

  try {
    const me = await getUserByEmail(session.email);
    if (!me) {
      // Possible for a legacy shared-password session with no user row.
      return NextResponse.json(
        { error: "This session isn't tied to a personal login — ask the owner to create one for you." },
        { status: 400 }
      );
    }

    const ok = await verifyPassword(me, body.currentPassword);
    if (!ok) return NextResponse.json({ error: "That current password isn't right." }, { status: 400 });

    const updated = await updateUser(me.id, me.organizationId, { password: body.newPassword });
    if (!updated) return NextResponse.json({ error: "Couldn't update the password." }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}
