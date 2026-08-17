// Shared source of truth for the nav groupings. Both NavBar.tsx (top-level
// dropdown) and each individual page's in-page section-tab strip (via
// PageHeader's `tabs` prop, currently only wired up for CRM/Bill Pay) read
// from these same lists so they can never drift out of sync with each
// other.
export type NavTab = { href: string; label: string };

// Marketing + Campaigns + Pipeline (2026-08-17, Seni's ask: "remove the CRM
// tab all together and move 'campaigns' and 'pipeline' under the marketing
// tab"). The old CRM group is gone; /guests keeps working by URL but no
// longer has a nav entry.
export const MARKETING_GROUP_TABS: NavTab[] = [
  { href: "/marketing", label: "Marketing" },
  { href: "/crm-campaigns", label: "Campaigns" },
  { href: "/sales-pipeline", label: "Pipeline" },
];

// Bill Pay stands alone as of 2026-08-17 (Seni's ask): the Vendors entry
// was dropped ("we don't need that anymore since we have the bill pay tab
// working the way it does") and Maintenance became the Team Expense Request
// tab next to Team Activity Log. The /vendors and /maintenance ROUTES still
// exist and still work by URL — only their nav entries are gone.
export const BILL_PAY_GROUP_TABS: NavTab[] = [{ href: "/bill-pay", label: "Bill Pay" }];

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
  // Renamed "Revenue" -> "AI Pricing" 2026-08-17 (Seni's ask) — the route is
  // unchanged, so existing links/bookmarks to /revenue-management still work.
  { href: "/revenue-management", label: "AI Pricing" },
  // AI Activity folded in as the last entry 2026-08-17 (Seni's ask); it was
  // its own top-level tab.
  { href: "/activity", label: "AI Activity" },
];

// Settings+Billing, added 2026-08-07 (Seni's ask) — both are account-level
// configuration, not day-to-day operating tabs.
export const SETTINGS_GROUP_TABS: NavTab[] = [
  { href: "/settings", label: "Settings" },
  // Team-member login management, moved out of the inline /settings section
  // to its own dropdown entry 2026-08-16 (Seni's ask).
  { href: "/settings/team", label: "Add a Team Member" },
  // Everyone's own login (password change) — 2026-08-17, Seni's ask that
  // team members can change their own password.
  { href: "/settings/account", label: "My Account" },
  { href: "/billing", label: "Billing" },
];
