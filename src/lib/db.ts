import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import { config, isDbConfigured } from "./config";

// Found 2026-08-06 while building the public Book Direct calendar: node-postgres's
// default type parser turns `date` columns (OID 1082 — e.g. rate_snapshots.stay_date
// and .run_date, rate_overrides.stay_date) into JS Date objects, even though every
// caller in this codebase (revenueManager.ts's RateSnapshotRow/RateOverrideRow types,
// string-comparisons like `s.stayDate < todayStr` in runAutoApplyPass) treats them as
// plain "YYYY-MM-DD" strings. A Date compared with `<`/`===` against a string never
// behaves as intended (Date-vs-string relational comparisons coerce the string via
// ToNumber, which is NaN for "YYYY-MM-DD" — so `date < "2026-08-06"` is always false).
// That silently broke runAutoApplyPass's "never touch the past" guard, and made the
// new public/availability route's rate lookup always miss (Map keyed by a Date
// object, looked up with a string key). Fixed at the root: `date` columns already
// come off the wire as "YYYY-MM-DD" text — telling pg not to parse them at all
// keeps them as exactly that string everywhere in the app, with zero call-site
// changes needed. Does NOT touch timestamp/timestamptz columns (created_at etc.),
// which are used elsewhere as real Date objects on purpose.
types.setTypeParser(1082, (val: string) => val);

// A single shared Postgres connection pool, reused across requests within
// the same warm serverless function instance — same pattern as
// lib/redis.ts's client reuse. Backs the Phase 1 CRM foundation tables (see
// docs/architecture/PHASE1_CRM_FOUNDATION.md): users/roles, approvals, the
// append-only AI activity log, the knowledge base, and the CRM extension
// data (guest notes/tags, message templates) that used to live in flat JSON
// files under data/.
//
// Deliberately plain `pg` + hand-written SQL rather than an ORM — see the
// note at the top of db/migrations/0001_init.sql for why (the build sandbox
// used to develop this app can't fetch native ORM engine binaries, and never
// has access to the real connection string anyway — a deliberate safety
// boundary). Table shapes here must stay in sync with db/migrations/*.sql by
// hand.

let pool: Pool | undefined;

export class DbNotConfiguredError extends Error {
  constructor() {
    super(
      "DATABASE_URL isn't set. Connect the Postgres database to this project in Vercel's Storage tab, or run `vercel env pull .env.local` to get it locally."
    );
    this.name = "DbNotConfiguredError";
  }
}

function getPool(): Pool {
  if (!isDbConfigured()) throw new DbNotConfiguredError();
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    pool.on("error", (err) => console.error("[db] idle client error", err));
  }
  return pool;
}

/** Run a parameterized query. Always use $1/$2/... placeholders — never
 * interpolate values into the SQL string directly. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const p = getPool();
  const result = await p.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Checks out a single client for the duration of `fn` — needed for
 * multi-statement transactions (begin/commit/rollback), where every
 * statement must run on the SAME underlying connection. `query()`/
 * `queryOne()` above each borrow a connection from the pool independently,
 * which is fine for one-off statements but wrong for transactions. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** SQL fragment restricting a table to one property group (2026-08-17).
 *
 * Returns something like:
 *   "and (t.property_group_id = $3 or t.property_group_id is null)"
 * — the `is null` branch is included ONLY for the default group, because
 * every pre-multi-property row is NULL and belongs to Legacy Colombia. For
 * any other group a NULL row is somebody else's data and must stay hidden.
 *
 * `paramIndex` is the $n position the caller will bind the group id at, so
 * this composes with hand-written parameterised SQL without renumbering.
 * Pass `undefined` for propertyGroupId to opt out of filtering entirely
 * (used by cross-property admin/cron paths).
 */
export function propertyGroupFilter(
  propertyGroupId: string | undefined,
  paramIndex: number,
  column = "property_group_id"
): string {
  if (!propertyGroupId) return "";
  // Kept as a literal rather than importing propertyGroups.ts, so lib/db.ts
  // stays dependency-free at the bottom of the import graph.
  const isDefaultGroup = propertyGroupId === "legacy-colombia";
  return isDefaultGroup
    ? ` and (${column} = $${paramIndex} or ${column} is null)`
    : ` and ${column} = $${paramIndex}`;
}
