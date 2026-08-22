"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/LanguageProvider";
import { IconBell } from "./NavIcons";
import type { NavBadges } from "./useNavBadges";

// Notification bell (2026-08-22). Answers "what's waiting on me?" by
// merging two sources:
//   1. the badge counts the shell ALREADY polls every 3 minutes
//      (useNavBadges) — free, nothing extra fetched
//   2. /api/notifications, one light call for the few actionable items the
//      badges don't cover (commissions, team requests, overdue construction)
//
// Merging rather than re-fetching matters here: the badge endpoints hit
// OwnerRez, and over-polling them is what caused the 2026-08-05 rate-limit
// incident that silently starved the guest-message cron. The extra call
// runs once on mount, not on every open.
//
// Read-only: every row is a count and a link into the module that owns it.
// Nothing is approved, dismissed or mutated from here.

type ApiItem = { key: string; label: string; count: number; href: string; urgent: boolean };

export function NotificationBell({ badges }: { badges: NavBadges }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState<ApiItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications");
        if (!res.ok) return;
        const data = (await res.json()) as { items?: ApiItem[] };
        if (!cancelled) setExtra(data.items ?? []);
      } catch {
        // Decorative-ish surface: fail quiet, badges alone still populate it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Derived from counts the shell already has in memory.
  const fromBadges: ApiItem[] = [
    {
      key: "approvals",
      label: `${badges.pendingCount} guest ${badges.pendingCount === 1 ? "reply" : "replies"} awaiting approval`,
      count: badges.pendingCount,
      href: "/approvals",
      // Guests are waiting on a human — the one genuinely time-critical item.
      urgent: true,
    },
    {
      key: "bills",
      label: `${badges.billsNeedingAttention} bill${badges.billsNeedingAttention === 1 ? "" : "s"} to review`,
      count: badges.billsNeedingAttention,
      href: "/bill-pay",
      urgent: false,
    },
    {
      key: "reviews",
      label: `${badges.reviewsNeedingAttention} review${badges.reviewsNeedingAttention === 1 ? "" : "s"} awaiting a response`,
      count: badges.reviewsNeedingAttention,
      href: "/reputation",
      urgent: false,
    },
    {
      key: "leads",
      label: `${badges.leadsNeedingAttention} new lead${badges.leadsNeedingAttention === 1 ? "" : "s"} not yet contacted`,
      count: badges.leadsNeedingAttention,
      href: "/sales-pipeline",
      urgent: false,
    },
    {
      // Included so the bell can't contradict the nav: the Marketing badge
      // is this same count, and a sidebar showing "146" beside a bell saying
      // "all clear" would just look broken.
      key: "campaigns",
      label: `${badges.campaignsNeedingAttention} campaign candidate${badges.campaignsNeedingAttention === 1 ? "" : "s"} to review`,
      count: badges.campaignsNeedingAttention,
      href: "/crm-campaigns",
      urgent: false,
    },
    {
      key: "maintenance",
      label: `${badges.workOrdersNeedingAttention} open work order${badges.workOrdersNeedingAttention === 1 ? "" : "s"}`,
      count: badges.workOrdersNeedingAttention,
      href: "/maintenance",
      urgent: false,
    },
  ].filter((i) => i.count > 0);

  const items = [...fromBadges, ...extra].sort((a, b) => Number(b.urgent) - Number(a.urgent));
  const total = items.reduce((s, i) => s + i.count, 0);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={t("notif.title")}
        className="relative rounded-lg p-2 text-black/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/10"
      >
        <IconBell className="w-[18px] h-[18px]" />
        {total > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] rounded-full bg-[var(--accent)] px-1 text-center text-[9px] font-semibold leading-4 text-[#0E1116]">
            {total > 99 ? "99+" : total}
          </span>
        )}
        <span className="sr-only">{t("notif.title")}</span>
      </button>

      {open && (
        <>
          <button aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div
            className="absolute right-0 top-full z-50 mt-1.5 w-[19rem] overflow-hidden rounded-xl border shadow-xl"
            style={{
              borderColor: "var(--border-subtle, rgba(255,255,255,0.12))",
              background: "var(--surface, #171C22)",
            }}
          >
            <div
              className="px-3.5 py-2.5 text-xs font-semibold border-b"
              style={{ borderColor: "var(--border-subtle, rgba(255,255,255,0.1))" }}
            >
              {t("notif.title")}
            </div>
            {items.length === 0 ? (
              <p className="px-3.5 py-6 text-center text-xs text-black/40 dark:text-white/40">
                {t("notif.allClear")}
              </p>
            ) : (
              <ul className="max-h-[60vh] overflow-y-auto py-1">
                {items.map((i) => (
                  <li key={i.key}>
                    <Link
                      href={i.href}
                      onClick={() => setOpen(false)}
                      className="flex items-start gap-2.5 px-3.5 py-2.5 hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <span
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: i.urgent ? "#D4AF37" : "var(--accent)" }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 text-[12.5px] leading-snug">{i.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
