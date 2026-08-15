# Legacy Colombia Dashboard & CRM

A local web app that connects to your OwnerRez account (via OwnerRez's official
API — not screen-scraping) and gives you a booking dashboard, a guest CRM,
automated-messaging templates with EN/ES translation, and financial reporting
for **Legacy Colombia**, all in one place. Runs on your Mac; nothing leaves
your computer except direct calls to the OwnerRez API (and, optionally,
Anthropic's API for translation).

## What's included

- **Dashboard** — who's checked in right now, upcoming arrivals, a monthly
  occupancy calendar, and revenue at a glance.
- **Guests / CRM** — every guest who's booked, merged across channels, with
  lifetime value, stay history, repeat-guest flagging, and your own private
  notes/tags per guest.
- **Messaging** — pre-arrival, check-in, and post-stay-review templates that
  auto-surface when they're due, with one-click English ⇄ Spanish translation
  and a sent-message log.
- **Reports** — monthly revenue, revenue by channel (Airbnb/Vrbo/Direct/etc.),
  occupancy rate, and cancellation rate, computed straight from your booking
  data.

## Quick start (no Terminal needed)

Double-click **"Start Dashboard.command"** in this folder — it installs
everything it needs the first time, starts the app, and opens your browser
automatically. See below for connecting your real OwnerRez account and
publishing it online.

## 1. First run (demo mode)

You can try the whole app right now, before connecting any real account —
it ships with realistic sample data for a demo "Legacy Colombia" property.

```bash
npm install
npm run dev
```

Then open **http://localhost:3000**. You'll see a yellow "Demo mode" banner
at the top — that's expected until you connect your real OwnerRez account
(step 2 below).

## 2. Connect your real OwnerRez account

1. Copy the env template: `cp .env.local.example .env.local`
2. Log in to OwnerRez → click your name (top right) → **My Account → API** →
   generate a **Personal Access Token** (starts with `pt_`).
3. Open `.env.local` and fill in:
   - `OWNERREZ_EMAIL` — the email you log in to OwnerRez with
   - `OWNERREZ_TOKEN` — the token you just generated
   - `OWNERREZ_PROPERTY_NAME` — should already say `Legacy Colombia`; change
     it only if that's not the exact (or close) name of the listing in your
     OwnerRez account
4. Restart the dev server (`npm run dev` again). The banner should turn green
   and show "Connected. Using property...".

If it shows a red connection error instead, it'll tell you exactly what went
wrong (e.g. no property matched — it'll list the property names it found in
your account so you can correct `OWNERREZ_PROPERTY_NAME`, or set
`OWNERREZ_PROPERTY_ID` directly).

**Only Legacy Colombia is wired up for now**, as requested — the dashboard
intentionally scopes every query to this one property, even if you have
others in your OwnerRez account. If you want to add another property later,
that's a small change (a property picker instead of a fixed name) — just ask.

## 3. Enable automated messaging (optional, needs OwnerRez's approval)

The Messaging tab drafts and logs messages for you, and you can always copy
the text and send it manually from OwnerRez's own message center or the
guest's Airbnb/Vrbo inbox — that works today, no extra setup.

To send messages *directly through this app*, OwnerRez requires a signed
Messaging API agreement. To request it: email **help@ownerrez.com** with the
subject line **"Messaging API Access"**. Once granted, let me know and I'll
wire up direct sending instead of the copy/paste flow.

## 4. Enable translation (optional)

The EN ⇄ ES buttons on the Messaging page use Claude to translate guest
messages. To enable it:

1. Get an API key at https://console.anthropic.com/settings/keys
2. Add `ANTHROPIC_API_KEY=sk-ant-...` to `.env.local`
3. Restart the dev server

Without a key, translation buttons show a clear "not configured" message
instead of failing silently — everything else in the app works fine without
it.

## 5. Publish it online (optional)

Want a real website link instead of running this on your Mac? Double-click
**"Publish Online.command"** in this folder — it publishes the app to
[Vercel](https://vercel.com) (free hosting, no credit card required) and
prints a live `https://...` link at the end.

After the first publish, two things need to happen on Vercel's website
(vercel.com/dashboard → your project → **Settings → Environment Variables**),
both just filling in text boxes:

1. Add the same values from your `.env.local` — `OWNERREZ_EMAIL`,
   `OWNERREZ_TOKEN`, `OWNERREZ_PROPERTY_NAME`, and `ANTHROPIC_API_KEY` if
   you're using translation.
2. Add `DASHBOARD_PASSWORD` set to a password of your choosing — this is
   what puts a login screen in front of the whole site so strangers with
   the link can't see your guest data or revenue.

Then trigger one redeploy (Vercel dashboard → **Deployments** tab → "..."
menu on the latest one → **Redeploy**) so those values take effect.

**Heads up about the hosted version:** guest notes/tags, message templates,
and the sent-message log won't reliably persist once deployed (Vercel's
free tier doesn't include permanent file storage) — those features will
still work in the moment, they just may not remember data between visits.
Everything from OwnerRez itself (bookings, guests, revenue) is unaffected,
since that's always fetched live. If you want the notes/templates to stick
permanently, that needs a small hosted database added on top — just ask.

## 6. AI-drafted guest replies, approved over WhatsApp

Every few minutes, the app checks every OwnerRez conversation thread for new
inbound guest messages. When one shows up, Claude drafts a reply — grounded
in the property facts in `src/lib/propertyFacts.ts` and a sample of your own
past host-authored messages in that OwnerRez inbox (for tone/style) — and
texts you the draft on WhatsApp for approval. Nothing goes to a guest until
you say so.

**Reply to the WhatsApp message with:**
- `YES` — sends the drafted reply exactly as-is
- `NO` — discards it, nothing is sent
- `EDIT: <your text>` — sends *your* text instead of the draft (edit freely)

Anything else (a plain text with none of these) is **not** sent to the
guest — you'll get a note back explaining the three options instead. This is
deliberate: it used to be that any plain reply was treated as an edit and
sent verbatim, which meant an unrelated text to this number (e.g. while
testing something else) could get delivered to a real guest if a draft
happened to be pending. Requiring `EDIT:` means only a message you clearly
meant as a guest reply ever goes out.

If you have more than one guest conversation waiting on approval at once,
swipe-to-reply on the specific WhatsApp message you're answering so it knows
which one you mean; a plain reply with no swipe falls back to the oldest
still-pending one.

This needs several things set up (see `.env.local.example` for the full
list): an `ANTHROPIC_API_KEY` with credits, a WhatsApp Business (Meta Cloud
API) connection (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_RECIPIENT_NUMBER`,
`WHATSAPP_VERIFY_TOKEN`), a Redis database connected via Vercel's Storage
tab (`REDIS_URL`, auto-injected once connected), and OwnerRez messaging
already connected (step 3 above).

**Why polling instead of a webhook:** OwnerRez doesn't offer a "new message"
webhook, so the app checks on a schedule instead — `/api/cron/check-messages`.
Vercel's free plan only allows a cron to run once a day, which isn't fast
enough to be useful, so the frequent checks are driven by a free external
scheduler (cron-job.org) hitting that URL with the `CRON_SECRET` you set as
a bearer token — Vercel's own once-daily cron in `vercel.json` is just a
backstop in case the external one ever stops. cron-job.org's free plan tops
out at once-per-minute (no sub-minute option); set the schedule there to
every 1 minute for the fastest possible WhatsApp approval alert (average
~30s delay, worst case ~60s) — the route's message-fetch step is
parallelized (see its comments) specifically so a run comfortably finishes
well inside that 1-minute window even with 150+ threads.

### Service requests: pricing-aware replies + auto-notify Gabriel

When a guest asks about a paid add-on experience (private chef, in-home
massage, jet ski, boat/pontoon rental, cold plunge, transportation, etc.),
the drafted reply quotes the specific price from `src/lib/propertyFacts.ts`'s
"Enhance Your Stay" menu and lets the guest know you'll loop in Gabriel to
coordinate. Two things happen automatically for these:

1. The WhatsApp approval text you get, and the suggestion card in the
   dashboard Inbox, both show the guest's WhatsApp number right up top
   (pulled from their OwnerRez guest record) so you can copy/paste it
   straight into a group if you want to.
2. The moment you approve the reply (from either WhatsApp or the dashboard),
   Gabriel gets a WhatsApp message telling him the guest's name, number, and
   what they asked about, so he can create a group with the guest and you to
   handle the actual booking.

Step 2 requires two things you set up once:

- `WHATSAPP_GABRIEL_NUMBER` — Gabriel's WhatsApp number, E.164 no `+`
  (e.g. `573207507474`).
- One Meta-approved message template. Gabriel's number has no open
  24-hour session with your WhatsApp number, so the *first* message to him
  has to go through an approved template rather than free text (same Meta
  rule that governs any business-initiated WhatsApp message). To create it:
  1. Meta Business Manager → WhatsApp Manager → your account → **Message
     Templates** → **Create Template**.
  2. Name: `service_request_alert` (or anything — just match it in
     `WHATSAPP_SERVICE_REQUEST_TEMPLATE` if you pick something else).
     Category: **Utility**. Language: **English (US)**.
  3. Body text, using Meta's `{{1}}`–`{{4}}` variables exactly like this:
     > New service request at {{1}}. Guest: {{2}}, WhatsApp: {{3}}. They're
     > asking about: {{4}}. Please reach out and set up a WhatsApp group
     > with the guest and Seni to help coordinate everything.
  4. Submit for review — Meta typically approves utility templates like this
     within minutes to a couple hours. Once it's approved, set
     `WHATSAPP_GABRIEL_NUMBER` (and `WHATSAPP_SERVICE_REQUEST_TEMPLATE` if
     you didn't use the default name) and redeploy.

Until that template is approved and both env vars are set, the pricing-aware
replies still work fine — you just won't get the Gabriel auto-notify, and
your own WhatsApp confirmation will say so.

## 7. Public AI chat widget (for legacycolombia.com)

A floating "Chat Live" bubble anonymous website visitors can use to ask
questions about the property — answered instantly by Claude, grounded in
`src/lib/propertyFacts.ts` plus every question Seni has personally answered
before (see "Learned answers" below, so the widget gets smarter over time).

If a question can't be confidently answered, the widget asks the visitor for
their name, email, and phone, then:

1. Drafts a fuller best-guess answer with Claude (a separate, more
   assumptive prompt than the cautious one used for direct answers — see
   `draftEscalationAnswerForApproval` in `src/lib/chatWidget.ts` — since this
   one always goes through Seni's approval first, it's fine to take a real
   swing at a complete answer).
2. Texts Seni on WhatsApp with the question and the suggested answer — same
   `YES` / `NO` / `EDIT: <your answer>` protocol already used for guest-reply
   approvals (section 6), so he can approve, correct, or reject it right
   from his own WhatsApp app, whichever pending item (a guest reply or a
   website question) he's replying to.
3. **Delivers the answer live if the visitor is still there.** The widget
   polls every few seconds after escalating; the moment Seni replies `YES`
   or `EDIT:`, it shows up right in their chat panel — no page refresh
   needed.
4. **Falls back to email + WhatsApp text if they've left.** If the visitor
   closes the tab (a `pagehide`/`beforeunload` beacon tells the server right
   away) or 10 minutes pass with no answer picked up live, a background
   sweep (piggybacked on the existing 1-minute `check-messages` cron — see
   `src/lib/chatEscalationFallback.ts`) emails them via Resend and/or texts
   them via a second WhatsApp template, using whichever contact info they
   left.
5. **Remembers the answer.** Every question Seni actually answers is stored
   (`chat_escalations` table) and fed back into future visitors' prompts, so
   a repeat question gets answered instantly by the AI instead of
   escalating again.

**To embed it on the WordPress site**, paste this into Elementor's global
"Custom Code" (or the theme's footer script injection) so it loads on every
page:

```html
<script src="https://crm.legacyestaterentals.com/chat-widget.js" defer></script>
```

That's the whole setup on the WordPress side — the script is fully
self-contained (no other tags, no CSS, no API keys needed there).

**New public routes** (unauthenticated by design, unlike every other route in
this app — locked down instead by CORS restricted to `https://legacycolombia.com`
and a per-IP rate limit via Redis):

- `POST /api/public/chat-widget` — takes `{ message, history }`, returns
  `{ reply, needsEscalation }`. Never sends a WhatsApp notification by
  itself. (20 req/hr per IP)
- `POST /api/public/chat-widget/escalate` — takes
  `{ question, visitorName, visitorEmail, visitorPhone, conversationSummary? }`,
  drafts a suggested answer, stores a `chat_escalations` row, texts you on
  WhatsApp, and returns `{ ok: true, escalationId }`. (20 req/hr per IP)
- `POST /api/public/chat-widget/poll` — takes `{ escalationId }`, returns
  `{ answered: boolean, answer?: string, stopPolling?: boolean }`. The
  widget calls this every ~4 seconds while an escalation is pending.
  (200 req/hr per IP — it's a cheap DB lookup, not an AI call)
- `POST /api/public/chat-widget/leave` — takes `{ escalationId }`, called via
  `navigator.sendBeacon` on page close so the fallback sweep doesn't have to
  wait the full 10 minutes. Best-effort only.

**Learned answers**: `src/lib/chatEscalations.ts`'s
`getRecentAnsweredEscalations()` feeds the last ~40 answered questions back
into both the direct-answer prompt and the escalation-draft prompt — the
more questions Seni answers, the fewer future visitors ever need to wait for
him.

**Phone/WhatsApp fallback setup** (optional but recommended alongside
email): submit a new Utility-category template in Meta Business Manager
(business.facebook.com/latest/whatsapp_manager/message_templates), same
process as the Gabriel template in section 6:

1. Name: `chat_widget_reply` (or set `WHATSAPP_CHAT_REPLY_TEMPLATE` to
   whatever you choose).
2. Category: Utility. Language: English (US).
3. Body text, using Meta's `{{1}}`/`{{2}}` variables exactly like this:
   > Hi {{1}}, thanks for reaching out to Legacy Colombia! Here's the
   > answer to your question: {{2}}
4. Submit for review — usually approved within minutes to a couple hours.

Until that template is approved, phone-based fallback delivery silently
fails (logged, not fatal) — email fallback still works on its own as long
as `RESEND_API_KEY` is set (section 8 below).

The widget script itself lives at `public/chat-widget.js` — plain
dependency-free JavaScript, no build step, safe to load from a different
origin. Requires `ANTHROPIC_API_KEY`, `DATABASE_URL`, and the WhatsApp env
vars already set up for AI guest replies (see section 6 above); Redis is
optional but recommended so the rate limits actually apply.

## Where your data lives

- **Bookings, guests, properties, reviews** — always pulled live from
  OwnerRez. Nothing is cached or duplicated.
- **Your notes/tags on guests, message templates, and the sent-message log**
  — stored locally in a `data/` folder inside this project (plain JSON
  files, not committed to git, not sent anywhere). Back this folder up if
  you want to keep that history.

## Running it day to day

```bash
npm run dev
```

Leave that running in a terminal and keep `http://localhost:3000` open in a
browser tab, or start it, use the app, and stop it (`Ctrl+C`) when you're
done — either way works. If you want it to feel like a "real" installed app
instead of a terminal command, that's also doable later (a menu-bar launcher,
or deploying it so you can reach it from your phone) — just ask when you're
ready for that.

## Verifying the OwnerRez data matches what you see in OwnerRez

The API client normalizes whatever field names OwnerRez's API returns into
this app's internal shape (see `src/lib/ownerrez.ts`). It's built defensively
against a few possible field-name variants, but every OwnerRez account's API
response can differ slightly by plan/version. If any numbers here don't match
what you see in the OwnerRez web app once you connect it for real, send me
what's off (e.g. "revenue looks doubled" or "arrival dates are one day early")
and I'll adjust the normalization — that's a quick fix, not a rebuild.

## Tech stack

Next.js (App Router) + TypeScript + Tailwind CSS, no database server required
(local JSON files for CRM extension data), Recharts for charts. Everything
runs with a single `npm run dev` — no Docker, no separate backend process.
