import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { buildExecutiveReport } from "@/lib/executiveReport";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Executive-summary cross-property diff (2026-08-17).
//
// Seni reported Alva's daily summary "still seems like it's using shared
// data" AFTER two rounds of scoping fixes. Reading the code again is clearly
// not sufficient — a field can be threaded correctly and still resolve to
// the same value through a shared cache, a config-driven default, or a
// helper that quietly ignores the group. So this BUILDS two reports for real
// and compares them field by field.
//
// Any field that comes back byte-identical for two properties with very
// different booking volumes is a leak suspect. Some identical values are
// legitimate (a zero on both sides, a shared config constant), so this
// reports rather than judges — but it makes the suspects impossible to miss.
//
//   GET /api/admin/report-audit?secret=…&a=legacy-alva&b=legacy-colombia
function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (value === null || typeof value !== "object") {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    out[`${prefix}.length`] = value.length;
    // Arrays of attention items etc: compare a stable summary, not identity.
    out[`${prefix}.json`] = JSON.stringify(value).slice(0, 500);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const a = req.nextUrl.searchParams.get("a") || "legacy-alva";
  const b = req.nextUrl.searchParams.get("b") || "legacy-colombia";

  const [reportA, reportB] = await Promise.all([
    buildExecutiveReport(undefined, a),
    buildExecutiveReport(undefined, b),
  ]);

  const flatA = flatten(reportA);
  const flatB = flatten(reportB);

  const identical: Record<string, unknown> = {};
  const different: Record<string, { [k: string]: unknown }> = {};

  for (const key of Object.keys(flatA)) {
    // generatedAt/propertyLabel are expected to differ or not matter.
    if (key === "generatedAt" || key === "propertyLabel") continue;
    const va = flatA[key];
    const vb = flatB[key];
    if (JSON.stringify(va) === JSON.stringify(vb)) {
      // Both zero/empty is not evidence of sharing — call it out separately.
      const isEmpty =
        va === 0 || va === null || va === "" || va === "[]" || va === false || va === "0";
      if (!isEmpty) identical[key] = va;
    } else {
      different[key] = { [a]: va, [b]: vb };
    }
  }

  return NextResponse.json({
    comparing: { a, b },
    suspectSharedFields: identical, // non-empty AND identical across two properties
    suspectCount: Object.keys(identical).length,
    differingCount: Object.keys(different).length,
    differing: different,
  });
}
