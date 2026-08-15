# Setting up AI features for your organization

This is a step-by-step guide for a new organization on this CRM. It covers
the two things you can connect yourself, in Settings, to control your own AI
features and (optionally) run them on your own Anthropic billing instead of
the shared platform default:

1. **Your own Anthropic (Claude) API key** — powers every AI feature.
2. **Your own WhatsApp Business API connection** — needed for AI guest-reply
   approvals, the website chat widget's human-in-the-loop escalation, and any
   other feature that texts you for approval.

Both are optional. Every AI feature already works out of the box on the
platform's shared Claude key — do this if you want your own Anthropic
billing, a higher usage cap, or your own WhatsApp number sending the
approval texts instead of the shared one.

Do OwnerRez first if you haven't already (Settings → OwnerRez, or the
onboarding wizard) — every AI feature reads real booking/guest data from
there, so nothing below is useful until that's connected.

---

## What each thing unlocks

| Feature | Needs your own Claude key? | Needs your own WhatsApp? |
|---|---|---|
| AI-drafted guest replies (approved by text) | No — shared key works | **Yes**, to receive/approve drafts |
| EN/ES (and other language) message translation | No — shared key works | No |
| AI review-response drafting (Reputation tab) | No — shared key works | No (approval happens in-app) |
| AI rate recommendations (Revenue Management tab) | No — shared key works | No |
| AI lifecycle marketing message drafts | No — shared key works | No |
| AI content/SEO drafts (Marketing tab) | No — shared key works | No |
| Website AI chat widget (public-facing) | No — shared key works | Optional, for the "text a human" escalation path |
| AI COO daily briefing | No — shared key works | No |
| Bill/invoice photo extraction | No — shared key works | **Yes**, since bills are forwarded as WhatsApp photos |

So: adding your own Claude key changes *whose account gets billed*, not
*what works*. Adding your own WhatsApp connection is what actually turns on
guest-reply approvals and bill-photo forwarding.

---

## Step 1 — Add your own Anthropic (Claude) API key (optional)

1. Go to **console.anthropic.com/settings/keys** and sign in (or create an
   Anthropic account if you don't have one).
2. Click **Create Key**, give it any name (e.g. "CRM"), and copy the key —
   it starts with `sk-ant-`.
3. Add a little prepaid credit to the account (Anthropic Console →
   **Billing**) — $5–10 is plenty to start; AI replies, translations, etc.
   cost a fraction of a cent each.
4. In this CRM, go to **Settings → AI (Claude)**, paste the key into
   **Anthropic API key**, and click **Save**.

That's it — every AI feature in the table above immediately starts running
on your key and your billing instead of the shared default. Leave it blank
at any time to fall back to the shared key again.

---

## Step 2 — Set up WhatsApp Business API (optional, needed for guest-reply approvals)

This is Meta's setup process, not ours — it takes about 15–20 minutes the
first time. You'll end up with four values to paste into **Settings →
WhatsApp (Meta Cloud API)**.

1. Go to **developers.facebook.com** → **My Apps** → **Create App** → choose
   the **Business** app type → give it any name.
2. On the app's dashboard, find **WhatsApp** in the product list and click
   **Set up**.
3. You're now on the WhatsApp **API Setup** page. Note two values shown
   there — you'll need them in step 6:
   - **Phone number ID**
   - **WhatsApp Business Account ID**
4. Under **From**, either use the free test number Meta gives you (fine for
   trying things out) or click **Add phone number** to register a real
   number you own — a dedicated number is best, since this is the number
   that will text you every AI draft for approval.
5. Generate a permanent access token (the free test number's default token
   expires in 24 hours, which will break things — don't use that one):
   - Go to **Business Settings** (business.facebook.com/settings) → **Users
     → System Users** → **Add** → name it anything (e.g. "CRM Bot") → role
     **Admin**.
   - Click **Add Assets**, select your app under **Apps**, and give it
     **Full control**.
   - Click **Generate New Token**, select your app, check
     **whatsapp_business_messaging** and **whatsapp_business_management**,
     and click **Generate Token**.
   - Copy the token immediately — Meta only shows it once.
6. In this CRM, go to **Settings → WhatsApp (Meta Cloud API)** and paste in:
   - **System User access token** — from step 5
   - **Phone Number ID** — from step 3
   - **Business Account ID** — from step 3
   - **Your WhatsApp number (E.164, no +)** — the personal number that
     should receive approval texts, e.g. `15551234567`
7. Pick a **Verify Token** — any random string you make up yourself (think
   of it like a password). You'll enter it in two places: contact us so we
   can set `whatsapp_verify_token` on your organization to match, and in
   step 8 below.
8. Back in the Meta app, go to **WhatsApp → Configuration**, click **Edit**
   next to Webhook, and set:
   - **Callback URL**: `https://<your-crm-domain>/api/whatsapp/webhook`
   - **Verify token**: the exact string from step 7
   - Click **Verify and Save**, then click **Manage** and subscribe to the
     **messages** field.
9. Send a WhatsApp message to your new business number from your own phone
   to confirm the webhook is live — ask us to check the logs if you're not
   sure it worked.

Once this is done, new guest messages will start texting you AI-drafted
replies to approve, and any bill/invoice photo you forward to that number
will get scanned into the Bill Pay tab automatically.

**Reply protocol** (same for every AI approval text you get, whichever
feature it's from):
- `YES` — sends the drafted reply exactly as-is
- `NO` — discards it, nothing is sent
- `EDIT: <your text>` — sends your own text instead of the draft

If more than one approval is waiting at once, swipe-to-reply on the specific
WhatsApp message you're answering so it knows which one you mean.

---

## Step 3 (optional, advanced) — Approve extra message templates

A couple of *outbound, business-initiated* WhatsApp messages (ones that open
a brand-new conversation rather than replying inside a 24-hour guest
conversation window) require a Meta-preapproved template rather than free
text — this is a WhatsApp platform rule, not something we control. You only
need these if you use the specific features below; everything else in this
guide works without them.

- **Property-manager auto-notify on service requests** (if a teammate should
  get pinged automatically whenever a guest asks about a paid add-on like a
  private chef or boat rental): create a **Utility**-category template named
  `service_request_alert` at **business.facebook.com/latest/whatsapp_manager/message_templates**,
  with body text using Meta's `{{1}}`–`{{4}}` variables, e.g.:
  > New service request at {{1}}. Guest: {{2}}, WhatsApp: {{3}}. They're
  > asking about: {{4}}. Please reach out and coordinate.
- **Chat widget phone fallback** (texting a website visitor's own phone if
  they leave before your reply is ready): create a **Utility** template
  named `chat_widget_reply` with `{{1}}`/`{{2}}` variables, e.g.:
  > Hi {{1}}, thanks for reaching out! Here's the answer to your question:
  > {{2}}

Submit either for review inside Meta's template manager — usually approved
within minutes to a couple hours. Let us know once approved so we can wire
the template name into your organization's settings.

---

## Troubleshooting

- **Not getting any WhatsApp texts at all**: double check the four WhatsApp
  values in Settings are saved, and that the webhook in Meta shows as
  "Active" with a green dot under WhatsApp → Configuration.
- **Translation/AI drafting says "not configured"**: means neither your own
  key nor the shared platform key is reachable — let us know, this usually
  means the shared key ran out of credit rather than anything on your end.
- **A WhatsApp reply of `YES`/`NO`/`EDIT:` didn't do anything**: the
  approval it was answering may have already expired or been superseded by
  a newer guest message — check the Messaging tab in the CRM for the
  current state of that conversation.
