import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { deleteUser, getUserByEmail, listUsers, setUserActive, upsertUser } from "@/lib/users";

export const dynamic = "force-dynamic";

// Settings → Team logins (2026-08-16, Seni's ask: "give me the ability to
// create future admin accounts on the CRM itself under the settings tab").
// CEO-only management of the org's logins: list, create/reset, deactivate.
// READ_ONLY sessions never get here for writes (proxy blocks them), but the
// CEO check below also keeps them from LISTING logins via GET.

function requireCeo(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Not logged in." }, { status: 401 }) };
  if (session.role !== "CEO") {
    return { error: NextResponse.json({ error: "Only an admin (CEO) login can manage team logins." }, { status: 403 }) };
  }
  return { session };
}

export async function GET(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;
  try {
    const users = await listUsers(session.organizationId);
    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        active: u.active,
        isYou: u.email.toLowerCase() === session.email.toLowerCase(),
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | { email?: string; name?: string; password?: string; role?: string }
    | null;

  const email = body?.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }
  if (!body?.password || body.password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  const role = body.role === "CEO" ? ("CEO" as const) : ("READ_ONLY" as const);

  // Lockout guard: an admin editing their OWN account can't demote
  // themselves out of admin access.
  if (email === session.email.toLowerCase() && role !== "CEO") {
    return NextResponse.json({ error: "You can't remove admin access from your own login." }, { status: 400 });
  }

  try {
    // Hijack guard: upsertUser's on-conflict(email) update is global —
    // without this check, "creating" an email that belongs to ANOTHER
    // organization would silently take over that account.
    const existing = await getUserByEmail(email);
    if (existing && existing.organizationId !== session.organizationId) {
      return NextResponse.json({ error: "That email is already in use." }, { status: 409 });
    }

    const user = await upsertUser({
      email,
      password: body.password,
      name: body.name?.trim() || undefined,
      role,
      organizationId: session.organizationId,
    });
    return NextResponse.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active },
      reset: Boolean(existing),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { userId?: string; active?: boolean } | null;
  if (!body?.userId || typeof body.active !== "boolean") {
    return NextResponse.json({ error: "userId and active are required." }, { status: 400 });
  }

  try {
    // Lockout guard: can't deactivate your own login.
    const users = await listUsers(session.organizationId);
    const target = users.find((u) => u.id === body.userId);
    if (!target) return NextResponse.json({ error: "No such login." }, { status: 404 });
    if (target.email.toLowerCase() === session.email.toLowerCase() && !body.active) {
      return NextResponse.json({ error: "You can't deactivate your own login." }, { status: 400 });
    }

    const ok = await setUserActive(body.userId, body.active, session.organizationId);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "No such login." }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { userId?: string } | null;
  if (!body?.userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });

  try {
    // Lockout guard: can't delete your own login.
    const users = await listUsers(session.organizationId);
    const target = users.find((u) => u.id === body.userId);
    if (!target) return NextResponse.json({ error: "No such login." }, { status: 404 });
    if (target.email.toLowerCase() === session.email.toLowerCase()) {
      return NextResponse.json({ error: "You can't delete your own login." }, { status: 400 });
    }

    const ok = await deleteUser(body.userId, session.organizationId);
    return ok
      ? NextResponse.json({ ok: true, deleted: target.email })
      : NextResponse.json({ error: "No such login." }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}
