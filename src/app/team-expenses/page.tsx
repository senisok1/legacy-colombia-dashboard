import { TeamExpenseRequests } from "@/components/TeamExpenseRequests";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { enforceBillingLock } from "@/lib/billingGate";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// Team Expense Request (2026-08-17, Seni's ask) — replaces the old
// Maintenance work-order tab in the nav, sitting immediately right of Team
// Activity Log.
export default async function TeamExpensesPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const lang = viewer?.language;

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t("exp.title", lang)}</h1>
        <p className="text-sm text-black/50 dark:text-white/50">{t("exp.subtitle", lang)}</p>
      </div>
      <TeamExpenseRequests />
    </div>
  );
}
