import { MessagingCenter } from "@/components/MessagingCenter";
import { isMessagingConfigured } from "@/lib/config";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";

export const dynamic = "force-dynamic";

// Deliberately does NOT fetch bookings/guests here — MessagingCenter's Inbox
// tab pulls everything it needs itself via /api/messages/inbox, and the
// Templates/Sent-log tabs never needed them either (see MessagingCenter.tsx).
// This used to block the whole page behind two OwnerRez calls (getBookings +
// getGuests) before rendering anything, purely for props nothing read —
// removing it means clicking the Messaging tab shows the page shell
// immediately instead of waiting on data it was throwing away.
export default async function MessagingPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  // Templates + sent log now load client-side after first paint (2026-08-16
  // instant-load fix) — the shell renders immediately.

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <p className="text-sm text-black/50 dark:text-white/50">
          Full conversation inbox with AI-suggested replies and automatic English translation, plus pre-arrival,
          check-in, and post-stay templates.
        </p>
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <MessagingCenter messagingConfigured={isMessagingConfigured()} />
      </div>
    </div>
  );
}
