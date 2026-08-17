import { getBookings } from "./ownerrez";
import { summaryStats, revPar, directBookingShare, occupancyRate, adr, bookingPace, isRevenueCounting, netAmount, lastMinuteDiscount, LAST_MINUTE_LEAD_DAYS, ADVANCE_LEAD_DAYS, cancellationRate, repeatGuestRate, type CancellationSummary, type RepeatGuestSummary } from "./finance";
import { config, isDbConfigured, isRedisConfigured, isWhatsAppConfigured } from "./config";
import { listWorkOrders } from "./maintenance";
import { listBills } from "./billPay";
import { listLeads } from "./leads";
import { listCampaignCandidates } from "./lifecycleMarketing";
import { listContentPieces } from "./contentMarketing";
import { getAllPendingDrafts, getRecentResponseTimes } from "./pendingDrafts";
import { getWeekdayWeekendRates, getRateComparisonSummary, type RateComparisonSummary } from "./revenueManager";
import { listBookingExtras, EXTRAS_PROPERTY_GROUP_ID } from "./bookingExtras";
import {
  summarizeExtras,
  yearStartIso,
  monthStartIso,
  EMPTY_EXTRAS_SUMMARY,
  type ExtrasSummary,
} from "./extrasAnalytics";
import { getReputationSummary, type ReputationSummary } from "./reputationManager";
import { getCooBriefing, type CooBriefing } from "./cooBriefing";
import { logAiActivity } from "./aiActivity";
import { sendWhatsAppText, sendDailySummaryTemplate } from "./whatsapp";
import { propertyGroupById } from "./propertyGroups";
import { sendEmail } from "./email";
import { getDefaultOrganizationId } from "./organizations";

// Phase 8 of the Legacy AI Company roadmap (docs/VISION.md) — the Data
// Analyst agent's 5am ET daily executive report: "occupancy, ADR, RevPAR,
// direct-booking %, revenue vs. budget, pace, marketing/SEO performance,
// guest satisfaction, open maintenance, bills due/awaiting approval, top AI
// recommendations. Never invents numbers; flags missing/delayed data."
//
// This file takes that guardrail literally. Every metric here is computed
// from data this app actually has (OwnerRez bookings, and — when the DB is
// connected — work orders, bills, leads, lifecycle campaigns, content
// pieces). Three items VISION.md asks for have NO real data source
// anywhere in this app yet (no budget/pacing feature, no reviews/reputation
// integration, no SEO/analytics connector) — rather than fabricate a number
// for those, `dataGaps` lists them explicitly so the report stays honest
// about what it doesn't know, exactly as instructed.

const AGENT_KEY = "data_analyst";
const AGENT_NAME = "AI Data Analyst";

// Thresholds for the "Urgent approvals needed" rollup — deliberately tight:
// a guest is on the other end of a pending reply, and an unpaid bill close
// to its due date risks a late fee or a vendor relationship. Everything else
// pending (new leads, campaign drafts, content ideas) can wait a day without
// real consequence, so it stays out of "urgent" and lives in the regular
// attention list below instead.
const STALE_DRAFT_HOURS = 2;
const URGENT_BILL_HOURS = 48;

// Rolling window for the inquiry-conversion funnel — long enough that a
// lead who takes a few weeks to decide still shows up as converted, short
// enough to stay a "recent performance" read rather than an all-time stat.
const INQUIRY_WINDOW_DAYS = 90;
// Rolling window for the guest response-time SLA average.
const RESPONSE_TIME_WINDOW_DAYS = 7;

export type AttentionItem = {
  label: string;
  count: number;
  severity: "critical" | "warning" | "info";
  href: string;
};

export type UrgentApprovals = {
  staleGuestReplies: number; // pending guest-reply drafts older than STALE_DRAFT_HOURS — a guest is actually waiting
  billsDueUrgent: number; // bills awaiting approval due within URGENT_BILL_HOURS
  urgentMaintenance: number; // open/in-progress/blocked work orders flagged urgent or emergency
  total: number;
};

export type BookingPaceSummary = { daysOut: number; nightsBooked: number; nightsAvailable: number; pct: number };

export type InquiryFunnel = {
  windowDays: number;
  count: number; // leads created within windowDays
  bookedCount: number; // of those, how many reached stage 'booked'
  conversionPct: number;
};

export type GuestResponseTime = {
  windowDays: number;
  sampleSize: number;
  avgMinutes: number | null;
  medianMinutes: number | null;
};

export type WeekdayWeekendRateSummary = {
  weekdayAvgGross: number | null; // dollars, not cents — same convention as adrGross/revParGross below
  weekendAvgGross: number | null;
  weekdaySampleSize: number;
  weekendSampleSize: number;
};

export type LastMinuteDiscountSummary = {
  lastMinuteAvgGross: number | null;
  advanceAvgGross: number | null;
  lastMinuteSampleSize: number;
  advanceSampleSize: number;
  discountPct: number | null;
  reliable: boolean;
};

