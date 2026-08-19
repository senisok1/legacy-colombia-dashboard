import { withClient } from "./db";

// Permanent record of each COP cash handoff to Gabriel (2026-08-19, Seni's
// ask: "I collect COP cash from Gabriel when I travel to the property so
// there needs to be a reset button as well"). Deliberately NOT a "reset to
// zero" — it snapshots the FX rate used (with Seni's own visible buffer,
// never hidden from Gabriel), the total, and exactly which extras/
// direct-booking commission rows were folded in, then marks those rows
// settled. Nothing is ever deleted; the running "owed" balance goes to zero
// simply because every included row now has settled_at set and drops out of
// the payable queries (listPayableExtras / listDirectBookingCommissions
// filtered to settled_at is null).

export type SettlementLineRef = {
  type: "extra" | "direct_booking";
  id: string;
  bookingId: number;
  amountUsd: number;
  /** The USD→COP rate this line converted at (2026-08-19): a direct
   * booking's day-of-detection locked rate, or the live rate for extras.
   * Optional — refs recorded before this field simply don't have it. */
  fxRate?: number;
};

export type CommissionSettlement = {
  id: string;
  propertyGroupId: string | null;
  settledByName: string | null;
  settledAt: string;
  fxRate: number;
  fxBufferPct: number;
  effectiveRate: number;
  totalUsd: number;
  totalCop: number;
  note: string | null;
  lineItemRefs: SettlementLineRef[];
};

type Row = {
  id: string;
  property_group_id: string | null;
  settled_by_name: string | null;
  settled_at: string | Date;
  fx_rate: string;
  fx_buffer_pct: string;
  effective_rate: string;
  total_usd: string;
  total_cop: string;
  note: string | null;
  line_item_refs: SettlementLineRef[];
};

function fromRow(r: Row): CommissionSettlement {
  return {
    id: r.id,
    propertyGroupId: r.property_group_id,
    settledByName: r.settled_by_name,
    settledAt: new Date(r.settled_at).toISOString(),
    fxRate: Number(r.fx_rate),
    fxBufferPct: Number(r.fx_buffer_pct),
    effectiveRate: Number(r.effective_rate),
    totalUsd: Number(r.total_usd),
    totalCop: Number(r.total_cop),
    note: r.note,
    lineItemRefs: r.line_item_refs ?? [],
  };
}

export async function listCommissionSettlements(organizationId: string): Promise<CommissionSettlement[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<Row>(
      `select id, property_group_id, settled_by_name, settled_at, fx_rate, fx_buffer_pct,
              effective_rate, total_usd, total_cop, note, line_item_refs
         from commission_settlements
        where organization_id = $1
        order by settled_at desc
        limit 50`,
      [organizationId]
    );
    return rows.map(fromRow);
  });
}

/** Creates a settlement and marks every included extra / direct-booking
 * commission row as settled, in one transaction — either all of it lands or
 * none of it does, so a mid-way failure can never leave a line item
 * silently un-settled while the settlement record says it was included. */
export async function createCommissionSettlement(input: {
  organizationId: string;
  propertyGroupId: string | null;
  settledByEmail: string;
  settledByName: string | null;
  fxRate: number;
  fxBufferPct: number;
  effectiveRate: number;
  totalUsd: number;
  totalCop: number;
  note: string | null;
  extraIds: string[];
  directBookingIds: string[];
  lineItemRefs: SettlementLineRef[];
}): Promise<CommissionSettlement> {
  return withClient(async (client) => {
    try {
      await client.query("begin");
      const { rows } = await client.query<Row>(
        `insert into commission_settlements
           (organization_id, property_group_id, settled_by_email, settled_by_name,
            fx_rate, fx_buffer_pct, effective_rate, total_usd, total_cop, note, line_item_refs)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         returning id, property_group_id, settled_by_name, settled_at, fx_rate, fx_buffer_pct,
                   effective_rate, total_usd, total_cop, note, line_item_refs`,
        [
          input.organizationId,
          input.propertyGroupId,
          input.settledByEmail,
          input.settledByName,
          input.fxRate,
          input.fxBufferPct,
          input.effectiveRate,
          input.totalUsd,
          input.totalCop,
          input.note,
          JSON.stringify(input.lineItemRefs),
        ]
      );
      const settlement = rows[0];
      if (!settlement) throw new Error("Failed to create the settlement record.");

      // Approval is stamped here too (via COALESCE, so an already-approved
      // row keeps its real approver/timestamp) rather than required as a
      // precondition — the owner-only quick "Settled" action (2026-08-19,
      // Seni's ask: "mark that as settled if paid by Gabriel already") can
      // settle a line that was never formally approved first, e.g. Gabriel
      // already collected cash directly. WHICH ids land here is still
      // entirely controlled by the caller (route.ts) — the bulk "Settle
      // payout" button only ever passes already-approved ids, so its
      // behavior is unchanged.
      if (input.extraIds.length > 0) {
        await client.query(
          `update booking_extras set
             approved = true,
             approved_by_email = coalesce(approved_by_email, $4),
             approved_by_name  = coalesce(approved_by_name, $5),
             approved_at       = coalesce(approved_at, now()),
             settled_at = now(), settlement_id = $1
           where organization_id = $2 and id = any($3::uuid[]) and declined = false and settled_at is null`,
          [settlement.id, input.organizationId, input.extraIds, input.settledByEmail, input.settledByName]
        );
      }
      if (input.directBookingIds.length > 0) {
        await client.query(
          `update direct_booking_commissions set
             approved = true,
             approved_by_email = coalesce(approved_by_email, $4),
             approved_by_name  = coalesce(approved_by_name, $5),
             approved_at       = coalesce(approved_at, now()),
             settled_at = now(), settlement_id = $1
           where organization_id = $2 and id = any($3::uuid[]) and declined = false and settled_at is null`,
          [settlement.id, input.organizationId, input.directBookingIds, input.settledByEmail, input.settledByName]
        );
      }

      await client.query("commit");
      return fromRow(settlement);
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  });
}
