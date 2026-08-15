import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { deleteTrialOrganizationBySlug, deleteTrialOrganizationById } from "@/lib/organizations";

// One-off cleanup for Phase 2 signup-flow smoke tests (same ADMIN_SECRET
// gate + safe-to-leave-deployed reasoning as api/admin/cleanup-test-drafts).
// Only ever deletes an organization that's still on the 'trial' plan / a
// 'trialing' subscription_status — see deleteTrialOrganizationBySlug's own
// guardrail comment. Never touches the real customer's org.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }

  const slug = req.nextUrl.searchParams.get("slug");
  const id = req.nextUrl.searchParams.get("id");
  if (!slug && !id) return NextResponse.json({ error: "Missing ?slug= or ?id=" }, { status: 400 });

  try {
    const result = id ? await deleteTrialOrganizationById(id) : await deleteTrialOrganizationBySlug(slug!);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Delete failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