export type ExecutiveReport = {
  generatedAt: string;
  /** How long this property has actually been operating, derived from its
   * own booking history (2026-08-17, Seni: "take into account this is a
   * brand new property that has only been in service for about 2 months").
   * Judging a two-month-old listing against a stabilised one produces
   * misleading commentary — soft forward pace is normal during ramp-up. Null
   * when there are no bookings to measure from. */
  propertyTenure?: {
    firstBookingDate: string | null;
    monthsInService: number | null;
    isNewProperty: boolean; // under 6 months of operating history
    totalBookingsAllTime: number;
  };
  /** Which property this report covers, e.g. "Legacy Alva" (2026-08-17).
   * Every heading, email subject and WhatsApp label reads from this instead
   * of a hardcoded "Legacy Colombia", so a report can't be mislabelled as
   * another property's. */
  propertyLabel?: string;
  // Cross-agent synthesis, generated AFTER every other field below is
  // computed (see the end of buildExecutiveReport()) — null when
  // ANTHROPIC_API_KEY isn't configured or the AI COO call itself failed.
  cooBriefing: CooBriefing | null;
  occupancy30d: number;
  adrGross: number;
  adrNet: number;
  revParGross: number;
  revParNet: number;
  directBookingPct: number;
  revenueYtdGross: number;
  revenueYtdNet: number;
  revenueMtdGross: number;
  revenueTodayGross: number;
  revenueTodayNet: number;
  // Paid extras (2026-08-17) — Legacy Colombia only; EMPTY_EXTRAS_SUMMARY
  // elsewhere. extrasHouseRevenue* is the HOUSE share only and is the sole
  // extras figure added to revenue; the guest total also contains Gabriel's
  // commission, which never belonged to the house. Deliberately excluded
  // from ADR / RevPAR / occupancy above — see lib/extrasAnalytics.ts.
  extrasYtd: ExtrasSummary;
  extrasMtd: ExtrasSummary;
  totalRevenueYtdGross: number; // revenueYtdGross + extrasYtd.houseRevenue
  totalRevenueMtdGross: number;
  bookingPace: { d30: BookingPaceSummary; d90: BookingPaceSummary; d365: BookingPaceSummary };
  inquiries: InquiryFunnel;
  guestResponseTime: GuestResponseTime;
  weekdayWeekendRate: WeekdayWeekendRateSummary;
  lastMinuteDiscount: LastMinuteDiscountSummary;
  rateComparison: RateComparisonSummary;
  cancellation: CancellationSummary;
  avgLengthOfStayNights: number;
  repeatGuest: RepeatGuestSummary;
  reputation: ReputationSummary;
  maintenance: { open: number; inProgress: number; blocked: number; urgentOrEmergency: number };
  bills: { awaitingApproval: number; dueSoonCount: number; dueSoonCents: number };
  approvalsPending: number; // guest-reply drafts awaiting Seni over WhatsApp/dashboard, any age
  urgentApprovals: UrgentApprovals; // the subset of pending items that are actually time-critical
  newLeads: number;
  campaignCandidates: number;
  contentIdeasAwaitingReview: number; // Marketing pieces sitting at 'idea' or 'draft'
  topAttention: AttentionItem[];
  // Explicit acknowledgement of what VISION.md's Data Analyst spec asks for
  // that this app genuinely cannot report yet — see header comment.
  dataGaps: string[];
};

