// Property groups (2026-08-16, Seni's ask: a dropdown on the "Legacy
// Colombia" wordmark to switch the whole dashboard to another property on
// the same OwnerRez account). A "group" is one physical property as the
// dashboard sees it — Legacy Colombia is really two OwnerRez listings (LC
// 413494 + Nukak Casa #19 492014) merged into one view, which stays the
// DEFAULT group and keeps its exact existing config-driven resolution (and
// all existing cache keys). Additional groups resolve by matching the
// OwnerRez property name.
//
// CLIENT-SAFE: constants only — no next/headers here (NavBar imports this).
export type PropertyGroup = {
  id: string;
  label: string;
  /** Case-insensitive substring matched against OwnerRez property names.
   * Absent for the default group (config-driven resolution). */
  nameMatch?: string;
};

export const PROPERTY_GROUPS: PropertyGroup[] = [
  { id: "legacy-colombia", label: "Legacy Colombia" },
  // "Legacy Alva Waterfront Farm Estate Pool, Theater, Kayaks" in OwnerRez.
  { id: "legacy-alva", label: "Legacy Alva", nameMatch: "Legacy Alva" },
  // Added 2026-08-17. nameMatch is a case-insensitive SUBSTRING of the
  // OwnerRez listing name, and must match EXACTLY ONE listing — verify with
  // GET /api/admin/property-groups?secret=… after adding any new one, which
  // reports how many listings each group resolves to.
  //
  // "Beachfront Oasis - Pool Cinema Game Room"
  { id: "legacy-pompano", label: "Legacy Pompano", nameMatch: "Beachfront Oasis" },
  // "Terrace Grill+Billiards+MiniGolf"
  { id: "legacy-miami", label: "Legacy Miami", nameMatch: "Terrace Grill" },
  // "Luxurious Waterfront Getaway"
  { id: "legacy-beach-house", label: "Legacy Beach House", nameMatch: "Luxurious Waterfront Getaway" },
];

export const DEFAULT_PROPERTY_GROUP_ID = "legacy-colombia";
export const PROPERTY_GROUP_COOKIE = "lc_property_group";

export function isValidPropertyGroupId(id: unknown): id is string {
  return typeof id === "string" && PROPERTY_GROUPS.some((g) => g.id === id);
}

export function propertyGroupById(id: string | undefined | null): PropertyGroup {
  return PROPERTY_GROUPS.find((g) => g.id === id) ?? PROPERTY_GROUPS[0];
}

/** Groups a login may use — empty access list means every group. */
export function allowedPropertyGroups(access: string[] | undefined | null): PropertyGroup[] {
  // No list at all = an unrestricted owner. This stays permissive on
  // purpose: every call site resolves access via
  // `getUserByEmail(...).catch(() => null)`, so a transient database blip
  // yields undefined here, and failing closed would lock a legitimate owner
  // out of his own dashboard mid-session. The blast radius is bounded
  // because the ROLE gate is independent of this and is not fail-open.
  if (!access || access.length === 0) return PROPERTY_GROUPS;

  const allowed = PROPERTY_GROUPS.filter((g) => access.includes(g.id));
  if (allowed.length > 0) return allowed;

  // SECURITY FIX (2026-08-17 audit): this used to `return PROPERTY_GROUPS`,
  // i.e. a user with an EXPLICIT restriction list that happened to match
  // nothing was silently upgraded to ALL FIVE properties. That's exactly
  // backwards — a non-empty list is a deliberate restriction, and the most
  // likely way it matches nothing is a group being renamed in
  // PROPERTY_GROUPS while stale ids sit in user_properties. Gabriel is
  // restricted to Legacy Colombia by such a list; one rename would have
  // handed him Alva, Pompano, Miami and Beach House.
  //
  // Fall back to the default group alone: restrictive, and still a working
  // dashboard rather than an empty screen.
  console.warn(
    `[propertyGroups] access list ${JSON.stringify(access)} matched no known group — falling back to ${DEFAULT_PROPERTY_GROUP_ID} only. Check user_properties for stale ids.`
  );
  return [propertyGroupById(DEFAULT_PROPERTY_GROUP_ID)];
}

/** The group a viewer should actually see: their cookie choice when it's
 * permitted, otherwise their first allowed property (2026-08-16). */
export function effectivePropertyGroupId(cookieValue: string | undefined | null, access: string[] | undefined | null): string {
  const requested = normalizePropertyGroupId(cookieValue);
  const allowed = allowedPropertyGroups(access);
  return allowed.some((g) => g.id === requested) ? requested : allowed[0].id;
}

/** Normalizes a raw cookie value to a valid group id (default fallback). */
export function normalizePropertyGroupId(id: string | undefined | null): string {
  return isValidPropertyGroupId(id) ? id : DEFAULT_PROPERTY_GROUP_ID;
}
