// Where each property physically is (2026-08-22, for the UI refresh's
// header strip: weather · city · local date · local time).
//
// CLIENT-SAFE: constants only, no server imports — the header renders this
// on the client so the clock can tick.
//
// Deliberately a static map rather than something derived from OwnerRez:
// the coordinates only feed a weather lookup and an IANA timezone for
// display, so a hardcoded table is both cheaper and far more predictable
// than parsing a listing address. Per Seni's spec this whole strip is
// "visual supplemental information only" — nothing here participates in
// reservation, occupancy or revenue logic, all of which keep using the
// app's existing date handling untouched.

export type PropertyLocation = {
  /** Matches PROPERTY_GROUPS ids in lib/propertyGroups.ts. */
  groupId: string;
  /** Short display label for the header, e.g. "El Peñol, Antioquia". */
  label: string;
  latitude: number;
  longitude: number;
  /** IANA zone — the header clock must show the PROPERTY's local time, not
   *  the viewer's browser time (explicit requirement in Seni's spec). */
  timeZone: string;
  /** Weather is reported in the unit locals actually use. */
  unit: "fahrenheit" | "celsius";
};

export const PROPERTY_LOCATIONS: PropertyLocation[] = [
  {
    groupId: "legacy-colombia",
    label: "El Peñol, Antioquia",
    latitude: 6.2205,
    longitude: -75.2437,
    timeZone: "America/Bogota",
    unit: "celsius",
  },
  {
    groupId: "legacy-alva",
    label: "Alva, Florida",
    latitude: 26.7159,
    longitude: -81.6106,
    timeZone: "America/New_York",
    unit: "fahrenheit",
  },
  {
    groupId: "legacy-pompano",
    label: "Pompano Beach, Florida",
    latitude: 26.2379,
    longitude: -80.1248,
    timeZone: "America/New_York",
    unit: "fahrenheit",
  },
  {
    groupId: "legacy-miami",
    label: "Miami, Florida",
    latitude: 25.7617,
    longitude: -80.1918,
    timeZone: "America/New_York",
    unit: "fahrenheit",
  },
  {
    groupId: "legacy-beach-house",
    label: "Jersey Shore, New Jersey",
    latitude: 39.3643,
    longitude: -74.4229,
    timeZone: "America/New_York",
    unit: "fahrenheit",
  },
];

export function propertyLocationById(groupId: string | null | undefined): PropertyLocation {
  return PROPERTY_LOCATIONS.find((l) => l.groupId === groupId) ?? PROPERTY_LOCATIONS[0];
}
