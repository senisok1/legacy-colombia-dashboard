import { notFound } from "next/navigation";
import Link from "next/link";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { findGuestWithStats } from "@/lib/guests";
import { formatDate } from "@/lib/format";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { BookingsTable } from "@/components/BookingsTable";
import { GuestNotesEditor } from "@/components/GuestNotesEditor";
import { Money } from "@/components/Money";

export const dynamic = "force-dynamic";

export default async function GuestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guestId = Number(id);
  const session = await getServerSession();
  await enforceBillingLock(session);
  const orgId = session?.organizationId;
  const [guests, bookings] = await Promise.all([getGuests(orgId), getBookings(orgId)]);
  const guest = await findGuestWithStats(guests, bookings, guestId, orgId);

  if (!guest) return notFound();

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <Link href="/guests" className="text-sm text-black/50 dark:text-white/50 hover:underline">
        ← All guests
      </Link>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">
            {guest.fullName} {guest.isRepeat && <span className="text-sm font-normal text-green-700 dark:text-green-400">(repeat guest)</span>}
          </h1>
          <p className="text-sm text-black/50 dark:text-white/50">
            {guest.email || "No email on file"} {guest.phone ? `· ${guest.phone}` : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <div className="text-xs uppercase text-black/50 dark:text-white/50">Total stays</div>
          <div className="text-2xl font-semibold">{guest.totalStays}</div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <div className="text-xs uppercase text-black/50 dark:text-white/50">Total nights</div>
          <div className="text-2xl font-semibold">{guest.totalNights}</div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <div className="text-xs uppercase text-black/50 dark:text-white/50">Lifetime value</div>
          <div className="text-2xl font-semibold">
            <Money amount={guest.lifetimeValue} />
          </div>
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <div className="text-xs uppercase text-black/50 dark:text-white/50">First → last stay</div>
          <div className="text-sm font-medium mt-1.5">
            {formatDate(guest.firstStay)} → {formatDate(guest.lastStay)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <h2 className="text-sm font-semibold mb-3">Stay history</h2>
          <BookingsTable bookings={guest.bookings} />
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <h2 className="text-sm font-semibold mb-3">Notes &amp; tags</h2>
          <GuestNotesEditor guestId={guest.id} initialNotes={guest.notes} initialTags={guest.tags} />
        </div>
      </div>
    </div>
  );
}
