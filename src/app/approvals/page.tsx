import { getAllPendingDrafts } from "@/lib/pendingDrafts";
import { ApprovalsQueue } from "@/components/ApprovalsQueue";
import { isMessagingConfigured } from "@/lib/config";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const configured = isMessagingConfigured();
  const drafts = configured ? await getAllPendingDrafts(session?.organizationId) : [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Every AI-suggested guest reply waiting on your yes/no, in one place — the same queue behind the WhatsApp
          approval texts and the Messaging inbox&rsquo;s suggestion card, just flattened across every conversation
          so you don&rsquo;t have to open each thread to find what needs a decision.
        </p>
      </div>

      {!configured ? (
        <p className="text-sm text-black/50 dark:text-white/50 py-8 text-center">
          OwnerRez messaging isn&rsquo;t connected yet — nothing to approve until it is.
        </p>
      ) : (
        <ApprovalsQueue initialDrafts={drafts} />
      )}
    </div>
  );
}
