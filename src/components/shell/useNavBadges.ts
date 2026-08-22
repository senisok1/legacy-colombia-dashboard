"use client";

import { useEffect, useState } from "react";

// Nav badge counts, extracted VERBATIM from NavBar.tsx on 2026-08-22 during
// the premium UI refresh. Behavior is unchanged on purpose — including the
// hard-won rate-limit protections documented below, which exist because of
// a real production incident.

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

// How often to poll for the badge counts below. This used to be "one
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
// Tanielian, thread 11265042) never triggered a WhatsApp approval alert.
// Badge counts aren't time-critical the way a live guest reply is, so
// widening this to 3 minutes cuts steady-state OwnerRez pressure from this
// component by 6x while still feeling responsive.
const APPROVALS_BADGE_POLL_MS = 180_000;

export type NavBadges = {
  pendingCount: number;
  billsNeedingAttention: number;
  leadsNeedingAttention: number;
  campaignsNeedingAttention: number;
  workOrdersNeedingAttention: number;
  reviewsNeedingAttention: number;
};

const EMPTY: NavBadges = {
  pendingCount: 0,
  billsNeedingAttention: 0,
  leadsNeedingAttention: 0,
  campaignsNeedingAttention: 0,
  workOrdersNeedingAttention: 0,
  reviewsNeedingAttention: 0,
};

export function useNavBadges(pathname: string | null, role?: string): NavBadges {
  const [badges, setBadges] = useState<NavBadges>(EMPTY);

  useEffect(() => {
    if (pathname?.startsWith("/login") || pathname?.startsWith("/signup") || pathname?.startsWith("/onboarding"))
      return;
    // These badges are all for admin-only tabs a team member can't see, yet
    // the polls ran on EVERY session — which is how a team login was reaching
    // /api/bills, /api/approvals, /api/leads and friends at all (2026-08-17
    // audit). The middleware now returns 403 for those, so skipping the polls
    // here isn't the security fix, just the reason the console isn't full of
    // 403s for requests that were never wanted. CONSTRUCTION logins have an
    // even narrower API allowlist (proxy.ts) than READ_ONLY, so they're
    // skipped here too.
    if (role === "READ_ONLY" || role === "CONSTRUCTION") return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/approvals");
        const data = (await res.json()) as { drafts: unknown[] };
        if (!cancelled) setBadges((b) => ({ ...b, pendingCount: data.drafts.length }));
      } catch {
        // Badge just stays at its last known value on a transient failure.
      }
      try {
        const res = await fetch("/api/bills");
        const data = (await res.json()) as { bills: { status: string }[] };
        if (!cancelled) {
          setBadges((b) => ({
            ...b,
            billsNeedingAttention: data.bills.filter((x) => BILL_NEEDS_ATTENTION.has(x.status)).length,
          }));
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
      try {
        const res = await fetch("/api/leads");
        const data = (await res.json()) as { leads: { stage: string }[] };
        if (!cancelled) {
          setBadges((b) => ({
            ...b,
            leadsNeedingAttention: data.leads.filter((x) => LEAD_NEEDS_ATTENTION.has(x.stage)).length,
          }));
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
      try {
        const res = await fetch("/api/campaigns");
        const data = (await res.json()) as { candidates: { status: string }[] };
        if (!cancelled) {
          setBadges((b) => ({
            ...b,
            campaignsNeedingAttention: data.candidates.filter((c) => c.status === "candidate").length,
          }));
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
      try {
        const res = await fetch("/api/maintenance");
        const data = (await res.json()) as { workOrders: { status: string }[] };
        if (!cancelled) {
          setBadges((b) => ({
            ...b,
            workOrdersNeedingAttention: data.workOrders.filter((w) => WORK_ORDER_NEEDS_ATTENTION.has(w.status)).length,
          }));
        }
      } catch {
        // Same fail-quiet behavior as the approvals poll above.
      }
      try {
        const res = await fetch("/api/reputation");
        const data = (await res.json()) as { entries: { response?: { status: string } }[] };
        if (!cancelled) {
          setBadges((b) => ({
            ...b,
            reviewsNeedingAttention: data.entries.filter((e) => e.response?.status === "pending_review").length,
          }));
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
  }, [pathname, role]);

  return badges;
}

/** Per-href badge count, generalized so both a plain link and any tab inside
 *  a group can look up "does this specific page need attention" — a group
 *  then sums its tabs' counts so the signal isn't hidden behind a collapsed
 *  section. Lifted verbatim from NavBar.tsx. */
export function badgeCountForHref(href: string, b: NavBadges): number {
  switch (href) {
    case "/approvals":
      return b.pendingCount;
    case "/bill-pay":
      return b.billsNeedingAttention;
    case "/sales-pipeline":
      return b.leadsNeedingAttention;
    case "/crm-campaigns":
      return b.campaignsNeedingAttention;
    case "/maintenance":
      return b.workOrdersNeedingAttention;
    case "/reputation":
      return b.reviewsNeedingAttention;
    default:
      return 0;
  }
}
