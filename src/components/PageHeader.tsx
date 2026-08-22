"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavTab } from "@/lib/navGroups";

// Shared page header (2026-08-05 visual refresh) — replaces the
// hand-copied `<h1 className="text-xl font-semibold">...` block that used
// to be duplicated at the top of every page.tsx. Two additions over the
// old inline markup: a small accent-colored kicker line (see
// globals.css's --accent variable) so pages read as part of one connected
// product rather than a stack of plain black-and-white screens, and an
// optional `tabs` prop that renders an in-page segmented control for the
// two consolidated sections (CRM, Bill Pay — see lib/navGroups.ts) so
// switching between Guests/Campaigns/Pipeline (or Bill Pay/Vendors)
// doesn't require going back up to the NavBar dropdown every time.
export function PageHeader({
  eyebrow,
  subtitle,
  tabs,
}: {
  // `title` is still part of the contract (every caller passes it) but is no
  // longer rendered here — the app shell's top header owns the page name as
  // of the 2026-08-22 refresh. Kept in the type rather than removed from all
  // six callers, so this stays a one-file change.
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  tabs?: NavTab[];
}) {
  const pathname = usePathname();

  return (
    <div className="space-y-4">
      {/* The <h1> moved into the app shell's top header (2026-08-22 UI
          refresh) — it now sits beside the property's weather/local time,
          so rendering it here too would print the page name twice on every
          screen. `title` is still accepted (and every caller still passes
          it) so nothing breaks and the shell stays the single place a page
          name is rendered. Subtitle and the section tabs stay: they carry
          real context the header deliberately doesn't. */}
      {subtitle && (
        <div>
          {eyebrow && (
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--accent)] mb-1">{eyebrow}</p>
          )}
          <p className="text-sm text-black/50 dark:text-white/50">{subtitle}</p>
        </div>
      )}

      {tabs && tabs.length > 1 && (
        <div className="inline-flex rounded-md border border-black/10 dark:border-white/15 overflow-hidden text-sm">
          {tabs.map((tab) => {
            const active = pathname?.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`px-3 py-1.5 transition-colors ${
                  active
                    ? "bg-[var(--accent)] text-white"
                    : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
