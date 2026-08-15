import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, queryOne } from "@/lib/db";
import { config, isDbConfigured } from "@/lib/config";
import { getDefaultOrganizationId } from "@/lib/organizations";

// One-time bootstrap: creates the very first per-user login. Runs over
// HTTP for the same reason api/admin/migrate does — DATABASE_URL is a
// "Sensitive" Vercel env var, so only code running inside a live Vercel
// function can ever see the real value. See that route's comment for the
// full story.
//
// Deliberately bootstrap-only: once ANY user exists in the table, this
// permanently refuses to create another one, regardless of secret. That
// keeps it safe to leave deployed rather than needing to remember to
// delete it after first use — from then on, account creation should go
// through a proper admin-only CRM screen (task: Approvals + AI Activity
// tabs work), not this endpoint.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { secret?: string; email?: string; password?: string; name?: string; role?: string }
    | null;

  if (!body || !config.adminSecret || body.secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }
  if (!body.email?.trim() || !body.password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  try {
    const existing = await queryOne<{ count: string }>("select count(*)::text as count from users");
    if (existing && Number(existing.count) > 0) {
      return NextResponse.json(
        { error: "A login already exists — this bootstrap endpoint only works once, for safety." },
        { status: 403 }
      );
    }

    const hash = await bcrypt.hash(body.password, 12);
    const organizationId = await getDefaultOrganizationId();
    const rows = await query<{ id: string; email: string; role: string }>(
      `insert into users (email, password_hash, name, role, organization_id)
       values ($1, $2, $3, $4, $5)
       returning id, email, role`,
      [body.email.trim().toLowerCase(), hash, body.name?.trim() || null, body.role || "CEO", organizationId]
    );

    return NextResponse.json({ ok: true, user: rows[0] });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
