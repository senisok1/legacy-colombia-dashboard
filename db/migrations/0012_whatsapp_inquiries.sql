-- Extends chat_escalations (see 0011_chat_widget.sql) to also cover public
-- inquiries that arrive directly over WhatsApp — e.g. someone clicking the
-- "Message" button on Legacy Colombia's Google Business Profile, which opens
-- a WhatsApp chat to the property's business number — rather than only
-- anonymous website-widget visitors. Seni asked for these to go through the
-- exact same AI-draft + YES/NO/EDIT: approval pathway as chat-widget
-- escalations (see lib/chatWidget.ts's draftEscalationAnswerForApproval and
-- the webhook's handleEscalationReply), so this reuses the table wholesale
-- rather than creating a parallel one.
--
-- 'source' distinguishes the two origins so the webhook knows how to deliver
-- the final answer once Seni approves it:
--   - 'website' (default, for every existing row): delivery is via the
--     widget's live poll, or the check-messages cron's template-based
--     WhatsApp/email fallback if the visitor already left — see
--     getChatEscalationsNeedingFallback. Required because there's no open
--     24-hour customer-service window with an anonymous visitor's number.
--   - 'whatsapp': the visitor messaged this WhatsApp number directly, so
--     that 24-hour window is already open — the webhook can deliver the
--     approved answer immediately as a free-text reply straight back to
--     them (see lib/whatsapp.ts's sendWhatsAppTextTo), no template or
--     fallback sweep needed.
--
-- Applied via GET /api/admin/migrate?secret=... (see that route's comment).

alter table chat_escalations
  add column if not exists source text not null default 'website'
    check (source in ('website', 'whatsapp'));

-- Used by the webhook to check whether a given WhatsApp number already has
-- an open, unresolved inquiry before creating a second one — avoids paging
-- Seni again for every follow-up message a visitor sends while waiting on
-- his first answer.
create index if not exists chat_escalations_whatsapp_pending_idx
  on chat_escalations (visitor_phone)
  where source = 'whatsapp' and status = 'pending';
