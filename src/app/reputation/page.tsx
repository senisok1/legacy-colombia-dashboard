import { listReputationEntries } from "@/lib/reputationManager";
import { getServerSession } from "@/lib/session";
import { cookies } from "next/headers";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { enforceBillingLock } from "@/lib/billingGate";
import { ReputationExplorer } from "@/components/ReputationExplorer";

export const dynamic = "force-dynamic";

export default async function ReputationPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const entries = await listReputationEntries(session?.organizationId, groupId);

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
