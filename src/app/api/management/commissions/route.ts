import { NextRequest, NextResponse, after } from "next/server";
import { redisGet, redisSet } from "@/lib/redis";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { buildGuestsById, resolveGuestName } from "@/lib/guestName";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import {
  listBookingExtras,
  setExtraApproval,
  unsettleBookingExtra,
  EXTRAS_PROPERTY_GROUP_ID,
  type BookingExtra,
} from "@/lib/bookingExtras";
import {
  syncDirectBookingCommissions,
  listDirectBookingCommissions,
  setDirectBookingApproval,
  setDirectBookingPct,
  setGuestPayoutOverride,
  unsettleDirectBooking,
  computeSplit,
  copSplitOverride,
  type DirectBookingCommission,
} from "@/lib/directBookingCommissions";
import {
  createCommissionSettlement,
  listCommissionSettlements,
  type SettlementLineRef,
} from "@/lib/commissionSettlements";
import { getUsdToRate } from "@/lib/exchangeRate";
import type { Booking, Guest } from "@/lib/types";

export const dynamic = "force-dynamic";

// Commissions tab (2026-08-19, Seni's ask): a shared ledger of what's owed
// to Gabriel — extras commission (see api/management/extras) and direct-
// booking 10% referrals (see lib/directBookingCommissions) — with an
// owner-only approve/decline gate and an owner-only settlement action that
// records a permanent COP payout instead of silently zeroing a balance.
//
//   GET   → the combined ledger for every logged-in role (READ_ONLY reads,
//           doesn't approve — see the viewerIsOwner flag the client uses to
//           hide the Approve/Decline/Settle controls, backed by the real
//           gate below).
//   PUT    {type, id, approved|declined}  → OWNER (CEO) ONLY
//   POST   {fxBufferPct?, note?}          → OWNER (CEO) ONLY — settle
//
// LEGACY COLOMBIA ONLY, same as extras — enforced server-side, not just
// hidden in the UI.

async function context(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Not logged in." }, { status: 401 }) };
  const me = await getUserByEmail(session.email).catch(() => null);
  const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, me?.propertyAccess);
  return { session, me, groupId };
}

type ExtraLine = {
  type: "extra";
  id: string;
  bookingId: number;
  guestName: string | null;
  serviceDate: string | null;
  kind: string;
  customLabel: string | null;
  label: string;
  guestPaid: number;
  vendorPaid: number;
  notes: string | null;
  houseAmount: number;
  gabrielAmount: number;
  createdBy: string | null;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  declined: boolean;
  declinedReason: string | null;
  settledAt: string | null;
  settlementId: string | null;
};

type DirectLine = {
  type: "direct_booking";
  id: string;
  bookingId: number;
  guestName: string | null;
  arrival: string | null;
  departure: string | null;
  totalAmount: number;
  commissionPct: number;
  /** USD→COP rate locked on detection day (see lib/directBookingCommissions
   * — 2026-08-19, Seni's ask). Null only while a pre-migration row awaits
   * its one-time backfill. */
  fxRate: number | null;
  /** Owner-only manual override of the total guest payout in COP
   * (2026-08-19, Seni's ask) — null means "use the derived totalAmount ×
   * fxRate figure". */
  guestPayoutCopOverride: number | null;
  houseAmount: number;
  gabrielAmount: number;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  declined: boolean;
  declinedReason: string | null;
  settledAt: string | null;
  settlementId: string | null;
};