export async function buildExecutiveReport(
  organizationId?: string,
  propertyGroupId?: string
): Promise<ExecutiveReport> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const bookings = await getBookings(orgId, propertyGroupId);
  const stats = summaryStats(bookings);
  // adr/revPar/occupancyRate all share the same stay-date-clipped accrual
  // basis (see lib/finance.ts) so RevPAR = ADR x Occupancy holds — using
  // stats.avgNightlyRate (a YTD average) here instead would silently mix a
  // full-year figure into a "30d" report and make the three numbers
  // internally inconsistent.
  // Paid extras (2026-08-17) — one query, two windows. Skipped entirely on
  // properties that don't run extras, so their report is byte-identical to
  // before rather than carrying zero-filled sections.
  const extrasByBooking =
    (propertyGroupId ?? EXTRAS_PROPERTY_GROUP_ID) === EXTRAS_PROPERTY_GROUP_ID
      ? await listBookingExtras(orgId).catch(() => new Map())
      : new Map();
  const extrasYtd = extrasByBooking.size
    ? summarizeExtras(bookings, extrasByBooking, yearStartIso())
    : EMPTY_EXTRAS_SUMMARY;
  const extrasMtd = extrasByBooking.size
    ? summarizeExtras(bookings, extrasByBooking, monthStartIso())
    : EMPTY_EXTRAS_SUMMARY;

  const adr30 = adr(bookings, 30);
  const revPar30 = revPar(bookings, 30);
  const direct30 = directBookingShare(bookings, 30);
  const lastMinute = lastMinuteDiscount(bookings, 12);
  // Cancellation rate, repeat-guest rate — Seni's ask (2026-08-01) to close
  // out the remaining recommended-KPI list. avgLengthOfStay reuses
  // summaryStats' existing YTD figure (see `stats` below) rather than a new
  // function, since it was already computed correctly.
  const cancellation = cancellationRate(bookings);
  const repeatGuest = repeatGuestRate(bookings);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // BUG FIX (2026-08-17 audit): this was the ONE revenue reduction in the
  // codebase missing isRevenueCounting, so every CANCELLED reservation
  // arriving this month added its full total to "Revenue MTD" — and any
  // iCal block carrying a non-zero amount did too (Legacy Pompano is 233
  // blocks out of 246 "bookings"). Cancellation rates here run 9.9%
  // (Colombia) to 17.6% (Alva), so the overstatement was material, silent,
  // and read daily in the email, the WhatsApp digest and the AI COO
  // narrative. The revenueTodayGross block twelve lines below always had
  // the gate; this one was simply missed.
  const mtdBookings = bookings.filter(
    (b) =>
      isRevenueCounting(b) && b.arrival && new Date(b.arrival) >= monthStart && new Date(b.arrival) <= now
  );
  const revenueMtdGross = mtdBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);

  // "Revenue today" = pickup — new reservations actually MADE today
  // (OwnerRez's created_utc), not revenue from stays happening today. This
  // is the standard short-term-rental meaning of a daily revenue number and
  // the one useful for tracking booking momentum day to day; a stay-based
  // "revenue today" would just be a sliver of ADR and wouldn't tell Seni
  // anything the MTD/YTD figures don't already.
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayBookings = bookings.filter(
    (b) => isRevenueCounting(b) && b.createdAt && new Date(b.createdAt) >= todayStart
  );
  const revenueTodayGross = todayBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
  const revenueTodayNet = todayBookings.reduce((sum, b) => sum + netAmount(b), 0);

  // Forward-looking booking pace — "how much of the next N days is already
  // on the books" — distinct from occupancy30d above, which looks backward.
  const pace30 = bookingPace(bookings, 30);
  const pace90 = bookingPace(bookings, 90);
  const pace365 = bookingPace(bookings, 365);

  // Weekday vs. weekend rate — live OwnerRez quotes on a small near-future
  // sample, cached; see revenueManager.ts's getWeekdayWeekendRates for why
  // this can't come from rate_snapshots yet.
  const weekdayWeekendRates = await getWeekdayWeekendRates(orgId, propertyGroupId);

  // AI vs. PriceLabs vs. actual live OwnerRez rate, averaged across every
  // upcoming tracked date — Seni's explicit ask (2026-08-01) so he can watch
  // this trend daily rather than only when he opens the Revenue Management
  // tab. See revenueManager.ts's getRateComparisonSummary().
  const rateComparison = await getRateComparisonSummary(orgId, propertyGroupId);

  // Reputation Manager (Agent #9) — avg rating + how much is sitting in
  // Seni's response queue. Reads live OwnerRez reviews either way; the
  // pending-draft count is 0 (not wrong, just empty) if the DB isn't
  // connected, since drafts live in reputation_responses.
  const reputation = await getReputationSummary(orgId, propertyGroupId);

  const dbAvailable = isDbConfigured();
  const [workOrders, bills, leads, campaignCandidates, contentPieces] = dbAvailable
    ? await Promise.all([
        listWorkOrders(orgId, propertyGroupId),
        listBills(orgId, propertyGroupId),
        listLeads(orgId, propertyGroupId),
        listCampaignCandidates(orgId, propertyGroupId),
        listContentPieces(orgId, propertyGroupId),
      ])
    : [[], [], [], [], []];

  const pendingDrafts = isRedisConfigured() ? await getAllPendingDrafts(orgId, propertyGroupId) : [];
  const approvalsPending = pendingDrafts.length;
  const staleCutoff = new Date(now.getTime() - STALE_DRAFT_HOURS * 60 * 60 * 1000);
  const staleGuestReplies = pendingDrafts.filter((d) => new Date(d.createdAt) <= staleCutoff).length;

  const openWorkOrders = workOrders.filter((w) => w.status === "open");
  const inProgressWorkOrders = workOrders.filter((w) => w.status === "in_progress");
  const blockedWorkOrders = workOrders.filter((w) => w.status === "blocked");
  const urgentOrEmergency = workOrders.filter(
    (w) => !["resolved", "cancelled"].includes(w.status) && (w.priority === "urgent" || w.priority === "emergency")
  );

  const billsAwaitingApproval = bills.filter((b) =>
    ["pending_review", "flagged_duplicate", "flagged_anomaly", "approved_for_payment"].includes(b.status)
  );
  const sevenDaysOut = new Date();
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
  const billsDueSoon = billsAwaitingApproval.filter(
    (b) => b.dueDate && new Date(b.dueDate) <= sevenDaysOut
  );
  const billsDueSoonCents = billsDueSoon.reduce((sum, b) => sum + b.amountCents, 0);
  const urgentBillCutoff = new Date(now.getTime() + URGENT_BILL_HOURS * 60 * 60 * 1000);
  const billsDueUrgent = billsAwaitingApproval.filter(
    (b) => b.dueDate && new Date(b.dueDate) <= urgentBillCutoff
  ).length;

  const urgentApprovals: UrgentApprovals = {
    staleGuestReplies,
    billsDueUrgent,
    urgentMaintenance: urgentOrEmergency.length,
    total: staleGuestReplies + billsDueUrgent + urgentOrEmergency.length,
  };

  const newLeads = leads.filter((l) => l.stage === "new").length;
  const pendingCampaigns = campaignCandidates.filter((c) => c.status === "candidate").length;
  const contentAwaitingReview = contentPieces.filter((p) => p.status === "idea" || p.status === "draft").length;

  // Inquiry funnel: every Lead created within the window counts as an
  // inquiry (regardless of current stage); of those, the ones that reached
  // 'booked' are conversions. This only sees inquiries that made it into
  // the CRM's Sales Pipeline (lib/leads.ts) — OwnerRez's own native
  // Inquiry/Quote/Hold booking statuses are a second, currently-untracked
  // inquiry source (flagged in dataGaps below).
  const inquiryCutoff = new Date(now.getTime() - INQUIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const recentLeads = leads.filter((l) => new Date(l.createdAt) >= inquiryCutoff);
  const bookedRecentLeads = recentLeads.filter((l) => l.stage === "booked");
  const inquiries: InquiryFunnel = {
    windowDays: INQUIRY_WINDOW_DAYS,
    count: recentLeads.length,
    bookedCount: bookedRecentLeads.length,
    conversionPct: recentLeads.length > 0 ? Math.round((bookedRecentLeads.length / recentLeads.length) * 1000) / 10 : 0,
  };

  // Guest response-time SLA — see pendingDrafts.ts's recordResponseTime for
  // why this reads from a small rolling log rather than Redis's normal
  // pending-drafts index (which can't look backward at resolved drafts).
  const recentResponseTimes = isRedisConfigured()
    ? await getRecentResponseTimes(RESPONSE_TIME_WINDOW_DAYS, orgId, propertyGroupId)
    : [];
  const sortedMinutes = recentResponseTimes.map((r) => r.minutes).sort((a, b) => a - b);
  const guestResponseTime: GuestResponseTime = {
    windowDays: RESPONSE_TIME_WINDOW_DAYS,
    sampleSize: sortedMinutes.length,
    avgMinutes:
      sortedMinutes.length > 0
        ? Math.round((sortedMinutes.reduce((sum, m) => sum + m, 0) / sortedMinutes.length) * 10) / 10
        : null,
    medianMinutes: sortedMinutes.length > 0 ? sortedMinutes[Math.floor(sortedMinutes.length / 2)] : null,
  };

  const topAttention: AttentionItem[] = [];
  if (urgentApprovals.total > 0) {
    const parts: string[] = [];
    if (urgentApprovals.staleGuestReplies > 0) {
      parts.push(`${urgentApprovals.staleGuestReplies} guest repl${urgentApprovals.staleGuestReplies === 1 ? "y" : "ies"} waiting >${STALE_DRAFT_HOURS}h`);
    }
    if (urgentApprovals.billsDueUrgent > 0) {
      parts.push(`${urgentApprovals.billsDueUrgent} bill${urgentApprovals.billsDueUrgent === 1 ? "" : "s"} due within ${URGENT_BILL_HOURS}h`);
    }
    if (urgentApprovals.urgentMaintenance > 0) {
      parts.push(`${urgentApprovals.urgentMaintenance} urgent/emergency maintenance issue${urgentApprovals.urgentMaintenance === 1 ? "" : "s"}`);
    }
    topAttention.push({
      label: `Urgent approvals needed: ${parts.join(", ")}`,
      count: urgentApprovals.total,
      severity: "critical",
      href: "/approvals",
    });
  }
  // Note: urgent/emergency maintenance is already surfaced above in the
  // "Urgent approvals needed" rollup when present — no separate bullet here
  // to avoid saying the same thing twice.
  if (billsDueSoon.length > 0) {
    topAttention.push({
      label: `${billsDueSoon.length} bill${billsDueSoon.length === 1 ? "" : "s"} due within 7 days, not yet paid`,
      count: billsDueSoon.length,
      severity: "warning",
      href: "/bill-pay",
    });
  }
  if (approvalsPending > 0) {
    topAttention.push({
      label: `${approvalsPending} guest-reply draft${approvalsPending === 1 ? "" : "s"} awaiting your approval`,
      count: approvalsPending,
      severity: "warning",
      href: "/approvals",
    });
  }
  if (openWorkOrders.length > 0) {
    topAttention.push({
      label: `${openWorkOrders.length} maintenance issue${openWorkOrders.length === 1 ? "" : "s"} not yet started`,
      count: openWorkOrders.length,
      severity: "info",
      href: "/maintenance",
    });
  }
  if (newLeads > 0) {
    topAttention.push({
      label: `${newLeads} new lead${newLeads === 1 ? "" : "s"} not yet contacted`,
      count: newLeads,
      severity: "info",
      href: "/sales-pipeline",
    });
  }
  if (pendingCampaigns > 0) {
    topAttention.push({
      label: `${pendingCampaigns} lifecycle campaign message${pendingCampaigns === 1 ? "" : "s"} drafted, awaiting your review`,
      count: pendingCampaigns,
      severity: "info",
      href: "/crm-campaigns",
    });
  }
  if (reputation.pendingResponseCount > 0) {
    topAttention.push({
      label: `${reputation.pendingResponseCount} review response${reputation.pendingResponseCount === 1 ? "" : "s"} drafted, awaiting your approval`,
      count: reputation.pendingResponseCount,
      severity: "info",
      href: "/reputation",
    });
  }
  if (contentAwaitingReview > 0) {
    topAttention.push({
      label: `${contentAwaitingReview} content idea${contentAwaitingReview === 1 ? "" : "s"} waiting on a draft or your review`,
      count: contentAwaitingReview,
      severity: "info",
      href: "/marketing",
    });
  }

  const dataGaps: string[] = [
    "Revenue vs. budget — no budget has been set up in this system yet, so there's nothing real to compare actuals against.",
    "Marketing/SEO performance — no analytics or search-console connector is wired up, so traffic/ranking/attribution numbers aren't available (only drafting activity is tracked, shown above).",
    "Inquiry count/conversion only covers leads entered in the Sales Pipeline CRM tab — OwnerRez's own native Inquiry/Quote/Hold bookings aren't cross-referenced yet, so this likely undercounts real inquiry volume.",
  ];
  if (reputation.totalReviews === 0) {
    dataGaps.push(
      "Guest satisfaction — no reviews came back from OwnerRez (not connected, or this account/plan doesn't expose the reviews endpoint)."
    );
  }
  if (guestResponseTime.sampleSize === 0) {
    dataGaps.push(
      "Guest response-time SLA has no data yet — it only started tracking replies sent after this feature shipped (2026-08-01), so it'll fill in over the next few days."
    );
  }
  if (weekdayWeekendRates.weekdaySampleSize === 0 && weekdayWeekendRates.weekendSampleSize === 0) {
    dataGaps.push(
      "Weekday/weekend rate — no live OwnerRez quotes came back for the sampled near-future dates (OwnerRez not connected, or those dates aren't quotable right now)."
    );
  }
  if (rateComparison.datesTracked === 0) {
    dataGaps.push(
      "Rate engine comparison — no rate_snapshots yet (the daily revenue-snapshot cron hasn't run, or the database isn't connected)."
    );
  }
  if (!lastMinute.reliable) {
    dataGaps.push(
      `Last-minute discount % is measured empirically (avg nightly rate for bookings made ≤${LAST_MINUTE_LEAD_DAYS} days before arrival vs. ≥${ADVANCE_LEAD_DAYS} days out) rather than read from a configured discount setting — right now there ${lastMinute.lastMinuteSampleSize + lastMinute.advanceSampleSize === 0 ? "are no" : "aren't enough"} bookings in the last 12 months in one or both groups (${lastMinute.lastMinuteSampleSize} last-minute, ${lastMinute.advanceSampleSize} advance) to trust the comparison yet.`
    );
  }
  if (!dbAvailable) {
    dataGaps.unshift(
      "Database isn't connected — maintenance, bills, leads, campaigns, and content numbers below are all zero, not actually zero-activity."
    );
  }

  // Operating history, measured from the earliest real booking this property
  // has. Uses arrival dates (not created_utc) because that's when the
  // property actually started hosting guests.
  const realBookings = bookings.filter((b) => !b.isBlock && b.status !== "Cancelled" && b.arrival);
  const firstArrival = realBookings
    .map((b) => b.arrival.slice(0, 10))
    .sort()
    .find(Boolean) ?? null;
  const monthsInService = firstArrival
    ? Math.max(
        0,
        Math.round(((Date.now() - new Date(`${firstArrival}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24 * 30.44)) * 10) / 10
      )
    : null;

  const report: ExecutiveReport = {
    propertyLabel: propertyGroupById(propertyGroupId).label,
    propertyTenure: {
      firstBookingDate: firstArrival,
      monthsInService,
      isNewProperty: monthsInService !== null && monthsInService < 6,
      totalBookingsAllTime: realBookings.length,
    },
    generatedAt: new Date().toISOString(),
    cooBriefing: null, // filled in below, after every other field exists to synthesize over
    occupancy30d: occupancyRate(bookings, 30),
    adrGross: adr30.gross,
    adrNet: adr30.net,
    revParGross: revPar30.gross,
    revParNet: revPar30.net,
    directBookingPct: direct30.pct,
    revenueYtdGross: stats.ytdRevenue,
    revenueYtdNet: stats.ytdNetRevenue,
    revenueMtdGross,
    revenueTodayGross,
    revenueTodayNet,
    extrasYtd,
    extrasMtd,
    totalRevenueYtdGross: Math.round((stats.ytdRevenue + extrasYtd.houseRevenue) * 100) / 100,
    totalRevenueMtdGross: Math.round((revenueMtdGross + extrasMtd.houseRevenue) * 100) / 100,
    bookingPace: {
      d30: { daysOut: pace30.daysOut, nightsBooked: pace30.nightsBooked, nightsAvailable: pace30.nightsAvailable, pct: pace30.pct },
      d90: { daysOut: pace90.daysOut, nightsBooked: pace90.nightsBooked, nightsAvailable: pace90.nightsAvailable, pct: pace90.pct },
      d365: { daysOut: pace365.daysOut, nightsBooked: pace365.nightsBooked, nightsAvailable: pace365.nightsAvailable, pct: pace365.pct },
    },
    inquiries,
    guestResponseTime,
    weekdayWeekendRate: {
      weekdayAvgGross: weekdayWeekendRates.weekdayAvgCents !== null ? Math.round(weekdayWeekendRates.weekdayAvgCents) / 100 : null,
      weekendAvgGross: weekdayWeekendRates.weekendAvgCents !== null ? Math.round(weekdayWeekendRates.weekendAvgCents) / 100 : null,
      weekdaySampleSize: weekdayWeekendRates.weekdaySampleSize,
      weekendSampleSize: weekdayWeekendRates.weekendSampleSize,
    },
    lastMinuteDiscount: lastMinute,
    rateComparison,
    cancellation,
    avgLengthOfStayNights: stats.avgLengthOfStay,
    repeatGuest,
    reputation,
    maintenance: {
      open: openWorkOrders.length,
      inProgress: inProgressWorkOrders.length,
      blocked: blockedWorkOrders.length,
      urgentOrEmergency: urgentOrEmergency.length,
    },
    bills: {
      awaitingApproval: billsAwaitingApproval.length,
      dueSoonCount: billsDueSoon.length,
      dueSoonCents: billsDueSoonCents,
    },
    approvalsPending,
    urgentApprovals,
    newLeads,
    campaignCandidates: pendingCampaigns,
    contentIdeasAwaitingReview: contentAwaitingReview,
    topAttention,
    dataGaps,
  };

  // Generated last, over the fully-assembled report above — see
  // cooBriefing.ts's header comment for why this reads across every other
  // agent's numbers instead of computing anything new itself.
  report.cooBriefing = await getCooBriefing(report, orgId, propertyGroupId);

  return report;
}

/** Condensed to fit a real "30-second read" over WhatsApp — the full
 * breakdown with data-gap callouts lives on the Reports tab (see
 * app/reports/page.tsx); this is the pushed daily digest. */
export function formatReportForWhatsApp(report: ExecutiveReport): string {
  const lines: string[] = [];
  lines.push(`📊 Daily summary — ${report.propertyLabel ?? "Legacy Colombia"}`);
  if (report.urgentApprovals.total > 0) {
    lines.push(`🔴 ${report.urgentApprovals.total} urgent approval${report.urgentApprovals.total === 1 ? "" : "s"} need your decision today`);
  }
  if (report.cooBriefing) {
    lines.push("");
    lines.push(`🧭 AI COO: ${report.cooBriefing.narrative}`);
    for (const p of report.cooBriefing.priorities) {
      lines.push(`   → ${p}`);
    }
  }
  lines.push("");
  lines.push(`Occupancy (30d): ${report.occupancy30d}%`);
  lines.push(`ADR: $${report.adrGross.toFixed(0)} gross / $${report.adrNet.toFixed(0)} net`);
  lines.push(`RevPAR (30d): $${report.revParGross.toFixed(0)} gross / $${report.revParNet.toFixed(0)} net`);
  lines.push(`Direct bookings (30d): ${report.directBookingPct}%`);
  lines.push(`Revenue YTD: $${report.revenueYtdGross.toFixed(0)} gross / $${report.revenueYtdNet.toFixed(0)} net`);
  lines.push(`Revenue MTD: $${report.revenueMtdGross.toFixed(0)}`);
  lines.push(`Revenue today (new bookings): $${report.revenueTodayGross.toFixed(0)}`);
  // Extras (2026-08-17) — only when there are any, and always the HOUSE
  // share, so this line can be added to the revenue figures above without
  // double-counting Gabriel's commission.
  if (report.extrasYtd.count > 0) {
    lines.push(
      `Extras YTD (house share): $${report.extrasYtd.houseRevenue.toFixed(0)} · attach rate ${report.extrasYtd.attachRatePct}%`
    );
    lines.push(`Total revenue YTD: $${report.totalRevenueYtdGross.toFixed(0)} (stays + extras)`);
  }
  lines.push("");
  lines.push(
    `Booking pace: 30d ${report.bookingPace.d30.pct}% · 90d ${report.bookingPace.d90.pct}% · 12mo ${report.bookingPace.d365.pct}% on the books`
  );
  lines.push(
    `Inquiries (${report.inquiries.windowDays}d): ${report.inquiries.count}, ${report.inquiries.conversionPct}% converted to bookings`
  );
  if (report.guestResponseTime.sampleSize > 0) {
    lines.push(
      `Guest response time (avg, ${report.guestResponseTime.windowDays}d): ${report.guestResponseTime.avgMinutes}m over ${report.guestResponseTime.sampleSize} repl${report.guestResponseTime.sampleSize === 1 ? "y" : "ies"}`
    );
  }
  if (report.weekdayWeekendRate.weekdayAvgGross !== null || report.weekdayWeekendRate.weekendAvgGross !== null) {
    lines.push(
      `Weekday rate: ${report.weekdayWeekendRate.weekdayAvgGross !== null ? "$" + report.weekdayWeekendRate.weekdayAvgGross.toFixed(0) : "n/a"} · Weekend rate: ${report.weekdayWeekendRate.weekendAvgGross !== null ? "$" + report.weekdayWeekendRate.weekendAvgGross.toFixed(0) : "n/a"} (live quotes, next 2 weeks)`
    );
  }
  if (report.lastMinuteDiscount.reliable && report.lastMinuteDiscount.discountPct !== null) {
    lines.push(
      `Last-minute discount (empirical, 12mo): ${report.lastMinuteDiscount.discountPct > 0 ? report.lastMinuteDiscount.discountPct + "% less" : Math.abs(report.lastMinuteDiscount.discountPct) + "% more"} per night vs. bookers who planned ${ADVANCE_LEAD_DAYS}+ days ahead`
    );
  }
  if (report.reputation.totalReviews > 0) {
    lines.push(
      `Reviews: ${report.reputation.avgRating !== null ? report.reputation.avgRating.toFixed(2) + "★" : "n/a"} avg over ${report.reputation.totalReviews}${report.reputation.needsResponseCount > 0 ? ` · ${report.reputation.needsResponseCount} unanswered` : ""}`
    );
  }
  if (report.cancellation.totalCount > 0) {
    lines.push(
      `Cancellation rate: ${report.cancellation.pct}% (${report.cancellation.cancelledCount} of ${report.cancellation.totalCount})`
    );
  }
  lines.push(`Avg length of stay (YTD): ${report.avgLengthOfStayNights} night${report.avgLengthOfStayNights === 1 ? "" : "s"}`);
  if (report.repeatGuest.totalGuests > 0) {
    lines.push(
      `Repeat-guest rate: ${report.repeatGuest.pct}% (${report.repeatGuest.repeatGuests} of ${report.repeatGuest.totalGuests} guests)`
    );
  }
  if (report.rateComparison.datesTracked > 0) {
    const rc = report.rateComparison;
    const parts: string[] = [];
    if (rc.aiAvgGross !== null) parts.push(`AI $${rc.aiAvgGross.toFixed(0)}`);
    if (rc.priceLabsAvgGross !== null) parts.push(`PriceLabs $${rc.priceLabsAvgGross.toFixed(0)}`);
    if (rc.ownerRezAvgGross !== null) parts.push(`OwnerRez live $${rc.ownerRezAvgGross.toFixed(0)} (n=${rc.ownerRezSampleSize})`);
    lines.push(
      `Rate engine (avg over ${rc.datesTracked} upcoming dates): ${parts.join(" · ")}${
        rc.avgAiVsPriceLabsPct !== null ? ` — AI ${rc.avgAiVsPriceLabsPct > 0 ? "+" : ""}${rc.avgAiVsPriceLabsPct}% vs PriceLabs` : ""
      }`
    );
  }
  lines.push("");

  if (report.topAttention.length === 0) {
    lines.push("✅ Nothing needs your attention right now.");
  } else {
    lines.push("Needs your attention:");
    for (const item of report.topAttention.slice(0, 6)) {
      const icon = item.severity === "critical" ? "🔴" : item.severity === "warning" ? "🟡" : "•";
      lines.push(`${icon} ${item.label}`);
    }
  }

  return lines.join("\n");
}

/** Fuller HTML version for the email channel — same numbers as the WhatsApp
 * text, laid out with a bit more room since email doesn't need to fit a
 * phone-notification "30-second read" quite as tightly. Inline styles only:
 * most email clients strip <style> blocks. */
export function formatReportForEmailHtml(report: ExecutiveReport): string {
  const money = (n: number) => `$${n.toFixed(0)}`;
  const attentionRows = report.topAttention.length
    ? report.topAttention
        .map((item) => {
          const color = item.severity === "critical" ? "#dc2626" : item.severity === "warning" ? "#b45309" : "#525252";
          return `<li style="margin-bottom:6px;"><span style="color:${color};font-weight:600;">${item.severity.toUpperCase()}</span> — ${item.label}</li>`;
        })
        .join("")
    : `<li>Nothing needs your attention right now.</li>`;

  const gapItems = report.dataGaps.map((g) => `<li style="margin-bottom:6px;">${g}</li>`).join("");

  const urgentBanner =
    report.urgentApprovals.total > 0
      ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#991b1b;font-weight:600;font-size:14px;">
          🔴 ${report.urgentApprovals.total} urgent approval${report.urgentApprovals.total === 1 ? "" : "s"} need your decision today
        </div>`
      : "";

  const cooBriefingBlock = report.cooBriefing
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:16px;">
        <div style="font-weight:600;font-size:13px;color:#1e40af;margin-bottom:4px;">🧭 AI COO</div>
        <div style="font-size:14px;color:#1e293b;">${report.cooBriefing.narrative}</div>
        ${
          report.cooBriefing.priorities.length > 0
            ? `<ul style="margin:8px 0 0;padding-left:18px;font-size:13px;color:#1e293b;">${report.cooBriefing.priorities
                .map((p) => `<li style="margin-bottom:3px;">${p}</li>`)
                .join("")}</ul>`
            : ""
        }
      </div>`
    : "";

  return `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#171717;">
      <h2 style="margin-bottom:4px;">📊 Daily executive summary — ${report.propertyLabel ?? "Legacy Colombia"}</h2>
      <p style="color:#737373;font-size:13px;margin-top:0;">Generated ${new Date(report.generatedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</p>

      ${urgentBanner}
      ${cooBriefingBlock}

      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Occupancy (30d)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${report.occupancy30d}%</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">ADR</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${money(report.adrGross)} gross / ${money(report.adrNet)} net</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">RevPAR (30d)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${money(report.revParGross)} gross / ${money(report.revParNet)} net</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Direct bookings (30d)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${report.directBookingPct}%</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Revenue YTD</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${money(report.revenueYtdGross)} gross / ${money(report.revenueYtdNet)} net</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Revenue MTD</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${money(report.revenueMtdGross)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Revenue today (new bookings)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${money(report.revenueTodayGross)}</td>
        </tr>
        ${
          report.extrasYtd.count > 0
            ? `<tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Extras YTD (house share)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${money(report.extrasYtd.houseRevenue)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:2px solid #333;"><strong>Total revenue YTD</strong></td>
          <td style="padding:8px 0;border-bottom:2px solid #333;text-align:right;font-weight:700;">${money(report.totalRevenueYtdGross)}</td>
        </tr>`
            : ""
        }
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Booking pace (30d / 90d / 12mo)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${report.bookingPace.d30.pct}% / ${report.bookingPace.d90.pct}% / ${report.bookingPace.d365.pct}%</td>
        </tr>
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Inquiries (${report.inquiries.windowDays}d) / conversion</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${report.inquiries.count} / ${report.inquiries.conversionPct}%</td>
        </tr>
        ${
          report.guestResponseTime.sampleSize > 0
            ? `<tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Guest response time (avg, ${report.guestResponseTime.windowDays}d)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${report.guestResponseTime.avgMinutes}m (${report.guestResponseTime.sampleSize} repl${report.guestResponseTime.sampleSize === 1 ? "y" : "ies"})</td>
        </tr>`
            : ""
        }
        ${
          report.weekdayWeekendRate.weekdayAvgGross !== null || report.weekdayWeekendRate.weekendAvgGross !== null
            ? `<tr>
          <td style="padding:8px 0;${report.lastMinuteDiscount.reliable ? 'border-bottom:1px solid #e5e5e5;' : ''}">Weekday / weekend rate (live, next 2wk)</td>
          <td style="padding:8px 0;${report.lastMinuteDiscount.reliable ? 'border-bottom:1px solid #e5e5e5;' : ''}text-align:right;font-weight:600;">${report.weekdayWeekendRate.weekdayAvgGross !== null ? money(report.weekdayWeekendRate.weekdayAvgGross) : "n/a"} / ${report.weekdayWeekendRate.weekendAvgGross !== null ? money(report.weekdayWeekendRate.weekendAvgGross) : "n/a"}</td>
        </tr>`
            : ""
        }
        ${
          report.lastMinuteDiscount.reliable && report.lastMinuteDiscount.discountPct !== null
            ? `<tr>
          <td style="padding:8px 0;${report.reputation.totalReviews > 0 ? 'border-bottom:1px solid #e5e5e5;' : ''}">Last-minute discount (empirical, 12mo)</td>
          <td style="padding:8px 0;${report.reputation.totalReviews > 0 ? 'border-bottom:1px solid #e5e5e5;' : ''}text-align:right;font-weight:600;">${report.lastMinuteDiscount.discountPct > 0 ? report.lastMinuteDiscount.discountPct + "% less" : Math.abs(report.lastMinuteDiscount.discountPct) + "% more"}/night vs. ${ADVANCE_LEAD_DAYS}+ day planners</td>
        </tr>`
            : ""
        }
        ${
          report.reputation.totalReviews > 0
            ? `<tr>
          <td style="padding:8px 0;${report.rateComparison.datesTracked > 0 ? 'border-bottom:1px solid #e5e5e5;' : ''}">Reviews</td>
          <td style="padding:8px 0;${report.rateComparison.datesTracked > 0 ? 'border-bottom:1px solid #e5e5e5;' : ''}text-align:right;font-weight:600;">${report.reputation.avgRating !== null ? report.reputation.avgRating.toFixed(2) + "★" : "n/a"} avg over ${report.reputation.totalReviews}${report.reputation.needsResponseCount > 0 ? ` (${report.reputation.needsResponseCount} unanswered)` : ""}</td>
        </tr>`
            : ""
        }
        ${
          report.rateComparison.datesTracked > 0
            ? `<tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Rate engine — AI / PriceLabs / OwnerRez live (avg, ${report.rateComparison.datesTracked} dates)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${report.rateComparison.aiAvgGross !== null ? money(report.rateComparison.aiAvgGross) : "n/a"} / ${report.rateComparison.priceLabsAvgGross !== null ? money(report.rateComparison.priceLabsAvgGross) : "n/a"} / ${report.rateComparison.ownerRezAvgGross !== null ? money(report.rateComparison.ownerRezAvgGross) + ` (n=${report.rateComparison.ownerRezSampleSize})` : "n/a"}${report.rateComparison.avgAiVsPriceLabsPct !== null ? `<br/><span style="font-weight:400;color:#737373;font-size:12px;">AI ${report.rateComparison.avgAiVsPriceLabsPct > 0 ? "+" : ""}${report.rateComparison.avgAiVsPriceLabsPct}% vs PriceLabs</span>` : ""}</td>
        </tr>`
            : ""
        }
        ${
          report.cancellation.totalCount > 0
            ? `<tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Cancellation rate</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${report.cancellation.pct}% (${report.cancellation.cancelledCount} of ${report.cancellation.totalCount})</td>
        </tr>`
            : ""
        }
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;">Avg length of stay (YTD)</td>
          <td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${report.avgLengthOfStayNights} night${report.avgLengthOfStayNights === 1 ? "" : "s"}</td>
        </tr>
        ${
          report.repeatGuest.totalGuests > 0
            ? `<tr>
          <td style="padding:8px 0;">Repeat-guest rate</td>
          <td style="padding:8px 0;text-align:right;font-weight:600;">${report.repeatGuest.pct}% (${report.repeatGuest.repeatGuests} of ${report.repeatGuest.totalGuests} guests)</td>
        </tr>`
            : ""
        }
      </table>
${
  report.extrasYtd.count > 0
    ? `
      <h3 style="margin-bottom:2px;">Extras &amp; ancillary revenue (YTD)</h3>
      <p style="margin:0 0 6px;color:#737373;font-size:12px;">
        Manually recorded on the Team Management tab. Only the house share counts as revenue &mdash;
        the guest total also contains Gabriel&rsquo;s commission, which passes through.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="color:#737373;font-size:12px;text-align:left;">
          <th style="padding:4px 0;font-weight:500;">Extra</th>
          <th style="padding:4px 0;font-weight:500;text-align:right;">Sold</th>
          <th style="padding:4px 0;font-weight:500;text-align:right;">Guest paid</th>
          <th style="padding:4px 0;font-weight:500;text-align:right;">House share</th>
          <th style="padding:4px 0;font-weight:500;text-align:right;">Commission</th>
        </tr>
        ${report.extrasYtd.byKind
          .map(
            (r) => `<tr>
          <td style="padding:6px 0;border-bottom:1px solid #e5e5e5;">${r.label}</td>
          <td style="padding:6px 0;border-bottom:1px solid #e5e5e5;text-align:right;">${r.count}</td>
          <td style="padding:6px 0;border-bottom:1px solid #e5e5e5;text-align:right;color:#737373;">${money(r.guestPaid)}</td>
          <td style="padding:6px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;">${money(r.houseRevenue)}</td>
          <td style="padding:6px 0;border-bottom:1px solid #e5e5e5;text-align:right;color:#737373;">${money(r.commission)}</td>
        </tr>`
          )
          .join("")}
        <tr>
          <td style="padding:6px 0;border-bottom:2px solid #333;font-weight:700;">Total</td>
          <td style="padding:6px 0;border-bottom:2px solid #333;text-align:right;font-weight:700;">${report.extrasYtd.count}</td>
          <td style="padding:6px 0;border-bottom:2px solid #333;text-align:right;font-weight:700;">${money(report.extrasYtd.guestPaid)}</td>
          <td style="padding:6px 0;border-bottom:2px solid #333;text-align:right;font-weight:700;">${money(report.extrasYtd.houseRevenue)}</td>
          <td style="padding:6px 0;border-bottom:2px solid #333;text-align:right;font-weight:700;">${money(report.extrasYtd.commission)}</td>
        </tr>
      </table>
      <p style="margin:6px 0 0;color:#737373;font-size:13px;">
        Attach rate <strong>${report.extrasYtd.attachRatePct}%</strong>
        (${report.extrasYtd.staysWithExtras} of ${report.extrasYtd.totalStays} stays)
        &middot; ${money(report.extrasYtd.houseRevenuePerStay)} house share per stay
        &middot; MTD house share ${money(report.extrasMtd.houseRevenue)}
      </p>
`
    : ""
}
      <h3 style="margin-bottom:6px;">Needs your attention</h3>
      <ul style="padding-left:18px;margin-top:0;">${attentionRows}</ul>

      <h3 style="margin-bottom:6px;color:#737373;font-size:13px;">What this report can&rsquo;t tell you yet</h3>
      <ul style="padding-left:18px;margin-top:0;color:#737373;font-size:13px;">${gapItems}</ul>

      <p style="margin-top:24px;"><a href="https://crm.legacyestaterentals.com/reports" style="color:#2563eb;">Open the full dashboard →</a></p>
    </div>
  `;
}

// WhatsApp is deliberately reserved for the three things Seni wants in the
// moment — inquiries, guest messages, new bookings (2026-08-17). Recaps and
// digests go by EMAIL only. Flipping this to true restores the WhatsApp leg
// without touching any other code.
const SEND_RECAPS_TO_WHATSAPP = false;

export type DeliveryResult = { attempted: boolean; sent: boolean; error?: string };

/** Sends the report over every configured channel independently — a
 * WhatsApp failure never blocks the email attempt or vice versa. Shared by
 * the scheduled cron (api/cron/daily-report) and the on-demand test route
 * (api/debug/send-test-report) so "run it now" and "run it at 5am ET" are
 * guaranteed to behave identically. */
export async function deliverExecutiveReport(
  report: ExecutiveReport,
  trigger: string,
  organizationId?: string,
  // Who this copy goes to (2026-08-17, Seni: "send one daily summary specific
  // for each property to each admin/owner ONLY based on the properties that
  // that specific admin/owner has access to"). Falls back to the account-wide
  // REPORT_EMAIL_TO when omitted, which is what the old single-recipient
  // behaviour did.
  recipientEmail?: string
): Promise<{ whatsapp: DeliveryResult; email: DeliveryResult }> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const whatsapp: DeliveryResult = { attempted: false, sent: false };
  const email: DeliveryResult = { attempted: false, sent: false };

  // WhatsApp delivery of this recap was REMOVED 2026-08-17 at Seni's request:
  // "I don't need the daily recap sent to my whatsapp any longer because I get
  // them emailed to me." WhatsApp is now reserved for the three things that
  // need him in the moment — inquiries, guest messages, and new bookings.
  // The EMAIL delivery below is untouched and remains the channel for this.
  // The whatsapp result object is kept (attempted:false) so the cron's
  // response shape and its logged activity record don't change.
  if (SEND_RECAPS_TO_WHATSAPP && isWhatsAppConfigured()) {
    whatsapp.attempted = true;
    try {
      // DURABLE FIX (2026-08-07): try the real Meta-approved template first
      // so the daily digest reaches Seni even when his 24h session window
      // is closed (which it usually is at 5am ET). Falls back to the old
      // free-text send — which drops silently when the window is closed —
      // if the template isn't configured/approved yet.
      const urgentNote =
        report.urgentApprovals.total > 0
          ? `${report.urgentApprovals.total} urgent approval${report.urgentApprovals.total === 1 ? "" : "s"} need your decision today. `
          : "";
      const headline = `${urgentNote}${report.cooBriefing?.narrative ?? "See full report for details."}`;
      const statsLine = `Occupancy (30d): ${report.occupancy30d}% · ADR: $${report.adrGross.toFixed(0)} · RevPAR: $${report.revParGross.toFixed(0)} · Direct: ${report.directBookingPct}% · Revenue MTD: $${report.revenueMtdGross.toFixed(0)} · Pace: 30d ${report.bookingPace.d30.pct}% / 90d ${report.bookingPace.d90.pct}% / 12mo ${report.bookingPace.d365.pct}%`;
      try {
        await sendDailySummaryTemplate({ orgLabel: report.propertyLabel ?? "Legacy Colombia", headline, statsLine }, orgId);
      } catch {
        await sendWhatsAppText(formatReportForWhatsApp(report), orgId);
      }
      whatsapp.sent = true;
    } catch (err) {
      whatsapp.error = err instanceof Error ? err.message : "Unknown error.";
    }
  }

  const emailTo = recipientEmail?.trim() || config.reportEmailTo;
  if (emailTo && config.resendApiKey) {
    email.attempted = true;
    try {
      await sendEmail({
        to: emailTo,
        subject: `Daily summary — ${report.propertyLabel ?? "Legacy Colombia"} (${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })})`,
        html: formatReportForEmailHtml(report),
      });
      email.sent = true;
    } catch (err) {
      email.error = err instanceof Error ? err.message : "Unknown error.";
    }
  }

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Generate & deliver daily executive report",
    trigger,
    decision: `${report.topAttention.length} item(s) flagged for attention`,
    actionTaken: `WhatsApp: ${whatsapp.attempted ? (whatsapp.sent ? "sent" : `failed (${whatsapp.error})`) : "not configured"}; Email: ${email.attempted ? (email.sent ? "sent" : `failed (${email.error})`) : "not configured"}`,
    result: whatsapp.sent || email.sent ? "sent" : "not_sent",
  }, orgId).catch(() => {});

  return { whatsapp, email };
}
