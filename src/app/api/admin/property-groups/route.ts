import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";
import { getTargetProperties } from "@/lib/ownerrez";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Verification for property-group setup (2026-08-17). Every non-default
// group resolves by case-insensitive NAME MATCH against the OwnerRez
// property list, so there are two failure modes: it matches nothing (the
// tab errors), or it matches MORE THAN ONE listing, which silently merges
// two properties' data — exactly the thing these groups exist to prevent.
// This reports what each group actually resolves to, so a newly added
// property can be confirmed before anyone relies on its numbers.
//
//   GET /api/admin/property-groups?secret=…
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const groups = await Promise.all(
    PROPERTY_GROUPS.map(async (g) => {
      try {
        const properties = await getTargetProperties(undefined, g.id);
        return {
          id: g.id,
          label: g.label,
          nameMatch: g.nameMatch ?? "(config-driven default)",
          matchCount: properties.length,
          ok: properties.length >= 1,
          warning:
            properties.length > 1 && g.nameMatch
              ? "Matches more than one listing — narrow nameMatch or this group merges two properties."
              : properties.length === 0
                ? "Matches no listing."
                : null,
          properties: properties.map((p) => ({ id: p.id, name: p.name })),
        };
      } catch (err) {
        return {
          id: g.id,
          label: g.label,
          nameMatch: g.nameMatch ?? "(config-driven default)",
          matchCount: 0,
          ok: false,
          warning: err instanceof Error ? err.message : "Unknown error.",
          properties: [],
        };
      }
    })
  );

  return NextResponse.json({ groups });
}
