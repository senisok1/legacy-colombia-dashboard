import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { getUserByEmail, updateUser } from "@/lib/users";

// One-off backfill tool (2026-08-18) for setting an EXISTING login's
// WhatsApp number without resetting their password — upsertUser (used by
// api/admin/set-user-password) requires a password and would force a reset
// just to touch one field. Needed because Team Requests notifications
// (lib/teamRequestNotify.ts) depend on this column, and it's mandatory only
// for NEW logins going forward (see api/settings/users/route.ts) — existing
// team members (Gabriel, Ahmed, Geo, …) need it backfilled once. Same
// ADMIN_SECRET trust boundary as every other one-off admin route. Safe to
// leave deployed — it can only ever change a phone number, never a
// password/role/email.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { secret?: string; email?: string; phone?: string }
    | null;

  if (!body || !config.adminSecret || body.secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase();
  const phone = body.phone?.trim();
  if (!email || !phone) {
    return NextResponse.json({ error: "email and phone are required." }, { status: 400 });
  }

  try {
    const user = await getUserByEmail(email);
    if (!user) return NextResponse.json({ error: `No login found for ${email}.` }, { status: 404 });

    const updated = await updateUser(user.id, user.organizationId, { whatsappPhone: phone });
    if (!updated) return NextResponse.json({ error: "Update failed." }, { status: 500 });

    return NextResponse.json({
      ok: true,
      user: { email: updated.email, name: updated.name, whatsappPhone: updated.whatsappPhone },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
