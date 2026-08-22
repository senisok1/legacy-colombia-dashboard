import { ManagementBoard } from "@/components/ManagementBoard";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { enforceBillingLock } from "@/lib/billingGate";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// Management tab (2026-08-16, Seni's ask): the on-site team's central view —
// who's at the house and when, party sizes, paid-extras requests,
// wedding/event notes, plus a shared team activity log. Works for every
// role; the READ_ONLY team login can view everything across the dashboard
// but this tab's notes/activity box is the only place it can write (see
// src/proxy.ts's role gate).
export default async function ManagementPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const lang = viewer?.language;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <p className="text-sm text-black/50 dark:text-white/50">{t("mgmt.subtitle", lang)}</p>
      </div>
      <ManagementBoard />
    </div>
  );
}