function toExtraLine(e: BookingExtra, bookingsById: Map<number, Booking>, guestsById: Map<number, Guest>): ExtraLine {
  const b = bookingsById.get(e.bookingId);
  // resolveGuestName joins against /v2/guests via guestId — OwnerRez's
  // /v2/bookings response very often leaves booking.guestName itself blank
  // (see lib/guestName.ts), which is why this tab was showing the generic
  // "Guest" fallback even for bookings with a perfectly good name on file
  // (2026-08-19 fix, Seni's ask).
  const guestName = b ? resolveGuestName(b, guestsById) : null;
  return {
    type: "extra",
    id: e.id,
    bookingId: e.bookingId,
    guestName,
    serviceDate: e.serviceDate,
    kind: e.kind,
    customLabel: e.customLabel,
    label: e.kind === "other" ? e.customLabel || "Other" : e.kind,
    guestPaid: e.guestPaid,
    vendorPaid: e.vendorPaid,
    notes: e.notes,
    houseAmount: e.houseShare,
    gabrielAmount: e.gabrielShare,
    createdBy: e.createdBy,
    approved: e.approved,
    approvedByName: e.approvedByName,
    approvedAt: e.approvedAt,
    declined: e.declined,
    declinedReason: e.declinedReason,
    settledAt: e.settledAt,
    settlementId: e.settlementId,
  };
}

function toDirectLine(
  d: DirectBookingCommission,
  bookingsById: Map<number, Booking>,
  guestsById: Map<number, Guest>
): DirectLine | null {
  const b = bookingsById.get(d.bookingId);
  const split = computeSplit(d, b);
  if (!split || !b) return null;
  return {
    type: "direct_booking",
    id: d.id,
    bookingId: d.bookingId,
    guestName: resolveGuestName(b, guestsById),
    arrival: b.arrival || null,
    departure: b.departure || null,
    totalAmount: split.totalAmount,
    commissionPct: d.commissionPct,
    fxRate: d.fxRate,
    guestPayoutCopOverride: d.guestPayoutCopOverride,
    houseAmount: split.houseAmount,
    gabrielAmount: split.gabrielAmount,
    approved: d.approved,
    approvedByName: d.approvedByName,
    approvedAt: d.approvedAt,
    declined: d.declined,
    declinedReason: d.declinedReason,
    settledAt: d.settledAt,
    settlementId: d.settlementId,
  };
}

// INSTANT-LOAD SNAPSHOT (2026-08-19, Seni: "loading commissions on the
// commissions tab still takes too long. I need them to be instant"): same
// pattern as /api/management — the shared board is served from a Redis
// snapshot in one O(1) GET, a background rebuild (after()) refreshes it, and
// the client immediately follows up with ?fresh=1 so what's on screen is
// current within a couple of seconds of paint. The earlier parallelization
// fix helped a warm cache but still left every cold OwnerRez fetch
// (getGuests fans out one request per guest) in the request path — the
// snapshot takes it out entirely. Viewer-specific fields (viewerIsOwner,
// viewerEmail) are stamped on the way out, never baked into the shared
// snapshot.
const COMMISSIONS_SNAPSHOT_TTL_SECONDS = 6 * 60 * 60;

function commissionsSnapshotKey(orgId: string): string {
  return `commissions:board:${orgId}`;
}

