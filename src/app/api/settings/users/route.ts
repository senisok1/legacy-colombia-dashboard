import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { deleteUser, getUserByEmail, listUsers, setUserActive, updateUser, upsertUser } from "@/lib/users";
import { PROPERTY_GROUPS, allowedPropertyGroups } from "@/lib/propertyGroups";
import { buildWelcomeEmail } from "@/lib/teamWelcomeEmail";
import { sendEmail } from "@/lib/email";
import { isEmailSendConfigured } from "@/lib/config";

// Per-login property access (2026-08-17, Seni's ask: "Gabriel should only
// have access to Legacy Colombia and not Legacy Alva"). Stored as a list of
// property-group ids; an EMPTY list deliberately means ALL properties, so
// every login that existed before this feature keeps working unchanged and
// future properties are visible by default unless explicitly restricted.
function sanitizePropertyAccess(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const valid = new Set(PROPERTY_GROUPS.map((g) => g.id));
  const ids = [...new Set(input.filter((x): x is string => typeof x === "string").map((x) => x.trim()))].filter((x) =>
    valid.has(x)
  );
  // "All properties" is the only meaning an empty selection can have.
  return ids.length === PROPERTY_GROUPS.length ? [] : ids;
}

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
        language: u.language,
        propertyAccess: u.propertyAccess,
        active: u.active,
        isYou: u.email.toLowerCase() === session.email.toLowerCase(),
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

// Welcome email (2026-08-17, Seni's ask). Best-effort by design: the login
// is already created and usable by the time this runs, so a Resend outage
// must not fail the request — the response carries emailSent/emailError so
// the admin knows to hand the details over manually instead.
async function sendWelcome(
  req: NextRequest,
  user: { email: string; name: string | null; role: string; language: string; propertyAccess: string[] },
  password: string,
  overrideTo?: string
): Promise<{ emailSent: boolean; emailError?: string }> {
  if (!isEmailSendConfigured()) {
    return { emailSent: false, emailError: "Email isn't configured (missing RESEND_API_KEY)." };
  }
  try {
    const origin = req.nextUrl.origin.includes("localhost")
      ? "https://crm.legacyestaterentals.com"
      : req.nextUrl.origin;
    const { subject, html, text } = buildWelcomeEmail({
      name: user.name,
      email: user.email,
      password,
      language: user.language,
      isAdmin: user.role === "CEO",
      properties:
        user.propertyAccess.length > 0 ? allowedPropertyGroups(user.propertyAccess).map((g) => g.label) : [],
      loginUrl: `${origin}/login`,
    });
    await sendEmail({ to: overrideTo || user.email, subject, html, text });
    return { emailSent: true };
  } catch (err) {
    return { emailSent: false, emailError: err instanceof Error ? err.message : "Unknown email error." };
  }
}

export async function POST(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | {
        email?: string;
        name?: string;
        password?: string;
        role?: string;
        language?: string;
        propertyAccess?: string[];
        /** Set false to create the login without emailing them. */
        sendWelcomeEmail?: boolean;
        /** Send the welcome email to this address instead (for a test send). */
        welcomeEmailTo?: string;
      }
    | null;

  const email = body?.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }
  if (!body?.password || body.password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  const role = body.role === "CEO" ? ("CEO" as const) : ("READ_ONLY" as const);
  // Team-member language (2026-08-16): they read the Management tab and
  // write notes in this language; notes are auto-translated to English for
  // admins (see api/management/activities).
  const ALLOWED_LANGUAGES = ["English", "Spanish", "Portuguese"] as const;
  const language = (ALLOWED_LANGUAGES as readonly string[]).includes(body.language ?? "")
    ? (body.language as string)
    : "English";

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
      language,
      propertyAccess: sanitizePropertyAccess(body.propertyAccess) ?? [],
      organizationId: session.organizationId,
    });
    const mail =
      body.sendWelcomeEmail === false
        ? { emailSent: false }
        : await sendWelcome(req, user, body.password, body.welcomeEmailTo?.trim() || undefined);

    return NextResponse.json({
      ok: true,
      ...mail,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        language: user.language,
        propertyAccess: user.propertyAccess,
        active: user.active,
      },
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

export async function PUT(req: NextRequest) {
  const { session, error } = requireCeo(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | {
        userId?: string;
        email?: string;
        name?: string;
        password?: string;
        role?: string;
        language?: string;
        propertyAccess?: string[];
      }
    | null;
  if (!body?.userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });

  const email = body.email?.trim().toLowerCase();
  if (email !== undefined && (!email || !email.includes("@"))) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }
  if (body.password && body.password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }

  const ALLOWED = ["English", "Spanish", "Portuguese"];
  const language = body.language && ALLOWED.includes(body.language) ? body.language : undefined;
  const role = body.role === "CEO" ? ("CEO" as const) : body.role === "READ_ONLY" ? ("READ_ONLY" as const) : undefined;
  const propertyAccess = sanitizePropertyAccess(body.propertyAccess);

  try {
    const users = await listUsers(session.organizationId);
    const target = users.find((u) => u.id === body.userId);
    if (!target) return NextResponse.json({ error: "No such login." }, { status: 404 });

    const isSelf = target.email.toLowerCase() === session.email.toLowerCase();
    // Lockout guard: don't let an admin demote their own account.
    if (isSelf && role && role !== "CEO") {
      return NextResponse.json({ error: "You can't remove admin access from your own login." }, { status: 400 });
    }
    // Email-collision guard (emails are globally unique across tenants).
    if (email && email !== target.email.toLowerCase()) {
      const clash = await getUserByEmail(email);
      if (clash) return NextResponse.json({ error: "That email is already in use." }, { status: 409 });
    }

    const updated = await updateUser(body.userId, session.organizationId, {
      ...(email !== undefined ? { email } : {}),
      ...(body.name !== undefined ? { name: body.name.trim() || null } : {}),
      ...(body.password ? { password: body.password } : {}),
      ...(role ? { role } : {}),
      ...(language ? { language } : {}),
      ...(propertyAccess !== undefined ? { propertyAccess } : {}),
    });
    if (!updated) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

    return NextResponse.json({
      ok: true,
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        language: updated.language,
        propertyAccess: updated.propertyAccess,
        active: updated.active,
      },
      // A changed email/password invalidates nothing server-side, but the
      // person must sign in again with the new credentials.
      selfChanged: isSelf,
    });
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
