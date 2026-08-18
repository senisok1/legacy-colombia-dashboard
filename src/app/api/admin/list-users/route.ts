import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { listUsers } from "@/lib/users";
import { getDefaultOrganizationId } from "@/lib/organizations";
import { allowedPropertyGroups } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// Read-only view of the org's logins for admin tooling (2026-08-17) — the
// same data Settings → Add a Team Member shows, reachable with ADMIN_SECRET
// instead of a browser session so onboarding can be driven for several
// people at once without re-typing what's already configured.
//
// Password hashes are NEVER returned.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const organizationId = await getDefaultOrganizationId();
  const users = await listUsers(organizationId);

  return NextResponse.json({
    users: users.map((u) => ({
      name: u.name,
      email: u.email,
      role: u.role,
      roleLabel: u.role === "CEO" ? "Owner/Admin" : "Team member",
      language: u.language,
      whatsappPhone: u.whatsappPhone,
      active: u.active,
      propertyAccess: u.propertyAccess.length > 0 ? u.propertyAccess : ["(all properties)"],
      propertyLabels: allowedPropertyGroups(u.propertyAccess).map((g) => g.label),
    })),
  });
}