async function buildCommissionsBoard(orgId: string, groupId: string) {
  // PERF (2026-08-19, Seni: "commissions tab took about 20 seconds to load
  // initially"): everything independent runs concurrently. The dominant cost
  // is OwnerRez itself on a cold Data Cache (getGuests alone fans out to one
  // request per guest on a miss — see lib/ownerrez.ts's fetchGuestsByIds).
  // The DB reads (extras/settlements) and the FX preview never depended on
  // that fetch, so they don't wait behind it; only the direct-bookings list
  // waits for the sync (which needs bookings first).
  const bookingsPromise = getBookings(orgId, groupId);
  const guestsPromise = getGuests(orgId, groupId).catch(() => [] as Guest[]);
  const extrasPromise = listBookingExtras(orgId);
  const settlementsPromise = listCommissionSettlements(orgId);
  // Read-only preview for the UI before Seni actually settles — the real
  // rate used in a settlement is fetched fresh again at settle time, never
  // trusted from this earlier read.
  const previewRatePromise = getUsdToRate("COP").catch(() => null);

  const bookings = await bookingsPromise;
  const bookingsById = new Map(bookings.map((b) => [b.id, b]));

  await syncDirectBookingCommissions({ organizationId: orgId, bookings }).catch((err) =>
    console.error("[commissions] syncDirectBookingCommissions failed:", err)
  );

  const [guests, extrasByBooking, directAllFlat, settlements, previewRate] = await Promise.all([
    guestsPromise,
    extrasPromise,
    listDirectBookingCommissions(orgId),
    settlementsPromise,
    previewRatePromise,
  ]);
  const guestsById = buildGuestsById(guests);
  const extrasAllFlat = [...extrasByBooking.values()].flat();

  const extraLinesAll = extrasAllFlat.map((e) => toExtraLine(e, bookingsById, guestsById));
  const directLinesAll = directAllFlat
    .map((d) => toDirectLine(d, bookingsById, guestsById))
    .filter((l): l is DirectLine => l !== null);

  // Active board (pending/approved/declined) only ever shows unsettled
  // lines — settled ones move to the history section below instead, where
  // the owner can Unlock one to fix a mistake (2026-08-19, Seni's ask).
  const extraLines = extraLinesAll.filter((l) => !l.settledAt);
  const directLines = directLinesAll.filter((l) => !l.settledAt);
  const settledLines: (ExtraLine | DirectLine)[] = [
    ...extraLinesAll.filter((l) => l.settledAt),
    ...directLinesAll.filter((l) => l.settledAt),
  ];

  const payable = [...extraLines, ...directLines].filter((l) => l.approved && !l.declined);
  const pending = [...extraLines, ...directLines].filter((l) => !l.approved && !l.declined);
  // EXTRAS ARE COP-NATIVE, DIRECT BOOKINGS ARE USD-NATIVE (2026-08-22 fix,
  // Seni: Gabriel's 300,000/200,000 COP pontoon entry made these headline
  // totals blow up to tens of millions of COP). `l.gabrielAmount` for an
  // extra IS a peso figure (Gabriel always enters local-vendor cash in COP —
  // see lib/bookingExtras.ts); this USD total must divide it by the live
  // rate instead of summing it as if it were already dollars. A direct
  // booking's gabrielAmount genuinely is USD (OwnerRez's own totalAmount ×
  // commissionPct), so it's untouched. Mirrors CommissionsBoard.tsx's
  // gabrielUsdFor().
  const usdEquivalent = (l: ExtraLine | DirectLine): number =>
    l.type === "extra" ? (previewRate ? l.gabrielAmount / previewRate.usdToTarget : 0) : l.gabrielAmount;
  const payableTotalUsd = Math.round(payable.reduce((s, l) => s + usdEquivalent(l), 0) * 100) / 100;
  const pendingTotalUsd = Math.round(pending.reduce((s, l) => s + usdEquivalent(l), 0) * 100) / 100;

  // Stay picker for "log an extra" (2026-08-19: the Add Extra form moved
  // here from Team Management, so it needs its own booking list instead
  // of inheriting stay context from a card it used to be nested inside).
  // Not date-filtered — an extra can legitimately be logged for a stay
  // that already departed (Gabriel remembering a chef he arranged last
  // week), same reasoning stayDates() used to allow in StayExtras.tsx.
  // Ordering (2026-08-21, Seni's ask: "start the dropdown with the current
  // stay and then descending to future stays in order"): the guest who's
  // in-house right now leads the list, then upcoming stays follow in
  // chronological order — a currently in-house stay's own arrival date is
  // always earlier than any future stay's, so a plain ascending sort by
  // arrival naturally puts it first. Already-departed stays stay in the
  // list (still loggable) but move to the end, most-recent-departure first,
  // same order they used to be shown in overall.
  const todayIso = new Date().toISOString().slice(0, 10);
  const eligibleStays = bookings.filter((b) => !b.isBlock && b.status !== "Cancelled");
  const currentAndFutureStays = eligibleStays
    .filter((b) => !b.departure || b.departure.slice(0, 10) >= todayIso)
    .sort((a, b) => new Date(a.arrival || 0).getTime() - new Date(b.arrival || 0).getTime());
  const pastStays = eligibleStays
    .filter((b) => b.departure && b.departure.slice(0, 10) < todayIso)
    .sort((a, b) => new Date(b.arrival || 0).getTime() - new Date(a.arrival || 0).getTime());
  const stays = [...currentAndFutureStays, ...pastStays]
    .slice(0, 300)
    .map((b) => ({
      bookingId: b.id,
      guestName: resolveGuestName(b, guestsById),
      arrival: b.arrival || null,
      departure: b.departure || null,
    }));

  return {
    enabled: true,
    extras: extraLines,
    directBookings: directLines,
    settledLines,
    settlements,
    pendingTotalUsd,
    payableTotalUsd,
    previewRate,
    stays,
  };
}

