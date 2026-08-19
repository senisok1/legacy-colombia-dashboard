import { NextRequest, NextResponse } from "next/server";
import { getBookings } from "@/lib/ownerrez";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { listBookingExtras, setExtraApproval, EXTRAS_PROPERTY_GROUP_ID, type BookingExtra } from "@/lib/bookingExtras";
import {
  syncDirectBookingCommissions,
  listDirectBookingCommissions,
  setDirectBookingApproval,
  computeSplit,
  type DirectBookingCommission,
} from "@/lib/directBookingCommissions";
import {
  createCommissionSettlement,
  listCommissionSettlements,
  type SettlementLineRef,
} from "@/lib/commissionSettlements";
import { getUsdToRate } from "@/lib/exchangeRate";
import type { Booking } from "@/lib/types";

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
  houseAmount: number;
  gabrielAmount: number;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  declined: boolean;
  declinedReason: string | null;
};

function toExtraLine(e: BookingExtra, bookingsById: Map<number, Booking>): ExtraLine {
  const b = bookingsById.get(e.bookingId);
  return {
    type: "extra",
    id: e.id,
    bookingId: e.bookingId,
    guestName: b?.guestName ?? null,
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
  };
}

function toDirectLine(d: DirectBookingCommission, bookingsById: Map<number, Booking>): DirectLine | null {
  const b = bookingsById.get(d.bookingId);
  const split = computeSplit(d, b);
  if (!split || !b) return null;
  return {
    type: "direct_booking",
    id: d.id,
    bookingId: d.bookingId,
    guestName: b.guestName ?? null,
    arrival: b.arrival || null,
    departure: b.departure || null,
    totalAmount: split.totalAmount,
    commissionPct: d.commissionPct,
    houseAmount: split.houseAmount,
    gabrielAmount: split.gabrielAmount,
    approved: d.approved,
    approvedByName: d.approvedByName,
    approvedAt: d.approvedAt,
    declined: d.declined,
    declinedReason: d.declinedReason,
  };
}

export async function GET(req: NextRequest) {
  const { session, groupId, error } = await context(req);
  if (error) return error;

  const viewerIsOwner = session.role === "CEO";
  if (groupId !== EXTRAS_PROPERTY_GROUP_ID) {
    return NextResponse.json({
      enabled: false,
      viewerIsOwner,
      viewerEmail: session.email,
      extras: [],
      directBookings: [],
      settlements: [],
      pendingTotalUsd: 0,
      payableTotalUsd: 0,
      previewRate: null,
      stays: [],
    });
  }

  try {
    const bookings = await getBookings(session.organizationId, groupId);
    const bookingsById = new Map(bookings.map((b) => [b.id, b]));

    await syncDirectBookingCommissions({ organizationId: session.organizationId, bookings }).catch((err) =>
      console.error("[commissions] syncDirectBookingCommissions failed:", err)
    );

    const extrasByBooking = await listBookingExtras(session.organizationId);
    const extrasFlat = [...extrasByBooking.values()].flat().filter((e) => !e.settledAt);
    const directFlat = (await listDirectBookingCommissions(session.organizationId)).filter((d) => !d.settledAt);

    const extraLines = extrasFlat.map((e) => toExtraLine(e, bookingsById));
    const directLines = directFlat.map((d) => toDirectLine(d, bookingsById)).filter((l): l is DirectLine => l !== null);

    const payable = [...extraLines, ...directLines].filter((l) => l.approved && !l.declined);
    const pending = [...extraLines, ...directLines].filter((l) => !l.approved && !l.declined);
    const payableTotalUsd = Math.round(payable.reduce((s, l) => s + l.gabrielAmount, 0) * 100) / 100;
    const pendingTotalUsd = Math.round(pending.reduce((s, l) => s + l.gabrielAmount, 0) * 100) / 100;

    const settlements = await listCommissionSettlements(session.organizationId);
    // Read-only preview for the UI before Seni actually settles — the real
    // rate used in a settlement is fetched fresh again at settle time, never
    // trusted from this earlier read.
    const previewRate = await getUsdToRate("COP").catch(() => null);

    // Stay picker for "log an extra" (2026-08-19: the Add Extra form moved
    // here from Team Management, so it needs its own booking list instead
    // of inheriting stay context from a card it used to be nested inside).
    // Not date-filtered — an extra can legitimately be logged for a stay
    // that already departed (Gabriel remembering a chef he arranged last
    // week), same reasoning stayDates() used to allow in StayExtras.tsx.
    const stays = bookings
      .filter((b) => !b.isBlock && b.status !== "Cancelled")
      .sort((a, b) => new Date(b.arrival || 0).getTime() - new Date(a.arrival || 0).getTime())
      .slice(0, 300)
      .map((b) => ({
        bookingId: b.id,
        guestName: b.guestName || "Guest",
        arrival: b.arrival || null,
        departure: b.departure || null,
      }));

    return NextResponse.json({
      enabled: true,
      viewerIsOwner,
      viewerEmail: session.email,
      extras: extraLines,
      directBookings: directLines,
      settlements,
      pendingTotalUsd,
      payableTotalUsd,
      previewRate,
      stays,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("GET /api/management/commissions failed:", message);
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
    | { type?: "extra" | "direct_booking"; id?: string; approved?: boolean; declined?: boolean; declinedReason?: string }
    | null;
  if (!body?.id || (body.type !== "extra" && body.type !== "direct_booking")) {
    return NextResponse.json({ error: "type and id are required." }, { status: 400 });
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

    const totalUsd =
      Math.round(
        (payableExtras.reduce((s, e) => s + e.gabrielShare, 0) +
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

    const fx = await getUsdToRate("COP");
    const effectiveRate = Math.round(fx.usdToTarget * (1 + fxBufferPct / 100) * 10000) / 10000;
    const totalCop = Math.round(totalUsd * effectiveRate);

    const lineItemRefs: SettlementLineRef[] = [
      ...payableExtras.map((e) => ({ type: "extra" as const, id: e.id, bookingId: e.bookingId, amountUsd: e.gabrielShare })),
      ...payableDirectWithSplit.map((x) => ({
        type: "direct_booking" as const,
        id: x.commission.id,
        bookingId: x.commission.bookingId,
        amountUsd: x.split.gabrielAmount,
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

    return NextResponse.json({ ok: true, settlement });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/management/commissions failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
