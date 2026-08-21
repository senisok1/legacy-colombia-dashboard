import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { redisGet } from "@/lib/redis";
import { sendDailySummaryTemplate, sendWhatsAppText } from "@/lib/whatsapp";
import { sendEmail } from "@/lib/email";
import { logAiActivity } from "@/lib/aiActivity";

// Webhook watchdog (2026-08-19, Seni's ask: "build what you need to build
// for 100% certainty on all of it"). Root problem it guards against:
// OwnerRez silently stopped delivering webhooks after 2026-08-18 01:11 UTC
// while still LISTING the subscriptions as active — no error, no signal,
// just missed inquiry/booking/message alerts (Shlomo) until someone noticed
// by hand. This cron makes that failure mode self-detecting AND
// self-healing:
//
//   1. Verifies all three subscription types (message, booking, inquiry)
//      exist on OwnerRez pointing at this app's /api/webhook — recreates
//      any that are missing.
//   2. Checks delivery freshness: api/webhook records every authenticated
//      event into webhook:raw-samples. If the newest sample is older than
//      STALE_HOURS, deliveries have likely died again (this account gets
//      guest/booking traffic near-daily) — so it deletes + recreates the
//      subscriptions to reset OwnerRez's delivery state.
//   3. If it had to fix ANYTHING, it tells Seni on BOTH channels: WhatsApp
//      (template carrier, window-proof) and email — deliberately redundant,
//      since a watchdog that alerts only through the channel being watched
//      can fail silently right along with it.
//
// Worst case on a quiet-traffic false alarm: one unnecessary resubscribe
// (harmless — same operation as admin/webhook-status?resubscribe=1) and one
// FYI ping. Same "fail toward an extra ping, never a missed one" philosophy
// as lib/adminReplyMarkers.ts.
export const maxDuration = 120;

// Tightened 36 → 24 (2026-08-21, Juan Botero's missed inquiry): at 36h with
// a once-daily run, deliveries that died right after a run got a blind
// window of up to ~2 days. The cron now also runs every 6h (vercel.json)
// instead of once a day. Worst case on a genuinely quiet day: one
// unnecessary resubscribe + one FYI ping — acceptable per the philosophy
// above. Note the inquiry-alert POLL (lib/inquiryAlerts.ts, every minute via
// check-messages) is now the delivery guarantee; this watchdog just keeps
// the fast push path alive.
const STALE_HOURS = 24;
const WEBHOOK_BASE = "https://legacy-colombia-dashboard.vercel.app/api/webhook";
const REQUIRED_TYPES = ["message", "booking", "inquiry"] as const;

