// Email as a PARALLEL alert channel (2026-08-21, Seni's ask: "add email as
// a parallel channel on every inquiry alert, new booking or new guest
// message" — belt-and-suspenders after Juan Botero's missed inquiry).
// WhatsApp stays the primary channel; these emails are deliberately
// best-effort and NEVER gate, replace, or reorder the WhatsApp logic —
// an email failure must not stop a WhatsApp send, and vice versa.
//
// Dedupe: each alert passes a Redis key derived from the same identifier
// its WhatsApp path dedupes on (inquiry id / booking id / draft id) with an
// ":email" suffix, marked AFTER a successful send — so WhatsApp's
// retry-next-run semantics (which re-enter the same code path) never
// produce duplicate emails.
import { sendEmail } from "@/lib/email";
import { config, isEmailSendConfigured } from "@/lib/config";
import { redisGet, redisSet } from "@/lib/redis";

// Same fallback as the webhook watchdog — Seni directly.
const DEFAULT_TO = "senisok1@gmail.com";

const DEDUPE_TTL_SECONDS = 400 * 24 * 60 * 60;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Best-effort alert email to Seni. Returns whether it actually sent. */
export async function sendAlertEmail(subject: string, text: string): Promise<boolean> {
  if (!isEmailSendConfigured()) return false;
  try {
    await sendEmail({
      to: config.reportEmailTo || DEFAULT_TO,
      subject,
      text,
      html: `<pre style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap;margin:0;">${esc(text)}</pre>`,
    });
    return true;
  } catch (err) {
    console.error(`[alertEmail] send failed for "${subject}":`, err);
    return false;
  }
}

/** sendAlertEmail with a Redis once-guard — safe inside retry loops. */
export async function sendAlertEmailOnce(dedupeKey: string, subject: string, text: string): Promise<boolean> {
  try {
    if (await redisGet(dedupeKey)) return false;
  } catch {
    // Redis hiccup — fall through and send; worst case is one duplicate
    // email, better than a missed one.
  }
  const ok = await sendAlertEmail(subject, text);
  if (ok) await redisSet(dedupeKey, "1", { exSeconds: DEDUPE_TTL_SECONDS }).catch(() => {});
  return ok;
}
