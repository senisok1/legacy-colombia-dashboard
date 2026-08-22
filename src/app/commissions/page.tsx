import { CommissionsBoard } from "@/components/CommissionsBoard";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { enforceBillingLock } from "@/lib/billingGate";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// Commissions tab (2026-08-19, Seni's ask): a shared ledger for Seni and
// Gabriel — extras commission (Team Management's "Add extra") plus
// Gabriel's 10% direct-booking referrals, both owner-approved and locked
// once approved. Reachable by every role; the READ_ONLY (Gabriel) session
// can view everything here but only the owner can approve/decline/settle
// (enforced in api/management/commissions, not just hidden client-side).
export default async function CommissionsPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const lang = viewer?.language;

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 space-y-4">
      <div>
        <p className="text-sm text-black/50 dark:text-white/50">{t("comm.subtitle", lang)}</p>
      </div>
      <CommissionsBoard />
    </div>
  );
}
