"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  MARKETING_GROUP_TABS,
  MESSAGING_GROUP_TABS,
  REPORTS_GROUP_TABS,
  SETTINGS_GROUP_TABS,
  type NavTab,
} from "@/lib/navGroups";
import { useCurrency } from "@/components/CurrencyProvider";
import { PROPERTY_GROUPS, propertyGroupById } from "@/lib/propertyGroups";

type NavPropertyGroup = { id: string; label: string };

// Nav structure — a flat list of either a single link or a "group" (a
// dropdown of related sub-pages). Consolidated 2026-08-05 (Seni's ask,
// after picking "visual refresh + consolidate tabs" over a mobile-first
// pass): CRM/CRM Campaigns/Sales Pipeline collapsed into one "CRM"
// dropdown, Bill Pay/Vendors into one "Bill Pay" dropdown. Consolidated
// further 2026-08-07 (Seni's explicit ask to cut down the top-level tab
// count): Approvals + Reputation folded under "Messaging", Maintenance
// folded under "Bill Pay", Revenue folded under "Reports", Billing folded
// under "Settings" — cuts the top-level count from 13 to 7. The underlying
// routes/badges are untouched (see navGroups.ts), so nothing that linked
// directly to e.g. /approvals or /revenue-management breaks.
type NavEntry = { type: "link"; href: string; label: string } | { type: "group"; label: string; tabs: NavTab[] };

const navEntries: NavEntry[] = [
  { type: "link", href: "/dashboard", label: "Dashboard" },
  // Management (2026-08-16): the on-site team's central tab — upcoming
  // stays, paid-extras/event notes, team activity log. Also the home base
  // for the READ_ONLY team login (see src/proxy.ts's role gate).
  { type: "link", href: "/management", label: "Team Management" },
  // Team Expense Request (2026-08-17) — the on-site team asks for spend, the
  // owner approves, whoever buys it marks it completed.
  { type: "link", href: "/team-expenses", label: "Team Expense Request" },
  // Team Activity Log sits to the RIGHT of Team Expense Request (2026-08-17,
  // Seni's ask) — it was briefly the other way round.
  { type: "link", href: "/team-log", label: "Team Activity Log" },
  { type: "group", label: "Messaging", tabs: MESSAGING_GROUP_TABS },
  { type: "group", label: "Marketing", tabs: MARKETING_GROUP_TABS },
  { type: "group", label: "Reports", tabs: REPORTS_GROUP_TABS },
  // Bill Pay sits between Reports and Settings (2026-08-17, Seni's ask).
  { type: "link", href: "/bill-pay", label: "Bill Pay" },
  { type: "group", label: "Settings", tabs: SETTINGS_GROUP_TABS },
];

// Bill statuses that mean "Seni hasn't dealt with this yet" — mirrors the
// "open" filter default on the Bill Pay tab itself (BillPayExplorer.tsx).
const BILL_NEEDS_ATTENTION = new Set(["pending_review", "flagged_duplicate", "flagged_anomaly"]);

// A lead sitting at "new" means nobody has reached out yet — the one stage
// where a badge is actually actionable (every later stage already implies
// someone looked at it).
const LEAD_NEEDS_ATTENTION = new Set(["new"]);

// A work order sitting at "open" means nobody has started on it yet — same
// "one stage nobody's looked at" logic as LEAD_NEEDS_ATTENTION above.
const WORK_ORDER_NEEDS_ATTENTION = new Set(["open"]);

// How often to poll for the nav badge counts below. This used to be "one
// Redis-backed route" and safe to run every 30s, but it has since grown to
// SIX endpoints (approvals, bills, leads, campaigns, maintenance,
// reputation) — several of which call getBookings()/getTargetProperties()
// under the hood, i.e. real OwnerRez API traffic, not just Redis. Because
// this effect re-fires on every client-side navigation AND re-arms its own
// interval, a single open tab left idle was quietly generating a steady
// drumbeat of OwnerRez calls every 30s, forever. Diagnosed 2026-08-05: this
// was the actual root cause of an OwnerRez 429 ("Rate limit exceeded" on
// /properties) that silently starved api/cron/check-messages of its own
// OwnerRez calls for over an hour, which meant a real guest message (Nyree
// Tanielian, thread 11265042) never triggered a WhatsApp approval alert —
// see project memory for the full incident writeup. Badge counts aren't
// time-critical the way a live guest reply is, so widening this to 3
// minutes cuts steady-state OwnerRez pressure from this component by 6x
// while still feeling responsive for a "something needs attention" nav
// indicator.
const APPROVALS_BADGE_POLL_MS = 180_000;

