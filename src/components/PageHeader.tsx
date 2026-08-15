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
  title,
  subtitle,
  tabs,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  tabs?: NavTab[];
}) {
  const pathname = usePathname();

  return (
    <div className="space-y-4">
      <div>
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--accent)] mb-1">{eyebrow}</p>
        )}
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-black/50 dark:text-white/50 mt-1">{subtitle}</p>}
      </div>

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
