import { NextRequest, NextResponse } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { withClient } from "@/lib/db";
import { config, isDbConfigured } from "@/lib/config";

// One-time (and safe-to-repeat) database migration runner, triggered over
// HTTP instead of run locally. Why this exists: DATABASE_URL was created by
// the Neon/Vercel Storage integration as a "Sensitive" environment
// variable, which Vercel deliberately never lets you export in plaintext —
// not via the dashboard, not via `vercel env pull`. That's a real value
// only inside a running Vercel function, which is exactly where this route
// runs, so it's the only place that can actually see it. See
// scripts/migrate.mjs for the (non-working, kept for reference/local-DB-use)
// local equivalent, and docs/architecture/PHASE1_CRM_FOUNDATION.md.
//
// Protected by ADMIN_SECRET rather than requiring a login — there's no
// user in the database yet for this to check against. Safe to call more
// than once: mirrors scripts/migrate.mjs's own already-applied tracking.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }

  const migrationsDir = path.join(process.cwd(), "db", "migrations");
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    return NextResponse.json(
      { error: `Couldn't read db/migrations/: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }

  try {
    const result = await withClient(async (client) => {
      await client.query(
        "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())"
      );
      const { rows } = await client.query("select name from _migrations");
      const applied = new Set(rows.map((r: { name: string }) => r.name));

      const appliedNow: string[] = [];
      const skipped: string[] = [];
      for (const file of files) {
        if (applied.has(file)) {
          skipped.push(file);
          continue;
        }
        const sql = readFileSync(path.join(migrationsDir, file), "utf8");
        await client.query("begin");
        try {
          await client.query(sql);
          await client.query("insert into _migrations (name) values ($1)", [file]);
          await client.query("commit");
          appliedNow.push(file);
        } catch (err) {
          await client.query("rollback");
          throw err;
        }
      }
      return { appliedNow, skipped };
    });

    return NextResponse.json({
      ok: true,
      applied: result.appliedNow,
      alreadyApplied: result.skipped,
      message:
        result.appliedNow.length === 0
          ? "Database already up to date."
          : `Applied ${result.appliedNow.length} migration(s).`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Migration failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
