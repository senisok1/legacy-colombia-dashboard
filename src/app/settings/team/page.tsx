import { TeamLoginsManager } from "@/components/TeamLoginsManager";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";

export const dynamic = "force-dynamic";

// "Add a Team Member" — its own page under the Settings nav dropdown
// (2026-08-16, Seni's ask; previously an inline section on /settings).
export default async function TeamMembersPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 space-y-6">
      <div>
        <p className="text-sm text-black/50 dark:text-white/50">
          Create and manage logins for your team — admins get full access, team members can view everything and
          add notes on the Management tab.
        </p>
      </div>
      {/* TeamLoginsManager renders its own two separate cards (create-login
          form, then current team members below it) — no shared wrapper here
          anymore, so the two sections read as genuinely distinct boxes
          instead of one big card with a divider inside it (2026-08-20,
          Seni's ask: "I want it visually as a separate box"). */}
      <TeamLoginsManager />
    </div>
  );
}
