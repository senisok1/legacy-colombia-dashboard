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
  /** Property-group ids this login may see; empty array = ALL properties. */
  propertyAccess: string[];
  /** WhatsApp number for task-request notifications (2026-08-18). Nullable —
   * only enforced as required for NEW logins, at the route layer (see
   * api/settings/users/route.ts), not here. Free text, not strictly validated
   * beyond "looks like it has a country code" at the point of entry. */
  whatsappPhone: string | null;
  /** Session-invalidation counter (2026-08-17 audit). Baked into the signed
   * login token at creation and bumped whenever this account changes in a way
   * that must kill outstanding sessions (password/role change, deactivation).
   * proxy.ts rejects any token whose embedded epoch is behind this value. See
   * db/migrations/0036_session_epoch.sql. */
  sessionEpoch: number;
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
  property_access?: string | null;
  session_epoch?: number | null;
  whatsapp_phone?: string | null;
};

const USER_COLUMNS =
  "id, email, password_hash, name, role, active, organization_id, language, property_access, session_epoch, whatsapp_phone";

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
    propertyAccess: (row.property_access || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    sessionEpoch: row.session_epoch ?? 0,
    whatsappPhone: row.whatsapp_phone || null,
  };
}

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const row = await queryOne<UserRow>(
    `select ${USER_COLUMNS} from users where lower(email) = lower($1)`,
    [email]
  );
  return row ? fromRow(row) : null;
}

// Strips everything but digits, and a leading country-code "1" duplicate
// isn't collapsed — good enough for "does this WhatsApp inbound sender match
// a stored team-member number", the only thing this is used for (2026-08-18,
// Team Requests WhatsApp accept/deny). Comparing digit-only avoids "+" /
// spacing/dash mismatches between what Seni typed in Settings and what Meta
// reports as the sender.
function normalizePhoneDigits(n: string): string {
  return n.replace(/\D/g, "");
}

/** Finds the team login whose stored WhatsApp number matches an inbound
 * sender's number, within one organization. Used by the WhatsApp webhook to
 * resolve a Team Request accept/deny reply to the right person — done as a
 * small in-memory scan (rarely more than a handful of logins per org) rather
 * than a SQL digit-strip, since not every environment's Postgres has the
 * needed extension and this runs at most once per inbound non-Seni message. */
export async function findUserByWhatsAppPhone(
  organizationId: string,
  phone: string
): Promise<AppUser | null> {
  const target = normalizePhoneDigits(phone);
  if (!target) return null;
  const rows = await query<UserRow>(
    `select ${USER_COLUMNS} from users where organization_id = $1 and whatsapp_phone is not null and whatsapp_phone <> '' and active = true`,
    [organizationId]
  );
  const match = rows.find((r) => normalizePhoneDigits(r.whatsapp_phone || "") === target);
  return match ? fromRow(match) : null;
}

/** Current session-invalidation epoch for a login, resolved by email (the
 * identifier the signed token carries). Returns null if no such user exists —
 * which the proxy treats as "session invalid" so a DELETED user's still-signed
 * cookie stops working immediately (2026-08-17 audit). Deliberately its own
 * tiny query, not getUserByEmail(), so the per-request check the proxy runs
 * pulls a single integer column and never touches the bcrypt hash. */
