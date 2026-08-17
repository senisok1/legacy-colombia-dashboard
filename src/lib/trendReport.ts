import { getBookings } from "./ownerrez";
import { accrueInDateRange, newBookingsInRange } from "./finance";
import { config, isEmailConfigured, isWhatsAppConfigured } from "./config";
import { logAiActivity } from "./aiActivity";
import { sendWhatsAppText } from "./whatsapp";
import { sendEmail } from "./email";
import { getDefaultOrganizationId } from "./organizations";
import type { Booking } from "./types";

// Weekly trend report — Seni's ask (2026-08-04 automation pass) for
// direction-of-travel reporting distinct from executiveReport.ts's daily
// snapshot. Sent once a week (see api/cron/weekly-trend-report) and covers
// TWO period-over-period comparisons in one digest:
//   - "This week" — trailing 7 days vs. the 7 days before that
//   - "This month" — trailing 30 days vs. the 30 days before that
// Both use rolling trailing windows anchored to "now" rather than calendar
// week/month boundaries, same convention as every other window in
// lib/finance.ts (adr/revPar/occupancyRate) — this avoids partial-period
// distortion right after the 1st of a month/a Monday, and keeps this file
// consistent with numbers Seni already sees elsewhere in the app.
//
// Deliberately built on stay-date occupancy/ADR/RevPAR (accrueInDateRange)
// AND on booking pickup (newBookingsInRange, i.e. reservations actually MADE
// in the period) — the first tells Seni how the property is performing,
// the second tells him whether momentum is building or stalling, which a
// pure stay-date view can't show for a period whose stays haven't happened
// yet.

const AGENT_KEY = "data_analyst";
const AGENT_NAME = "AI Data Analyst";

export type MetricComparison = {
  current: number;
  prior: number;
  /** Percentage-point delta — only meaningful for already-percent metrics
   * (occupancy). Null for dollar/count metrics, which use deltaPct instead. */
  deltaPts?: number;
  /** Relative % change vs. prior period. Null when prior was 0 and current
   * wasn't (an undefined/infinite % change isn't worth reporting as a number). */
  deltaPct: number | null;
};

export type PeriodComparison = {
  label: string;
  daysBack: number;
  currentStart: string;
  currentEnd: string;
  priorStart: string;
  priorEnd: string;
  occupancyPct: MetricComparison;
  adrGross: MetricComparison;
  revParGross: MetricComparison;
  revenueGross: MetricComparison;
  revenueNet: MetricComparison;
  newBookingsCount: MetricComparison;
  pickupRevenueGross: MetricComparison;
};

export type TrendReport = {
  generatedAt: string;
  weekly: PeriodComparison;
  monthly: PeriodComparison;
};

function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

function metric(current: number, prior: number, isPercent = false): MetricComparison {
  return {
    current,
    prior,
    ...(isPercent ? { deltaPts: Math.round((current - prior) * 10) / 10 } : {}),
    deltaPct: pctDelta(current, prior),
  };
}

function buildComparison(bookings: Booking[], label: string, daysBack: number): PeriodComparison {
  const now = new Date();
  const currentStart = new Date(now);
  currentStart.setDate(currentStart.getDate() - daysBack);
  const priorEnd = currentStart;
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorStart.getDate() - daysBack);

  const cur = accrueInDateRange(bookings, currentStart, now);
  const pri = accrueInDateRange(bookings, priorStart, priorEnd);
  const curPickup = newBookingsInRange(bookings, currentStart, now);
  const priPickup = newBookingsInRange(bookings, priorStart, priorEnd);

  const occCur = daysBack > 0 ? Math.round((cur.nights / daysBack) * 1000) / 10 : 0;
  const occPri = daysBack > 0 ? Math.round((pri.nights / daysBack) * 1000) / 10 : 0;
  const adrCur = cur.nights > 0 ? Math.round((cur.grossRevenue / cur.nights) * 100) / 100 : 0;
  const adrPri = pri.nights > 0 ? Math.round((pri.grossRevenue / pri.nights) * 100) / 100 : 0;
  const revParCur = daysBack > 0 ? Math.round((cur.grossRevenue / daysBack) * 100) / 100 : 0;
  const revParPri = daysBack > 0 ? Math.round((pri.grossRevenue / daysBack) * 100) / 100 : 0;

  return {
    label,
    daysBack,
    currentStart: currentStart.toISOString(),
    currentEnd: now.toISOString(),
    priorStart: priorStart.toISOString(),
    priorEnd: priorEnd.toISOString(),
    occupancyPct: metric(occCur, occPri, true),
    adrGross: metric(adrCur, adrPri),
    revParGross: metric(revParCur, revParPri),
    revenueGross: metric(Math.round(cur.grossRevenue * 100) / 100, Math.round(pri.grossRevenue * 100) / 100),
    revenueNet: metric(Math.round(cur.netRevenue * 100) / 100, Math.round(pri.netRevenue * 100) / 100),
    newBookingsCount: metric(curPickup.count, priPickup.count),
    pickupRevenueGross: metric(
      Math.round(curPickup.grossRevenue * 100) / 100,
      Math.round(priPickup.grossRevenue * 100) / 100
    ),
  };
}

