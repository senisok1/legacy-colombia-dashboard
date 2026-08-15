import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { BillingPlans } from "@/components/BillingPlans";

// The Phase 4 hard-lock destination (see lib/billingGate.ts) as well as the
// normal, voluntary "manage my plan" screen for an org in good standing —
// same page either way, it just leads with different copy depending on
// what /api/billing/status reports (see BillingPlans.tsx).
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-sm text-black/50 dark:text-white/50 mt-1">
          Manage your subscription — pricing is based on how many properties you manage.
        </p>
      </div>
      <BillingPlans />
    </div>
  );
}
