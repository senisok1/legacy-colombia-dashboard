import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { getDefaultOrganizationId } from "@/lib/organizations";
import { findOrCreateVendorByName, createBill, updateBillStatus, listBills } from "@/lib/billPay";

// One-time (safe-to-repeat-ish — see dedupe note below) import of the
// expense line items from Gutierrez Group's ("MOME") Nukak #19 monthly
// property-manager statements (Jan-Jun 2026 PDFs Seni uploaded 2026-08-05).
// These are historical, already-settled expenses deducted by the property
// manager before remitting the balance to Seni — NOT open invoices awaiting
// payment — so every bill here is created then immediately marked
// "paid_manually" (record-keeping only, matches lib/billPay.ts's model).
// Income line items (Rental Income, VAT Over Income, 2025 Balance, the
// April "Retainer - Seni Sok" owner injection) are intentionally excluded —
// this route only loads the EXPENSE side into Bill Pay.
//
// All amounts are in COP, exactly as Gutierrez Group reported them — not
// converted to USD, since no reliable single exchange rate covers all six
// months and mis-converting real financial records would be worse than
// just displaying them in their native currency (see the formatCurrency
// currency-param fix shipped alongside this route).
//
// Guarded by ADMIN_SECRET like the other one-off admin routes. Re-running
// this is not perfectly idempotent — bills.createBill's duplicate detector
// only flags same-vendor-same-amount within a 10-day window, and these
// entries are ~30 days apart, so re-running would create a second full set
// of duplicate bills rather than being silently skipped. Don't re-run it
// after a successful pass; if a correction is needed, edit/delete the
// specific bill(s) via /bill-pay instead.

// Deliberately no propertyId here — bills.property_id is a foreign key into
// the `properties` table (its own internal id, not OwnerRez's numeric
// property id), and looking that row up isn't worth it for a single-property
// account. Every other Bill Pay entry already goes in unscoped the same way.
const CURRENCY = "COP";
const SOURCE_LABEL = "Gutierrez Group (MOME) Nukak #19 monthly statement";

type LineItem = {
  vendor: string;
  amountCop: number;
  category: string;
};

type MonthBills = {
  month: string; // e.g. "January 2026"
  invoiceDate: string; // ISO, month-end
  items: LineItem[];
};

