"use client";

import Link from "next/link";
import { useState } from "react";
import { useT } from "@/components/LanguageProvider";
import { useCurrency } from "@/components/CurrencyProvider";
import { NAV_LABEL_KEYS, type NavEntry } from "@/lib/navModel";
import { badgeCountForHref, type NavBadges } from "./useNavBadges";
import { iconForLabel, IconDashboard, IconStays, IconMessaging, IconConstruction, IconMore, IconLogout } from "./NavIcons";
import { PropertySwitcher } from "./PropertySwitcher";
import { useShellVisuals } from "./ShellData";

// Mobile navigation (2026-08-22 UI refresh): a fixed bottom bar of five
// primary destinations plus a "More" drawer holding every secondary module.
//
// TWO RULES FROM THE BRIEF, ENFORCED HERE:
// 1. Nothing accessible on desktop may become inaccessible on mobile — the
//    More drawer is built from the SAME role-filtered entries the sidebar
//    renders, so any module a login can reach is reachable here too.
// 2. No new functionality. "Stays" and "Tasks" are fast paths to EXISTING
//    routes (/management and /construction), not new screens or data.
//
// Bottom-bar tap targets are >=48px tall and the bar carries iOS safe-area
// padding so the home indicator never sits on top of a control.

type BottomItem = {
  key: string;
  href: string;
  labelKey: string;
  fallback: string;
  icon: React.ReactNode;
  badge?: number;
};