export async function buildTrendReport(
  organizationId?: string,
  propertyGroupId?: string
): Promise<TrendReport> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const bookings = await getBookings(orgId, propertyGroupId);
  return {
    generatedAt: new Date().toISOString(),
    weekly: buildComparison(bookings, "This week vs. the 7 days before", 7),
    monthly: buildComparison(bookings, "Last 30 days vs. the 30 days before", 30),
  };
}

function arrow(deltaPct: number | null, deltaPts?: number): string {
  const v = deltaPts !== undefined ? deltaPts : deltaPct;
  if (v === null || v === undefined || v === 0) return "→";
  return v > 0 ? "▲" : "▼";
}

function fmtPct(m: MetricComparison): string {
  const d = m.deltaPts !== undefined ? `${m.deltaPts > 0 ? "+" : ""}${m.deltaPts}pt` : m.deltaPct !== null ? `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}%` : "n/a";
  return `${m.current}% (was ${m.prior}%, ${arrow(m.deltaPct, m.deltaPts)} ${d})`;
}

function fmtMoney(m: MetricComparison): string {
  const d = m.deltaPct !== null ? `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}%` : "n/a (was $0)";
  return `$${m.current.toFixed(0)} (was $${m.prior.toFixed(0)}, ${arrow(m.deltaPct)} ${d})`;
}

function fmtCount(m: MetricComparison): string {
  const d = m.deltaPct !== null ? `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}%` : "n/a (was 0)";
  return `${m.current} (was ${m.prior}, ${arrow(m.deltaPct)} ${d})`;
}

function formatSection(c: PeriodComparison): string[] {
  return [
    `${c.label}:`,
    `  Occupancy: ${fmtPct(c.occupancyPct)}`,
    `  ADR (gross): ${fmtMoney(c.adrGross)}`,
    `  RevPAR (gross): ${fmtMoney(c.revParGross)}`,
    `  Revenue (gross): ${fmtMoney(c.revenueGross)}`,
    `  New bookings made: ${fmtCount(c.newBookingsCount)}`,
    `  Pickup revenue (bookings made in period): ${fmtMoney(c.pickupRevenueGross)}`,
  ];
}

/** WhatsApp text version — same "30-second read" convention as
 * executiveReport.ts's formatReportForWhatsApp. */
export function formatTrendReportForWhatsApp(report: TrendReport): string {
  const lines: string[] = ["📈 Weekly trend report — Legacy Colombia", ""];
  lines.push(...formatSection(report.weekly));
  lines.push("");
  lines.push(...formatSection(report.monthly));
  return lines.join("\n");
}

/** Fuller HTML version for the email channel — inline styles only, same
 * reasoning as executiveReport.ts's formatReportForEmailHtml. */