// Per-org USD/<secondary currency> display toggle — see CurrencyProvider.tsx.
// Only renders once an org has turned on a secondary currency in Settings >
// Currency (off by default for every tenant except Seni's own Legacy Estate
// Rentals login, which uses COP). Shows on every page (NavBar is rendered
// once in the root layout) so switching currency anywhere applies
// everywhere: Dashboard, Reports, Revenue Management, Bill Pay, etc. The
// title tooltip surfaces the live rate so the conversion isn't a black box.
function CurrencyToggle() {
  const { secondaryCurrency, displayCurrency, setDisplayCurrency, rate } = useCurrency();
  if (!secondaryCurrency) return null;

  const title = rate
    ? `1 USD ≈ ${rate.usdToTarget.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${secondaryCurrency}${
        rate.source === "fallback" ? " (fallback rate — live lookup unavailable)" : ""
      }`
    : "Loading exchange rate…";

  return (
    <div
      className="flex items-center rounded-md bg-black/5 dark:bg-white/10 p-0.5 shrink-0 whitespace-nowrap"
      title={title}
    >
      {["USD", secondaryCurrency].map((c) => (
        <button
          key={c}
          onClick={() => setDisplayCurrency(c)}
          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
            displayCurrency === c
              ? "bg-[var(--accent)] text-white"
              : "text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white"
          }`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

function Badge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={`text-[10px] leading-none px-1.5 py-0.5 rounded-full ${
        active ? "bg-white/25 text-white" : "bg-amber-500 text-white"
      }`}
    >
      {count}
    </span>
  );
}

// Tabs hidden from READ_ONLY team logins (2026-08-16, Seni's ask) — team
// members see Dashboard, Management, Bill Pay, and Settings only. Admins
// keep everything. Display-layer only; the real enforcement is the proxy's
// role gate (a team member typing /messaging still can't change anything).
// Team members (READ_ONLY) see EXACTLY these tabs (2026-08-17, Seni's spec):
// Dashboard, Team Management, Team Expense Request, Team Activity Log, and a
// plain Settings link (no Settings dropdown — no Add a Team Member, no
// Billing). Everything else is hidden here AND blocked in src/proxy.ts, so
// typing the URL doesn't get around it.
const TEAM_HIDDEN_LABELS = new Set(["Messaging", "Marketing", "Reports", "Bill Pay"]);

// Wordmark property switcher (2026-08-16, Seni's ask): clicking the brand
// opens a dropdown of the account's property views; picking one sets the
// lc_property_group cookie and reloads, re-scoping the whole dashboard.
function PropertySwitcher({ activeGroupId, groups }: { activeGroupId: string; groups: NavPropertyGroup[] }) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  // position:fixed dropdown, same fix as the nav group panels: the header's
  // overflow handling clips position:absolute children (menu was in the DOM
  // but invisible — confirmed live 2026-08-16).
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const active = propertyGroupById(activeGroupId);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 6, left: r.left });
    }
    setOpen((o) => !o);
  }

  async function choose(groupId: string) {
    if (groupId === activeGroupId || switching) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      const res = await fetch("/api/settings/property-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      if (res.ok) window.location.reload();
      else setSwitching(false);
    } catch {
      setSwitching(false);
    }
  }

  return (
    <div className="relative shrink-0 whitespace-nowrap">
      <button
        ref={btnRef}
        onClick={toggle}
        className="font-semibold tracking-tight flex items-center gap-2 hover:opacity-80"
        title="Switch property"
      >
        <span className="w-2 h-2 rounded-full bg-[var(--accent)]" aria-hidden />
        {switching ? "Switching…" : active.label}
        <span className="text-xs opacity-60">▾</span>
      </button>
      {open && menuPos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
            className="z-50 min-w-[12rem] rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-neutral-900 p-1 shadow-lg"
          >
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => void choose(g.id)}
                className={`block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10 ${
                  g.id === activeGroupId ? "font-semibold text-[var(--accent)]" : ""
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function NavBar({
  role,
  propertyGroupId,
  propertyGroups,
}: {
  role?: string;
  propertyGroupId?: string;
  propertyGroups?: NavPropertyGroup[];
}) {
  const visibleEntries =
    role === "READ_ONLY"
      ? navEntries
          .filter((e) => !TEAM_HIDDEN_LABELS.has(e.label))
          // Settings collapses from a dropdown to a single link for the team.
          .map((e): NavEntry => (e.label === "Settings" ? { type: "link", href: "/settings", label: "Settings" } : e))
      : navEntries;
  const pathname = usePathname();
  const router = useRouter();
  const [pendingCount, setPendingCount] = useState(0);
  const [billsNeedingAttention, setBillsNeedingAttention] = useState(0);
  const [leadsNeedingAttention, setLeadsNeedingAttention] = useState(0);
  const [campaignsNeedingAttention, setCampaignsNeedingAttention] = useState(0);
  const [workOrdersNeedingAttention, setWorkOrdersNeedingAttention] = useState(0);
  const [reviewsNeedingAttention, setReviewsNeedingAttention] = useState(0);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // Bug found 2026-08-05: the CRM/Bill Pay dropdown panels were rendered as
  // position:absolute children of <nav>, which needs overflow-x-auto so it
  // can scroll horizontally on narrow viewports instead of wrapping. Per the
  // CSS Overflow spec, an element can't have overflow-x:auto and
  // overflow-y:visible at the same time — the browser silently forces
  // overflow-y to auto too (tried a plain "overflow-y-visible" utility
  // first; the *computed* overflow-y stayed "auto" regardless), which
  // clipped the dropdown to the nav's own ~32px height. Fix: render the
  // panel with position:fixed, with its coordinates computed from the
  // trigger button's own on-screen position at the moment it's opened.
  // Fixed positioning is anchored to the viewport, not the scrolling
  // ancestor, so it fully escapes the clip. The header is `sticky top-0`,
  // so its buttons don't move on page scroll — computing the position once,
  // on click, is enough (no scroll listener needed to keep it in sync).
  const [dropdownPos, setDropdownPos] = useState<{ label: string; top: number; left: number } | null>(null);
  const navRef = useRef<HTMLElement>(null);

  // Closes any open group dropdown when the route actually changes.
  // Deliberately done during render (React's documented pattern for
  // "reset state when a prop/derived value changes") rather than in a
  // useEffect, which would cause an extra post-navigation render just to
  // clear this.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpenGroup(null);
  }

  // Per-href badge counts, generalized so both a plain link and any tab
  // inside a group can look up "does this specific page need attention" —
  // a group button then sums its tabs' counts so the signal isn't hidden
  // behind a collapsed dropdown.
  function badgeCountForHref(href: string): number {
    switch (href) {
      case "/approvals":
        return pendingCount;
      case "/bill-pay":
        return billsNeedingAttention;
      case "/sales-pipeline":
        return leadsNeedingAttention;
      case "/crm-campaigns":
        return campaignsNeedingAttention;
      case "/maintenance":
        return workOrdersNeedingAttention;
      case "/reputation":
        return reviewsNeedingAttention;
      default:
        return 0;
    }
  }

  // Surfaces "something needs your attention" right in the nav, without
  // requiring Seni to click into Approvals to discover a queue has built up.
  useEffect(() => {
    if (pathname?.startsWith("/login") || pathname?.startsWith("/signup") || pathname?.startsWith("/onboarding"))
      return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/approvals");
        const data = (await res.json()) as { drafts: unknown[] };
        if (!cancelled) setPendingCount(data.drafts.length);
      } catch {
        // Badge just stays at its last known value on a transient failure.
      }
      try {
        const res = await fetch("/api/bills");
        const data = (await res.json()) as { bills: { status: string }[] };
        if (!cancelled) {
          setBillsNeedingAttention(data.bills.filter((b) => BILL_NEEDS_ATTENTION.has(b.status)).length);
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
      try {
        const res = await fetch("/api/leads");
        const data = (await res.json()) as { leads: { stage: string }[] };
        if (!cancelled) {
          setLeadsNeedingAttention(data.leads.filter((l) => LEAD_NEEDS_ATTENTION.has(l.stage)).length);
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
      try {
        const res = await fetch("/api/campaigns");
        const data = (await res.json()) as { candidates: { status: string }[] };
        if (!cancelled) {
          setCampaignsNeedingAttention(data.candidates.filter((c) => c.status === "candidate").length);
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
      try {
        const res = await fetch("/api/maintenance");
        const data = (await res.json()) as { workOrders: { status: string }[] };
        if (!cancelled) {
          setWorkOrdersNeedingAttention(
            data.workOrders.filter((w) => WORK_ORDER_NEEDS_ATTENTION.has(w.status)).length
          );
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
      try {
        const res = await fetch("/api/reputation");
        const data = (await res.json()) as { entries: { response?: { status: string } }[] };
        if (!cancelled) {
          setReviewsNeedingAttention(data.entries.filter((e) => e.response?.status === "pending_review").length);
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
    }

    poll();
    const interval = setInterval(poll, APPROVALS_BADGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pathname]);

  // Close an open group dropdown on outside click or on navigation.
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenGroup(null);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  if (pathname?.startsWith("/login") || pathname?.startsWith("/signup") || pathname?.startsWith("/onboarding"))
    return null;

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-black/10 bg-white/80 backdrop-blur sticky top-0 z-10 dark:bg-black/40 dark:border-white/10">
      {/* max-w-6xl (the same width used for page content below) was too
          narrow to hold the wordmark + all 13 nav entries side by side once
          measured against real button widths — flexbox was shrinking both
          the wordmark and individual nav buttons below their natural
          content width, which made multi-word labels ("Bill Pay", the "▾"
          group indicator, even "Legacy Colombia · Dashboard" itself) wrap
          onto a second line internally. That's what read as "two Dashboard
          buttons" (the wordmark's "· Dashboard" suffix wrapping onto its
          own line right next to the real Dashboard nav pill) and an
          "unorganized" row (some buttons one line, some two, uneven
          spacing). Fixed 2026-08-05 by dropping the redundant "· Dashboard"
          suffix entirely (the actual Dashboard nav link sits right next to
          it — no need to say it twice), giving the header its own wider
          max-width than the page content below it, and making every label
          whitespace-nowrap/shrink-0 so text never wraps internally again —
          if the window is ever genuinely too narrow for that, the nav
          scrolls horizontally (overflow-x-auto) instead of squeezing. */}
      <div className="mx-auto max-w-[100rem] px-6 py-3 flex items-center justify-between gap-4">
        <PropertySwitcher
          activeGroupId={propertyGroupId ?? "legacy-colombia"}
          groups={propertyGroups && propertyGroups.length > 0 ? propertyGroups : PROPERTY_GROUPS}
        />
        {/* overflow-x-auto here was silently clipping the CRM/Bill Pay
            dropdown panels: per the CSS Overflow spec, an element can't
            have overflow-x:auto and overflow-y:visible at once — the
            browser forces overflow-y to auto too (confirmed live: even an
            explicit overflow-y-visible utility computed back to "auto"),
            so this 32px-tall flex row clipped its own dropdown children the
            moment they extended below it. The dropdown panels themselves
            now render with position:fixed (see openGroup/dropdownPos state
            above) instead of relying on this container's overflow being
            visible, so this overflow-x-auto can stay exactly as it was for
            the narrow-viewport horizontal-scroll fallback. */}
        <nav ref={navRef} className="flex items-center gap-1 overflow-x-auto">
          {visibleEntries.map((entry) => {
            if (entry.type === "link") {
              const active = pathname?.startsWith(entry.href);
              const count = badgeCountForHref(entry.href);
              return (
                <Link
                  key={entry.href}
                  href={entry.href}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                    active
                      ? "bg-[var(--accent)] text-white"
                      : "text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
                  }`}
                >
                  {entry.label}
                  <Badge count={count} active={!!active} />
                </Link>
              );
            }

            // Group (dropdown)
            const active = entry.tabs.some((t) => pathname?.startsWith(t.href));
            const groupCount = entry.tabs.reduce((sum, t) => sum + badgeCountForHref(t.href), 0);
            const isOpen = openGroup === entry.label;
            return (
              <div key={entry.label} className="relative shrink-0">
                <button
                  onClick={(e) => {
                    if (isOpen) {
                      setOpenGroup(null);
                      return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDropdownPos({ label: entry.label, top: rect.bottom + 4, left: rect.left });
                    setOpenGroup(entry.label);
                  }}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                    active
                      ? "bg-[var(--accent)] text-white"
                      : "text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
                  }`}
                >
                  {entry.label}
                  <Badge count={groupCount} active={active} />
                  <span className="text-[9px] opacity-60">▾</span>
                </button>
                {isOpen && dropdownPos?.label === entry.label && (
                  <div
                    className="fixed min-w-[10rem] rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-neutral-900 shadow-lg py-1 z-20"
                    style={{ top: dropdownPos.top, left: dropdownPos.left }}
                  >
                    {entry.tabs.map((tab) => {
                      const tabActive = pathname?.startsWith(tab.href);
                      const tabCount = badgeCountForHref(tab.href);
                      return (
                        <Link
                          key={tab.href}
                          href={tab.href}
                          className={`px-3 py-1.5 text-sm flex items-center justify-between gap-2 whitespace-nowrap ${
                            tabActive
                              ? "text-[var(--accent)] font-medium"
                              : "text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
                          }`}
                        >
                          {tab.label}
                          <Badge count={tabCount} active={false} />
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <CurrencyToggle />
          <button
            onClick={logout}
            className="px-3 py-1.5 rounded-md text-sm text-black/50 hover:bg-black/5 dark:text-white/50 dark:hover:bg-white/10 shrink-0 whitespace-nowrap"
          >
            Log out
          </button>
        </nav>
      </div>
    </header>
  );
}
