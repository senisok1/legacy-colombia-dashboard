#!/usr/bin/env node
// Creates (or resets) a user account for per-user login. Run with:
//   node scripts/seed-user.mjs "you@example.com" "a-temporary-password" "Your Name" CEO
//
// Role must be one of: CEO, LOCAL_MANAGER, PROPERTY_MANAGER,
// MAINTENANCE_STAFF, MARKETING_STAFF, ACCOUNTANT, BOOKKEEPER, VENDOR,
// AI_AGENT, READ_ONLY. Defaults to CEO if omitted.
//
// Must be run somewhere with the real DATABASE_URL (your own machine, same
// as scripts/migrate.mjs) — this never runs automatically.

import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

const [, , email, password, name, role] = process.argv;

if (!email || !password) {
  console.error('Usage: node scripts/seed-user.mjs "you@example.com" "temporary-password" ["Your Name"] [ROLE]');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("No DATABASE_URL found in .env.local. Run `npm run db:migrate` first (it checks the same thing).");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function main() {
  const hash = await bcrypt.hash(password, 12);

  // Every user belongs to an organization (tenant) — see
  // db/migrations/0015_organizations.sql. Default to the existing
  // customer's org since this script predates multi-tenancy; pass a real
  // signup flow through once one exists (Phase 2).
  const orgResult = await pool.query("select id from organizations where slug = $1", ["legacy-estate-rentals"]);
  const organizationId = orgResult.rows[0]?.id;
  if (!organizationId) {
    console.error(
      "No default organization found — run the db migrations (db/migrations/0015_organizations.sql) first."
    );
    process.exit(1);
  }

  const result = await pool.query(
    `insert into users (email, password_hash, name, role, organization_id)
     values ($1, $2, $3, $4, $5)
     on conflict (email) do update set
       password_hash = excluded.password_hash,
       name = excluded.name,
       role = excluded.role,
       active = true
     returning id, email, role`,
    [email.toLowerCase(), hash, name || null, role || "CEO", organizationId]
  );
  console.log("User ready:", result.rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
