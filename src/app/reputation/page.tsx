import { listReputationEntries } from "@/lib/reputationManager";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { ReputationExplorer } from "@/components/ReputationExplorer";

export const dynamic = "force-dynamic";

export default async function ReputationPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const entries = await listReputationEntries(session?.organizationId);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Reputation</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Every guest review from OwnerRez (Airbnb, Vrbo, and other OTAs), with AI-drafted responses queued for
          your approval. Nothing is ever posted automatically — OwnerRez&rsquo;s API has no write endpoint for
          reviews at all, so an &ldquo;approved&rdquo; response is ready for you to copy into OwnerRez&rsquo;s own
          Quality Center yourself.
        </p>
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <ReputationExplorer initialEntries={entries} />
      </div>
    </div>
  );
}
