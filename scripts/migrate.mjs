#!/usr/bin/env node
// Applies every .sql file in db/migrations/ that hasn't been applied yet,
// tracked in a `_migrations` table. Run with: npm run db:migrate
//
// Deliberately plain `pg` + hand-written SQL rather than an ORM's migration
// tool (see the note at the top of db/migrations/0001_init.sql for why) —
// this script has no dependency on anything that needs network access
// beyond your own Postgres database.
//
// Must be run somewhere that has the real DATABASE_URL — your own machine
// (this reads .env.local, same as the app) or anywhere else with the env
// var set. It intentionally does NOT run automatically during `next build`
// or on every deploy — migrations are a deliberate, reviewed step.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "No DATABASE_URL / DATABASE_URL_UNPOOLED found in .env.local.\n" +
      "Run `npx vercel env pull .env.local --environment=preview` first."
  );
  process.exit(1);
}

const migrationsDir = path.join(projectRoot, "db", "migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.log("No migration files found in db/migrations/.");
  process.exit(0);
}

const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    await client.query(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())"
    );

    const { rows } = await client.query("select name from _migrations");
    const applied = new Set(rows.map((r) => r.name));

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      console.log(`apply ${file} ...`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into _migrations (name) values ($1)", [file]);
        await client.query("commit");
        console.log(`  done`);
        appliedCount++;
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }

    if (appliedCount === 0) {
      console.log("Database already up to date.");
    } else {
      console.log(`Applied ${appliedCount} migration(s).`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
