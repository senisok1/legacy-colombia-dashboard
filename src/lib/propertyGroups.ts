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
];

export const DEFAULT_PROPERTY_GROUP_ID = "legacy-colombia";
export const PROPERTY_GROUP_COOKIE = "lc_property_group";

export function isValidPropertyGroupId(id: unknown): id is string {
  return typeof id === "string" && PROPERTY_GROUPS.some((g) => g.id === id);
}

export function propertyGroupById(id: string | undefined | null): PropertyGroup {
  return PROPERTY_GROUPS.find((g) => g.id === id) ?? PROPERTY_GROUPS[0];
}

/** Normalizes a raw cookie value to a valid group id (default fallback). */
export function normalizePropertyGroupId(id: string | undefined | null): string {
  return isValidPropertyGroupId(id) ? id : DEFAULT_PROPERTY_GROUP_ID;
}