async function buildAndStoreCommissions(orgId: string, groupId: string) {
  const board = await buildCommissionsBoard(orgId, groupId);
  await redisSet(commissionsSnapshotKey(orgId), JSON.stringify(board), {
    exSeconds: COMMISSIONS_SNAPSHOT_TTL_SECONDS,
  }).catch(() => {}); // best-effort — a Redis hiccup must never break the fresh path
  return board;
}

/** Schedules a background snapshot rebuild — called after every mutation so
 * the NEXT snapshot read reflects the change even before any ?fresh=1. */
function refreshCommissionsSnapshot(orgId: string): void {
  after(buildAndStoreCommissions(orgId, EXTRAS_PROPERTY_GROUP_ID).catch(() => {}));
}

export async function GET(req: NextRequest) {
  const { session, groupId, error } = await context(req);
  if (error) return error;

  const viewerIsOwner = session.role === "CEO";
  const viewer = { viewerIsOwner, viewerEmail: session.email };
  if (groupId !== EXTRAS_PROPERTY_GROUP_ID) {
    return NextResponse.json({
      enabled: false,
      ...viewer,
      extras: [],
      directBookings: [],
      settledLines: [],
      settlements: [],
      pendingTotalUsd: 0,
      payableTotalUsd: 0,
      previewRate: null,
      stays: [],
    });
  }

  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  try {
    if (!fresh) {
      const cached = await redisGet(commissionsSnapshotKey(session.organizationId)).catch(() => null);
      if (cached) {
        // Serve the snapshot instantly; refresh it in the background so the
        // client's follow-up ?fresh=1 (and the next visitor) get current data.
        after(buildAndStoreCommissions(session.organizationId, groupId).catch(() => {}));
        return NextResponse.json({ ...(JSON.parse(cached) as Record<string, unknown>), ...viewer });
      }
    }
    return NextResponse.json({ ...(await buildAndStoreCommissions(session.organizationId, groupId)), ...viewer });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/management/commissions failed:", message);
    // Even a failed FRESH build should serve the snapshot rather than error —
    // stale beats a "couldn't load" banner (same as /api/management).
    const cached = await redisGet(commissionsSnapshotKey(session.organizationId)).catch(() => null);
    if (cached) {
      return NextResponse.json({ ...(JSON.parse(cached) as Record<string, unknown>), ...viewer });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const { session, me, error } = await context(req);
  if (error) return error;

  // Owner-only — the real gate, not just a hidden checkbox. Mirrors
  // team-expenses' PATCH and the extras route's DELETE.
  if (session.role !== "CEO") {
    return NextResponse.json({ error: "Only the owner can approve or decline a commission." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        type?: "extra" | "direct_booking";
        id?: string;
        approved?: boolean;
        declined?: boolean;
        declinedReason?: string;
        commissionPct?: unknown;
        guestPayoutCopOverride?: unknown;
        unsettle?: boolean;
      }
    | null;
  if (!body?.id || (body.type !== "extra" && body.type !== "direct_booking")) {
    return NextResponse.json({ error: "type and id are required." }, { status: 400 });
  }

  // Owner-only Unlock (2026-08-19, Seni's ask: "allow the admin / owner
  // user to unlock and edit"). Un-settles the row — clears settled_at/
  // settlement_id so it falls back into the unsettled/approved pool, where
  // the existing owner-edit path (below/PATCH extras, commissionPct here)
  // already covers editing it. The settlement record it came out of keeps
  // its original total forever (see unsettleBookingExtra's comment) — a
  // correction moves the line forward, it never rewrites history.
  if (body.unsettle === true) {
    try {
      const updated =
        body.type === "extra"
          ? await unsettleBookingExtra(session.organizationId, body.id)
          : await unsettleDirectBooking(session.organizationId, body.id);
      if (!updated) {
        return NextResponse.json({ error: "No such commission, or it isn't currently settled." }, { status: 404 });
      }
      refreshCommissionsSnapshot(session.organizationId);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
    }
  }

  // Owner-only Edit mode (2026-08-19, Seni's ask: an Edit control next to
  // "Settle payout"): a commissionPct in the body means "change this direct
  // booking's %" rather than an approve/decline decision. Clamped 0–100 —
  // the split is derived live from this %, so an absurd typo would directly
  // misstate real money. Settled rows stay immutable (WHERE clause in
  // setDirectBookingPct, not just this route).
  if (body.commissionPct !== undefined) {
    if (body.type !== "direct_booking") {
      return NextResponse.json({ error: "commissionPct only applies to direct bookings." }, { status: 400 });
    }
    const pctRaw = Number(body.commissionPct);
    if (!Number.isFinite(pctRaw)) {
      return NextResponse.json({ error: "commissionPct must be a number." }, { status: 400 });
    }
    const commissionPct = Math.min(Math.max(Math.round(pctRaw * 100) / 100, 0), 100);
    try {
      const updated = await setDirectBookingPct({ organizationId: session.organizationId, id: body.id, commissionPct });
      if (!updated) {
        return NextResponse.json(
          { error: "No such commission, or it's already been settled and can't be changed." },
          { status: 404 }
        );
      }
      refreshCommissionsSnapshot(session.organizationId);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
    }
  }

  // Owner-only guest-payout COP override (2026-08-19, Seni's ask: "input and
  // revise the total guest payout... in case the conversion is a little
  // off"). guestPayoutCopOverride === null explicitly clears the override
  // (reverts to the derived figure) — undefined just means "not this kind of
  // request", which is why the check is `!== undefined`, not truthiness.
  if (body.guestPayoutCopOverride !== undefined) {
    if (body.type !== "direct_booking") {
      return NextResponse.json({ error: "guestPayoutCopOverride only applies to direct bookings." }, { status: 400 });
    }
    let guestPayoutCopOverride: number | null;
    if (body.guestPayoutCopOverride === null) {
      guestPayoutCopOverride = null;
    } else {
      const raw = Number(body.guestPayoutCopOverride);
      if (!Number.isFinite(raw) || raw < 0) {
        return NextResponse.json({ error: "guestPayoutCopOverride must be a non-negative number." }, { status: 400 });
      }
      guestPayoutCopOverride = Math.round(raw * 100) / 100;
    }
    try {
      const updated = await setGuestPayoutOverride({
        organizationId: session.organizationId,
        id: body.id,
        guestPayoutCopOverride,
      });
      if (!updated) {
        return NextResponse.json(
          { error: "No such commission, or it's already been settled and can't be changed." },
          { status: 404 }
        );
      }
      refreshCommissionsSnapshot(session.organizationId);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
    }
  }

  try {
    const approvalInput = {
      organizationId: session.organizationId,
      id: body.id,
      approved: body.approved === true,
      declined: body.declined === true,
      declinedReason: body.declinedReason?.trim() || null,
      byEmail: session.email,
      byName: me?.name ?? null,
    };
    const updated =
      body.type === "extra" ? await setExtraApproval(approvalInput) : await setDirectBookingApproval(approvalInput);
    if (!updated) {
      return NextResponse.json(
        { error: "No such commission, or it's already been settled and can't be changed." },
        { status: 404 }
      );
    }
    refreshCommissionsSnapshot(session.organizationId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { session, me, groupId, error } = await context(req);
  if (error) return error;

  if (session.role !== "CEO") {
    return NextResponse.json({ error: "Only the owner can settle a payout." }, { status: 403 });
  }
  if (groupId !== EXTRAS_PROPERTY_GROUP_ID) {
    return NextResponse.json({ error: "Commissions are only tracked for Legacy Colombia." }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { fxBufferPct?: unknown; note?: string; only?: { type?: "extra" | "direct_booking"; id?: string } }
    | null;
  const bufferRaw = Number(body?.fxBufferPct ?? 0);
  // Clamped, not just validated — a visible buffer is the whole point (see
  // the "match anything containing Gabriel" conversation this replaced a
  // hidden-markup idea with), but an unbounded number typed by mistake
  // shouldn't be able to 10x a payout.
  const fxBufferPct = Number.isFinite(bufferRaw) ? Math.min(Math.max(bufferRaw, 0), 50) : 0;
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const only = body?.only && (body.only.type === "extra" || body.only.type === "direct_booking") && body.only.id
    ? { type: body.only.type, id: body.only.id }
    : null;

  try {
    const bookings = await getBookings(session.organizationId, groupId);
    const bookingsById = new Map(bookings.map((b) => [b.id, b]));

    let payableExtras: BookingExtra[];
    let payableDirect: DirectBookingCommission[];

    if (only) {
      // Owner-only quick "Settled" action (2026-08-19, Seni's ask: "mark
      // that as settled if paid by Gabriel already") — settles exactly one
      // line, regardless of whether it was ever formally approved first
      // (createCommissionSettlement stamps the approval alongside the
      // settlement in that case). Still excludes declined/already-settled
      // lines, same as the bulk path below.
      if (only.type === "extra") {
        const all = [...(await listBookingExtras(session.organizationId)).values()].flat();
        const line = all.find((e) => e.id === only.id && !e.declined && !e.settledAt);
        payableExtras = line ? [line] : [];
        payableDirect = [];
      } else {
        const all = await listDirectBookingCommissions(session.organizationId);
        const line = all.find((d) => d.id === only.id && !d.declined && !d.settledAt);
        payableExtras = [];
        payableDirect = line ? [line] : [];
      }
      if (payableExtras.length === 0 && payableDirect.length === 0) {
        return NextResponse.json(
          { error: "No such commission, or it's already been declined or settled." },
          { status: 404 }
        );
      }
    } else {
      const extrasByBooking = await listBookingExtras(session.organizationId);
      payableExtras = [...extrasByBooking.values()].flat().filter((e) => e.approved && !e.declined && !e.settledAt);

      const directFlat = await listDirectBookingCommissions(session.organizationId);
      payableDirect = directFlat.filter((d) => d.approved && !d.declined && !d.settledAt);
    }

    const payableDirectWithSplit = payableDirect
      .map((d) => ({ commission: d, split: computeSplit(d, bookingsById.get(d.bookingId)) }))
      .filter((x): x is { commission: DirectBookingCommission; split: NonNullable<ReturnType<typeof computeSplit>> } => x.split !== null);

    const fx = await getUsdToRate("COP");
    // EXTRAS ARE COP-NATIVE, DIRECT BOOKINGS ARE USD-NATIVE (2026-08-22 fix,
    // Seni: Gabriel logged a pontoon extra as 300,000/200,000 COP and the
    // settle math — which used to sum e.gabrielShare directly as USD, then
    // multiply it by the live rate AGAIN to get a COP total — would have
    // produced a payout roughly 3,600x too large. `e.gabrielShare` on an
    // extra is already pesos (Gabriel always enters local-vendor cash in
    // COP — see lib/bookingExtras.ts); this only needs to be DIVIDED by the
    // live rate to get its USD-equivalent contribution to totalUsd, and used
    // AS-IS (no multiply) for the real COP total. Direct bookings are
    // untouched — genuinely USD-native (OwnerRez's own totalAmount), same
    // locked-rate/override math as before.
    const extraUsdEquivalent = (e: BookingExtra) => e.gabrielShare / fx.usdToTarget;
    const totalUsd =
      Math.round(
        (payableExtras.reduce((s, e) => s + extraUsdEquivalent(e), 0) +
          payableDirectWithSplit.reduce((s, x) => s + x.split.gabrielAmount, 0)) *
          100
      ) / 100;

    if (totalUsd <= 0) {
      return NextResponse.json(
        {
          error: only
            ? "Couldn't settle that — the booking behind it is no longer available."
            : "Nothing approved and unsettled to settle right now.",
        },
        { status: 400 }
      );
    }

    // Per-line rates (2026-08-19, Seni's ask): a Gabriel direct booking uses
    // the USD→COP rate LOCKED on the day it was detected, never the live
    // rate — extras (no locked rate concept, and COP-native since 2026-08-22)
    // pass straight through. The buffer applies uniformly on top.
    // effective_rate stored below is therefore the BLENDED rate
    // (totalCop / totalUsd), which is exactly what "rate actually used for
    // this payout" should mean now.
    const rateFor = (locked: number | null | undefined) => locked ?? fx.usdToTarget;
    // A guest-payout override (2026-08-19, Seni's ask) replaces the
    // rate-derived COP figure for that one line entirely — it IS the real
    // total Gabriel collected, corrected by hand — so it takes precedence
    // over locked/live-rate math wherever it's set.
    const copFor = (x: { commission: DirectBookingCommission; split: { gabrielAmount: number } }) => {
      const override = copSplitOverride(x.commission);
      return override ? override.gabrielCop : x.split.gabrielAmount * rateFor(x.commission.fxRate);
    };
    const copBeforeBuffer =
      payableExtras.reduce((s, e) => s + e.gabrielShare, 0) +
      payableDirectWithSplit.reduce((s, x) => s + copFor(x), 0);
    const totalCop = Math.round(copBeforeBuffer * (1 + fxBufferPct / 100));
    const effectiveRate = totalUsd > 0 ? Math.round((totalCop / totalUsd) * 10000) / 10000 : 0;

    const lineItemRefs: SettlementLineRef[] = [
      ...payableExtras.map((e) => ({
        type: "extra" as const,
        id: e.id,
        bookingId: e.bookingId,
        amountUsd: extraUsdEquivalent(e),
        fxRate: fx.usdToTarget,
      })),
      ...payableDirectWithSplit.map((x) => ({
        type: "direct_booking" as const,
        id: x.commission.id,
        bookingId: x.commission.bookingId,
        amountUsd: x.split.gabrielAmount,
        // If overridden, the "rate" is implied backward from the manually
        // corrected COP total rather than the locked/live rate — still a
        // useful number to have on the permanent record, just derived
        // differently than usual.
        fxRate:
          x.split.gabrielAmount > 0 ? copFor(x) / x.split.gabrielAmount : rateFor(x.commission.fxRate),
      })),
    ];

    const settlement = await createCommissionSettlement({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      settledByEmail: session.email,
      settledByName: me?.name ?? null,
      fxRate: fx.usdToTarget,
      fxBufferPct,
      effectiveRate,
      totalUsd,
      totalCop,
      note,
      extraIds: payableExtras.map((e) => e.id),
      directBookingIds: payableDirect.map((d) => d.id),
      lineItemRefs,
    });

    refreshCommissionsSnapshot(session.organizationId);
    return NextResponse.json({ ok: true, settlement });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/management/commissions failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
