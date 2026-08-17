// Client-safe half of the paid-extras feature (2026-08-17).
//
// WHY THIS FILE EXISTS. StayExtras.tsx is a "use client" component and needs
// the option list and the label helper. Importing those from
// lib/bookingExtras.ts dragged that module's `./db` import — and therefore
// the `pg` driver — into the browser bundle, and the Turbopack build failed
// with "Module not found: Can't resolve 'dns'". Anything both the server and
// the client need lives here; lib/bookingExtras.ts keeps the queries and
// re-exports these so server callers still have one import site.

export const EXTRAS_PROPERTY_GROUP_ID = "legacy-colombia";

export const EXTRA_KINDS = [
  { value: "daily_cleaning", label: "Daily cleaning" },
  { value: "private_chef", label: "Private chef" },
  { value: "private_massage", label: "Private massage" },
  { value: "jetskis", label: "Jet skis" },
  { value: "pontoon", label: "Pontoon" },
  { value: "ice_tub", label: "Ice tub setup" },
  { value: "other", label: "Other" },
] as const;

export type ExtraKind = (typeof EXTRA_KINDS)[number]["value"];

const VALID_KINDS = new Set<string>(EXTRA_KINDS.map((k) => k.value));

export function isValidExtraKind(kind: string): kind is ExtraKind {
  return VALID_KINDS.has(kind);
}

export function extraKindLabel(kind: string, customLabel?: string | null): string {
  if (kind === "other") return customLabel?.trim() || "Other";
  return EXTRA_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export type BookingExtra = {
  id: string;
  bookingId: number;
  kind: string;
  customLabel: string | null;
  serviceDate: string | null; // YYYY-MM-DD
  guestPaid: number;
  housePaid: number;
  /** Always guestPaid - housePaid. Derived, never stored — see migration 0034. */
  commission: number;
  notes: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: string;
};
