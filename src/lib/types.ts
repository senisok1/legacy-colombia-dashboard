// Shared types for the OwnerRez dashboard/CRM.
// These normalize OwnerRez's raw API fields into a stable shape our UI relies on.
// If your OwnerRez account returns slightly different field names for any of these
// resources, adjust the `normalize*` functions in lib/ownerrez.ts — the rest of the
// app only ever touches these normalized types.

export type Property = {
  id: number;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  active: boolean;
  raw?: unknown;
};

export type BookingStatus =
  | "Inquiry"
  | "Quote"
  | "Hold"
  | "Booked"
  | "Cancelled"
  | "Checked In"
  | "Checked Out"
  | "Unknown";

export type Booking = {
  id: number;
  propertyId: number;
  propertyName?: string;
  guestId: number | null;
  guestName?: string;
  arrival: string; // ISO date
  departure: string; // ISO date
  nights: number;
  status: BookingStatus;
  source: string; // Airbnb, Vrbo, Booking.com, Direct, etc.
  adults: number;
  children: number;
  totalAmount: number;
  hostFee?: number;
  payoutAmount?: number;
  createdAt?: string;
  updatedAt?: string;
  // True for calendar blocks / channel-imported "not available" placeholders
  // (e.g. an Airbnb iCal sync marking dates unavailable) rather than an
  // actual guest reservation. These still occupy the calendar but have no
  // guest, revenue, or CRM value attached.
  isBlock: boolean;
  // OwnerRez message-thread IDs tied to this booking. Empty for inquiries/blocks
  // that never opened a conversation thread. The first entry is the one to
  // reply on for most bookings.
  threadIds: number[];
  raw?: unknown;
};

export type Guest = {
  id: number;
  firstName: string;
  lastName: string;
  fullName: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  country?: string;
  raw?: unknown;
};

export type GuestWithStats = Guest & {
  bookings: Booking[];
  totalStays: number;
  totalNights: number;
  lifetimeValue: number;
  firstStay?: string;
  lastStay?: string;
  isRepeat: boolean;
  notes: string;
  tags: string[];
};

export type Review = {
  id: number;
  bookingId?: number;
  propertyId?: number;
  guestName?: string;
  source: string;
  rating?: number;
  comment?: string;
  hostResponse?: string; // set once Seni/Reputation Manager has already replied on the OTA
  visible?: boolean; // OwnerRez's own public/private flag for this review
  createdAt?: string;
  raw?: unknown;
};