export async function getUserSessionEpoch(email: string): Promise<number | null> {
  const row = await queryOne<{ session_epoch: number }>(
    "select session_epoch from users where lower(email) = lower($1)",
    [email]
  );
  return row ? row.session_epoch ?? 0 : null;
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
  propertyAccess?: string[];
  whatsappPhone?: string | null;
}): Promise<AppUser> {
  const hash = await bcrypt.hash(input.password, 12);
  const organizationId = input.organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<UserRow>(
    `insert into users (email, password_hash, name, role, organization_id, language, property_access, whatsapp_phone)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (email) do update set
       password_hash = excluded.password_hash,
       name = excluded.name,
       role = excluded.role,
       language = excluded.language,
       property_access = excluded.property_access,
       -- Only overwrite a stored number when a new one is actually supplied —
       -- resetting an existing login's password (the common on-conflict path)
       -- must not silently blank out a phone that was set earlier.
       whatsapp_phone = coalesce($8, users.whatsapp_phone),
       active = true,
       -- Session invalidation (2026-08-17 audit): this is the password/role
       -- reset path (scripts/seed-user, admin/set-user-password), so bump the
       -- epoch to kill any cookie minted under the OLD password/role. On the
       -- initial insert the column just defaults to 0.
       session_epoch = users.session_epoch + 1
     returning ${USER_COLUMNS}`,
    [
      input.email.toLowerCase(),
      hash,
      input.name ?? null,
      input.role ?? "READ_ONLY",
      organizationId,
      input.language ?? "English",
      input.propertyAccess && input.propertyAccess.length > 0 ? input.propertyAccess.join(",") : null,
      input.whatsappPhone?.trim() || null,
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
    `select ${USER_COLUMNS}
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
    // Session invalidation (2026-08-17 audit): a DEACTIVATION must immediately
    // kill the user's outstanding 30-day cookies, so bump the epoch whenever
    // active is being set to false. Reactivation doesn't need to invalidate
    // anything (there was no valid session to preserve), so it leaves the
    // epoch untouched — `case` keeps this a single round trip.
    `update users
       set active = $2,
           session_epoch = session_epoch + case when $2 = false then 1 else 0 end
     where id = $1 and organization_id = $3 returning id`,
    [userId, active, organizationId]
  );
  return rows.length > 0;
}

/** Updates an existing login BY ID (Settings → Team logins' Edit button,
 * 2026-08-16). Unlike upsertUser (which keys on email and therefore can't
 * rename one), this can change the email itself. Only the fields provided
 * are touched; password is re-hashed only when a new one is supplied.
 * Org-scoped so one tenant can never edit another's users. Returns null if
 * no matching row. */
export async function updateUser(
  userId: string,
  organizationId: string,
  fields: {
    email?: string;
    name?: string | null;
    password?: string;
    role?: Role;
    language?: string;
    propertyAccess?: string[];
    whatsappPhone?: string | null;
  }
): Promise<AppUser | null> {
  const sets: string[] = [];
  const values: unknown[] = [userId, organizationId];
  const push = (sql: string, value: unknown) => {
    values.push(value);
    sets.push(`${sql} = $${values.length}`);
  };

  if (fields.email !== undefined) push("email", fields.email.toLowerCase());
  if (fields.name !== undefined) push("name", fields.name);
  if (fields.role !== undefined) push("role", fields.role);
  if (fields.language !== undefined) push("language", fields.language);
  if (fields.propertyAccess !== undefined)
    push("property_access", fields.propertyAccess.length > 0 ? fields.propertyAccess.join(",") : null);
  if (fields.whatsappPhone !== undefined) push("whatsapp_phone", fields.whatsappPhone?.trim() || null);
  if (fields.password) push("password_hash", await bcrypt.hash(fields.password, 12));
  if (sets.length === 0) return null;

  // Session invalidation (2026-08-17 audit): a password change or a role
  // change (e.g. CEO -> READ_ONLY) must kill every outstanding cookie for this
  // login, otherwise the old token keeps working for up to 30 days with its
  // stale embedded role/credential. Bump the epoch (no bound parameter — it's
  // a self-referential increment) whenever either of those two fields is in
  // play. An email-only or name-only edit doesn't need it: a changed email
  // self-invalidates, because the token carries the OLD email and
  // getUserSessionEpoch() will then find no matching row.
  if (fields.password || fields.role !== undefined) {
    sets.push("session_epoch = session_epoch + 1");
  }

  const row = await queryOne<UserRow>(
    `update users set ${sets.join(", ")}
     where id = $1 and organization_id = $2
     returning ${USER_COLUMNS}`,
    values
  );
  return row ? fromRow(row) : null;
}

/** Permanently deletes a login (Settings → Team logins' Delete button).
 * Org-scoped like setUserActive. Nothing else references users(id) — team
 * activity attribution is stored denormalized as author_email/author_name,
 * so past notes keep their author label after deletion.
 *
 * Session invalidation (2026-08-17 audit): no epoch bump is needed here — once
 * the row is gone, getUserSessionEpoch() returns null for that email and the
 * proxy rejects the deleted user's still-signed cookie on its next request. */
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
     returning ${USER_COLUMNS}`,
    [input.email.toLowerCase(), hash, input.name ?? null, input.role, input.organizationId]
  );
  return row ? fromRow(row) : null;
}
