#!/usr/bin/env node
// Read-only diagnostic — prints the STRUCTURE of the database connection
// string (host, port, database name, username) without ever printing the
// password, so it's safe to screenshot or share. Run with: node scripts/diagnose-db.mjs

import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

function inspect(name) {
  const raw = process.env[name];
  console.log(`\n${name}:`);
  if (!raw) {
    console.log("  (not set)");
    return;
  }
  console.log(`  length: ${raw.length}`);
  console.log(`  starts with: ${JSON.stringify(raw.slice(0, 12))}`);
  console.log(`  ends with:   ${JSON.stringify(raw.slice(-12))}`);
  try {
    const u = new URL(raw);
    console.log(`  protocol: ${u.protocol}`);
    console.log(`  username: ${u.username ? "(set, length " + u.username.length + ")" : "(empty)"}`);
    console.log(`  password: ${u.password ? "(set, length " + u.password.length + ")" : "(empty)"}`);
    console.log(`  hostname: ${u.hostname}`);
    console.log(`  port: ${u.port || "(default)"}`);
    console.log(`  pathname (db name): ${u.pathname}`);
    console.log(`  search params: ${u.search}`);
  } catch (err) {
    console.log(`  FAILED TO PARSE AS URL: ${err.message}`);
  }
}

inspect("DATABASE_URL");
inspect("DATABASE_URL_UNPOOLED");
inspect("DATABASE_PGHOST");
