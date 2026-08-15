import { query } from "./db";
import { sendEmail } from "./email";
import { isEmailConfigured, config } from "./config";

// 101+-property signups never see a self-serve Stripe Checkout (see
// lib/billing.ts's ENTERPRISE_MIN_PROPERTIES) — this is where that "talk to
// sales" form lands instead. Deliberately tiny: store the inquiry so it's
// never lost even if the notification email fails, and best-effort notify
// Seni directly (same "second channel, fail quiet" pattern as
// lib/whatsapp.ts's Gabriel notify — a missed enterprise lead is bad, but a
// crashed request because Resend is down is worse).
export type EnterpriseInquiryInput = {
  organizationId?: string;
  name: string;
  email: string;
  propertyCount?: number;
  message?: string;
};

export async function recordEnterpriseInquiry(input: EnterpriseInquiryInput): Promise<void> {
  await query(
    `insert into enterprise_inquiries (organization_id, name, email, property_count, message)
     values ($1, $2, $3, $4, $5)`,
    [input.organizationId ?? null, input.name, input.email, input.propertyCount ?? null, input.message ?? null]
  );

  if (!isEmailConfigured()) return;
  try {
    await sendEmail({
      to: config.reportEmailTo,
      subject: `Enterprise pricing inquiry: ${input.name} (${input.propertyCount ?? "?"} properties)`,
      html: `
        <p>New enterprise inquiry from the billing page (101+ properties):</p>
        <ul>
          <li><strong>Name:</strong> ${input.name}</li>
          <li><strong>Email:</strong> ${input.email}</li>
          <li><strong>Property count:</strong> ${input.propertyCount ?? "not given"}</li>
          <li><strong>Organization id:</strong> ${input.organizationId ?? "n/a (not signed up yet)"}</li>
        </ul>
        ${input.message ? `<p><strong>Message:</strong><br/>${input.message}</p>` : ""}
      `,
    });
  } catch {
    // Stored above regardless — a failed notification email doesn't lose
    // the lead, it just means Seni finds it by checking the table instead
    // of his inbox.
  }
}
