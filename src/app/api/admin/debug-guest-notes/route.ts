import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { query, withClient } from "@/lib/db";

// One-off diagnostic for the Phase 3 smoke-test finding that guest-notes
// saves are failing in production (PATCH /api/guests/:id returning 500).
// Read-only — inspects guest_notes' actual columns/indexes on the live DB so
// we can tell whether migration 0015's guest_notes_org_guest_idx unique
// index actually exists (vs. only the organization_id column having been
// added), without needing DATABASE_URL locally. Same ADMIN_SECRET gate as
// the other one-off admin routes. Safe to leave deployed.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }

  try {
    const columns = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns where table_name = 'guest_notes' order by ordinal_position`
    );
    const indexes = await query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'guest_notes'`
    );
    const orgColumns = await query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'organizations' order by ordinal_position`
    );

    let insertError: string | null = null;
    try {
      await withClient(async (client) => {
        await client.query("begin");
        try {
          await client.query(
            `insert into guest_notes (organization_id, guest_id, notes, tags)
             values ((select id from organizations limit 1), -999999, 'diagnostic', '{}')
             on conflict (organization_id, guest_id) do update set notes = excluded.notes`
          );
        } finally {
          await client.query("rollback");
        }
      });
    } catch (err) {
      insertError = err instanceof Error ? err.message : String(err);
    }

    return NextResponse.json({ columns, indexes, orgColumns, insertError });
  } catch (err) {
    return NextResponse.json(
      { error: `Diagnostic failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