export function MobileNav({
  entries,
  pathname,
  badges,
  activeGroupId,
  userName,
  userRole,
  onLogout,
}: {
  entries: NavEntry[];
  pathname: string | null;
  badges: NavBadges;
  activeGroupId: string;
  userName: string;
  userRole: string;
  onLogout: () => void;
}) {
  const t = useT();
  const visuals = useShellVisuals();
  const [moreOpen, setMoreOpen] = useState(false);
  const navLabel = (label: string) => (NAV_LABEL_KEYS[label] ? t(NAV_LABEL_KEYS[label]) : label);

  // Only offer a bottom-bar destination the current role can actually reach
  // (a CONSTRUCTION login has no /messaging, a READ_ONLY login has no
  // /construction) — anything not permitted simply isn't rendered.
  const canReach = (href: string) =>
    entries.some((e) => (e.type === "link" ? e.href === href : e.tabs.some((tb) => tb.href === href)));

  const candidates: BottomItem[] = [
    {
      key: "dashboard",
      href: "/dashboard",
      labelKey: "nav.dashboard",
      fallback: "Dashboard",
      icon: <IconDashboard className="w-[21px] h-[21px]" />,
    },
    {
      key: "stays",
      href: "/management",
      labelKey: "nav.stays",
      fallback: "Stays",
      icon: <IconStays className="w-[21px] h-[21px]" />,
    },
    {
      key: "messages",
      href: "/messaging",
      labelKey: "nav.messages",
      fallback: "Messages",
      icon: <IconMessaging className="w-[21px] h-[21px]" />,
      badge: badgeCountForHref("/approvals", badges),
    },
    {
      key: "tasks",
      href: "/construction",
      labelKey: "nav.tasks",
      fallback: "Tasks",
      icon: <IconConstruction className="w-[21px] h-[21px]" />,
    },
  ];
  const bottom = candidates.filter((c) => canReach(c.href));

  return (
    <>
      {/* Fixed bottom bar */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t backdrop-blur"
        style={{
          borderColor: "var(--border-subtle, rgba(255,255,255,0.1))",
          background: "color-mix(in srgb, var(--background) 94%, transparent)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <ul className="flex items-stretch">
          {bottom.map((item) => {
            const active = !!pathname?.startsWith(item.href);
            return (
              <li key={item.key} className="flex-1">
                <Link
                  href={item.href}
                  className={`relative flex flex-col items-center justify-center gap-0.5 min-h-[52px] px-1 py-1.5 text-[10px] transition-colors ${
                    active ? "text-[var(--accent)]" : "text-[var(--text-muted,rgba(120,120,120,0.9))]"
                  }`}
                >
                  <span className="relative">
                    {item.icon}
                    {item.badge ? (
                      <span className="absolute -top-1 -right-2 min-w-[15px] text-center text-[9px] leading-[15px] px-1 rounded-full bg-[var(--accent)] text-[#0E1116] font-semibold">
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate max-w-full">{t(item.labelKey)}</span>
                  {active && (
                    <span className="absolute top-0 inset-x-3 h-[2px] rounded-full bg-[var(--accent)]" />
                  )}
                </Link>
              </li>
            );
          })}
          <li className="flex-1">
            <button
              onClick={() => setMoreOpen(true)}
              className={`w-full flex flex-col items-center justify-center gap-0.5 min-h-[52px] px-1 py-1.5 text-[10px] transition-colors ${
                moreOpen ? "text-[var(--accent)]" : "text-[var(--text-muted,rgba(120,120,120,0.9))]"
              }`}
            >
              <IconMore className="w-[21px] h-[21px]" />
              <span>{t("nav.more")}</span>
            </button>
          </li>
        </ul>
      </nav>

      {/* More drawer — every secondary module, plus account controls */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col">
          <button
            aria-label="Close"
            onClick={() => setMoreOpen(false)}
            className="flex-1 bg-black/60 backdrop-blur-sm"
          />
          <div
            className="rounded-t-2xl border-t max-h-[82vh] overflow-y-auto"
            style={{
              borderColor: "var(--border-subtle, rgba(255,255,255,0.1))",
              background: "var(--surface, #171C22)",
              paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)",
            }}
          >
            <div className="sticky top-0 flex items-center justify-between px-4 pt-3 pb-2" style={{ background: "var(--surface, #171C22)" }}>
              <span className="mx-auto h-1 w-9 rounded-full bg-white/20" aria-hidden />
            </div>

            <PropertySwitcher groups={visuals?.groups ?? []} activeGroupId={activeGroupId} collapsed={false} />

            <ul className="px-3 pb-2 space-y-0.5">
              {entries.map((entry) => {
                if (entry.type === "link") {
                  const active = !!pathname?.startsWith(entry.href);
                  const count = badgeCountForHref(entry.href, badges);
                  return (
                    <li key={entry.href}>
                      <Link
                        href={entry.href}
                        onClick={() => setMoreOpen(false)}
                        className={`flex items-center gap-3 rounded-xl px-3 min-h-[46px] text-sm ${
                          active ? "bg-[var(--accent)]/12 text-[var(--accent)] font-medium" : "hover:bg-white/5"
                        }`}
                      >
                        {iconForLabel(entry.label)}
                        <span className="min-w-0 flex-1 truncate">{navLabel(entry.label)}</span>
                        {count > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/20 text-[var(--accent)]">
                            {count}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                }
                return (
                  <li key={entry.label}>
                    <div className="flex items-center gap-3 px-3 pt-3 pb-1 text-[11px] uppercase tracking-wider text-black/40 dark:text-white/40">
                      {navLabel(entry.label)}
                    </div>
                    <ul className="space-y-0.5">
                      {entry.tabs.map((tab) => {
                        const tabActive = !!pathname?.startsWith(tab.href);
                        const tabCount = badgeCountForHref(tab.href, badges);
                        return (
                          <li key={tab.href}>
                            <Link
                              href={tab.href}
                              onClick={() => setMoreOpen(false)}
                              className={`flex items-center gap-3 rounded-xl px-3 min-h-[46px] text-sm ${
                                tabActive
                                  ? "bg-[var(--accent)]/12 text-[var(--accent)] font-medium"
                                  : "hover:bg-white/5"
                              }`}
                            >
                              {iconForLabel(tab.label)}
                              <span className="min-w-0 flex-1 truncate">{navLabel(tab.label)}</span>
                              {tabCount > 0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/20 text-[var(--accent)]">
                                  {tabCount}
                                </span>
                              )}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>

            <MobileAccountRow userName={userName} userRole={userRole} onLogout={onLogout} />
          </div>
        </div>
      )}
    </>
  );
}

/** Currency toggle + who's signed in + log out — the controls that live in
 *  the desktop header/sidebar footer, kept reachable on mobile. */
function MobileAccountRow({
  userName,
  userRole,
  onLogout,
}: {
  userName: string;
  userRole: string;
  onLogout: () => void;
}) {
  const t = useT();
  const { secondaryCurrency, displayCurrency, setDisplayCurrency } = useCurrency();
  return (
    <div className="border-t mt-1 px-4 pt-3" style={{ borderColor: "var(--border-subtle, rgba(255,255,255,0.1))" }}>
      {secondaryCurrency && (
        <div className="flex items-center gap-2 pb-3">
          <span className="text-[11px] text-black/50 dark:text-white/50">{t("nav.currency")}</span>
          <div className="flex items-center rounded-lg bg-white/10 p-0.5">
            {["USD", secondaryCurrency].map((c) => (
              <button
                key={c}
                onClick={() => setDisplayCurrency(c)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium ${
                  displayCurrency === c ? "bg-[var(--accent)] text-[#0E1116]" : "text-white/60"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 pb-2">
        <span
          className="shrink-0 grid place-items-center rounded-full text-[12px] font-semibold"
          style={{ width: 34, height: 34, background: "var(--accent)", color: "#0E1116" }}
        >
          {userName.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{userName}</span>
          <span className="block truncate text-[11px] text-black/50 dark:text-white/50">{userRole}</span>
        </span>
        <button
          onClick={onLogout}
          className="flex items-center gap-1.5 rounded-lg px-3 min-h-[40px] text-[12px] text-black/60 dark:text-white/60 hover:bg-white/5"
        >
          <IconLogout className="w-4 h-4" />
          {t("nav.logout")}
        </button>
      </div>
    </div>
  );
}