export type MessageTemplate = {
  id: string;
  name: string;
  trigger: "manual" | "pre_arrival" | "check_in" | "post_stay_review";
  daysOffset: number; // e.g. -3 for 3 days before arrival, 1 for 1 day after departure
  subject: string;
  bodyEn: string;
  bodyEs: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MessageLogEntry = {
  id: string;
  bookingId: number;
  guestId: number | null;
  guestName?: string;
  templateId?: string;
  templateName?: string;
  language: "en" | "es";
  subject: string;
  body: string;
  status: "draft" | "sent" | "failed";
  createdAt: string;
};

export type CrmGuestRecord = {
  guestId: number;
  notes: string;
  tags: string[];
  updatedAt: string;
};

// ---------- Bill Pay + Vendor management (Phase 4, tracking/detection only) ----------
// See db/migrations/0002_bill_pay.sql and lib/billPay.ts. Deliberately no
// "paid_by_ai" or similar status — this system never moves money; Seni pays
// vendors himself and marks a bill "paid_manually" here purely for records.

export type Vendor = {
  id: string;
  name: string;
  category?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  // Free-text context only, never used programmatically to send money — see
  // the migration's comment on this column.
  paymentNotes?: string;
  defaultPropertyId?: string;
  notes?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BillStatus =
  | "pending_review"
  | "flagged_duplicate"
  | "flagged_anomaly"
  | "approved_for_payment"
  | "paid_manually"
  | "rejected";

export type Bill = {
  id: string;
  vendorId: string;
  vendorName?: string; // joined in for display, not stored on the row
  propertyId?: string;
  invoiceNumber?: string;
  amountCents: number;
  currency: string;
  category?: string;
  invoiceDate?: string; // ISO date
  dueDate?: string; // ISO date
  source: "manual" | "email" | "whatsapp" | "upload";
  sourceReference?: string;
  attachmentUrl?: string;
  status: BillStatus;
  duplicateOfBillId?: string;
  flagReason?: string;
  confidenceScore?: number;
  reviewedById?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  createdAt: string;
  updatedAt: string;
};

// ---------- Sales Pipeline (Phase 6, tracking/prioritization only) ----------
// See db/migrations/0004_sales_pipeline.sql and lib/leads.ts. Stages match
// VISION.md's Sales Agent spec exactly. Nothing here sends a guest-facing
// message or promises a date/discount on its own — it's a board for Seni (or
// a future Sales Agent, once one exists) to work from.

export type LeadStage = "new" | "contacted" | "qualified" | "proposal" | "deposit" | "booked" | "lost" | "nurture";

export type Lead = {
  id: string;
  guestId?: number; // OwnerRez guest id, once one exists — see the migration's comment
  bookingId?: number; // OwnerRez booking id, once one exists (e.g. an Inquiry/Quote)
  propertyId?: string;
  guestName: string;
  contactEmail?: string;
  contactPhone?: string;
  source: string; // free text: "WhatsApp", "Instagram DM", "OwnerRez inquiry", "Referral", "Phone", etc.
  stage: LeadStage;
  desiredArrival?: string; // ISO date
  desiredDeparture?: string; // ISO date
  partySize?: number;
  estimatedValueCents?: number;
  notes?: string;
  nextAction?: string;
  nextActionDueAt?: string;
  lastContactedAt?: string;
  lostReason?: string; // only meaningful when stage === "lost"
  createdAt: string;
  updatedAt: string;
};

// ---------- Maintenance (Phase 3 gap) ----------
// See db/migrations/0007_maintenance.sql and lib/maintenance.ts. Tracks every
// reported issue — guest-flagged via the existing service-request detection
// (lib/serviceRequestNotify.ts) or manually logged by Seni — through a real
// open -> in_progress/blocked -> resolved/cancelled lifecycle. Replaces the
// old "notify Gabriel and forget" behavior with persistent tracking.

export type WorkOrderStatus = "open" | "in_progress" | "blocked" | "resolved" | "cancelled";
export type WorkOrderPriority = "low" | "normal" | "urgent" | "emergency";

export type WorkOrder = {
  id: string;
  propertyId?: string;
  guestId?: number; // OwnerRez guest id, when this came from a guest report
  bookingId?: number;
  threadId?: number; // OwnerRez message thread this was reported in, if any
  title: string;
  description?: string;
  category?: string; // free text: plumbing, electrical, pool, appliance, pest, hvac, other, ...
  source: string; // "guest_message", "manual", "inspection", "vendor", etc.
  reportedBy?: string;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  assignedVendorId?: string;
  assignedVendorName?: string; // joined in for display, not stored on the row
  costCents?: number; // record-keeping only, filled in on resolution — never a payment instruction
  rootCause?: string;
  resolutionNotes?: string;
  gabrielNotifiedAt?: string;
  vendorNotifiedAt?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
};

// ---------- CRM & Lifecycle Marketing (Phase 6, second half) ----------
// See db/migrations/0005_lifecycle_campaigns.sql and lib/lifecycleMarketing.ts.
// Outbound/proactive re-engagement, as opposed to Sales Pipeline's inbound
// leads. Every candidate starts at 'candidate' and nothing is ever sent
// without an explicit approval click — see that file's header comment.

export type LifecycleCampaignType = "win_back" | "referral" | "abandoned_booking" | "review_request";

export type LifecycleCampaignStatus = "candidate" | "approved" | "sent" | "skipped" | "failed" | "opted_out";

export type LifecycleCampaignCandidate = {
  id: string;
  campaignType: LifecycleCampaignType;
  guestId?: number;
  guestName: string;
  guestEmail?: string;
  guestPhone?: string;
  bookingId?: number;
  threadId?: number;
  triggerReason: string;
  draftMessage: string;
  draftMessageEnglish?: string;
  language?: string;
  status: LifecycleCampaignStatus;
  sendError?: string;
  sentAt?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
};

// ---------- Marketing, social & SEO content (Phase 7, drafting/review) ----------
// See db/migrations/0006_marketing_content.sql and lib/contentMarketing.ts.
// Standalone content_pieces (idea/blog/email etc.) are still draft-only —
// Seni reviews and posts those himself. Pieces that belong to a
// content_campaign (Phase 7b, Social Media Manager) can additionally be
// pushed to Postiz once configured (see lib/postiz.ts + isPostizConfigured())
// so approving them in the CRM is the only action needed before they go live
// on the real social account. See db/migrations/0020_content_campaigns.sql.

export type ContentPieceType = "blog" | "social" | "email";
export type ContentPieceStatus = "idea" | "draft" | "approved" | "published_externally" | "archived";

// The specific social channels the Social Media Manager drafts for. Stored
// in content_pieces.channel (free text) alongside contentType: "social" —
// no separate enum/column needed. Kept as a union here purely so
// lib/contentMarketing.ts can give each one its own voice instructions.
export type SocialChannel =
  | "instagram_reel"
  | "tiktok"
  | "facebook"
  | "x"
  | "linkedin"
  | "pinterest"
  | "youtube_short"
  | "substack";

export type ContentPiece = {
  id: string;
  contentType: ContentPieceType;
  topic: string;
  channel?: string;
  targetKeyword?: string;
  body?: string;
  metaDescription?: string;
  seoNotes?: string;
  propertyId?: string;
  status: ContentPieceStatus;
  createdAt: string;
  updatedAt: string;
  campaignId?: string;
  mediaUrl?: string;
  postizPostId?: string;
  scheduledAt?: string;
};

export type ContentCampaignStatus = "draft" | "generating" | "ready_for_review" | "approved" | "archived";

// One weekly batch: a single pillar asset (a video, photo set, or theme)
// repurposed into one content_piece per channel. See createCampaignBatch()
// in lib/contentMarketing.ts.
export type ContentCampaign = {
  id: string;
  pillarAssetDescription: string;
  pillarAssetMediaUrl?: string;
  status: ContentCampaignStatus;
  createdAt: string;
  updatedAt: string;
};

// A single message inside an OwnerRez conversation thread (guest <-> host).
// OwnerRez's GET /v2/messages response shape isn't fully documented publicly,
// so lib/ownerrez.ts's normalizer reads several plausible field-name variants
// defensively, same approach as the other normalizers in that file.
export type ThreadMessage = {
  id: number;
  threadId: number;
  body: string;
  // True if this message came from the guest (i.e. something we might want
  // to draft an AI reply to). False for anything host-authored (owner,
  // co_host, or an automated system message) — those are used as style
  // examples instead, never as something to reply to.
  isGuest: boolean;
  fromRole: string;
  sentAt?: string;
  raw?: unknown;
};

export type ConnectionStatus = {
  configured: boolean;
  demoMode: boolean;
  propertyName: string;
  lastError?: string;
};

// An AI-drafted reply to an inbound guest message, awaiting Seni's approval
// over WhatsApp before it's pushed into OwnerRez. Lives in Redis (see
// lib/pendingDrafts.ts) since it needs to survive across serverless
// invocations — the cron job that creates it and the webhook that approves
// it run as separate function calls, possibly minutes apart.
export type PendingDraft = {
  id: string; // short id, referenced in the WhatsApp approval message
  threadId: number;
  bookingId: number;
  guestId: number | null;
  guestName?: string;
  guestMessage: string; // the inbound message this is replying to, in the guest's own language
  draftReply: string; // the AI-drafted reply text, in the guest's own language — this is what actually gets sent on approval
  // Human-readable name of the language guestMessage/draftReply are written
  // in (e.g. "Spanish"), plus English translations of both — shown in the
  // dashboard Inbox and in the WhatsApp approval text, since Seni only reads
  // English. Optional because older drafts created before this field existed
  // won't have it.
  language?: string;
  guestMessageEnglish?: string;
  replyEnglish?: string;
  // True when the guest is asking about a paid add-on experience (private
  // chef, massage, jet ski, boat/pontoon rental, cold plunge, transportation,
  // etc.) — see lib/aiReply.ts. Drives two things: surfacing the guest's
  // WhatsApp number to Seni in the approval message, and auto-notifying
  // Gabriel (the on-site property manager) once Seni approves the reply.
  isServiceRequest?: boolean;
  // The guest's WhatsApp/phone number, resolved from OwnerRez guest data at
  // draft-creation time (see lib/guestName.ts's resolveGuestPhone). Only
  // populated when isServiceRequest is true, to keep the field meaningful —
  // absent/undefined means "not looked up" or "not on file", not "no phone".
  guestPhone?: string;
  // Set once this draft's approval request has actually been texted to
  // Seni's WhatsApp (see lib/whatsapp.ts's sendWhatsAppText) — lets the cron
  // poll and the dashboard Inbox share one draft per thread without either
  // one re-drafting or re-notifying if the other already handled it.
  wamid?: string;
  // "superseded" is set automatically (never by Seni) when a newer draft is
  // created for the same thread before this one was ever resolved — see
  // createPendingDraft in pendingDrafts.ts. Distinct from "rejected" (Seni
  // actively discarded it) since nobody made a decision here; the guest just
  // said something new before this got answered.
  status: "pending" | "approved" | "sent" | "rejected" | "failed" | "superseded";
  createdAt: string;
  resolvedAt?: string;
};

// ---------- Reputation Manager (Agent #9) ----------
// See db/migrations/0008_reputation.sql and lib/reputationManager.ts. Reviews
// themselves always come live from OwnerRez (lib/ownerrez.ts's getReviews());
// only the AI-drafted response and Seni's decision are stored here. "approved"
// means "ready for Seni to copy into OwnerRez himself" — OwnerRez's API has
// no write endpoint for reviews, so this app can never post one automatically.

export type ReputationResponseStatus = "pending_review" | "approved" | "rejected" | "posted";

export type ReputationResponse = {
  id: string;
  propertyId?: string;
  reviewId: number;
  reviewSource: string;
  reviewRating?: number;
  guestName?: string;
  reviewCreatedAt?: string;
  reviewComment?: string;
  draftText: string;
  status: ReputationResponseStatus;
  decidedAt?: string;
  postedAt?: string;
  createdAt: string;
  updatedAt: string;
};

// A live OwnerRez review joined with its drafted/decided response (if any) —
// the shape the Reputation tab actually renders. `response` is undefined for
// a review that hasn't been scanned/drafted yet.
export type ReputationEntry = {
  review: Review;
  response?: ReputationResponse;
};

// ---------- Public chat-widget escalations ----------
// See db/migrations/0011_chat_widget.sql and lib/chatEscalations.ts. Created
// when an anonymous website visitor asks something lib/chatWidget.ts's
// answerVisitorQuestion() can't confidently answer. Seni approves (as-is or
// edited) or rejects over WhatsApp, same YES/NO/EDIT: convention as the
// guest-reply approval flow (see lib/pendingDrafts.ts's PendingDraft).
// Answered rows double as a growing FAQ: recent ones are fed back into
// answerVisitorQuestion()'s prompt so similar future questions don't need to
// escalate again.

export type ChatEscalationStatus = "pending" | "answered" | "rejected";

// "website" (default): came from the anonymous chat-widget on the site — see
// db/migrations/0011_chat_widget.sql. "whatsapp": came from someone messaging
// the property's WhatsApp number directly (e.g. the Google Business
// Profile's "Message" button) — see db/migrations/0012_whatsapp_inquiries.sql
// and the webhook's handlePublicWhatsAppInquiry. Determines how the approved
// answer actually gets delivered — see resolveChatEscalation callers.
export type ChatEscalationSource = "website" | "whatsapp";

export type ChatEscalation = {
  id: string;
  question: string;
  conversationSummary?: string;
  visitorName: string;
  visitorEmail?: string;
  visitorPhone?: string;
  source: ChatEscalationSource;
  // Best-guess answer Claude drafts at escalation time for Seni to
  // approve/edit — deliberately more complete/assumptive than the cautious,
  // hedged reply the visitor already saw in the widget (see
  // lib/chatWidget.ts's draftEscalationAnswerForApproval).
  aiDraftAnswer?: string;
  status: ChatEscalationStatus;
  // What actually gets delivered to the visitor: aiDraftAnswer verbatim on
  // "YES", or Seni's own wording after "EDIT: ...". Unset while pending or
  // if rejected.
  finalAnswer?: string;
  // WhatsApp message id of the approval request texted to Seni — lets him
  // swipe-to-reply to disambiguate which escalation he's answering, same as
  // PendingDraft.wamid.
  wamid?: string;
  // True once the widget itself has picked up and shown finalAnswer live
  // (visitor was still on the page) — prevents the fallback sweep from also
  // emailing/texting them.
  deliveredViaWidget: boolean;
  // Set by a page-unload beacon (see api/public/chat-widget/leave) so the
  // fallback sweep can fire right away instead of waiting the full timeout
  // when a visitor visibly navigates away or closes the tab.
  visitorLeftAt?: string;
  fallbackSentAt?: string;
  fallbackChannel?: string; // "email" | "whatsapp" | "email+whatsapp"
  createdAt: string;
  answeredAt?: string;
};