const MONTHS: MonthBills[] = [
  {
    month: "January 2026",
    invoiceDate: "2026-01-31",
    items: [
      { vendor: "Gabriel", amountCop: 3_777_296, category: "Salary" },
      { vendor: "Cleaning & Maintenance Service", amountCop: 2_952_700, category: "Cleaning" },
      { vendor: "Internet Service", amountCop: 228_600, category: "Internet" },
      { vendor: "Repairs & Maintenance", amountCop: 230_000, category: "Repairs & Maintenance" },
      { vendor: "Supplies", amountCop: 1_922_781, category: "Supplies" },
      { vendor: "Purchases", amountCop: 128_639, category: "Purchases" },
      { vendor: "Banking Expenses", amountCop: 45_834, category: "Banking Expenses" },
      { vendor: "Utilities", amountCop: 2_218_414, category: "Utilities" },
      { vendor: "Gutierrez Group (Property Manager)", amountCop: 7_815_912, category: "Management Fee" },
      { vendor: "VAT / Tax Remittance", amountCop: 1_485_023, category: "VAT" },
    ],
  },
  {
    month: "February 2026",
    invoiceDate: "2026-02-28",
    items: [
      { vendor: "Gabriel", amountCop: 5_591_694, category: "Salary" },
      { vendor: "Cleaning & Maintenance Service", amountCop: 1_669_100, category: "Cleaning" },
      { vendor: "HOA Fees (Parcelación Nukak)", amountCop: 6_909_340, category: "HOA Fees" },
      { vendor: "Internet Service", amountCop: 532_950, category: "Internet" },
      { vendor: "Other / Miscellaneous Expenses", amountCop: 1_031_424, category: "Other Expenses" },
      { vendor: "Repairs & Maintenance", amountCop: 1_573_400, category: "Repairs & Maintenance" },
      { vendor: "Supplies", amountCop: 660_900, category: "Supplies" },
      { vendor: "Utilities", amountCop: 2_552_647, category: "Utilities" },
      { vendor: "Gutierrez Group (Property Manager)", amountCop: 5_397_036, category: "Management Fee" },
      { vendor: "VAT / Tax Remittance", amountCop: 1_025_437, category: "VAT" },
    ],
  },
  {
    month: "March 2026",
    invoiceDate: "2026-03-31",
    items: [
      { vendor: "Gabriel", amountCop: 3_235_496, category: "Salary" },
      { vendor: "Cleaning & Maintenance Service", amountCop: 4_227_300, category: "Cleaning" },
      { vendor: "HOA Fees (Parcelación Nukak)", amountCop: 3_464_441, category: "HOA Fees" },
      { vendor: "Internet Service", amountCop: 532_950, category: "Internet" },
      { vendor: "Other / Miscellaneous Expenses", amountCop: 326_640, category: "Other Expenses" },
      { vendor: "Repairs & Maintenance", amountCop: 3_819_499, category: "Repairs & Maintenance" },
      { vendor: "Supplies", amountCop: 2_513_160, category: "Supplies" },
      { vendor: "Purchases", amountCop: 327_000, category: "Purchases" },
      { vendor: "Utilities", amountCop: 2_607_665, category: "Utilities" },
      { vendor: "Banking Expenses", amountCop: 131_905, category: "Banking Expenses" },
      { vendor: "Tourism Tax", amountCop: 613_000, category: "Tourism Tax" },
      { vendor: "Gutierrez Group (Property Manager)", amountCop: 6_188_174, category: "Management Fee" },
      { vendor: "VAT / Tax Remittance", amountCop: 1_175_753, category: "VAT" },
    ],
  },
  {
    month: "April 2026",
    invoiceDate: "2026-04-30",
    items: [
      { vendor: "Gabriel", amountCop: 3_115_396, category: "Salary" },
      { vendor: "Cleaning & Maintenance Service", amountCop: 3_783_200, category: "Cleaning" },
      { vendor: "HOA Fees (Parcelación Nukak)", amountCop: 3_922_990, category: "HOA Fees" },
      { vendor: "Internet Service", amountCop: 532_950, category: "Internet" },
      { vendor: "Guest Insurance", amountCop: 882_846, category: "Guest Insurance 2026" },
      { vendor: "Booking Commission", amountCop: 261_540, category: "Other Expenses: Booking Commission" },
      { vendor: "Repairs & Maintenance", amountCop: 480_000, category: "Repairs & Maintenance: Jacuzzi" },
      { vendor: "Repairs & Maintenance", amountCop: 790_003, category: "Repairs & Maintenance: Gas/Gasoline" },
      { vendor: "Supplies", amountCop: 960_703, category: "Supplies" },
      { vendor: "Purchases", amountCop: 240_000, category: "Purchases: Pool Supplies" },
      { vendor: "Utilities", amountCop: 1_782_883, category: "Utilities" },
      { vendor: "JDG", amountCop: 828_240, category: "Transfer to Client: JDG" },
      { vendor: "Banking Expenses", amountCop: 85_827, category: "Banking Expenses" },
      { vendor: "Gutierrez Group (Property Manager)", amountCop: 5_409_294, category: "Management Fee" },
      { vendor: "VAT / Tax Remittance", amountCop: 1_027_766, category: "VAT" },
    ],
  },
  {
    month: "May 2026",
    invoiceDate: "2026-05-31",
    items: [
      { vendor: "Gabriel", amountCop: 1_302_548, category: "Salary" },
      { vendor: "Cleaning & Maintenance Service", amountCop: 8_112_048, category: "Cleaning" },
      { vendor: "HOA Fees (Parcelación Nukak)", amountCop: 4_031_586, category: "HOA Fees" },
      { vendor: "Internet Service", amountCop: 532_950, category: "Internet" },
      { vendor: "PMS Software", amountCop: 37_434, category: "Other Expenses: PMS" },
      { vendor: "Repairs & Maintenance", amountCop: 440_000, category: "Repairs & Maintenance: Gas & Pressure Washer" },
      { vendor: "Repairs & Maintenance", amountCop: 300_000, category: "Repairs & Maintenance: Pago Ensek" },
      { vendor: "Utilities", amountCop: 2_176_065, category: "Utilities" },
      { vendor: "Banking Expenses", amountCop: 18_377, category: "Banking Expenses" },
      { vendor: "Gutierrez Group (Property Manager)", amountCop: 4_311_542, category: "Management Fee" },
      { vendor: "VAT / Tax Remittance", amountCop: 819_193, category: "VAT" },
    ],
  },
  {
    month: "June 2026",
    invoiceDate: "2026-06-30",
    items: [
      { vendor: "Repairs & Maintenance", amountCop: 140_000, category: "Maintenance Supplies: Control TV" },
      { vendor: "Gabriel", amountCop: 3_878_342, category: "Salary" },
      { vendor: "Cleaning & Maintenance Service", amountCop: 4_811_900, category: "Cleaning" },
      { vendor: "HOA Fees (Parcelación Nukak)", amountCop: 2_903_642, category: "HOA Fees" },
      { vendor: "Internet Service", amountCop: 532_950, category: "Internet" },
      { vendor: "PMS Software", amountCop: 39_169, category: "Other Expenses: PMS" },
      { vendor: "Repairs & Maintenance", amountCop: 660_000, category: "Repairs & Maintenance: Reparacion Meson" },
      { vendor: "Utilities", amountCop: 7_135_740, category: "Utilities (Including Lots 17 & 18)" },
      { vendor: "Supplies", amountCop: 901_415, category: "Supplies" },
      { vendor: "Banking Expenses", amountCop: 102_737, category: "Banking Expenses" },
      { vendor: "Gutierrez Group (Property Manager)", amountCop: 7_566_125, category: "Management Fee" },
      { vendor: "VAT / Tax Remittance", amountCop: 1_437_564, category: "VAT" },
    ],
  },
];

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set on this deployment." }, { status: 400 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  try {
    const organizationId = await getDefaultOrganizationId();
    const existingBillCount = (await listBills(organizationId)).length;

    const created: { month: string; vendor: string; amountCop: number; category: string }[] = [];
    const vendorsCreated = new Set<string>();
    const vendorsReused = new Set<string>();

    if (!dryRun) {
      for (const monthBlock of MONTHS) {
        for (const item of monthBlock.items) {
          const { vendor, created: wasCreated } = await findOrCreateVendorByName(item.vendor, organizationId);
          if (wasCreated) vendorsCreated.add(item.vendor);
          else vendorsReused.add(item.vendor);

          const bill = await createBill(
            {
              vendorId: vendor.id,
              amountCents: Math.round(item.amountCop * 100),
              currency: CURRENCY,
              category: item.category,
              invoiceDate: monthBlock.invoiceDate,
              dueDate: monthBlock.invoiceDate,
              source: "upload",
              sourceReference: `${SOURCE_LABEL} — ${monthBlock.month}`,
            },
            organizationId
          );

          // These are historical, already-paid expenses (deducted by the PM
          // before remitting balance) — not open invoices — so mark paid
          // immediately rather than leaving them in pending_review.
          await updateBillStatus(
            bill.id,
            {
              status: "paid_manually",
              reviewNotes: `Imported from ${SOURCE_LABEL} — ${monthBlock.month}. Deducted by the property manager before remitting balance; not an open invoice.`,
            },
            organizationId
          );

          created.push({ month: monthBlock.month, vendor: item.vendor, amountCop: item.amountCop, category: item.category });
        }
      }
    }

    const totalByMonth = MONTHS.map((m) => ({
      month: m.month,
      totalCop: m.items.reduce((sum, i) => sum + i.amountCop, 0),
      count: m.items.length,
    }));

    return NextResponse.json({
      ok: true,
      dryRun,
      organizationId,
      existingBillCountBeforeImport: existingBillCount,
      billsCreated: created.length,
      vendorsCreated: Array.from(vendorsCreated),
      vendorsReused: Array.from(vendorsReused),
      totalByMonth,
      grandTotalCop: totalByMonth.reduce((sum, m) => sum + m.totalCop, 0),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Import failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
