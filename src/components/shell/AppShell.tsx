"use client";

import { usePathname, useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useT } from "@/components/LanguageProvider";
import { NAV_LABEL_KEYS, visibleEntriesFor } from "@/lib/navModel";
import { useNavBadges } from "./useNavBadges";
import { Sidebar } from "./Sidebar";
import { TopHeader } from "./TopHeader";
import { MobileNav } from "./MobileNav";
import { ShellVisualsProvider, useShellVisuals } from "./ShellData";
import { PropertySwitcher } from "./PropertySwitcher";
import {
  getSidebarCollapsed,
  getSidebarCollapsedServer,
  subscribeSidebar,
  toggleSidebarCollapsed,
} from "./sidebarStore";

// The application shell for the 2026-08-22 premium UI refresh: a persistent
// left sidebar on desktop, a compact top bar + fixed bottom nav on mobile,
// and a simplified page header carrying the property's weather / local date
// / local time.
//
// This REPLACES NavBar.tsx as the layout's navigation chrome, but it does
// not replace its logic: the nav model (entries, role filtering, property
// scoping) and the badge polling were both lifted verbatim into
// lib/navModel.ts and ./useNavBadges.ts. Routes, permissions, badges and
// modules are untouched — the refresh brief is explicit that this is a
// presentation-layer change only.

/** Page title from the current route, using the same i18n keys the nav
 *  entries already use so the header and the nav never disagree. */
function usePageTitle(): string {
  const pathname = usePathname();
  const t = useT();
  const TITLES: { prefix: string; label: string }[] = [
    { prefix: "/dashboard", label: "Dashboard" },
    { prefix: "/management", label: "Team Management" },
    { prefix: "/team-expenses", label: "Team Expense Request" },
    { prefix: "/team-log", label: "Team Activity Log" },
    { prefix: "/commissions", label: "Commissions" },
    { prefix: "/construction-budget", label: "Construction Budget" },
    { prefix: "/construction", label: "Construction Management" },
    { prefix: "/messaging", label: "Messaging" },
    { prefix: "/approvals", label: "Approvals" },
    { prefix: "/reputation", label: "Reputation" },
    { prefix: "/marketing", label: "Marketing" },
    { prefix: "/crm-campaigns", label: "Campaigns" },
    { prefix: "/sales-pipeline", label: "Pipeline" },
    { prefix: "/reports", label: "Reports" },
    { prefix: "/revenue-management", label: "AI Pricing" },
    { prefix: "/activity", label: "AI Activity" },
    { prefix: "/bill-pay", label: "Bill Pay" },
    // Settings sub-routes listed explicitly: these pages used to render
    // their own <h1> ("Add a Team Member", "My Account"), which the shell
    // header now owns — without these entries both would flatten to
    // "Settings" and the more specific name would be lost.
    { prefix: "/settings/team", label: "Add a Team Member" },
    { prefix: "/settings/account", label: "My Account" },
    { prefix: "/settings", label: "Settings" },
    { prefix: "/billing", label: "Billing" },
    { prefix: "/maintenance", label: "Maintenance" },
    { prefix: "/vendors", label: "Vendors" },
    { prefix: "/guests", label: "CRM" },
  ];
  // Longest prefix wins so /construction-budget doesn't resolve to
  // /construction.
  const match = [...TITLES].sort((a, b) => b.prefix.length - a.prefix.length).find((x) => pathname?.startsWith(x.prefix));
  if (!match) return "";
  return NAV_LABEL_KEYS[match.label] ? t(NAV_LABEL_KEYS[match.label]) : match.label;
}



function ShellInner({
  role,
  propertyGroupId,
  userName,
  userRole,
  locale,
  children,
}: {
  role?: string;
  propertyGroupId: string;
  userName: string;
  userRole: string;
  locale: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const badges = useNavBadges(pathname, role);
  const entries = visibleEntriesFor(role, propertyGroupId);
  const title = usePageTitle();
  const visuals = useShellVisuals();
  // Collapsed preference persists across navigations and sessions, read via
  // an external store so it neither breaks SSR nor sets state from an
  // effect. See ./sidebarStore.ts.
  const collapsed = useSyncExternalStore(
    subscribeSidebar,
    getSidebarCollapsed,
    getSidebarCollapsedServer
  );

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        entries={entries}
        pathname={pathname}
        badges={badges}
        activeGroupId={propertyGroupId}
        userName={userName}
        userRole={userRole}
        collapsed={collapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
        onLogout={() => void logout()}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar: brand + property switcher, since the sidebar
            (which normally holds the switcher) is hidden at this width. */}
        <div
          className="md:hidden sticky top-0 z-30 border-b backdrop-blur"
          style={{
            borderColor: "var(--border-subtle, rgba(255,255,255,0.1))",
            background: "color-mix(in srgb, var(--background) 92%, transparent)",
          }}
        >
          <div className="flex items-center gap-2 px-3 py-2">
            <span
              className="shrink-0 rounded-md grid place-items-center text-[10px] font-semibold tracking-[0.08em]"
              style={{
                width: 26,
                height: 26,
                border: "1px solid var(--accent-gold, #D4AF37)",
                color: "var(--accent-gold, #D4AF37)",
              }}
            >
              LE
            </span>
            <div className="min-w-0 flex-1">
              <PropertySwitcher
                groups={visuals?.groups ?? []}
                activeGroupId={propertyGroupId}
                collapsed={false}
              />
            </div>
          </div>
        </div>

        <TopHeader title={title} locale={locale} role={role} badges={badges} />

        {/* pb-24 on mobile keeps the last card clear of the fixed bottom bar */}
        <main className="flex-1 pb-24 md:pb-0">{children}</main>
      </div>

      <MobileNav
        entries={entries}
        pathname={pathname}
        badges={badges}
        activeGroupId={propertyGroupId}
        userName={userName}
        userRole={userRole}
        onLogout={() => void logout()}
      />
    </div>
  );
}

export function AppShell({
  role,
  propertyGroupId,
  propertyGroups,
  userName,
  userRole,
  locale,
  children,
}: {
  role?: string;
  propertyGroupId: string;
  propertyGroups: { id: string; label: string }[];
  userName: string;
  userRole: string;
  locale: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // Auth pages render bare — no nav chrome, same as the old NavBar's early
  // return for these routes.
  if (pathname?.startsWith("/login") || pathname?.startsWith("/signup") || pathname?.startsWith("/onboarding")) {
    return <main className="flex-1">{children}</main>;
  }
  return (
    <ShellVisualsProvider fallbackGroups={propertyGroups} activeGroupId={propertyGroupId}>
      <ShellInner
        role={role}
        propertyGroupId={propertyGroupId}
        userName={userName}
        userRole={userRole}
        locale={locale}
      >
        {children}
      </ShellInner>
    </ShellVisualsProvider>
  );
}
