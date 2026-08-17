import { NextRequest, NextResponse } from "next/server";
import { config, isEmailSendConfigured } from "@/lib/config";
import { upsertUser, getUserByEmail } from "@/lib/users";
import { buildWelcomeEmail } from "@/lib/teamWelcomeEmail";
import { sendEmail } from "@/lib/email";
import { allowedPropertyGroups, PROPERTY_GROUPS } from "@/lib/propertyGroups";
import { getDefaultOrganizationId } from "@/lib/organizations";

export const dynamic = "force-dynamic";

// Create a login AND send its onboarding email in one admin-gated call
// (2026-08-17). The Settings → Add a Team Member UI already does this, but
// it needs a signed-in CEO browser session; this lets onboarding be driven
// for several people at once, and adds a cc so Seni is copied on what each
// person receives.
//
// POST /api/admin/onboard-user?secret=…
// {
//   "users": [
//     { "name": "Gabriel", "email": "pm@legacycolombia.com", "password": "…",
//       "role": "READ_ONLY", "language": "Spanish",
//       "properties": ["legacy-colombia"] }
//   ],
//   "cc": "senisok1@gmail.com",
//   "dryRun": true
// }
//
// dryRun renders the emails and reports exactly who would receive what,
// WITHOUT creating logins or sending anything — worth using first, since a
// welcome email carries a working password and can't be unsent.
type InputUser = {
  name?: string;
  email?: string;
  password?: string;
  role?: string;
  language?: string;
  properties?: string[];
};

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | { users?: InputUser[]; cc?: string | string[]; bcc?: string | string[]; dryRun?: boolean }
    | null;
  const users = body?.users ?? [];
  if (users.length === 0) return NextResponse.json({ error: "No users supplied." }, { status: 400 });
  if (!isEmailSendConfigured()) {
    return NextResponse.json({ error: "Email isn't configured (RESEND_API_KEY)." }, { status: 400 });
  }

  const organizationId = await getDefaultOrganizationId();
  const origin = req.nextUrl.origin.includes("localhost")
    ? "https://crm.legacyestaterentals.com"
    : req.nextUrl.origin;
  const validGroups = new Set(PROPERTY_GROUPS.map((g) => g.id));
  const results: unknown[] = [];

  for (const u of users) {
    const email = u.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      results.push({ email: u.email ?? null, ok: false, error: "A valid email is required." });
      continue;
    }
    // password omitted = onboard an EXISTING login without changing it.
    const settingPassword = Boolean(u.password);
    if (settingPassword && (u.password as string).length < 8) {
      results.push({ email, ok: false, error: "Password must be at least 8 characters." });
      continue;
    }

    const role = u.role === "CEO" ? ("CEO" as const) : ("READ_ONLY" as const);
    const language = ["English", "Spanish", "Portuguese"].includes(u.language ?? "")
      ? (u.language as string)
      : "English";
    const properties = (u.properties ?? []).filter((p) => validGroups.has(p));

    try {
      const existing = await getUserByEmail(email);
      if (!settingPassword && !existing) {
        results.push({ email, ok: false, error: "No such login — supply a password to create one." });
        continue;
      }
      const { subject, html, text } = buildWelcomeEmail({
        name: u.name ?? null,
        email,
        password: u.password ?? null,
        language: settingPassword ? language : existing?.language ?? language,
        isAdmin: settingPassword ? role === "CEO" : existing?.role === "CEO",
        properties:
          (settingPassword ? properties : existing?.propertyAccess ?? []).length > 0
            ? allowedPropertyGroups(settingPassword ? properties : existing?.propertyAccess ?? []).map(
                (g) => g.label
              )
            : [],
        loginUrl: `${origin}/login`,
      });

      if (body?.dryRun) {
        // Report the EFFECTIVE values — what the email was actually built
        // from — not the request defaults (2026-08-17). Reporting the
        // defaults made a re-send to existing users look like it would
        // downgrade an owner to READ_ONLY and switch Gabriel to English,
        // when the rendered email was correct all along. A dry run that
        // misdescribes its own output is worse than none.
        const effectiveRole = settingPassword ? role : existing?.role ?? role;
        const effectiveLanguage = settingPassword ? language : existing?.language ?? language;
        const effectiveProperties = settingPassword ? properties : existing?.propertyAccess ?? [];
        results.push({
          email,
          ok: true,
          dryRun: true,
          existingLogin: Boolean(existing),
          wouldSetPassword: settingPassword,
          role: effectiveRole,
          language: effectiveLanguage,
          properties: effectiveProperties.length > 0 ? effectiveProperties : "ALL",
          subject,
          preview: text.slice(0, 400),
        });
        continue;
      }

      // Only touch the login when a password was actually supplied —
      // otherwise this is a pure re-send of the guide.
      if (settingPassword) await upsertUser({
        email,
        password: u.password as string,
        name: u.name?.trim() || undefined,
        role,
        language,
        propertyAccess: properties,
        organizationId,
      });

      // cc is visible to the recipient; bcc isn't. Seni chose cc for the
      // first three (Ahmed/Geo/Gabriel) — he's happy to be seen on those —
      // but later batches can pass "bcc" instead to stay hidden.
      const messageId = await sendEmail({
        to: email,
        subject,
        html,
        text,
        cc: body?.cc,
        bcc: body?.bcc,
      });
      results.push({
        email,
        ok: true,
        created: !existing,
        // Was set to Boolean(existing), which reported "passwordReset: true"
        // on a pure re-send where nothing was touched (2026-08-17) — alarming
        // and wrong. A password only changes when one was actually supplied.
        passwordChanged: settingPassword,
        role,
        language,
        properties: properties.length > 0 ? properties : "ALL",
        messageId,
      });
    } catch (err) {
      results.push({ email, ok: false, error: err instanceof Error ? err.message : "Unknown error." });
    }
  }

  return NextResponse.json({ ok: true, dryRun: Boolean(body?.dryRun), cc: body?.cc ?? null, results });
}
