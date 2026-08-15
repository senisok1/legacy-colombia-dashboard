import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured, config } from "@/lib/config";
import { getUserByEmail, createUserForSignup } from "@/lib/users";
import { createTrialOrganization } from "@/lib/organizations";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/session";

// Self-serve tenant signup (Phase 2 of the multi-tenant conversion — see
// db/migrations/0015_organizations.sql and lib/organizations.ts). Creates a
// brand-new organization on a 14-day trial plus its first user (role CEO —
// the account owner), then logs them straight in.
//
// IMPORTANT — not linked from the live marketing site yet, on purpose: a
// newly signed-up org gets its own isolated row in every table (Phase 0)
// and can store its own encrypted OwnerRez/WhatsApp/PriceLabs credentials
// (Phase 1), but the actual data-reading code (lib/ownerrez.ts, the
// dashboard/CRM/messaging/etc. read paths, and every cron job) still reads
// from the single global config/env vars rather than resolving credentials
// per-request — that rewiring is Phase 3, not done yet. Until Phase 3
// ships, a second org signing up today would see Legacy Estate Rentals'
// live guest/booking data on their dashboard, which would be a real
// cross-tenant data leak, not just an inconvenience. This route exists so
// the mechanics (org + user creation, isolated credential storage) can be
// built and tested now, but do not expose a public "Sign up" link or
// announce this to prospective customers until Phase 3 is verified done.
export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }
  if (!config.authSecret) {
    return NextResponse.json({ error: "AUTH_SECRET isn't set on this deployment." }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { orgName?: string; name?: string; email?: string; password?: string }
    | null;

  const orgName = body?.orgName?.trim();
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password;
  const name = body?.name?.trim();

  if (!orgName) return NextResponse.json({ error: "Company/property name is required." }, { status: 400 });
  if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });
  if (!password || password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }

  try {
    // Check first so the overwhelmingly common case (a genuinely new email)
    // never creates an orphaned trial org — see createUserForSignup's own
    // comment in lib/users.ts for why this can't just be an upsert.
    const existing = await getUserByEmail(email);
    if (existing) {
      return NextResponse.json(
        { error: "An account with that email already exists. Try logging in instead." },
        { status: 409 }
      );
    }

    const organization = await createTrialOrganization(orgName);
    const user = await createUserForSignup({
      email,
      password,
      name,
      role: "CEO",
      organizationId: organization.id,
    });

    if (!user) {
      // Lost a race against a simultaneous signup for the same email —
      // vanishingly rare. Leaves one orphaned trial org with no users
      // behind; cheap to clean up manually later rather than adding
      // org-deletion plumbing for this one edge case.
      return NextResponse.json(
        { error: "An account with that email already exists. Try logging in instead." },
        { status: 409 }
      );
    }

    const token = createSessionToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    });
    const res = NextResponse.json({ ok: true, organizationId: organization.id });
    res.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: `Signup failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
