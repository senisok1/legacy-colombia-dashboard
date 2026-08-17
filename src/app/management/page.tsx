import { ManagementBoard } from "@/components/ManagementBoard";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";

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

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Team Management</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Upcoming and in-house stays for the on-site team — guest info, dates, party size, paid-extras requests,
          event notes, and the shared team activity log.
        </p>
      </div>
      <ManagementBoard />
    </div>
  );
}
