import { TeamExpenseRequests } from "@/components/TeamExpenseRequests";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";

export const dynamic = "force-dynamic";

// Team Expense Request (2026-08-17, Seni's ask) — replaces the old
// Maintenance work-order tab in the nav, sitting immediately right of Team
// Activity Log.
export default async function TeamExpensesPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Team Expense Request</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Anyone on the team can ask for money to be spent. The owner approves it, then whoever buys it marks it
          completed with what it actually cost. Every step records who and when.
        </p>
      </div>
      <TeamExpenseRequests />
    </div>
  );
}
