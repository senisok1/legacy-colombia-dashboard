import bcrypt from "bcryptjs";
import { query, queryOne } from "./db";
import { getDefaultOrganizationId } from "./organizations";

// Per-user accounts for the CRM foundation (Phase 1) — see
// docs/architecture/PHASE1_CRM_FOUNDATION.md. Replaces (alongside
// lib/session.ts) the single shared DASHBOARD_PASSWORD as the long-term
// login mechanism; both stay valid at once during the overlap window (see
// api/login/route.ts and proxy.ts) so there's no risk of a lockout.

export type Role =
  | "CEO"
  | "LOCAL_MANAGER"
  | "PROPERTY_MANAGER"
  | "MAINTENANCE_STAFF"
  | "MARKETING_STAFF"
  | "ACCOUNTANT"
  | "BOOKKEEPER"
  | "VENDOR"
  | "AI_AGENT"
  | "READ_ONLY";

export type AppUser = {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  role: Role;
  active: boolean;
  organizationId: string;
  /** Interface/notes language — 'English' | 'Spanish' | 'Portuguese'. */
  language: string;
};

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  role: Role;
  active: boolean;
  organization_id: string;
  language?: string | null;
};

function fromRow(row: UserRow): AppUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    role: row.role,
    active: row.active,
    organizationId: row.organization_id,
    language: row.language || "English",
  };
}

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const row = await queryOne<UserRow>(
    "select id, email, password_hash, name, role, active, organization_id, language from users where lower(email) = lower($1)",
    [email]
  );
  return row ? fromRow(row) : null;
}

export async function verifyPassword(user: AppUser, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash);
}

export async function touchLastLogin(userId: string): Promise<void> {
  await query("update users set last_login_at = now() where id = $1", [userId]);
}

/** Creates a user, or resets an existing one's password/name/role if the
 * email already exists — used by scripts/seed-user.mjs. Not exposed through
 * any API route; only run from a trusted script. Defaults to the current
 * customer's organization if none is given — real tenant-choosing happens
 * once Phase 2's signup flow exists; until then every caller of this
 * function predates multi-tenancy and means "the existing customer." */
export async function upsertUser(input: {
  email: string;
  password: string;
  name?: string;
  role?: Role;
  organizationId?: string;
  language?: string;
}): Promise<AppUser> {
  const hash = await bcrypt.hash(input.password, 12);
  const organizationId = input.organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<UserRow>(
    `insert into users (email, password_hash, name, role, organization_id, language)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (email) do update set
       password_hash = excluded.password_hash,
       name = excluded.name,
       role = excluded.role,
       language = excluded.language,
       active = true
     returning id, email, password_hash, name, role, active, organization_id, language`,
    [
      input.email.toLowerCase(),
      hash,
      input.name ?? null,
      input.role ?? "READ_ONLY",
      organizationId,
      input.language ?? "English",
    ]
  );
  if (!row) throw new Error("Failed to create user.");
  return fromRow(row);
}

/** All logins belonging to one organization — for the Settings tab's
 * "Team logins" manager (2026-08-16). Password hashes stay in the return
 * type (AppUser) but callers exposing this over HTTP must strip them. */
export async function listUsers(organizationId: string): Promise<AppUser[]> {
  const rows = await query<UserRow>(
    `select id, email, password_hash, name, role, active, organization_id, language
     from users where organization_id = $1
     order by role, lower(coalesce(name, email))`,
    [organizationId]
  );
  return rows.map(fromRow);
}

/** Deactivate/reactivate a login. Org-scoped so one tenant's admin can
 * never touch another tenant's users. Returns false if no matching row. */
export async function setUserActive(userId: string, active: boolean, organizationId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `update users set active = $2 where id = $1 and organization_id = $3 returning id`,
    [userId, active, organizationId]
  );
  return rows.length > 0;
}

/** Permanently deletes a login (Settings → Team logins' Delete button).
 * Org-scoped like setUserActive. Nothing else references users(id) — team
 * activity attribution is stored denormalized as author_email/author_name,
 * so past notes keep their author label after deletion. */
export async function deleteUser(userId: string, organizationId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from users where id = $1 and organization_id = $2 returning id`,
    [userId, organizationId]
  );
  return rows.length > 0;
}

/** Signup-safe user creation (Phase 2, api/signup/route.ts) — deliberately
 * NOT upsertUser() above, which does `on conflict (email) do update` and
 * would silently hijack an existing account (overwriting its password and
 * moving it to a new organization_id) if someone signed up with an email
 * that's already registered. `users.email` is globally unique across every
 * tenant (see db/migrations/0001_init.sql), so that collision is a real
 * possibility once this is a multi-tenant product, not a hypothetical.
 * Uses `on conflict do nothing` instead and returns null if the email was
 * already taken (including the race where two signups for the same email
 * land at nearly the same time) — the caller must treat null as "email
 * already registered" and must not fall back to upsert. */
export async function createUserForSignup(input: {
  email: string;
  password: string;
  name?: string;
  role: Role;
  organizationId: string;
}): Promise<AppUser | null> {
  const hash = await bcrypt.hash(input.password, 12);
  const row = await queryOne<UserRow>(
    `insert into users (email, password_hash, name, role, organization_id)
     values ($1, $2, $3, $4, $5)
     on conflict (email) do nothing
     returning id, email, password_hash, name, role, active, organization_id, language`,
    [input.email.toLowerCase(), hash, input.name ?? null, input.role, input.organizationId]
  );
  return row ? fromRow(row) : null;
}
