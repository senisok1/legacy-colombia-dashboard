"use client";

import Link from "next/link";
import { useState } from "react";
import { useT } from "@/components/LanguageProvider";
import { NAV_LABEL_KEYS, type NavEntry } from "@/lib/navModel";
import { badgeCountForHref, type NavBadges } from "./useNavBadges";
import { iconForLabel, IconChevron, IconCollapse, IconLogout } from "./NavIcons";
import { PropertySwitcher } from "./PropertySwitcher";
import { useShellVisuals } from "./ShellData";

// Persistent left sidebar for desktop (2026-08-22 UI refresh, replacing the
// horizontal top nav). Every entry, route, badge and role rule is unchanged
// — the nav model itself lives in lib/navModel.ts, lifted verbatim from the
// old NavBar. This file is presentation only.

function Badge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={`shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded-full font-medium ${
        active ? "bg-[var(--accent)] text-[#0E1116]" : "bg-[var(--accent)]/20 text-[var(--accent)]"
      }`}
    >
      {count}
    </span>
  );
}

export function Sidebar({
  entries,
  pathname,
  badges,
  activeGroupId,
  userName,
  userRole,
  collapsed,
  onToggleCollapsed,
  onLogout,
}: {
  entries: NavEntry[];
  pathname: string | null;
  badges: NavBadges;
  activeGroupId: string;
  userName: string;
  userRole: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onLogout: () => void;
}) {
  const t = useT();
  const visuals = useShellVisuals();
  const navLabel = (label: string) => (NAV_LABEL_KEYS[label] ? t(NAV_LABEL_KEYS[label]) : label);

  // Groups start expanded when the current page is inside them, so the
  // active item is never hidden behind a collapsed section.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const isGroupOpen = (entry: Extract<NavEntry, { type: "group" }>) => {
    const auto = entry.tabs.some((tab) => pathname?.startsWith(tab.href));
    return openGroups[entry.label] ?? auto;
  };

  return (
    <aside
      className={`hidden md:flex flex-col shrink-0 border-r transition-[width] duration-200 ${
        collapsed ? "w-[68px]" : "w-[248px]"
      }`}
      style={{
        borderColor: "var(--border-subtle, rgba(255,255,255,0.1))",
        background: "var(--surface, rgba(255,255,255,0.02))",
      }}
    >
      {/* Brand */}
      <div className={`flex items-center gap-2.5 px-4 pt-4 pb-1 ${collapsed ? "justify-center px-2" : ""}`}>
        <span
          className="shrink-0 rounded-md grid place-items-center text-[11px] font-semibold tracking-[0.08em]"
          style={{
            width: 30,
            height: 30,
            border: "1px solid var(--accent-gold, #D4AF37)",
            color: "var(--accent-gold, #D4AF37)",
          }}
        >
          LE
        </span>
        {!collapsed && (
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold tracking-[0.14em] leading-tight">LEGACY</span>
            <span className="block text-[9px] tracking-[0.22em] text-black/50 dark:text-white/50 leading-tight">
              ESTATE RENTALS
            </span>
          </span>
        )}
      </div>

      <PropertySwitcher
        groups={visuals?.groups ?? []}
        activeGroupId={activeGroupId}
        collapsed={collapsed}
      />

      {/* Primary navigation */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {entries.map((entry) => {
          if (entry.type === "link") {
            const active = !!pathname?.startsWith(entry.href);
            const count = badgeCountForHref(entry.href, badges);
            return (
              <Link
                key={entry.href}
                href={entry.href}
                title={collapsed ? navLabel(entry.label) : undefined}
                className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  collapsed ? "justify-center px-0" : ""
                } ${
                  active
                    ? "bg-[var(--accent)]/12 text-[var(--accent)] font-medium"
                    : "text-black/70 dark:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"
                }`}
              >
                {iconForLabel(entry.label)}
                {!collapsed && <span className="min-w-0 flex-1 truncate">{navLabel(entry.label)}</span>}
                {!collapsed && <Badge count={count} active={active} />}
                {collapsed && count > 0 && (
                  <span className="absolute ml-6 -mt-4 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                )}
              </Link>
            );
          }

          const groupActive = entry.tabs.some((tab) => pathname?.startsWith(tab.href));
          const groupCount = entry.tabs.reduce((sum, tab) => sum + badgeCountForHref(tab.href, badges), 0);
          const open = isGroupOpen(entry);

          // Collapsed rail: a group becomes a single icon linking to its
          // first tab, so no destination becomes unreachable.
          if (collapsed) {
            return (
              <Link
                key={entry.label}
                href={entry.tabs[0].href}
                title={navLabel(entry.label)}
                className={`flex items-center justify-center rounded-lg py-2 transition-colors ${
                  groupActive
                    ? "bg-[var(--accent)]/12 text-[var(--accent)]"
                    : "text-black/70 dark:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"
                }`}
              >
                {iconForLabel(entry.label)}
                {groupCount > 0 && (
                  <span className="absolute ml-6 -mt-4 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                )}
              </Link>
            );
          }

          return (
            <div key={entry.label}>
              <button
                onClick={() => setOpenGroups((s) => ({ ...s, [entry.label]: !open }))}
                className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  groupActive
                    ? "bg-[var(--accent)]/12 text-[var(--accent)] font-medium"
                    : "text-black/70 dark:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"
                }`}
              >
                {iconForLabel(entry.label)}
                <span className="min-w-0 flex-1 truncate text-left">{navLabel(entry.label)}</span>
                <Badge count={groupCount} active={groupActive} />
                <IconChevron
                  className={`w-3.5 h-3.5 shrink-0 opacity-50 transition-transform ${open ? "rotate-90" : ""}`}
                />
              </button>
              {open && (
                <ul className="mt-0.5 mb-1 ml-[19px] space-y-0.5 border-l pl-2.5" style={{ borderColor: "var(--border-subtle, rgba(255,255,255,0.1))" }}>
                  {entry.tabs.map((tab) => {
                    const tabActive = !!pathname?.startsWith(tab.href);
                    const tabCount = badgeCountForHref(tab.href, badges);
                    return (
                      <li key={tab.href}>
                        <Link
                          href={tab.href}
                          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                            tabActive
                              ? "text-[var(--accent)] font-medium"
                              : "text-black/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/10"
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate">{navLabel(tab.label)}</span>
                          <Badge count={tabCount} active={false} />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer: who's signed in, plus the collapse control */}
      <div className="border-t px-2 py-2" style={{ borderColor: "var(--border-subtle, rgba(255,255,255,0.1))" }}>
        <div className={`flex items-center gap-2.5 px-1.5 py-1.5 ${collapsed ? "justify-center px-0" : ""}`}>
          <span
            className="shrink-0 grid place-items-center rounded-full text-[11px] font-semibold"
            style={{
              width: 30,
              height: 30,
              background: "var(--accent)",
              color: "#0E1116",
            }}
          >
            {userName.slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{userName}</span>
              <span className="block truncate text-[10px] text-black/50 dark:text-white/50">{userRole}</span>
            </span>
          )}
          {!collapsed && (
            <button
              onClick={onLogout}
              title={t("nav.logout")}
              className="shrink-0 rounded-md p-1.5 text-black/50 dark:text-white/50 hover:bg-black/5 dark:hover:bg-white/10"
            >
              <IconLogout className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
          className={`mt-0.5 w-full flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] text-black/50 dark:text-white/50 hover:bg-black/5 dark:hover:bg-white/10 ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <IconCollapse className={`w-4 h-4 shrink-0 transition-transform ${collapsed ? "rotate-180" : ""}`} />
          {!collapsed && <span>{t("nav.collapseSidebar")}</span>}
        </button>
      </div>
    </aside>
  );
}