export async function GET(req: NextRequest) {
  // CRON AUTH — fail closed in production, same guard as every other cron
  // route. Additionally accepts ?secret=ADMIN_SECRET so the watchdog can be
  // run by hand for verification (CRON_SECRET is a Sensitive env var and
  // can't be used from outside Vercel's scheduler).
  const isProd = process.env.VERCEL_ENV === "production";
  const adminOk = Boolean(config.adminSecret) && req.nextUrl.searchParams.get("secret") === config.adminSecret;
  if (!adminOk) {
    if (!config.cronSecret) {
      if (isProd) {
        console.error("[cron/webhook-watchdog] CRON_SECRET is not set in production — refusing to run unauthenticated.");
        return NextResponse.json({ error: "Cron not configured." }, { status: 503 });
      }
      console.warn("[cron/webhook-watchdog] CRON_SECRET unset — running WITHOUT auth (non-production only).");
    } else {
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${config.cronSecret}`) {
        return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      }
    }
  }

  if (!config.ownerRezOAuthToken) {
    return NextResponse.json({ ok: false, error: "OWNERREZ_OAUTH_TOKEN isn't set — can't inspect subscriptions." });
  }
  const authHeaders = {
    Authorization: `Bearer ${config.ownerRezOAuthToken}`,
    "User-Agent": config.userAgent,
  };
  const webhookUrl = `${WEBHOOK_BASE}?secret=${(process.env.WEBHOOK_SECRET || "").trim()}`;

  const problems: string[] = [];
  const actions: string[] = [];

  try {
    // --- 1. Subscription existence ---
    const listRes = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
      headers: authHeaders,
      cache: "no-store",
    });
    const listBody = (await listRes.json().catch(() => null)) as
      | { items?: { id: number; type: string; webhook_url: string }[] }
      | null;
    if (!listRes.ok) {
      problems.push(`Couldn't list OwnerRez webhook subscriptions (HTTP ${listRes.status}).`);
    }
    const mine = (listBody?.items ?? []).filter((s) => s.webhook_url.startsWith(WEBHOOK_BASE));
    const presentTypes = new Set(mine.map((s) => s.type));
    const missing = REQUIRED_TYPES.filter((t) => !presentTypes.has(t));
    for (const type of missing) {
      problems.push(`OwnerRez subscription for '${type}' events was MISSING.`);
      const res = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ type, action: "entity_create", webhook_url: webhookUrl }),
      });
      actions.push(`Recreated '${type}' subscription (HTTP ${res.status}).`);
    }

    // --- 2. Delivery freshness ---
    let newestSampleAt: string | null = null;
    try {
      const raw = await redisGet("webhook:raw-samples");
      const samples = raw ? (JSON.parse(raw) as { at?: string }[]) : [];
      newestSampleAt = samples[0]?.at ?? null;
    } catch {
      /* treated as unknown, not stale — Redis hiccups shouldn't churn subscriptions */
    }
    const ageHours = newestSampleAt
      ? (Date.now() - new Date(newestSampleAt).getTime()) / (60 * 60 * 1000)
      : null;
    if (ageHours !== null && ageHours > STALE_HOURS) {
      problems.push(
        `No webhook delivery in ${Math.round(ageHours)}h (last: ${newestSampleAt}) — OwnerRez has likely gone silent again.`
      );
      // Full reset: delete ours, recreate all three. Same operation as
      // api/admin/webhook-status?resubscribe=1 (which fixed the 2026-08-19
      // outage), just automatic.
      for (const sub of mine) {
        await fetch(`https://api.ownerrez.com/v2/webhooksubscriptions/${sub.id}`, {
          method: "DELETE",
          headers: authHeaders,
        }).catch(() => {});
      }
      for (const type of REQUIRED_TYPES) {
        const res = await fetch("https://api.ownerrez.com/v2/webhooksubscriptions", {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ type, action: "entity_create", webhook_url: webhookUrl }),
        });
        actions.push(`Resubscribed '${type}' (HTTP ${res.status}).`);
      }
    }

    // --- 3. Alert Seni on both channels if anything was wrong ---
    if (problems.length > 0) {
      const summary = `${problems.join(" ")} ${actions.length > 0 ? `Auto-fix: ${actions.join(" ")}` : ""}`.trim();
      let whatsappSent = false;
      try {
        await sendDailySummaryTemplate({
          orgLabel: "Legacy Estates OS",
          headline: "⚠️ Webhook watchdog: problem found & auto-fixed",
          statsLine: summary.slice(0, 500),
        });
        whatsappSent = true;
      } catch {
        whatsappSent = await sendWhatsAppText(`⚠️ Webhook watchdog\n\n${summary}`).then(
          () => true,
          () => false
        );
      }
      let emailSent = false;
      const emailTo = config.reportEmailTo || "senisok1@gmail.com";
      try {
        await sendEmail({
          to: emailTo,
          subject: "⚠️ CRM webhook watchdog: problem found & auto-fixed",
          text: summary,
          html: `<p>${summary}</p><p>Details: https://crm.legacyestaterentals.com/activity</p>`,
        });
        emailSent = true;
      } catch (err) {
        console.error("[cron/webhook-watchdog] email alert failed:", err);
      }
      await logAiActivity({
        agentKey: "guest_experience",
        agentDisplayName: "AI Guest Experience Manager",
        task: "Webhook watchdog",
        trigger: problems.join(" "),
        actionTaken: `${actions.join(" ") || "No auto-fix applied."} Alerts — WhatsApp: ${whatsappSent ? "sent" : "FAILED"}, email: ${emailSent ? "sent" : "FAILED"}.`,
        result: "notified",
      }).catch(() => {});
      return NextResponse.json({ ok: true, healthy: false, problems, actions, whatsappSent, emailSent });
    }

    return NextResponse.json({
      ok: true,
      healthy: true,
      subscriptions: mine.map((s) => ({ id: s.id, type: s.type })),
      newestDelivery: newestSampleAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("[cron/webhook-watchdog] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
