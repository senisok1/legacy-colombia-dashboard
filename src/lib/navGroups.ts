// Shared source of truth for the nav groupings. Both NavBar.tsx (top-level
// dropdown) and each individual page's in-page section-tab strip (via
// PageHeader's `tabs` prop, currently only wired up for CRM/Bill Pay) read
// from these same lists so they can never drift out of sync with each
// other.
export type NavTab = { href: string; label: string };

// CRM(Guests)+CRM Campaigns+Sales Pipeline, consolidated 2026-08-05.
export const CRM_GROUP_TABS: NavTab[] = [
  { href: "/guests", label: "Guests" },
  { href: "/crm-campaigns", label: "Campaigns" },
  { href: "/sales-pipeline", label: "Pipeline" },
];

// Bill Pay+Vendors (2026-08-05) + Maintenance (2026-08-07, Seni's ask to
// further condense the top-level nav — Maintenance is vendor/work-order
// driven, same audience as Bill Pay/Vendors).
export const BILL_PAY_GROUP_TABS: NavTab[] = [
  { href: "/bill-pay", label: "Bill Pay" },
  { href: "/vendors", label: "Vendors" },
  { href: "/maintenance", label: "Maintenance" },
];

// Messaging+Approvals+Reputation, added 2026-08-07 (Seni's ask) — all three
// are "things needing a human decision on a guest/review interaction",
// grouped under the tab guests actually message through.
export const MESSAGING_GROUP_TABS: NavTab[] = [
  { href: "/messaging", label: "Inbox" },
  { href: "/approvals", label: "Approvals" },
  { href: "/reputation", label: "Reputation" },
];

// Reports+Revenue, added 2026-08-07 (Seni's ask) — Revenue Management is
// itself a reporting/analysis view (rate comparisons, snapshots), not an
// action queue, so it groups naturally under Reports.
export const REPORTS_GROUP_TABS: NavTab[] = [
  { href: "/reports", label: "Reports" },
  { href: "/revenue-management", label: "Revenue" },
];

// Settings+Billing, added 2026-08-07 (Seni's ask) — both are account-level
// configuration, not day-to-day operating tabs.
export const SETTINGS_GROUP_TABS: NavTab[] = [
  { href: "/settings", label: "Settings" },
  // Team-member login management, moved out of the inline /settings section
  // to its own dropdown entry 2026-08-16 (Seni's ask).
  { href: "/settings/team", label: "Add a Team Member" },
  { href: "/billing", label: "Billing" },
];
