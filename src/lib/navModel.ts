import {
  CONSTRUCTION_GROUP_TABS,
  MARKETING_GROUP_TABS,
  MESSAGING_GROUP_TABS,
  REPORTS_GROUP_TABS,
  SETTINGS_GROUP_TABS,
  TEAM_MANAGEMENT_GROUP_TABS,
  type NavTab,
} from "@/lib/navGroups";

// Nav model, extracted VERBATIM from NavBar.tsx on 2026-08-22 during the
// premium UI refresh so the new sidebar shell and the old top nav describe
// the same navigation from one source. Nothing about which entries exist,
// which roles see them, or which routes they point at changed in the move —
// this is a straight lift, deliberately, because the refresh brief is
// explicit that routes, permissions and modules must stay exactly as-is.
//
// CLIENT-SAFE: constants + pure functions only.

export type NavEntry =
  | { type: "link"; href: string; label: string }
  | { type: "group"; label: string; tabs: NavTab[] };

// Nav structure — a flat list of either a single link or a "group" (a
// dropdown of related sub-pages). Consolidated 2026-08-05 (Seni's ask,
// after picking "visual refresh + consolidate tabs"): CRM/CRM Campaigns/
// Sales Pipeline collapsed into one "CRM" dropdown, Bill Pay/Vendors into
// one "Bill Pay" dropdown. Consolidated further 2026-08-07 (Seni's explicit
// ask to cut the top-level tab count): Approvals + Reputation folded under
// "Messaging", Maintenance under "Bill Pay", Revenue under "Reports",
// Billing under "Settings". The underlying routes/badges are untouched (see
// navGroups.ts), so nothing that linked directly to e.g. /approvals or
// /revenue-management breaks.
export const navEntries: NavEntry[] = [
  { type: "link", href: "/dashboard", label: "Dashboard" },
  // Team Management dropdown (2026-08-16, expanded 2026-08-20 per Seni's
  // ask): the on-site team's central tab — upcoming stays, paid-extras/event
  // notes — grouping Team Expense Request and Team Activity Log as sub-items
  // instead of separate top-level tabs. Also the home base for the READ_ONLY
  // team login (see src/proxy.ts's role gate); TEAM_HIDDEN_LABELS below
  // doesn't include "Team Management" so this group stays visible to team
  // logins exactly as the three separate tabs did before.
  { type: "group", label: "Team Management", tabs: TEAM_MANAGEMENT_GROUP_TABS },
  // Commissions (2026-08-19) — shared by Seni and Gabriel: extras commission
  // + direct-booking referrals, owner approves/settles, Gabriel views.
  { type: "link", href: "/commissions", label: "Commissions" },
  // Construction Management (2026-08-20, Seni's ask) — an open-items
  // checklist + activity log. Admin/owner-only in the nav (see
  // TEAM_HIDDEN_LABELS) — a regular READ_ONLY team login never sees it. A
  // dedicated CONSTRUCTION-role login sees ONLY the checklist as a plain
  // link (see roleEntries below, which swaps this whole group entry out);
  // src/proxy.ts additionally hard-blocks that login from reaching
  // /construction-budget regardless of what the nav shows.
  { type: "group", label: "Construction Management", tabs: CONSTRUCTION_GROUP_TABS },
  { type: "group", label: "Messaging", tabs: MESSAGING_GROUP_TABS },
  { type: "group", label: "Marketing", tabs: MARKETING_GROUP_TABS },
  { type: "group", label: "Reports", tabs: REPORTS_GROUP_TABS },
  // Bill Pay sits between Reports and Settings (2026-08-17, Seni's ask).
  { type: "link", href: "/bill-pay", label: "Bill Pay" },
  { type: "group", label: "Settings", tabs: SETTINGS_GROUP_TABS },
];

// Tabs hidden from READ_ONLY team logins (2026-08-16, Seni's ask) — team
// members see exactly: Dashboard, Team Management (with Team Expense Request
// and Team Activity Log nested under it), and a plain Settings link (no
// Settings dropdown — no Add a Team Member, no Billing). Everything else is
// hidden here AND blocked in src/proxy.ts, so typing the URL doesn't get
// around it. Display-layer only; the proxy's role gate is the real gate.
export const TEAM_HIDDEN_LABELS = new Set([
  "Messaging",
  "Marketing",
  "Reports",
  "Bill Pay",
  "Construction Management",
]);

// Maps each nav entry's internal (English) label to its i18n key — the
// `label` field itself stays a fixed English string used for the
// TEAM_HIDDEN_LABELS/Settings-collapse logic above; this is purely a display
// lookup. Entries with no mapping (admin-only groups a translated team login
// never sees) just render their English label untranslated.
export const NAV_LABEL_KEYS: Record<string, string> = {
  Dashboard: "nav.dashboard",
  "Team Management": "nav.management",
  "Team Expense Request": "nav.expenses",
  "Team Activity Log": "nav.activityLog",
  Commissions: "nav.commissions",
  "Construction Management": "nav.construction",
  Settings: "nav.settings",
};

// Commissions stays Legacy Colombia only for now (2026-08-19, Seni's ask:
// "hide the commissions tab for now for all other properties"). Nav-level
// hiding only; the real scoping stays server-side in
// api/management/commissions, which returns enabled:false elsewhere.
export const PROPERTY_SCOPED_LABELS = new Set(["Commissions"]);

/** Nav entries this role may see. Lifted verbatim from NavBar.tsx. */
export function entriesForRole(role?: string): NavEntry[] {
  // CONSTRUCTION logins (2026-08-20) see exactly three nav entries:
  // Dashboard (Seni's ask: "give the construction management team members
  // the same dashboard tab view that the team members have" — the same
  // ops-focused view READ_ONLY gets, see app/dashboard/page.tsx's isTeam
  // flag), the Construction Management checklist, and Construction Budget
  // (widened same day: "the construction team member can enter actual
  // amount as well" — import/delete on that tab stays Seni-only via
  // api/construction-budget's requireManager). This is a UI-layer mirror of
  // the hard proxy.ts block; that block is the real enforcement.
  if (role === "CONSTRUCTION") {
    // Plain links, NOT the Construction Management dropdown group — kept as
    // separate entries so this list stays exactly what the role can reach,
    // independent of how the CEO nav happens to group them.
    return [
      { type: "link", href: "/dashboard", label: "Dashboard" },
      { type: "link", href: "/construction", label: "Construction Management" },
      { type: "link", href: "/construction-budget", label: "Construction Budget" },
    ];
  }
  if (role === "READ_ONLY") {
    return navEntries
      .filter((e) => !TEAM_HIDDEN_LABELS.has(e.label))
      // Settings collapses from a dropdown to a single link for the team.
      .map((e): NavEntry => (e.label === "Settings" ? { type: "link", href: "/settings", label: "Settings" } : e));
  }
  return navEntries;
}

/** Role-filtered entries, further filtered by the active property group. */
export function visibleEntriesFor(role: string | undefined, propertyGroupId: string | undefined): NavEntry[] {
  const byRole = entriesForRole(role);
  return (propertyGroupId ?? "legacy-colombia") === "legacy-colombia"
    ? byRole
    : byRole.filter((e) => !PROPERTY_SCOPED_LABELS.has(e.label));
}