export function formatTrendReportForEmailHtml(report: TrendReport): string {
  const row = (label: string, m: MetricComparison, fmt: (m: MetricComparison) => string) => {
    const v = m.deltaPts !== undefined ? m.deltaPts : m.deltaPct;
    const color = v === null || v === undefined || v === 0 ? "#525252" : v > 0 ? "#15803d" : "#b91c1c";
    return `<tr>
      <td style="padding:6px 0;border-bottom:1px solid #e5e5e5;">${label}</td>
      <td style="padding:6px 0;border-bottom:1px solid #e5e5e5;text-align:right;color:${color};font-weight:600;">${fmt(m)}</td>
    </tr>`;
  };

  const section = (c: PeriodComparison) => `
    <h3 style="margin-bottom:6px;">${c.label}</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">
      ${row("Occupancy", c.occupancyPct, fmtPct)}
      ${row("ADR (gross)", c.adrGross, fmtMoney)}
      ${row("RevPAR (gross)", c.revParGross, fmtMoney)}
      ${row("Revenue (gross)", c.revenueGross, fmtMoney)}
      ${row("New bookings made", c.newBookingsCount, fmtCount)}
      ${row("Pickup revenue (bookings made in period)", c.pickupRevenueGross, fmtMoney)}
    </table>
  `;

  return `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#171717;">
      <h2 style="margin-bottom:4px;">📈 Weekly trend report — Legacy Colombia</h2>
      <p style="color:#737373;font-size:13px;margin-top:0;">Generated ${new Date(report.generatedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET · rolling windows, not calendar week/month</p>
      ${section(report.weekly)}
      ${section(report.monthly)}
      <p style="margin-top:8px;"><a href="https://crm.legacyestaterentals.com/reports" style="color:#2563eb;">Open the full dashboard →</a></p>
    </div>
  `;
}

// WhatsApp is deliberately reserved for the three things Seni wants in the
// moment — inquiries, guest messages, new bookings (2026-08-17). Recaps and
// digests go by EMAIL only. Flipping this to true restores the WhatsApp leg
// without touching any other code.
const SEND_RECAPS_TO_WHATSAPP = false;

export type TrendDeliveryResult = { attempted: boolean; sent: boolean; error?: string };

/** Same independent-per-channel delivery convention as
 * executiveReport.ts's deliverExecutiveReport. */
export async function deliverTrendReport(
  report: TrendReport,
  trigger: string,
  organizationId?: string
): Promise<{ whatsapp: TrendDeliveryResult; email: TrendDeliveryResult }> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const whatsapp: TrendDeliveryResult = { attempted: false, sent: false };
  const email: TrendDeliveryResult = { attempted: false, sent: false };

  // WhatsApp delivery removed 2026-08-17 (same reason as the daily recap in
  // executiveReport.ts — Seni reads these by email). Email leg below is live.
  if (SEND_RECAPS_TO_WHATSAPP && isWhatsAppConfigured()) {
    whatsapp.attempted = true;
    try {
      await sendWhatsAppText(formatTrendReportForWhatsApp(report), orgId);
      whatsapp.sent = true;
    } catch (err) {
      whatsapp.error = err instanceof Error ? err.message : "Unknown error.";
    }
  }

  if (isEmailConfigured()) {
    email.attempted = true;
    try {
      await sendEmail({
        to: config.reportEmailTo,
        subject: `Weekly trend report — Legacy Colombia (${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })})`,
        html: formatTrendReportForEmailHtml(report),
      });
      email.sent = true;
    } catch (err) {
      email.error = err instanceof Error ? err.message : "Unknown error.";
    }
  }

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Generate & deliver weekly trend report",
    trigger,
    decision: `Revenue ${report.weekly.revenueGross.deltaPct !== null ? (report.weekly.revenueGross.deltaPct > 0 ? "+" : "") + report.weekly.revenueGross.deltaPct + "%" : "n/a"} week-over-week`,
    actionTaken: `WhatsApp: ${whatsapp.attempted ? (whatsapp.sent ? "sent" : `failed (${whatsapp.error})`) : "not configured"}; Email: ${email.attempted ? (email.sent ? "sent" : `failed (${email.error})`) : "not configured"}`,
    result: whatsapp.sent || email.sent ? "sent" : "not_sent",
  }, orgId).catch(() => {});

  return { whatsapp, email };
}
