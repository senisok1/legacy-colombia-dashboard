// Central place for environment-driven configuration.
// Copy .env.local.example to .env.local and fill in your real values to go live.

export const config = {
  // .trim() guards against stray whitespace/newlines that can sneak in when
  // pasting into a multi-line textarea (e.g. Vercel's env var editor).
  ownerRezEmail: (process.env.OWNERREZ_EMAIL || "").trim(),
  ownerRezToken: (process.env.OWNERREZ_TOKEN || "").trim(),
  // The one property this dashboard focuses on for now. Must match the property
  // name exactly as it appears in your OwnerRez account (case-insensitive match
  // is used as a fallback). You can point this at a different property later,
  // or we can extend the app to handle multiple properties.
  propertyName: process.env.OWNERREZ_PROPERTY_NAME || "Legacy Colombia",
  // Optional: if you already know the numeric OwnerRez property ID, set it here
  // to skip the name-lookup step entirely.
  propertyId: process.env.OWNERREZ_PROPERTY_ID
    ? Number(process.env.OWNERREZ_PROPERTY_ID)
    : undefined,
  // Additional OwnerRez property IDs that represent the SAME physical unit as
  // the primary property above, just listed a second (or third...) time as a
  // separate channel import — e.g. "Nukak - Casa #19" (id 492014) is a second
  // Airbnb listing for the same villa as propertyName's "Legacy Colombia:
  // Luxury Waterfront Wellness Retreat" (id 413494), added 2026-08-04. Every
  // OwnerRez read in lib/ownerrez.ts (bookings, guests, reviews, availability)
  // merges data across the primary property + these IDs so the dashboard/CRM
  // shows one combined view of the villa regardless of which listing a guest
  // actually booked through. Comma-separated numeric IDs.
  additionalPropertyIds: (process.env.OWNERREZ_ADDITIONAL_PROPERTY_IDS ?? "492014")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  // Optional: used for the translation helper on the Messaging page. If unset,
  // translation requests will return a clear "not configured" message instead
  // of failing silently.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  userAgent: "Legacy Colombia Dashboard/1.0 (local)",

  // --- Messaging (OwnerRez OAuth) ---
  // OwnerRez's Personal Access Tokens do NOT support the messaging endpoints —
  // sending/reading a message thread requires an OAuth app instead. These come
  // from Developer/API Settings -> OAuth Apps in OwnerRez.
  ownerRezOAuthClientId: (process.env.OWNERREZ_OAUTH_CLIENT_ID || "").trim(),
  ownerRezOAuthClientSecret: (process.env.OWNERREZ_OAUTH_CLIENT_SECRET || "").trim(),
  // The long-lived access token obtained by completing the one-time OAuth
  // connection at /api/oauth/start. Stored as a plain env var (like the PAT)
  // since this app intentionally avoids running a database.
  ownerRezOAuthToken: (process.env.OWNERREZ_OAUTH_TOKEN || "").trim(),

  // --- AI guest-reply drafting (Claude) ---
  // Reuses the same key as the translation helper above. Get one at
  // https://console.anthropic.com/settings/keys and make sure it has credits.
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",

  // --- Persistent storage (Redis, for AI drafts awaiting WhatsApp approval) ---
  // Auto-injected by the Vercel Redis marketplace integration once the
  // database is connected to this project — see Storage tab in Vercel.
  redisUrl: (process.env.REDIS_URL || "").trim(),

  // --- WhatsApp (Meta Cloud API) — guest-reply approval channel ---
  // All five of these come from Meta for Developers -> your app -> WhatsApp ->
  // API Setup, plus the System User permanent token (Business Settings ->
  // Users -> System Users). See README's WhatsApp section for the full setup.
  whatsappAccessToken: (process.env.WHATSAPP_ACCESS_TOKEN || "").trim(),
  whatsappPhoneNumberId: (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim(),
  whatsappBusinessAccountId: (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "").trim(),
  // The host's own WhatsApp number (E.164, no "+"), e.g. 17326895070. This is
  // the only number the bot will ever message or accept approvals from.
  whatsappRecipientNumber: (process.env.WHATSAPP_RECIPIENT_NUMBER || "").trim(),
  // Arbitrary shared secret used only for Meta's webhook verification
  // handshake (GET /api/whatsapp/webhook?hub.verify_token=...). Not a
  // third-party credential — you can set this to anything.
  whatsappVerifyToken: (process.env.WHATSAPP_VERIFY_TOKEN || "").trim(),

  // --- WhatsApp — Gabriel (on-site property manager) auto-notify ---
  // Gabriel's WhatsApp number (E.164, no "+"), e.g. 573207507474. When a
  // guest asks about a paid add-on experience (chef, massage, jet ski, boat
  // rental, etc.) and Seni approves the AI-drafted reply, this app notifies
  // Gabriel via an approved WhatsApp message template so he can create a
  // group with the guest and Seni to coordinate. Optional — if unset, the
  // pricing-aware reply still works, it just skips the Gabriel notify step.
  whatsappGabrielNumber: (process.env.WHATSAPP_GABRIEL_NUMBER || "").trim(),
  // The name of the Meta-approved message template used for that first
  // notification to Gabriel. Required because Gabriel won't have an open
  // 24-hour customer-service window with this WhatsApp number, so a
  // free-text message can't be sent to him until he's replied at least once
  // — see README's WhatsApp section for the exact template body to submit.
  whatsappServiceRequestTemplate: (process.env.WHATSAPP_SERVICE_REQUEST_TEMPLATE || "service_request_alert").trim(),
  whatsappTemplateLanguage: (process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en_US").trim(),

  // --- WhatsApp — session-opener template (2026-08-07 reliability fix) ---
  // ROOT CAUSE: sendWhatsAppText() (approval pings + the daily executive
  // report — the two things Seni's WhatsApp is actually FOR) sends plain
  // free text to Seni's own number. WhatsApp only delivers free text within
  // an open 24h customer-service window, which only stays open as long as
  // Seni keeps texting the business number back — every approval he
  // answered by replying on WhatsApp re-opened it for the next push, so this
  // silently worked for months, then silently broke the first time Seni went
  // 24h+ without texting back (e.g. approving from the dashboard instead).
  // Meta's Graph API still returns 200 + a real message id in that case —
  // there is no error to catch — the message is just never delivered.
  // Fixed by always sending this zero-parameter Meta-approved Utility
  // template FIRST (see sendSessionOpener in whatsapp.ts), which — unlike
  // free text — can reach Seni regardless of session state and reopens the
  // window for the free-text message that immediately follows it. Costs one
  // extra short WhatsApp message per push; that's the trade-off for this
  // class of bug never being able to silently recur again. Optional by
  // design (falls back to the old behavior if unset/not yet approved by
  // Meta) so this doesn't block anything while the template is in review.
  whatsappSessionOpenerTemplate: (process.env.WHATSAPP_SESSION_OPENER_TEMPLATE || "crm_session_opener").trim(),

  // --- WhatsApp — durable fix for approval-ping + daily-report delivery
  // (2026-08-07, corrected same day) ---
  // The crm_session_opener template above was built on a mistaken
  // assumption: sending a template message to Seni does NOT reopen his 24h
  // customer-service window by itself (per Meta's own docs, only a message
  // Seni sends TO the business reopens it) — so the opener-then-free-text
  // pattern never actually fixed the silent-delivery-failure bug it was
  // built for. Confirmed via a live test the same day: texting the business
  // number manually reopened the window and everything worked, which looks
  // like confirmation but isn't proof the opener template itself does
  // anything. The only mechanism that's actually guaranteed to reach Seni
  // regardless of session state is a template message that carries the real
  // content in its own params (same pattern already proven for
  // service_request_alert/vendor_work_order_alert/chat_widget_reply) —
  // these two cover the two channels Seni explicitly said he'd stopped
  // receiving: the per-message guest-reply approval ping, and the daily
  // executive report. Both fall back to the old sendWhatsAppText() behavior
  // (still fine for chat-widget bill-forward confirmations, etc., where a
  // reply is Seni's OWN inbound message and the window is guaranteed open)
  // if the template isn't configured/approved yet, so this ships without
  // breaking anything mid-Meta-review.
  whatsappGuestReplyApprovalTemplate: (process.env.WHATSAPP_GUEST_REPLY_APPROVAL_TEMPLATE || "guest_reply_approval_alert").trim(),
  whatsappDailySummaryTemplate: (process.env.WHATSAPP_DAILY_SUMMARY_TEMPLATE || "daily_summary_alert").trim(),
  whatsappBookingNotificationTemplate: (process.env.WHATSAPP_BOOKING_NOTIFICATION_TEMPLATE || "booking_notification").trim(),
  whatsappAdminReplyNotificationTemplate: (process.env.WHATSAPP_ADMIN_REPLY_NOTIFICATION_TEMPLATE || "admin_reply_notification").trim(),

  // --- WhatsApp — public chat widget answer fallback ---
  // Used only when a website visitor who asked an escalated question has
  // left the site (see lib/chatEscalations.ts) and left a phone number.
  // Requires a Meta-approved template (same reason as Gabriel's above: no
  // open 24-hour session exists with an anonymous visitor's number) — see
  // README's chat widget section for the exact body to submit.
  whatsappChatReplyTemplate: (process.env.WHATSAPP_CHAT_REPLY_TEMPLATE || "chat_widget_reply").trim(),

  // --- WhatsApp — vendor auto-notify on maintenance assignment ---
  // Fires once when a work order (see lib/maintenance.ts) is newly assigned
  // to a vendor who has a WhatsApp-capable phone on file (Vendor.contactPhone
  // in lib/billPay.ts). Unlike Gabriel's number above, there's no single
  // fixed recipient here — the destination is whichever vendor gets
  // assigned — so only a template name is needed, not a number. Requires a
  // Meta-approved template because a vendor's phone has essentially never
  // messaged this WhatsApp number before, so there's no open 24-hour
  // customer-service session to send free text in — same constraint as
  // Gabriel's and the chat-widget's templates above; see README's WhatsApp
  // section for the exact body to submit. Optional — if unset, vendor
  // assignment still works, it just skips the notify step (see
  // lib/maintenanceVendorNotify.ts).
  whatsappVendorNotifyTemplate: (process.env.WHATSAPP_VENDOR_NOTIFY_TEMPLATE || "vendor_work_order_alert").trim(),

  // Vercel sets this automatically on Cron Job invocations — used to reject
  // requests to /api/cron/* that don't come from Vercel's own scheduler.
  cronSecret: (process.env.CRON_SECRET || "").trim(),

  // Guards the one-time bootstrap endpoints (api/admin/migrate,
  // api/admin/seed-user). Separate from CRON_SECRET on purpose — it's not
  // sensitive (created plain, not marked "Sensitive" in Vercel), since
  // Claude generates and needs to hand this value to Seni directly, unlike
  // CRON_SECRET which Vercel itself manages.
  adminSecret: (process.env.ADMIN_SECRET || "").trim(),

  // --- Postgres (CRM foundation — users/roles, approvals, AI activity log,
  // knowledge base) ---
  // Auto-injected by the Vercel/Neon Storage integration once the database is
  // connected to this project. Prefer the pooled URL for normal app queries
  // (many short-lived serverless invocations); the unpooled URL is used only
  // by scripts/migrate.mjs, which needs a plain session connection for DDL.
  databaseUrl: (process.env.DATABASE_URL || "").trim(),

  // Signs the per-user login session cookie (see src/lib/session.ts). A long
  // random string — generated once by this app's setup, never typed or
  // memorized by a person. If unset, per-user login is disabled and the app
  // falls back to the single shared DASHBOARD_PASSWORD only.
  authSecret: (process.env.AUTH_SECRET || "").trim(),

  // --- Revenue Manager (shadow mode) — PriceLabs Customer API ---
  // Self-service key from PriceLabs: Account Settings -> API Details ->
  // Enable -> "I Need API Access". Enabling it adds a real $1/month charge
  // per synced listing on Seni's PriceLabs bill (confirmed 2026-07-30) — this
  // key reads PriceLabs' recommended rates only, for comparison in
  // lib/revenueManager.ts. Nothing in this app ever calls a PriceLabs write
  // endpoint.
  pricelabsApiKey: (process.env.PRICELABS_API_KEY || "").trim(),
  // The PriceLabs listing id for the Legacy Colombia property (the numeric id
  // shown on PriceLabs' Pricing Dashboard, e.g. the "PARENT" row's id). Set
  // this once known — see lib/pricelabs.ts's getListings() to look it up.
  pricelabsListingId: (process.env.PRICELABS_LISTING_ID || "").trim(),
  // How many upcoming days get a real, dense (every single day) OwnerRez
  // quote + AI recommendation in the daily shadow-mode snapshot, before
  // falling back to once-a-week sampling further out — see
  // lib/revenueManager.ts's fullCoverageDates(). Raised from the original
  // "13 scattered Monday-only dates" design (2026-08-04, Seni's ask for full
  // calendar coverage) — configurable in case OwnerRez's API ever pushes
  // back on the higher daily call volume.
  revenueSnapshotDenseDaysAhead: process.env.REVENUE_SNAPSHOT_DENSE_DAYS_AHEAD
    ? Number(process.env.REVENUE_SNAPSHOT_DENSE_DAYS_AHEAD)
    : 60,
  // How far out (in weeks) the once-a-week sparse sampling continues past the
  // dense window above — keeps a full year of directional visibility without
  // needing 365 individual OwnerRez calls a day.
  revenueSnapshotSparseWeeksAhead: process.env.REVENUE_SNAPSHOT_SPARSE_WEEKS_AHEAD
    ? Number(process.env.REVENUE_SNAPSHOT_SPARSE_WEEKS_AHEAD)
    : 52,

  // --- Revenue Manager — auto-apply band (Phase 5c) ---
  // Ships OFF. Setting this to the literal string "true" in Vercel is a
  // deliberate, out-of-band step Seni takes himself (not a dashboard
  // toggle) — see lib/revenueManager.ts's runAutoApplyPass() and
  // db/migrations/0014_rate_override_source.sql's header comment for the
  // full reasoning. Anything other than exactly "true" is treated as off,
  // so a typo'd env var fails safe.
  revenueAutoApplyEnabled: (process.env.REVENUE_AUTO_APPLY_ENABLED || "").trim().toLowerCase() === "true",
  // How close (in percent) the AI recommendation must be to OwnerRez's live
  // quoted rate for a date to qualify for auto-apply — small nudges only,
  // never a large repricing. 5% by default once/if enabled.
  revenueAutoApplyBandPct: process.env.REVENUE_AUTO_APPLY_BAND_PCT
    ? Number(process.env.REVENUE_AUTO_APPLY_BAND_PCT)
    : 5,

  // --- Email (Resend) — daily executive report, second channel alongside
  // WhatsApp ---
  // Free API key from https://resend.com (no domain verification needed to
  // start — their shared onboarding@resend.dev sender works immediately;
  // set REPORT_EMAIL_FROM once a custom domain is verified there).
  resendApiKey: (process.env.RESEND_API_KEY || "").trim(),
  // Where the daily report email goes — Seni's own inbox.
  reportEmailTo: (process.env.REPORT_EMAIL_TO || "").trim(),
  reportEmailFrom: (process.env.REPORT_EMAIL_FROM || "CEO Dashboard <onboarding@resend.dev>").trim(),

  // --- Marketing/SEO — real Search Console + GA4 data (headless, read-only) ---
  // A Google Cloud service account (legacy-crm-analytics project), granted
  // Viewer access directly on ONLY the Legacy Colombia GA4 property and
  // ONLY the legacycolombia.com Search Console property — Seni's Google
  // account has other, unrelated sites/properties on it that this must never
  // touch. Auth is a private-key JWT flow (no OAuth consent screen, no
  // refresh tokens), same shape as PriceLabs'/OwnerRez's API-key clients.
  // Paste the *entire* downloaded JSON key file as one env var value.
  googleServiceAccountKey: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").trim(),
  // Search Console "domain property" identifier, e.g. "sc-domain:legacycolombia.com".
  gscSiteUrl: (process.env.GSC_SITE_URL || "").trim(),
  // GA4 numeric property id (Admin -> Property details), e.g. "540074334".
  // Tracking wasn't actually installed on the site as of 2026-08-02 (Site
  // Kit install deferred — see docs/VISION.md), so GA4 calls below will
  // succeed but return all-zero rows until that's done.
  ga4PropertyId: (process.env.GA4_PROPERTY_ID || "").trim(),

  // --- Stripe (Phase 4 subscription billing) ---
  // Secret key from https://dashboard.stripe.com/apikeys — starts "sk_test_"
  // in test mode, "sk_live_" once Seni switches the account live. Used
  // server-side only (lib/stripe.ts) to create Checkout/Portal sessions and
  // verify webhook signatures. Seni creates the Stripe account and pastes
  // this himself — see the "credential handoff pattern" this app already
  // uses for every other third-party key.
  stripeSecretKey: (process.env.STRIPE_SECRET_KEY || "").trim(),
  // Signing secret for the /api/webhooks/stripe endpoint, from Stripe
  // Dashboard -> Developers -> Webhooks -> (the endpoint) -> Signing secret.
  // Without this, incoming webhook payloads can't be trusted to actually be
  // from Stripe (see api/webhooks/stripe/route.ts).
  stripeWebhookSecret: (process.env.STRIPE_WEBHOOK_SECRET || "").trim(),
  // One Stripe Price id per tier per billing interval — created once in the
  // Stripe Dashboard (Product catalog) or via scripts/create-stripe-prices.mjs
  // (see that script's header for the one-time setup flow). See
  // lib/billing.ts's PRICING_TIERS for the actual dollar amounts each of
  // these should be. There is deliberately no Enterprise price here — 101+
  // properties always routes to the "talk to sales" contact form instead of
  // a self-serve Stripe Checkout (see api/billing/enterprise-contact).
  stripePriceSoloMonthly: (process.env.STRIPE_PRICE_SOLO_MONTHLY || "").trim(),
  stripePriceSoloAnnual: (process.env.STRIPE_PRICE_SOLO_ANNUAL || "").trim(),
  stripePriceStarterMonthly: (process.env.STRIPE_PRICE_STARTER_MONTHLY || "").trim(),
  stripePriceStarterAnnual: (process.env.STRIPE_PRICE_STARTER_ANNUAL || "").trim(),
  stripePriceGrowthMonthly: (process.env.STRIPE_PRICE_GROWTH_MONTHLY || "").trim(),
  stripePriceGrowthAnnual: (process.env.STRIPE_PRICE_GROWTH_ANNUAL || "").trim(),
  stripePriceScaleMonthly: (process.env.STRIPE_PRICE_SCALE_MONTHLY || "").trim(),
  stripePriceScaleAnnual: (process.env.STRIPE_PRICE_SCALE_ANNUAL || "").trim(),
  stripePriceProMonthly: (process.env.STRIPE_PRICE_PRO_MONTHLY || "").trim(),
  stripePriceProAnnual: (process.env.STRIPE_PRICE_PRO_ANNUAL || "").trim(),
  stripePricePortfolioMonthly: (process.env.STRIPE_PRICE_PORTFOLIO_MONTHLY || "").trim(),
  stripePricePortfolioAnnual: (process.env.STRIPE_PRICE_PORTFOLIO_ANNUAL || "").trim(),

  // --- Postiz (Social Media Manager — real posting/scheduling) ---
  // Postiz (postiz.com) is the scheduling layer that lets an approved
  // content_piece actually reach a real Instagram/Facebook/TikTok/etc.
  // account instead of just sitting in this CRM as text to copy-paste. Seni
  // creates the Postiz account and connects his own social accounts himself
  // (same credential-handoff pattern as every other integration here) — this
  // app never sees his social-platform logins, only the resulting Postiz API
  // key. Get the key from Postiz -> Settings -> API (Standard plan or
  // higher). Self-hosted Postiz instances can override postizApiUrl;
  // platform.postiz.com is the default for the hosted SaaS.
  postizApiUrl: (process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1").trim(),
  postizApiKey: (process.env.POSTIZ_API_KEY || "").trim(),
  // Maps this app's channel names (see SocialChannel in lib/types.ts, e.g.
  // "instagram_reel", "facebook", "tiktok") to the Postiz "integration id"
  // for the specific connected account each one should post through. Postiz
  // assigns one integration id per connected social account, visible in
  // Postiz's dashboard or via its GET /integrations endpoint. Set as JSON,
  // e.g. {"instagram_reel":"abc123","facebook":"def456"}. Channels with no
  // entry here simply can't be auto-pushed yet — createCampaignBatch() still
  // drafts them, they just stay CRM-only until Seni connects that account.
  postizChannelMap: (() => {
    try {
      const raw = (process.env.POSTIZ_CHANNEL_MAP || "").trim();
      if (!raw) return {} as Record<string, string>;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {} as Record<string, string>;
    }
  })(),

  // --- Website form capture (Elementor Pro webhook -> marketing_contacts) ---
  // Not a third-party credential — an arbitrary shared secret Claude
  // generated (like ADMIN_SECRET), embedded in the webhook URL Seni pastes
  // into an Elementor form's "Webhook" action (Form settings -> Actions
  // After Submit -> Webhook -> URL:
  // https://crm.legacyestaterentals.com/api/webhooks/website-form?secret=...).
  // Only guards against randoms POSTing junk contacts in — not sensitive
  // enough to mark "Sensitive" in Vercel.
  websiteFormWebhookSecret: (process.env.WEBSITE_FORM_WEBHOOK_SECRET || "").trim(),
};

export function isLiveModeConfigured(): boolean {
  return Boolean(config.ownerRezEmail && config.ownerRezToken);
}

export function isMessagingConfigured(): boolean {
  return Boolean(config.ownerRezOAuthToken);
}

export function isAiReplyConfigured(): boolean {
  return Boolean(config.anthropicApiKey);
}

export function isRedisConfigured(): boolean {
  return Boolean(config.redisUrl);
}

export function isWhatsAppConfigured(): boolean {
  return Boolean(
    config.whatsappAccessToken &&
      config.whatsappPhoneNumberId &&
      config.whatsappRecipientNumber
  );
}

export function isGabrielNotifyConfigured(): boolean {
  return Boolean(
    config.whatsappAccessToken &&
      config.whatsappPhoneNumberId &&
      config.whatsappGabrielNumber &&
      config.whatsappServiceRequestTemplate
  );
}

export function isDbConfigured(): boolean {
  return Boolean(config.databaseUrl);
}

export function isPerUserLoginConfigured(): boolean {
  return Boolean(config.databaseUrl && config.authSecret);
}

export function isPriceLabsConfigured(): boolean {
  return Boolean(config.pricelabsApiKey);
}

export function isEmailConfigured(): boolean {
  return Boolean(config.resendApiKey && config.reportEmailTo);
}

/** Looser than isEmailConfigured() above — that one also requires
 * REPORT_EMAIL_TO (a fixed destination for the daily report). Sending to an
 * arbitrary website visitor's own address only needs the API key itself. */
export function isEmailSendConfigured(): boolean {
  return Boolean(config.resendApiKey);
}

export function isChatReplyTemplateConfigured(): boolean {
  return Boolean(
    config.whatsappAccessToken && config.whatsappPhoneNumberId && config.whatsappChatReplyTemplate
  );
}

export function isVendorNotifyConfigured(): boolean {
  return Boolean(
    config.whatsappAccessToken && config.whatsappPhoneNumberId && config.whatsappVendorNotifyTemplate
  );
}

export function isGuestReplyApprovalTemplateConfigured(): boolean {
  return Boolean(
    config.whatsappAccessToken && config.whatsappPhoneNumberId && config.whatsappGuestReplyApprovalTemplate
  );
}

export function isDailySummaryTemplateConfigured(): boolean {
  return Boolean(
    config.whatsappAccessToken && config.whatsappPhoneNumberId && config.whatsappDailySummaryTemplate
  );
}

export function isSearchAnalyticsConfigured(): boolean {
  return Boolean(config.googleServiceAccountKey && config.gscSiteUrl);
}

export function isGa4Configured(): boolean {
  return Boolean(config.googleServiceAccountKey && config.ga4PropertyId);
}

/** Whether Stripe Checkout/Portal calls can actually be made yet. Guards
 * api/billing/checkout and api/billing/portal — the billing PAGE itself
 * still renders without this (so a not-yet-configured deployment doesn't
 * 500), it just can't create a real session. */
export function isStripeConfigured(): boolean {
  return Boolean(config.stripeSecretKey);
}

/** Whether the Phase 4 hard-lock policy should actually be enforced. False
 * on any deployment where Stripe hasn't been wired up yet (no
 * STRIPE_SECRET_KEY) so this ships without locking out the one real
 * tenant (or any local/dev environment) before Seni has actually created
 * Stripe Prices and pasted the keys in — see lib/billingGate.ts. */
export function isBillingEnforced(): boolean {
  return isStripeConfigured();
}

/** Whether pushPieceToPostiz() (lib/postiz.ts) can make real API calls yet.
 * False until Seni has created a Postiz account and pasted the API key in —
 * see the postizApiKey comment above. Individual channels can still be
 * unpushable even when this is true, if that specific channel isn't in
 * postizChannelMap yet (i.e. Seni hasn't connected that account in Postiz). */
export function isPostizConfigured(): boolean {
  return Boolean(config.postizApiKey);
}
