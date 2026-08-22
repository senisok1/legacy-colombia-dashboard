import { ConstructionBudgetBoard } from "@/components/ConstructionBudgetBoard";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";

export const dynamic = "force-dynamic";

// Construction Budget (2026-08-20, Seni's ask) — admin/owner (CEO) only,
// stricter than the Construction Management checklist. See
// api/construction-budget/route.ts's header comment for the full access
// model: this lives at a sibling path (not nested under /construction) so
// the CONSTRUCTION login role's proxy.ts allowlist never matches it, and the
// API independently requires a CEO session regardless of what this page
// renders.
export default async function ConstructionBudgetPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-4">
      <div>
        <p className="text-sm text-black/50 dark:text-white/50">
          Imported line-item budget with live actual-spend tracking. Admin/owner only.
        </p>
      </div>
      <ConstructionBudgetBoard />
    </div>
  );
}
