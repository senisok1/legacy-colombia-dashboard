import { redirect } from "next/navigation";
import { isBillingEnforced } from "./config";
import { getOrganizationById } from "./organizations";
import { isOrgLocked } from "./billing";
import type { SessionPayload } from "./session";

// Called at the top of every authenticated dashboard page.tsx, right after
// getServerSession() — same insertion point Phase 3 already used to thread
// organizationId through every page (see lib/session.ts's getServerSession
// comment). Redirects to /billing if the org's trial has run out or its
// subscription is past_due/canceled — the hard-lock policy Seni chose for
// Phase 4 (no read-only grace period).
//
// Deliberately a no-op (never redirects) when:
//   - Stripe isn't configured on this deployment yet (isBillingEnforced()
//     false) — so this ships without locking out Legacy Estate Rentals (or
//     breaking local dev) before Seni has actually created Stripe Prices.
//   - There's no session / no organizationId — each page's own existing
//     auth handling (or lack thereof, pre-login) already covers that case;
//     this function only adds the billing concern on top.
//   - The organization can't be loaded — fails open rather than locking
//     someone out because of a transient DB hiccup.
export async function enforceBillingLock(session: SessionPayload | null): Promise<void> {
  if (!isBillingEnforced()) return;
  if (!session?.organizationId) return;

  const org = await getOrganizationById(session.organizationId);
  if (org && isOrgLocked(org)) {
    redirect("/billing");
  }
}
