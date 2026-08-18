import { TeamActivityLog } from "@/components/TeamActivityLog";
import { TeamRequests } from "@/components/TeamRequests";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";

export const dynamic = "force-dynamic";

// Team Activity Log — moved out of the Management tab into its own tab
// (2026-08-17, Seni's ask). Path is /team-log, deliberately NOT /activity:
// that's the AI Activity tab, which is admin-only and blocked for team
// logins in src/proxy.ts.
export default async function TeamLogPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Team Activity Log</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Work that isn&apos;t tied to one guest — cleaning, repairs, deliveries, supplies. Everyone sees who
          logged what and when.
        </p>
      </div>
      <TeamRequests />
      <TeamActivityLog />
    </div>
  );
}
